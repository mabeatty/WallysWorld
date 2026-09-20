// Runs on ebth.com pages. Reads whitelisted auction fields and hands them to the background worker.
// Pages you browse yourself are only captured if they are lot or list pages (never account,
// cart or checkout pages). Pages the worker opens for a scheduled job are always reported so
// blocks and logouts are noticed.
(async function () {
  if (window.top !== window) return;
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
    lot: kind === "lot" ? EBTH.parseLot(document) : null
  };
  try { await chrome.runtime.sendMessage({ type: "capture", payload: payload }); } catch (e) { /* worker asleep or extension reloaded */ }
})();
