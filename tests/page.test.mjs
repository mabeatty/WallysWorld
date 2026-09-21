import test from "node:test";
import assert from "node:assert/strict";
import { domFrom, EBTH, HAVE_FIXTURES, HAVE_SALE, LOT_FILE, LIST_FILE, LOT_ID, lotDoc, listDoc, saleDoc, salePayload, payload, sensitiveStrings, load } from "./helpers.mjs";

const skip = !HAVE_FIXTURES && "save a lot page (filename contains Rolex) and the Followed Items page into tests/fixtures";

test("lot page: specs, condition, sale, images, bid state", { skip }, () => {
  const doc = lotDoc();
  assert.equal(EBTH.pageKind(doc, "/items/14568274-1970-rolex"), "lot");
  const lot = EBTH.parseLot(doc);
  assert.equal(lot.item_id, LOT_ID);
  assert.equal(lot.specs.Brand, "Rolex");
  assert.equal(lot.weight_g, 92.9);
  assert.equal(lot.sale_id, "90479");
  assert.match(lot.verified_by, /Certified Watchmaker/);
  assert.equal(lot.catalog_number, "ITMGU87655");
  assert.ok(lot.images.length >= 8);
  const [it] = EBTH.listItems(doc);
  assert.equal(it.item_id, LOT_ID);
  assert.equal(it.high_bid, 3300);
  assert.equal(it.min_next_bid, 3350);
  assert.equal(it.bids_count, 40);
  assert.equal(it.unique_bidders, 13);
  assert.equal(it.extended, false);
  assert.match(it.ends_at, /^2026-09-20T20:03:20/);
});

test("list page: 20 lots, absolute urls, signed in", { skip }, () => {
  const doc = listDoc();
  assert.equal(EBTH.pageKind(doc, "/users/followed_items"), "list");
  const items = EBTH.listItems(doc);
  assert.equal(items.length, 20);
  assert.ok(items.every((i) => /^https:\/\/www\.ebth\.com\/items\/\d+-/.test(i.url)), "every lot has an absolute url");
  assert.ok(items.every((i) => i.unique_bidders <= i.bids_count));
  assert.deepEqual(EBTH.verdictFrom(EBTH.signals(doc, 200), true), ["ok", ""]);
});

test("nothing personal leaves the browser", { skip }, () => {
  for (const [file, doc, path] of [[LOT_FILE, lotDoc(), "/items/14568274-x"], [LIST_FILE, listDoc(), "/users/followed_items"]]) {
    const sens = sensitiveStrings(file);
    assert.ok(sens.length >= 3, "fixture should contain account data for this test to mean anything");
    const body = JSON.stringify(payload(doc, path));
    for (const s of sens) assert.ok(!body.includes(s), "payload leaked an account field");
  }
});

test("verdicts: block, logout, challenge, odd page, status codes", { skip }, () => {
  const doc = listDoc();
  const sig = EBTH.signals(doc, 200);
  assert.equal(EBTH.verdictFrom({ ...sig, signedIn: false }, true)[0], "logged_out");
  assert.equal(EBTH.verdictFrom({ ...sig, signedIn: false }, false)[0], "ok");
  assert.equal(EBTH.verdictFrom({ ...sig, status: 403 }, false)[0], "blocked");
  assert.equal(EBTH.verdictFrom({ ...sig, status: 429 }, false)[0], "blocked");
  assert.equal(EBTH.verdictFrom({ ...sig, status: 404 }, false)[0], "gone");
  assert.equal(EBTH.verdictFrom({ ...sig, status: 500 }, false)[0], "transient");
  const challenge = load(LIST_FILE, "https://www.ebth.com/");
  challenge.documentElement.innerHTML = "<head><title>Just a moment...</title></head><body>Verify you are human</body>";
  assert.equal(EBTH.verdictFrom(EBTH.signals(challenge, 200), false)[0], "blocked");
  const odd = load(LIST_FILE, "https://www.ebth.com/");
  odd.documentElement.innerHTML = "<head><title>Service page</title></head><body>hello</body>";
  assert.equal(EBTH.verdictFrom(EBTH.signals(odd, 200), false)[0], "unexpected");
  const plain = load(LIST_FILE, "https://www.ebth.com/");
  plain.documentElement.innerHTML = "<head><title>Item ended | EBTH</title></head><body>This item has ended</body>";
  assert.equal(EBTH.verdictFrom(EBTH.signals(plain, 200), false)[0], "ok", "EBTH page without state is not a block");
});

test("browsing you do yourself: account, cart and checkout pages are never captured", { skip }, () => {
  const doc = listDoc();
  for (const p of ["/checkout", "/cart", "/account/orders", "/users/settings", "/bids/1"]) assert.equal(EBTH.pageKind(doc, p), null, p);
  assert.equal(EBTH.pageKind(doc, "/sales/90479-x"), "list");
});

const skipSale = !HAVE_SALE && "save the sale page (scrolled to the bottom) into tests/fixtures";

test("sale page: every lot card is read, with bid and end time", { skip: skipSale }, () => {
  const doc = saleDoc();
  assert.equal(EBTH.pageKind(doc, "/sales/90479-september-remarkable-finds"), "list");
  const sale = EBTH.saleMeta(doc);
  assert.deepEqual([sale.id, sale.name, sale.item_count], ["90479", "SEPTEMBER REMARKABLE FINDS", 319]);
  const cards = EBTH.cardItems(doc);
  assert.equal(cards.length, 318);
  assert.equal(new Set(cards.map((c) => c.item_id)).size, 318);
  assert.ok(cards.every((c) => /^https:\/\/www\.ebth\.com\/items\/\d+-/.test(c.url) && c.name && c.high_bid != null));
  const items = EBTH.withEndTimes(cards, sale.ends_at);
  const rolex = items.find((i) => i.item_id === LOT_ID);
  assert.equal(rolex.high_bid, 3300);
  assert.equal(rolex.ends_at, "2026-09-21T00:03:00.000Z", "7:03pm Central");
  assert.ok(items.every((i) => i.ends_at && i.ends_at_approx === true));
  const earliest = items.map((i) => i.ends_at).sort()[0];
  assert.equal(earliest, "2026-09-21T00:00:00.000Z", "first lot closes at the sale's own end time");
});

test("sale page: end times are dropped when the page's zone does not match this browser's", { skip: skipSale }, () => {
  const doc = saleDoc();
  const sale = EBTH.saleMeta(doc);
  const shifted = new Date(new Date(sale.ends_at).getTime() + 2 * 3600e3).toISOString();
  const items = EBTH.withEndTimes(EBTH.cardItems(doc), shifted);
  assert.ok(items.every((i) => i.ends_at === null));
  assert.ok(items.every((i) => i.high_bid != null), "bids are still kept");
});

test("sale payload carries no account or key material", { skip: skipSale }, () => {
  const body = JSON.stringify(salePayload(saleDoc()));
  assert.ok(!body.includes("subscribeKey") && !body.includes("sub-c-") && !body.includes("pubnub"));
});

test("card end times survive later pages of a sale, and exact times are never overwritten", { skip: skipSale }, () => {
  const doc = saleDoc();
  const sale = EBTH.saleMeta(doc);
  const later = EBTH.withEndTimes(EBTH.cardItems(doc).slice(240, 288), sale.ends_at);          // lots that close 80+ minutes after the sale end
  assert.ok(later.every((i) => i.ends_at && new Date(i.ends_at) > new Date(sale.ends_at)), "later pages keep their times");
  const mixed = [{ item_id: "1", ends_at: "2026-09-21T00:03:20.000Z", ends_at_approx: false }, { item_id: "2", end_label: "Sunday, September 20th 2026 @ 7:00pm" }];
  const out = EBTH.withEndTimes(mixed, "2026-09-20T20:00:00.000-04:00");
  assert.equal(out[0].ends_at, "2026-09-21T00:03:20.000Z");
  assert.equal(out[0].ends_at_approx, false);
  assert.equal(out[1].ends_at, "2026-09-21T00:00:00.000Z");
});

test("a share-by-email link that contains a lot's address is not the lot's link", () => {
  const share = "mailto:?subject=Look&body=https://www.ebth.com/items/111-a-lot";
  const html = (links) => `<div data-react-props='{"item":{"id":111,"name":"A lot","aasmState":"for_sale","highBidAmount":5}}'>${links}</div>`;
  // the email link comes first, as it did on the followed-items page
  let [it] = EBTH.listItems(domFrom(html(`<a href="${share}">Email</a><a href="/items/111-a-lot?utm=x#top">A lot</a>`)));
  assert.equal(it.url, "https://www.ebth.com/items/111-a-lot", "the real link, without the query or fragment");
  // only an email link: no address at all, rather than a broken one
  [it] = EBTH.listItems(domFrom(html(`<a href="${share}">Email</a>`)));
  assert.equal(it.url, null);
  // an absolute link to the site still works, and another site's link never does
  [it] = EBTH.listItems(domFrom(html(`<a href="https://www.ebth.com/items/111-a-lot">A lot</a>`)));
  assert.equal(it.url, "https://www.ebth.com/items/111-a-lot");
  [it] = EBTH.listItems(domFrom(html(`<a href="https://example.com/items/111-a-lot">Elsewhere</a>`)));
  assert.equal(it.url, null);
});
