/*
 * catawiki.js - reads what the extension needs from a Catawiki page.
 *
 * Catawiki is a Next.js app: every page embeds a __NEXT_DATA__ script tag with clean JSON for
 * the auction and its lots -- identity, title, condition, category, curator, close time. No
 * CSS-selector guessing needed for any of that.
 *
 * A lot page (/l/[lotId]) IS a getServerSideProps page ("gssp":true in __NEXT_DATA__), meaning
 * Catawiki re-renders it server-side on every request and bakes the live bid, full bid history,
 * and reserve status straight into pageProps.biddingBlockResponse -- confirmed by comparing a
 * plain View Source capture against a fully-loaded, waited-on page: identical bid data in both.
 * So there is no separate client-only bid state to read off the DOM; parseLotDetail() below reads
 * everything from the one JSON parse. (An auction-LIST page is different: it has no bid data for
 * its lots at all, live or static -- see parseAuctionList's comment.)
 *
 * Works in three places: the content script (real DOM), the service worker (pure functions
 * only), and Node tests (jsdom). Attaches to globalThis.Catawiki, or module.exports under Node.
 */
(function (root) {
  "use strict";

  function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function num(s) {
    var m = (s || "").match(/-?\d[\d,.]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, "")) : null;
  }

  function nextData(doc) {
    var el = doc.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  // "/a/[...pageId]" for an auction listing, "/l/[lotId]" for a single lot -- confirmed against
  // real pages of both kinds. Far more reliable than guessing from the URL path, since it is the
  // actual Next.js page template Catawiki itself rendered.
  function pageKind(doc) {
    var nd = nextData(doc);
    var p = nd && nd.page;
    if (p === "/a/[...pageId]") return "list";
    if (p === "/l/[lotId]") return "lot";
    return null;
  }

  function epochToIso(ms) {
    return typeof ms === "number" ? new Date(ms).toISOString() : null;
  }

  // Best-effort match against a lot's specifications for a catalog reference number (Scott,
  // Michel, Yvert, Sassone, Stanley Gibbons, or a generic "Catalogue number" field). No real lot
  // we've sampled has had one populated yet, so this is unconfirmed against an actual example --
  // it matches on the specification's NAME, not its value, since Catawiki appears to key these by
  // the catalog system's name (e.g. "Sassone number") rather than a fixed field name.
  var CATALOG_NUMBER_NAME_RE = /(catalog(ue)?|scott|michel|yvert|sassone|stanley\s*gibbons|\bsg\b)\s*(number|no\.?|ref(erence)?)/i;
  function findCatalogNumber(specs) {
    var keys = Object.keys(specs || {});
    for (var i = 0; i < keys.length; i++) {
      if (CATALOG_NUMBER_NAME_RE.test(keys[i])) return specs[keys[i]];
    }
    return null;
  }

  // The top-level auction descriptor the ingest RPC upserts into catawiki_auctions -- present
  // under pageProps.auction on BOTH page kinds, so this is shared rather than duplicated between
  // parseAuctionList and parseLotDetail. A content script needs this same shape regardless of
  // which kind of page it happens to be looking at, to send alongside whatever lot(s) it found.
  function auctionFromPage(doc) {
    var nd = nextData(doc);
    var pp = nd && nd.props && nd.props.pageProps;
    var a = pp && pp.auction;
    if (!a) return null;
    var cats = a.categories || [];
    var category = cats.length ? cats[cats.length - 1].title : null;
    var curator = (pp.expert && pp.expert.name) ||
      (pp.lotDetailsData && pp.lotDetailsData.experts && pp.lotDetailsData.experts[0] && pp.lotDetailsData.experts[0].name) ||
      (a.auctioneers && a.auctioneers[0] && a.auctioneers[0].name) || null;
    return { id: String(a.id), name: a.title || null, url: a.url || null, category: category, curator: curator, ends_at: a.closeAt || null };
  }

  // An auction listing page: the auction's own metadata, plus every lot's identity fields. No
  // bid data of any kind lives on this page -- not even server-rendered, unlike a lot page (see
  // file header) -- so high_bid/watchers_count/etc. are deliberately absent from each lot here.
  // That's the crawler's actual design, not a gap to fill in: a "list" job's job is to discover
  // and refresh lot identity across a whole auction cheaply; a "detail" job (parseLotDetail,
  // below) is what captures bid state, one lot at a time.
  function parseAuctionList(doc) {
    var nd = nextData(doc);
    var pp = nd && nd.props && nd.props.pageProps;
    if (!pp || !pp.auction) return null;
    var auction = auctionFromPage(doc);
    var lots = (pp.lots || []).map(function (l) {
      return {
        item_id: String(l.id),
        name: l.title || null,
        url: l.url || null,
        condition: l.subtitle || null,
        auction_id: auction.id
      };
    });
    return { auction: auction, lots: lots };
  }

  // A single lot's page. Turns out everything we need -- including the live bid, full bid
  // history, reserve status and seller stats -- is server-rendered into this page's own
  // __NEXT_DATA__ (under pageProps.lotDetailsData), not just hydrated into the DOM afterward as
  // the auction-list page's data is. So this needs no separate DOM read at all: what you see
  // rendered on screen ("Current bid €38") is just React displaying
  // lotDetailsData.biddingBlockResponse.localizedCurrentBidAmount from this same JSON.
  //
  // expertsEstimate is null on every lot we've sampled so far -- the exact shape of a populated
  // one (field names for low/high) is a guess (est.low/est.high or est.min/est.max) pending a
  // real example of a lot that has one.
  function parseLotDetail(doc) {
    var nd = nextData(doc);
    var pp = nd && nd.props && nd.props.pageProps;
    var ld = pp && pp.lotDetailsData;
    if (!ld) return null;

    // auction and biddingBlockResponse are siblings of lotDetailsData under pageProps, not
    // nested inside it -- verified against a real lot page's actual __NEXT_DATA__ layout.
    var auction = (pp && pp.auction) || {};
    var cats = auction.categories || [];
    var category = cats.length ? cats[cats.length - 1].title : null;
    var curator = (ld.experts && ld.experts[0] && ld.experts[0].name) ||
      (auction.auctioneers && auction.auctioneers[0] && auction.auctioneers[0].name) || null;

    var bb = (pp && pp.biddingBlockResponse) || {};
    var bids = (bb.biddingHistory && bb.biddingHistory.bids) || [];
    var reserveMet = bb.reservePriceMet; // null means no reserve was set; true/false means one was
    var noReserve = reserveMet === null || reserveMet === undefined;

    var destShip = ld.shippingConfig && ld.shippingConfig.destinationCountry && ld.shippingConfig.destinationCountry.shipping;
    var shippingEur = destShip && typeof destShip.rate === "number" ? destShip.rate / 100 : null;

    var est = ld.expertsEstimate || null;
    var estimateLow = est ? (est.low != null ? est.low : est.min) : null;
    var estimateHigh = est ? (est.high != null ? est.high : est.max) : null;

    var specifications = {};
    (ld.specifications || []).forEach(function (s) {
      if (s && s.name) specifications[s.name] = s.value;
    });

    var badges = (ld.sellerInfo && ld.sellerInfo.badges) || [];
    var verified = badges.some(function (b) { return b && b.name === "verified"; });

    var seller = ld.sellerInfo ? {
      id: String(ld.sellerInfo.id),
      name: ld.sellerInfo.sellerName || ld.sellerInfo.userName || null,
      country: (ld.sellerInfo.address && ld.sellerInfo.address.country && ld.sellerInfo.address.country.name) || null,
      score: ld.sellerInfo.score ? ld.sellerInfo.score.score : null,
      feedback_count: ld.sellerInfo.score ? ld.sellerInfo.score.lifetimeCount : null,
      objects_sold: ld.sellerInfo.objectsSold ? ld.sellerInfo.objectsSold.total : null,
      is_pro: !!ld.sellerInfo.isPro,
      is_top: !!ld.sellerInfo.isTop,
      verified: verified
    } : null;

    var liveFormat = !!auction.liveStream;
    var catalogNumber = findCatalogNumber(specifications);

    return {
      item_id: String(ld.lotId),
      auction_id: String(auction.id),
      name: ld.lotTitle || null,
      url: (ld.seo && ld.seo.metaTags && ld.seo.metaTags.canonical) || null,
      category: category,
      curator: curator,
      condition: ld.lotSubtitle || null,
      description: ld.description || ld.autoTranslatedDescription || null,
      ends_at: auction.closeAt || epochToIso(bb.biddingEndTime),
      live_format: liveFormat,
      catalog_number: catalogNumber,
      no_reserve: noReserve,
      reserve_met: noReserve ? null : reserveMet,
      high_bid: typeof bb.localizedCurrentBidAmount === "number" ? bb.localizedCurrentBidAmount : null,
      is_starting_bid: bids.length === 0,
      bids_count: bids.length,
      watchers_count: typeof ld.favoriteCount === "number" ? ld.favoriteCount : null,
      estimate_low: estimateLow,
      estimate_high: estimateHigh,
      shipping_eur: shippingEur,
      specifications: specifications,
      seller: seller
    };
  }

  // Maps either shape this file produces -- a bare list-item from parseAuctionList().lots[]
  // (item_id, name, url, condition, auction_id only) or the rich object from parseLotDetail() --
  // onto catawiki_ingest_page's exact flat column names. A list-item simply won't have most of
  // these properties, so most fields below come out null; that's correct and intentional, since
  // the RPC's on-conflict clause (fixed in migration 0024) coalesces a null incoming field against
  // whatever a prior detail-job crawl already stored, rather than overwriting it.
  function toIngestLot(lot) {
    if (!lot) return null;
    var seller = lot.seller || null;
    return {
      item_id: lot.item_id,
      auction_id: lot.auction_id,
      name: lot.name || null,
      url: lot.url || null,
      category: lot.category || null,
      ends_at: lot.ends_at || null,
      live_format: typeof lot.live_format === "boolean" ? lot.live_format : null,
      no_reserve: typeof lot.no_reserve === "boolean" ? lot.no_reserve : null,
      reserve_met: lot.reserve_met === undefined ? null : lot.reserve_met,
      high_bid: typeof lot.high_bid === "number" ? lot.high_bid : null,
      is_starting_bid: typeof lot.is_starting_bid === "boolean" ? lot.is_starting_bid : null,
      watchers_count: typeof lot.watchers_count === "number" ? lot.watchers_count : null,
      bids_count: typeof lot.bids_count === "number" ? lot.bids_count : null,
      estimate_low: typeof lot.estimate_low === "number" ? lot.estimate_low : null,
      estimate_high: typeof lot.estimate_high === "number" ? lot.estimate_high : null,
      shipping_eur: typeof lot.shipping_eur === "number" ? lot.shipping_eur : null,
      catalog_number: lot.catalog_number || null,
      condition: lot.condition || null,
      description: lot.description || null,
      seller_name: seller ? seller.name : null,
      seller_location: seller ? seller.country : null,
      seller_verified: seller ? seller.verified : null,
      seller_feedback_pct: seller ? seller.score : null,
      seller_objects_sold: seller ? seller.objects_sold : null
    };
  }

  var Catawiki = { nextData: nextData, pageKind: pageKind, auctionFromPage: auctionFromPage, parseAuctionList: parseAuctionList, parseLotDetail: parseLotDetail, toIngestLot: toIngestLot, clean: clean, num: num };
  if (typeof module !== "undefined" && module.exports) module.exports = Catawiki;
  else root.Catawiki = Catawiki;
})(typeof globalThis !== "undefined" ? globalThis : this);
