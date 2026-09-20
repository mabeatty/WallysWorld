// Runs on ebth.com pages. Reads whitelisted auction fields and hands them to the background worker.
// Pages you browse yourself are only captured if they are lot or list pages (never account,
// cart or checkout pages). Pages the worker opens for a scheduled job are always reported so
// blocks and logouts are noticed.
//
// A sale is many pages. This script reads exactly the page it is on; the database decides which
// page of which sale to open next, so each page is an ordinary page load. On a sale page you browse
// yourself, scrolling loads more lots and they are captured as they appear.
(async function () {
  if (window.top !== window) return;
  var who;
  try { who = await chrome.runtime.sendMessage({ type: "whoami" }); } catch (e) { return; }
  var isJob = !!(who && who.job);
  var kind = EBTH.pageKind(document, location.pathname);
  if (!isJob && !kind) return;
  if (isJob && !kind) kind = who.kind === "list" ? "list" : "lot";

  var CARD = 'a.items-grid__item[href*="/items/"]';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // The lot cards are drawn by the page's own scripts, so in a background tab they can appear a little after
  // the page finishes loading. Give them time to show up before reading.
  if (isJob && kind === "list" && EBTH.itemStates(document).size === 0) {
    var t0 = Date.now();
    while (Date.now() - t0 < 40000 && !document.querySelector(CARD)) await sleep(500);
  }

  var nav = performance.getEntriesByType("navigation")[0];
  var status = nav && nav.responseStatus ? nav.responseStatus : 0;

  function build() {
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
      payload.sale = sale ? { id: sale.id, name: sale.name, item_count: sale.item_count } : null;
      payload.items = EBTH.withEndTimes(cards, sale && sale.ends_at);
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

  await send(build());

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
        await send(build());
      }, 4000);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
