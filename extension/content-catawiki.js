// Runs on catawiki.com pages. Reads a lot's or an auction listing's data straight out of the
// page's own __NEXT_DATA__ and hands it to the background worker.
//
// Unlike content.js/EBTH, this never needs to poll for content to appear: a Catawiki lot page is
// server-rendered fresh on every request (getServerSideProps), so the live bid, full bid history,
// and reserve status are already in the HTML the instant it loads -- see lib/catawiki.js's file
// header for how that was confirmed. An auction-listing page never carries bid data at all, live
// or static, by the crawler's own design (see parseAuctionList's comment) -- so there is nothing
// to wait for there either.
(async function () {
  if (window.top !== window) return;
  var who;
  try { who = await chrome.runtime.sendMessage({ type: "whoami" }); } catch (e) { return; }
  var isJob = !!(who && who.job);
  var kind = Catawiki.pageKind(document);
  if (!isJob && !kind) return;
  if (isJob && !kind) kind = who.kind === "list" ? "list" : "lot";

  // The one failure mode worth distinguishing from a normal page: Catawiki sits behind Akamai's
  // bot protection, and a challenge/captcha page has no __NEXT_DATA__ script tag at all. Report
  // that as a bad verdict rather than silently sending an "ok" payload with empty lots, so a
  // block is visible the same way one is for EBTH, instead of just looking like quiet auctions.
  var nd = Catawiki.nextData(document);
  var verdict = "ok", note = "";
  if (!nd) {
    verdict = "blocked";
    note = "no __NEXT_DATA__ found on page titled " + JSON.stringify((document.title || "").slice(0, 120));
  } else if (!kind) {
    verdict = "unexpected";
    note = "__NEXT_DATA__ present but page type not recognized (page=" + JSON.stringify(nd.page) + ")";
  }

  function build() {
    var auction = verdict === "ok" ? Catawiki.auctionFromPage(document) : null;
    var lots = [];
    if (verdict === "ok" && kind === "list") {
      var parsed = Catawiki.parseAuctionList(document);
      lots = parsed ? parsed.lots.map(Catawiki.toIngestLot) : [];
    } else if (verdict === "ok") {
      var lot = Catawiki.parseLotDetail(document);
      lots = lot ? [Catawiki.toIngestLot(lot)] : [];
    }
    return {
      kind: kind || (who && who.kind) || "lot",
      url: location.origin + location.pathname,
      verdict: verdict,
      note: note,
      auction: auction,
      lots: lots
    };
  }

  async function send(payload) {
    try { await chrome.runtime.sendMessage({ type: "catawiki_capture", payload: payload }); }
    catch (e) { /* worker asleep or extension reloaded */ }
  }

  await send(build());
})();
