import test from "node:test";
import assert from "node:assert/strict";
import { EBTH, HAVE_FIXTURES, LOT_FILE, LIST_FILE, LOT_ID, lotDoc, listDoc, payload, sensitiveStrings, load } from "./helpers.mjs";

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
