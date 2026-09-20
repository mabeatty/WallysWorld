// Runs on ebth.com pages. Reads whitelisted auction fields and hands them to the background worker.
// Pages you browse yourself are only captured if they are lot or list pages (never account,
// cart or checkout pages). Pages the worker opens for a scheduled job are always reported so
// blocks and logouts are noticed.
//
// Sale pages: the page loads its own lots with a background request. For a scheduled read this script
// finds that request in the browser's resource list and asks for the next pages the same way, slowly.
// If that does not work it tries a few other request styles, and it reports what it saw so the
// database side can be adjusted without touching the extension. On a sale page you browse yourself,
// scrolling loads more lots and they are captured as they appear.
(async function () {
  if (window.top !== window) return;
  var MAX_PAGES = 20;
  var COOLDOWN_MS = 60 * 60 * 1000;      // after a total paging failure, don't probe again for an hour
  var who;
  try { who = await chrome.runtime.sendMessage({ type: "whoami" }); } catch (e) { return; }
  var isJob = !!(who && who.job);
  var kind = EBTH.pageKind(document, location.pathname);
  if (!isJob && !kind) return;
  if (isJob && !kind) kind = who.kind === "list" ? "list" : "lot";

  var CARD = 'a.items-grid__item[href*="/items/"]';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var parseHtml = function (h) { return new DOMParser().parseFromString(h, "text/html"); };

  // A scheduled sale page runs in a background tab, where the lot cards can appear a little after the
  // page finishes loading. Give them time to show up before reading.
  if (isJob && kind === "list" && EBTH.itemStates(document).size === 0) {
    var t0 = Date.now();
    while (Date.now() - t0 < 40000 && !document.querySelector(CARD)) await sleep(500);
  }

  var nav = performance.getEntriesByType("navigation")[0];
  var status = nav && nav.responseStatus ? nav.responseStatus : 0;

  var XHR_HTML = { "X-Requested-With": "XMLHttpRequest", "Accept": "text/html, */*; q=0.01" };
  var XHR_JSON = { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*; q=0.01" };

  function requestStyles() {
    var v = [];
    if (who && who.hint && who.hint.urlTemplate) v.push({ label: "hint", url: who.hint.urlTemplate, headers: who.hint.headers || {} });
    EBTH.listRequestCandidates(performance.getEntriesByType("resource")).slice(0, 2).forEach(function (u, i) {
      v.push({ label: "c" + i, url: u, headers: {} });
      v.push({ label: "c" + i + "j", url: u, headers: XHR_JSON });
    });
    v.push({ label: "pg", url: location.href, headers: {} });
    v.push({ label: "pgx", url: location.href, headers: XHR_HTML });
    v.push({ label: "pgj", url: location.href, headers: XHR_JSON });
    return v;
  }
  async function fetchPage(n, style) {
    var r = await fetch(EBTH.withPage(style.url, n), { credentials: "include", headers: style.headers || {} });
    var text = await r.text();
    var parsed = EBTH.parsePageResponse(text, parseHtml);
    var ct = (r.headers.get("content-type") || "").split(";")[0].split("/").pop();
    var info = ct + " " + Math.round(text.length / 1000) + "kB " + parsed.format + "=" + parsed.items.length;
    if (!parsed.items.length && style.label !== "pg") info += " s=" + text.slice(0, 70).replace(/\s+/g, " ");
    return { status: r.status, items: parsed.items, info: info };
  }

  async function build(allowPaging) {
    var payload = {
      kind: kind,
      url: location.origin + location.pathname,
      sig: EBTH.signals(document, status),
      items: EBTH.listItems(document),
      lot: kind === "lot" ? EBTH.parseLot(document) : null,
      sale: null,
      pages: 1,
      diag: null
    };
    var cards = payload.items.length ? [] : EBTH.cardItems(document);
    if (kind === "list" && cards.length) {
      var sale = EBTH.saleMeta(document);
      payload.sale = sale ? { id: sale.id, name: sale.name } : null;
      var res = { items: cards, pages: 1, status: 200, diag: "" };
      var need = sale && sale.item_count && sale.item_count > cards.length;
      if (allowPaging && need) {
        var cool = (await chrome.storage.local.get({ pagingCooldownUntil: 0 })).pagingCooldownUntil;
        if (Date.now() < cool) {
          payload.diag = "paging paused after a failed attempt; retrying after " + new Date(cool).toLocaleTimeString();
        } else {
          var styles = requestStyles();
          res = await EBTH.collectPages({
            firstItems: cards, itemCount: sale.item_count, maxPages: MAX_PAGES, variants: styles,
            sleep: sleep, delayMs: function () { return 4000 + Math.random() * 4000; }, fetchPage: fetchPage
          });
          var cand = EBTH.listRequestCandidates(performance.getEntriesByType("resource"))
            .map(function (u) { return u.replace("https://www.ebth.com", "").slice(0, 90); });
          payload.diag = "read " + (res.items.length) + " of " + sale.item_count + ". cand=" + JSON.stringify(cand) + " " + res.diag;
          if (res.items.length <= cards.length && res.status < 400) {
            await chrome.storage.local.set({ pagingCooldownUntil: Date.now() + COOLDOWN_MS });
          }
        }
      }
      if (res.status >= 400) payload.sig.status = res.status;
      payload.items = EBTH.withEndTimes(res.items, sale && sale.ends_at);
      payload.pages = res.pages;
    }
    if (kind === "list" && payload.items.length === 0) {
      payload.diag = "no lot cards found; grid=" + !!document.getElementById("items_grid") +
        " anchors=" + document.querySelectorAll('a[href*="/items/"]').length +
        " visible=" + document.visibilityState + " ready=" + document.readyState;
    }
    return payload;
  }
  async function send(payload) {
    try { await chrome.runtime.sendMessage({ type: "capture", payload: payload }); }
    catch (e) { /* worker asleep or extension reloaded */ }
  }

  await send(await build(isJob));

  // Sale page you are browsing: as scrolling loads more lots, capture them too.
  if (!isJob && kind === "list" && document.querySelector(CARD)) {
    var sent = document.querySelectorAll(CARD).length, timer = null;
    new MutationObserver(function () {
      if (document.querySelectorAll(CARD).length <= sent) return;
      clearTimeout(timer);
      timer = setTimeout(async function () {
        var n = document.querySelectorAll(CARD).length;
        if (n <= sent) return;
        sent = n;
        await send(await build(false));
      }, 4000);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
