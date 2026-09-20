// Runs on ebth.com pages. Reads whitelisted auction fields and hands them to the background worker.
// Pages you browse yourself are only captured if they are lot or list pages (never account,
// cart or checkout pages). Pages the worker opens for a scheduled job are always reported so
// blocks and logouts are noticed. For a scheduled sale page it also reads the sale's later
// pages, slowly, the way scrolling would.
(async function () {
  if (window.top !== window) return;
  var MAX_PAGES = 20;
  var who;
  try { who = await chrome.runtime.sendMessage({ type: "whoami" }); } catch (e) { return; }
  var isJob = !!(who && who.job);
  var kind = EBTH.pageKind(document, location.pathname);
  if (!isJob && !kind) return;
  if (isJob && !kind) kind = who.kind === "list" ? "list" : "lot";

  var nav = performance.getEntriesByType("navigation")[0];
  var status = nav && nav.responseStatus ? nav.responseStatus : 0;
  var payload = {
    kind: kind,
    url: location.origin + location.pathname,
    sig: EBTH.signals(document, status),
    items: EBTH.listItems(document),
    lot: kind === "lot" ? EBTH.parseLot(document) : null,
    sale: null,
    pages: 1
  };

  var cards = payload.items.length ? [] : EBTH.cardItems(document);
  if (kind === "list" && cards.length) {
    var sale = EBTH.saleMeta(document);
    payload.sale = sale ? { id: sale.id, name: sale.name } : null;
    var res = { items: cards, pages: 1, status: 200 };
    if (isJob && sale && sale.item_count && sale.item_count > cards.length) {
      res = await EBTH.collectPages({
        firstItems: cards, itemCount: sale.item_count, maxPages: MAX_PAGES,
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
        delayMs: function () { return 4000 + Math.random() * 4000; },
        fetchPage: async function (n) {
          var u = new URL(location.href);
          u.searchParams.set("page", String(n));
          u.hash = "";
          var r = await fetch(u.toString(), { credentials: "include" });
          var text = await r.text();
          return { status: r.status, doc: new DOMParser().parseFromString(text, "text/html") };
        }
      });
    }
    if (res.status >= 400) payload.sig.status = res.status;
    payload.items = EBTH.withEndTimes(res.items, sale && sale.ends_at);
    payload.pages = res.pages;
  }
  try { await chrome.runtime.sendMessage({ type: "capture", payload: payload }); } catch (e) { /* worker asleep or extension reloaded */ }
})();
