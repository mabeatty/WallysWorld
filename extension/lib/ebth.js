/*
 * ebth.js - reads what the extension needs from an EBTH page.
 *
 * Whitelist only: the page's embedded state also carries account, payment and realtime-key
 * fields. Those are never read, so they never leave the browser.
 *
 * Works in three places: the content script (real DOM), the service worker (pure functions
 * only), and Node tests (jsdom). Attaches to globalThis.EBTH, or module.exports under Node.
 */
(function (root) {
  "use strict";

  var BLOCK_MARKERS = ["captcha", "access denied", "verify you are human", "unusual traffic",
    "just a moment", "pardon our interruption", "request blocked", "are you a robot"];
  var DENY_PREFIXES = ["/checkout", "/cart", "/account", "/users/", "/bids", "/orders"];
  var ALLOW_EXACT = ["/users/followed_items"];

  function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function num(s) {
    var m = (s || "").match(/-?\d[\d,]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, "")) : null;
  }
  function baseImg(u) { return (u || "").split("?")[0]; }
  function absUrl(href) {
    if (!href) return null;
    var u = href.indexOf("http") === 0 ? href : "https://www.ebth.com" + href;
    return u.split("?")[0].split("#")[0];
  }

  function itemStates(doc) {
    var out = new Map();
    doc.querySelectorAll("[data-react-props]").forEach(function (el) {
      var d;
      try { d = JSON.parse(el.getAttribute("data-react-props")); } catch (e) { return; }
      var it = d && d.item;
      if (it && it.id != null && !out.has(String(it.id))) out.set(String(it.id), it);
    });
    return out;
  }

  function normState(it) {
    var bidders = (it.bidderIds || []).map(String);
    return {
      item_id: String(it.id),
      name: it.name || null,
      state: it.aasmState || null,
      high_bid: it.highBidAmount == null ? null : it.highBidAmount,
      min_next_bid: it.minimumBidAmount == null ? null : it.minimumBidAmount,
      bids_count: it.bidsCount == null ? null : it.bidsCount,
      unique_bidders: new Set(bidders).size,
      bidder_ids: bidders,
      extended: !!it.extended,
      ends_at: it.saleEndsAt || null,
      main_image: baseImg(it.mainImage)
    };
  }

  function listItems(doc) {
    var urls = {};
    doc.querySelectorAll('a[href*="/items/"]').forEach(function (a) {
      var m = (a.getAttribute("href") || "").match(/\/items\/(\d+)-/);
      if (m && !urls[m[1]]) urls[m[1]] = absUrl(a.getAttribute("href"));
    });
    var out = [];
    itemStates(doc).forEach(function (it, id) {
      var r = normState(it);
      r.url = urls[id] || null;
      out.push(r);
    });
    return out;
  }

  function parseLot(doc) {
    var og = doc.querySelector('meta[name="og:url"]');
    var url = og ? og.getAttribute("content") : null;
    var m = (url || "").match(/\/items\/(\d+)/);
    var itemId = m ? m[1] : null;

    var specs = {};
    doc.querySelectorAll('[itemprop="description"] table tr').forEach(function (tr) {
      var tds = tr.querySelectorAll("td");
      if (tds.length === 2) specs[clean(tds[0].textContent).replace(/:+$/, "")] = clean(tds[1].textContent);
    });

    var cond = doc.querySelector('[itemprop="ItemCondition"] p');
    var notes = [];
    doc.querySelectorAll(".item-detail .detail-block ul li").forEach(function (li) { notes.push(clean(li.textContent)); });

    var catalogNumber = null;
    var seq = Array.prototype.slice.call(doc.querySelectorAll("h3.item-detail__detail-heading, p"));
    for (var i = 0; i < seq.length; i++) {
      if (seq[i].tagName === "H3" && clean(seq[i].textContent) === "Item #") {
        for (var j = i + 1; j < seq.length; j++) {
          if (seq[j].tagName === "P") { catalogNumber = clean(seq[j].textContent); break; }
        }
        break;
      }
    }

    var cats = [];
    doc.querySelectorAll(".categories__container a").forEach(function (a) {
      var t = clean(a.textContent);
      if (t && cats.indexOf(t) < 0) cats.push(t);
    });

    var saleId = null, saleName = null;
    var sale = doc.querySelector("a.item-detail__sale-link--desktop");
    if (sale) {
      var sm = (sale.getAttribute("href") || "").match(/\/sales\/(\d+)-/);
      saleId = sm ? sm[1] : null;
      saleName = clean(sale.textContent).replace(/^View all items from /, "").replace(/ sale$/, "");
    }
    var more = (doc.body ? doc.body.textContent : "").match(/([\d,]+)\s+More Items in This Sale/);

    var images = [];
    var states = itemStates(doc);
    var main = itemId && states.has(itemId) ? baseImg(states.get(itemId).mainImage) : "";
    if (main) images.push(main);
    doc.querySelectorAll(".carousel__item img").forEach(function (img) {
      var u = baseImg(img.getAttribute("data-src") || "");
      if (u && images.indexOf(u) < 0 && u.indexOf("Guide") < 0) images.push(u);
    });

    return {
      item_id: itemId, url: url, specs: specs, weight_g: num(specs["Total Weight (grams)"]),
      condition: cond ? clean(cond.textContent) : null,
      catalog_notes: notes,
      verified_by: notes.filter(function (n) { return n.toLowerCase().indexOf("verified") >= 0; })[0] || null,
      catalog_number: catalogNumber, categories: cats,
      sale_id: saleId, sale_name: saleName,
      sale_other_items: more ? parseInt(more[1].replace(/,/g, ""), 10) : null,
      images: images
    };
  }

  // ---- sale / category pages: lot cards carry title, current bid and end time, but no bid counts
  var MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

  function cardItems(doc) {
    var out = [], seen = {};
    doc.querySelectorAll('a.items-grid__item[href*="/items/"]').forEach(function (a) {
      var m = (a.getAttribute("href") || "").match(/\/items\/(\d+)-/);
      if (!m || seen[m[1]]) return;
      seen[m[1]] = true;
      var t = a.querySelector(".item__title");
      var bid = a.querySelector(".item__bid-amount");
      var tm = a.querySelector("time.time-remaining");
      out.push({
        item_id: m[1],
        name: t ? (t.getAttribute("title") || clean(t.textContent)) : null,
        url: absUrl(a.getAttribute("href")),
        state: null, bids_count: null, unique_bidders: null, bidder_ids: [], extended: false,
        high_bid: bid ? num(bid.textContent) : null,
        end_label: tm ? tm.getAttribute("title") : null
      });
    });
    return out;
  }

  function saleMeta(doc) {
    var el = doc.querySelector('[data-react-class="sale_header/Application"]');
    if (!el) return null;
    var d;
    try { d = JSON.parse(el.getAttribute("data-react-props")); } catch (e) { return null; }
    return { id: d.saleId == null ? null : String(d.saleId), name: d.name || null,
             item_count: d.itemCount == null ? null : d.itemCount, ends_at: d.saleEndsAt || null };
  }

  // "Sunday, September 20th 2026 @ 7:03pm" -> Date in the browser's time zone (minute precision)
  function parseEndLabel(label) {
    var m = (label || "").match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!m) return null;
    var mon = MONTHS.indexOf(m[1].toLowerCase());
    if (mon < 0) return null;
    var h = parseInt(m[4], 10) % 12 + (m[6].toLowerCase() === "pm" ? 12 : 0);
    return new Date(parseInt(m[3], 10), mon, parseInt(m[2], 10), h, parseInt(m[5], 10), 0, 0);
  }

  // Attach ISO end times to card items. Cards only show minutes, so they are flagged approximate. A sale's lots
  // close in order starting at the sale's own end time, so if the earliest card on the page comes out EARLIER
  // than the sale end, the page is showing times in a zone other than this browser's: drop them all.
  function withEndTimes(items, saleEndsAt) {
    var dates = items.map(function (i) { return parseEndLabel(i.end_label); });
    var valid = dates.filter(Boolean);
    var ok = valid.length > 0;
    if (ok && saleEndsAt) {
      var min = Math.min.apply(null, valid.map(function (d) { return d.getTime(); }));
      ok = min >= new Date(saleEndsAt).getTime() - 5 * 60000;
    }
    return items.map(function (i, k) {
      var r = {}; for (var key in i) if (key !== "end_label") r[key] = i[key];
      if (i.ends_at) return r;                       // exact time already known (e.g. from a JSON response)
      r.ends_at = ok && dates[k] ? dates[k].toISOString() : null;
      r.ends_at_approx = true;
      return r;
    });
  }

  function pageKind(doc, pathname) {
    var ogType = doc.querySelector('meta[name="og:type"]');
    if (pathname.indexOf("/items/") === 0 && ogType && ogType.getAttribute("content") === "product" &&
        doc.querySelector('[itemprop="description"] table')) return "lot";
    if (itemStates(doc).size === 0 && !doc.querySelector('a.items-grid__item[href*="/items/"]')) return null;
    if (ALLOW_EXACT.indexOf(pathname) >= 0) return "list";
    for (var i = 0; i < DENY_PREFIXES.length; i++) if (pathname.indexOf(DENY_PREFIXES[i]) === 0) return null;
    return "list";
  }

  function signals(doc, status) {
    var text = doc.body ? doc.body.textContent : "";
    return {
      status: status || 0,
      hasState: itemStates(doc).size > 0 || !!doc.querySelector('a.items-grid__item[href*="/items/"]'),
      title: doc.title || "",
      bodyStart: text.slice(0, 1500),
      signedIn: text.indexOf("Sign Out") >= 0 || doc.documentElement.outerHTML.indexOf("Sign Out") >= 0
    };
  }

  // -> [verdict, note]; verdicts: ok | gone | blocked | logged_out | unexpected | transient
  function verdictFrom(sig, requiresLogin) {
    var st = sig.status || 0;
    if (st === 404 || st === 410) return ["gone", "http " + st];
    if (st === 403 || st === 429 || st === 503) return ["blocked", "http " + st];
    if (st >= 500) return ["transient", "http " + st];
    if (st >= 400) return ["blocked", "http " + st];
    var title = (sig.title || "").toLowerCase();
    if (!sig.hasState) {
      var head = title + " " + (sig.bodyStart || "").toLowerCase();
      for (var i = 0; i < BLOCK_MARKERS.length; i++) {
        if (head.indexOf(BLOCK_MARKERS[i]) >= 0) return ["blocked", "challenge or block page"];
      }
      if (title.indexOf("ebth") < 0) return ["unexpected", "not an EBTH page and no auction state"];
    }
    if (requiresLogin && !sig.signedIn) return ["logged_out", "session appears logged out"];
    return ["ok", ""];
  }

  var EBTH = { itemStates: itemStates, normState: normState, listItems: listItems, parseLot: parseLot,
               cardItems: cardItems, saleMeta: saleMeta, parseEndLabel: parseEndLabel, withEndTimes: withEndTimes,
               pageKind: pageKind, signals: signals, verdictFrom: verdictFrom };
  if (typeof module !== "undefined" && module.exports) module.exports = EBTH;
  else root.EBTH = EBTH;
})(typeof globalThis !== "undefined" ? globalThis : this);
