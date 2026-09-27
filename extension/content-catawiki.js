// Runs on catawiki.com pages. Reads a lot's or an auction listing's data straight out of the
// page's own __NEXT_DATA__ and hands it to the background worker.
//
// A lot or auction-list page never needs to wait for anything: the live bid, full bid history,
// reserve status, and every lot's identity are already in the very first HTML the server sends
// (getServerSideProps) -- see lib/catawiki.js's file header for how that was confirmed. A category
// page (e.g. /en/c/187-stamps) is a different, much heavier kind of page -- thousands of items,
// filters, pagination -- and real production evidence (an extension-created background tab
// reporting an unrecognized page on its first read, while the same tab checked moments later by
// hand always showed the right data) points to it briefly settling through an initial state
// before its real content is in place. So unlike the other two page kinds, this one gets a short
// retry loop rather than a single, immediate read.
(async function () {
  if (window.top !== window) return;
  var who;
  try { who = await chrome.runtime.sendMessage({ type: "whoami" }); } catch (e) { return; }
  var isJob = !!(who && who.job);

  var kind = null;
  for (var attempt = 0; attempt < 10; attempt++) {
    kind = Catawiki.pageKind(document);
    if (kind) break;
    await new Promise(function (r) { setTimeout(r, 500); });
  }

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
    } else if (verdict === "ok" && kind === "category") {
      // A category page has no single auction of its own -- auctionFromPage() already resolves
      // to null here since pageProps.auction doesn't exist on this page kind, which is correct:
      // each lot found this way carries its own auction_id instead (see parseCategoryList).
      var parsedCat = Catawiki.parseCategoryList(document);
      lots = parsedCat ? parsedCat.lots.map(Catawiki.toIngestLot) : [];
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
