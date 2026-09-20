// Runs on ebth.com pages. Reads whitelisted auction fields and hands them to the background worker.
// Pages you browse yourself are only captured if they are lot or list pages (never account,
// cart or checkout pages). Pages the worker opens for a scheduled job are always reported so
// blocks and logouts are noticed. For a scheduled sale page it also reads the sale's later
// pages, slowly, the way scrolling would. On a sale page you browse yourself, scrolling loads
// more lots and they are captured as they appear.
(async function () {
  if (window.top !== window) return;
  var MAX_PAGES = 20;
  var who;
  try { who = await chrome.runtime.sendMessage({ type: "whoami" }); } catch (e) { return; }
  var isJob = !!(who && who.job);
  var kind = EBTH.pageKind(document, location.pathname);
  if (!isJob && !kind) return;
  if (isJob && !kind) kind = who.kind === "list" ? "list" : "lot";

  var CARD = 'a.items-grid__item[href*="/items/"]';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // A scheduled sale page runs in a background tab, where the lot cards can appear a little after the
  // page finishes loading. Give them time to show up before reading.
  if (isJob && kind === "list" && EBTH.itemStates(document).size === 0) {
    var t0 = Date.now();
    while (Date.now() - t0 < 40000 && !document.querySelector(CARD)) await sleep(500);
  }

  var nav = performance.getEntriesByType("navigation")[0];
  var status = nav && nav.responseStatus ? nav.responseStatus : 0;

  // Different ways the site might answer a request for a later page; the first that returns new lots is used.
  var VARIANTS = [
    {},
    { "X-Requested-With": "XMLHttpRequest", "Accept": "text/html, */*; q=0.01" },
    { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*; q=0.01" }
  ];
  async function fetchPage(n, headers) {
    var u = new URL(location.href);
    u.searchParams.set("page", String(n));
    u.hash = "";
    var r = await fetch(u.toString(), { credentials: "include", headers: headers || {} });
    var text = await r.text();
    var html = EBTH.htmlFromPossiblyEscaped(text);
    var doc = new DOMParser().parseFromString(html, "text/html");
    var ct = (r.headers.get("content-type") || "").split(";")[0].split("/").pop();
    return { status: r.status, doc: doc,
             info: ct + " " + Math.round(text.length / 1000) + "kB items=" + (text.match(/\/items\/\d+-/g) || []).length };
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
      if (allowPaging && sale && sale.item_count && sale.item_count > cards.length) {
        res = await EBTH.collectPages({
          firstItems: cards, itemCount: sale.item_count, maxPages: MAX_PAGES, variants: VARIANTS,
          sleep: sleep, delayMs: function () { return 4000 + Math.random() * 4000; }, fetchPage: fetchPage
        });
      }
      if (res.status >= 400) payload.sig.status = res.status;
      payload.items = EBTH.withEndTimes(res.items, sale && sale.ends_at);
      payload.pages = res.pages;
      if (sale && sale.item_count && payload.items.length < sale.item_count && allowPaging) {
        payload.diag = "read " + payload.items.length + " of " + sale.item_count + " lots. " + res.diag;
      }
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

  var first = await build(isJob);
  await send(first);

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
