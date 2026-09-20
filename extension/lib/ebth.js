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

  // Attach ISO end times to card items. Cards only show minutes, so they are flagged approximate,
  // and they are dropped entirely unless the earliest one lines up with the sale's own end time
  // (a guard against the page showing times in a time zone other than this browser's).
  function withEndTimes(items, saleEndsAt) {
    var dates = items.map(function (i) { return parseEndLabel(i.end_label); });
    var valid = dates.filter(Boolean);
    var ok = valid.length > 0;
    if (ok && saleEndsAt) {
      var min = Math.min.apply(null, valid.map(function (d) { return d.getTime(); }));
      ok = Math.abs(min - new Date(saleEndsAt).getTime()) <= 20 * 60000;
    }
    return items.map(function (i, k) {
      var r = {}; for (var key in i) if (key !== "end_label") r[key] = i[key];
      if (i.ends_at) return r;                       // exact time already known (e.g. from a JSON response)
      r.ends_at = ok && dates[k] ? dates[k].toISOString() : null;
      r.ends_at_approx = true;
      return r;
    });
  }

  // ---- later pages may come back as JSON. The shape is not known in advance, so look for arrays of
  // objects that resemble the site's own item state (id, name, bid amount / end time) and map them.
  function looksLikeItem(o) {
    return !!o && typeof o === "object" && !Array.isArray(o) && /^\d+$/.test(String(o.id == null ? "" : o.id)) &&
      (typeof o.name === "string" || typeof o.title === "string") &&
      ("highBidAmount" in o || "currentBid" in o || "current_bid" in o || "bidAmount" in o || "saleEndsAt" in o || "aasmState" in o);
  }
  function findItemArrays(v, out, depth) {
    if (v == null || depth > 6) return out;
    if (Array.isArray(v)) {
      var n = v.filter(looksLikeItem).length;
      if (n > 0 && n >= v.length / 2) { out.push(v); return out; }
      v.forEach(function (x) { findItemArrays(x, out, depth + 1); });
    } else if (typeof v === "object") {
      Object.keys(v).forEach(function (k) { findItemArrays(v[k], out, depth + 1); });
    }
    return out;
  }
  function firstDefined() { for (var i = 0; i < arguments.length; i++) if (arguments[i] != null) return arguments[i]; return null; }
  function jsonItem(o) {
    var r = normState({
      id: o.id, name: o.name || o.title, aasmState: o.aasmState || o.state,
      highBidAmount: firstDefined(o.highBidAmount, o.currentBid, o.current_bid, o.bidAmount),
      minimumBidAmount: o.minimumBidAmount, bidsCount: o.bidsCount, bidderIds: o.bidderIds, extended: o.extended,
      saleEndsAt: firstDefined(o.saleEndsAt, o.endsAt, o.ends_at, o.endTime), mainImage: o.mainImage
    });
    var u = firstDefined(o.url, o.path, o.href);
    r.url = u ? absUrl(u) : null;
    r.ends_at_approx = false;
    return r;
  }
  // -> { items, format }. parseHtml(html) must return a document (DOMParser in the browser, JSDOM in tests).
  function parsePageResponse(text, parseHtml) {
    var t = (text || "").replace(/^\s+/, "");
    if (t.charAt(0) === "{" || t.charAt(0) === "[") {
      try {
        var items = [];
        findItemArrays(JSON.parse(t), [], 0).forEach(function (a) { a.filter(looksLikeItem).forEach(function (o) { items.push(jsonItem(o)); }); });
        return { items: items, format: "json" };
      } catch (e) { /* not JSON after all */ }
    }
    return { items: cardItems(parseHtml(htmlFromPossiblyEscaped(text || ""))), format: "html" };
  }

  // The page loads its own lots with a background request. Find it in the browser's resource list so the
  // next page can be requested the same way.
  function listRequestCandidates(entries) {
    var seen = {}, out = [];
    (entries || []).forEach(function (e) {
      var n = e.name || "";
      if (n.indexOf("https://www.ebth.com/") !== 0) return;
      if (["fetch", "xmlhttprequest"].indexOf(e.initiatorType) < 0) return;
      if (/\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ico)(\?|$)/i.test(n)) return;
      if (/analytics|segment|pubnub|braze|sentry|rollbar|beacon/i.test(n)) return;
      if (!seen[n]) { seen[n] = true; out.push(n); }
    });
    function score(n) { return (/[?&]page=/.test(n) ? 4 : 0) + (/sale_id|category|status=|sort=/.test(n) ? 2 : 0) + (/items/.test(n) ? 1 : 0); }
    out.sort(function (a, b) { return score(b) - score(a); });
    return out.slice(0, 3);
  }
  function withPage(url, n) {
    if (url.indexOf("{page}") >= 0) return url.replace("{page}", String(n));
    var u = new URL(url); u.searchParams.set("page", String(n)); u.hash = "";
    return u.toString();
  }

  // A HTML page, an HTML fragment, or a script/JSON string that embeds the cards' HTML
  // Return an HTML string that cardItems can read.
  function htmlFromPossiblyEscaped(text) {
    if (text.indexOf("items-grid__item") < 0) return text;
    if (text.indexOf('<a class="items-grid__item') >= 0 || text.indexOf("<a class='items-grid__item") >= 0) return text;
    return text.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replace(/\\u0026/gi, "&")
               .replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }

  var WRONG_STYLE = [401, 404, 405, 406, 410, 422];

  // Load the remaining pages of a paged list. fetchPage(n, variant) -> Promise<{status, doc, info}>.
  // Timing and fetching are injected so this can be tested. Page 2 is tried with each request
  // variant in turn until one returns new cards; that variant is then used for the rest. Stops on
  // any error status, an empty page, or the cap. diag says what each attempt returned.
  async function collectPages(o) {
    var items = o.firstItems.slice(), seen = {}, pages = 1, status = 200, diag = [];
    var variants = o.variants || [0], vi = 0;
    items.forEach(function (i) { seen[i.item_id] = true; });
    function merge(r) {
      var added = 0;
      (r.items || cardItems(r.doc)).forEach(function (c) { if (!seen[c.item_id]) { seen[c.item_id] = true; items.push(c); added++; } });
      return added;
    }
    for (var p = 2; p <= o.maxPages; p++) {
      if (o.itemCount && items.length >= o.itemCount) break;
      var added = 0, r;
      var tries = p === 2 ? variants.length : 1;
      for (var k = 0; k < tries; k++) {
        var v = p === 2 ? k : vi;
        await o.sleep(o.delayMs());
        r = await o.fetchPage(p, variants[v]);
        pages++;
        var lab = (variants[v] && variants[v].label) || "v" + v;
        if (r.status >= 400) {
          diag.push(lab + ":" + r.status);
          if (WRONG_STYLE.indexOf(r.status) >= 0) continue;     // this request style is not accepted; try the next one
          status = r.status; break;                             // 403, 429, 5xx: treat as a block
        }
        added = merge(r);
        diag.push(lab + ":" + r.status + (r.info ? " " + r.info : "") + " new=" + added);
        if (added > 0) { if (p === 2) vi = k; break; }
      }
      if (status >= 400 || added === 0) break;
    }
    return { items: items, pages: pages, status: status, variant: vi, diag: diag.join(" | ").slice(0, 900) };
  }

  // Headers worth replaying from the page's own request. Everything the browser sets itself is left out.
  var SKIP_HEADERS = /^(cookie|host|user-agent|accept-encoding|accept-language|connection|content-length|origin|referer|priority|pragma|cache-control|upgrade-insecure-requests|te|sec-.*)$/i;
  function replayableHeaders(list) {
    var out = {};
    var entries = Array.isArray(list) ? list.map(function (h) { return [h.name, h.value]; })
                                      : Object.keys(list || {}).map(function (k) { return [k, list[k]]; });
    entries.forEach(function (e) { if (e[0] && e[1] != null && !SKIP_HEADERS.test(e[0])) out[e[0]] = e[1]; });
    return out;
  }

  // Scroll a page until it has loaded `target` lots, growth stops, or time runs out.
  // count/scroll/sleep/now are injected so this can be tested.
  async function scrollUntil(o) {
    var start = o.now(), last = o.count(), lastGrowth = start;
    while (o.now() - start < o.maxMs) {
      if (o.target && o.count() >= o.target) break;
      o.scroll();
      await o.sleep(o.stepMs || 1500);
      var c = o.count();
      if (c > last) { last = c; lastGrowth = o.now(); }
      else if (o.now() - lastGrowth >= o.idleMs) break;
    }
    return { count: o.count(), ms: o.now() - start };
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
               collectPages: collectPages, htmlFromPossiblyEscaped: htmlFromPossiblyEscaped,
               parsePageResponse: parsePageResponse, replayableHeaders: replayableHeaders, scrollUntil: scrollUntil, listRequestCandidates: listRequestCandidates, withPage: withPage, pageKind: pageKind, signals: signals, verdictFrom: verdictFrom };
  if (typeof module !== "undefined" && module.exports) module.exports = EBTH;
  else root.EBTH = EBTH;
})(typeof globalThis !== "undefined" ? globalThis : this);
