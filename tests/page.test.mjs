import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EBTH, HAVE_FIXTURES, HAVE_SALE, LOT_FILE, LIST_FILE, LOT_ID, lotDoc, listDoc, saleDoc, salePayload, payload, sensitiveStrings, load } from "./helpers.mjs";

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

function pagedFetcher(cards, size, { failAt } = {}) {
  const pages = [];
  for (let i = 0; i < cards.length; i += size) pages.push(cards.slice(i, i + size));
  const asDoc = (cs) => new JSDOM("<div id=items_grid>" + cs.map((c) =>
    `<a class="items-grid__item item" href="${c.url}"><h4 class="item__title" title="${c.name}">${c.name}</h4>` +
    `<span class="item__bid-amount">$${c.high_bid}</span><time class="time-remaining" title="${c.end_label}">x</time></a>`).join("") + "</div>").window.document;
  const calls = [];
  return { calls, fetchPage: async (n) => { calls.push(n); if (n === failAt) return { status: 429, doc: null }; return { status: 200, doc: asDoc(pages[n - 1] || []) }; }, pages };
}

test("paging: reads every page slowly, stops on an empty page, an error, or the cap", { skip: skipSale }, async () => {
  const doc = saleDoc();
  const all = EBTH.cardItems(doc);
  const sleeps = [];
  const run = async (opts, size = 24) => {
    const f = pagedFetcher(all, size, opts);
    const first = all.slice(0, size);
    const r = await EBTH.collectPages({ firstItems: first, itemCount: 319, maxPages: opts.maxPages || 20,
      sleep: async (ms) => { sleeps.push(ms); }, delayMs: () => 5000, fetchPage: f.fetchPage });
    return { r, f };
  };
  let { r, f } = await run({});
  assert.equal(r.items.length, 318);
  assert.equal(new Set(r.items.map((i) => i.item_id)).size, 318, "no duplicates");
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.slice(0, 3), [2, 3, 4]);
  assert.equal(r.pages, 15, "14 real pages plus the empty one that ends the loop");
  assert.ok(sleeps.length === 14 && sleeps.every((ms) => ms === 5000), "waits before every extra page");

  ({ r } = await run({ failAt: 4 }));
  assert.equal(r.status, 429);
  assert.equal(r.items.length, 72, "keeps what it had, stops at the error");

  ({ r, f } = await run({ maxPages: 5 }));
  assert.equal(r.pages, 5);
  assert.equal(f.calls.length, 4);
  assert.equal(r.items.length, 120);
});

test("sale payload carries no account or key material", { skip: skipSale }, () => {
  const body = JSON.stringify(salePayload(saleDoc()));
  assert.ok(!body.includes("subscribeKey") && !body.includes("sub-c-") && !body.includes("pubnub"));
});

test("paging: if the plain request returns nothing new, another request style is tried and then kept", { skip: skipSale }, async () => {
  const all = EBTH.cardItems(saleDoc());
  const size = 48;
  const f = pagedFetcher(all, size);
  const empty = new JSDOM("<div id=items_grid></div>").window.document;
  const styles = [];
  const r = await EBTH.collectPages({
    firstItems: all.slice(0, size), itemCount: 319, maxPages: 20, variants: [{}, { x: 1 }, { x: 2 }],
    sleep: async () => {}, delayMs: () => 0,
    fetchPage: async (n, v) => { styles.push([n, JSON.stringify(v)]); return v.x === 2 ? f.fetchPage(n) : { status: 200, doc: empty, info: "html 3kB items=0" }; }
  });
  assert.equal(r.items.length, 318);
  assert.equal(r.variant, 2);
  assert.deepEqual(styles.slice(0, 3), [[2, "{}"], [2, '{"x":1}'], [2, '{"x":2}']], "page 2 tried with each style in order");
  assert.ok(styles.slice(3).every(([, v]) => v === '{"x":2}'), "later pages reuse the style that worked");
  assert.match(r.diag, /v0:200 html 3kB items=0 new=0 \| v1:200/);
});

test("paging: when no request style returns lots, it stops after trying each once and says so", { skip: skipSale }, async () => {
  const all = EBTH.cardItems(saleDoc());
  const empty = new JSDOM("<div></div>").window.document;
  const calls = [];
  const r = await EBTH.collectPages({
    firstItems: all.slice(0, 48), itemCount: 319, maxPages: 20, variants: [{}, { x: 1 }, { x: 2 }],
    sleep: async () => {}, delayMs: () => 0, fetchPage: async (n, v) => { calls.push(n); return { status: 200, doc: empty, info: "x" }; }
  });
  assert.equal(r.items.length, 48);
  assert.equal(calls.length, 3, "three attempts at page 2, nothing more");
  assert.equal(r.pages, 4);
  assert.ok(r.diag.includes("v2:"));
});

test("script or JSON responses that embed the card markup are unescaped", { skip: skipSale }, () => {
  const cards = EBTH.cardItems(saleDoc()).slice(0, 2);
  const html = cards.map((c) => `<a class="items-grid__item item" href="${c.url}"><h4 class="item__title" title="${c.name}">${c.name}</h4><span class="item__bid-amount">$${c.high_bid}</span></a>`).join("");
  const asJs = "$(\"#items_grid\").append(" + JSON.stringify(html).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + ");";
  const doc = new JSDOM(EBTH.htmlFromPossiblyEscaped(asJs)).window.document;
  assert.deepEqual(EBTH.cardItems(doc).map((c) => c.item_id), cards.map((c) => c.item_id));
  const plain = "<a class=\"items-grid__item item\" href=\"https://www.ebth.com/items/1-x\"></a>";
  assert.equal(EBTH.htmlFromPossiblyEscaped(plain), plain, "normal HTML is left alone");
});

const parseHtml = (h) => new JSDOM(h).window.document;

test("JSON responses: item arrays are found wherever they sit and mapped like the site's own item state", () => {
  const body = { meta: { page: 2 }, data: { results: [
    { id: 14568274, name: "Rolex", aasmState: "for_sale", highBidAmount: 3300, minimumBidAmount: 3350, bidsCount: 40,
      bidderIds: [1, 2, 2], saleEndsAt: "2026-09-20T20:03:20.000-04:00", path: "/items/14568274-rolex" },
    { id: "14600826", title: "Postal covers", currentBid: "3.0", saleEndsAt: "2026-09-20T20:04:20.000-04:00" }] }, other: [{ id: 1 }] };
  const r = EBTH.parsePageResponse(JSON.stringify(body), parseHtml);
  assert.equal(r.format, "json");
  assert.equal(r.items.length, 2);
  const [a, b] = r.items;
  assert.deepEqual([a.item_id, a.high_bid, a.bids_count, a.unique_bidders, a.state], ["14568274", 3300, 40, 2, "for_sale"]);
  assert.equal(a.ends_at, "2026-09-20T20:03:20.000-04:00");
  assert.equal(a.ends_at_approx, false);
  assert.equal(a.url, "https://www.ebth.com/items/14568274-rolex");
  assert.deepEqual([b.item_id, b.name, b.high_bid], ["14600826", "Postal covers", "3.0"]);
  assert.equal(EBTH.parsePageResponse("{\"results\":[]}", parseHtml).items.length, 0);
});

test("responses that are HTML, or a script embedding HTML, still work; exact times survive withEndTimes", { skip: skipSale }, () => {
  const cards = EBTH.cardItems(saleDoc()).slice(0, 3);
  const html = cards.map((c) => `<a class="items-grid__item item" href="${c.url}"><h4 class="item__title" title="${c.name}">${c.name}</h4><span class="item__bid-amount">$${c.high_bid}</span></a>`).join("");
  assert.equal(EBTH.parsePageResponse(html, parseHtml).items.length, 3);
  const js = "$(x).append(" + JSON.stringify(html).replace(/</g, "\\u003c") + ")";
  assert.equal(EBTH.parsePageResponse(js, parseHtml).items.length, 3);
  const mixed = [{ item_id: "1", ends_at: "2026-09-21T00:03:20.000Z", ends_at_approx: false }, { item_id: "2", end_label: "Sunday, September 20th 2026 @ 7:00pm" }];
  const out = EBTH.withEndTimes(mixed, "2026-09-20T20:00:00.000-04:00");
  assert.equal(out[0].ends_at, "2026-09-21T00:03:20.000Z");
  assert.equal(out[0].ends_at_approx, false);
  assert.equal(out[1].ends_at, "2026-09-21T00:00:00.000Z");
});

test("the page's own list request is found in the browser's resource list", () => {
  const entries = [
    { name: "https://www.ebth.com/assets/app.js", initiatorType: "script" },
    { name: "https://www.ebth.com/api/items?sale_id=90479&page=1&sort=ending", initiatorType: "fetch" },
    { name: "https://www.ebth.com/collect/segment", initiatorType: "xmlhttprequest" },
    { name: "https://cdn.other.com/x", initiatorType: "fetch" },
    { name: "https://www.ebth.com/api/user/followed", initiatorType: "xmlhttprequest" },
    { name: "https://www.ebth.com/img/a.png", initiatorType: "fetch" },
  ];
  const c = EBTH.listRequestCandidates(entries);
  assert.equal(c[0], "https://www.ebth.com/api/items?sale_id=90479&page=1&sort=ending", "most list-like first");
  assert.ok(!c.some((u) => /segment|assets|png|other/.test(u)));
  assert.equal(EBTH.withPage(c[0], 3), "https://www.ebth.com/api/items?sale_id=90479&page=3&sort=ending");
  assert.equal(EBTH.withPage("https://www.ebth.com/api/items?sale_id=1", 2), "https://www.ebth.com/api/items?sale_id=1&page=2");
  assert.equal(EBTH.withPage("https://www.ebth.com/x/{page}/items", 4), "https://www.ebth.com/x/4/items");
});

test("paging with parsed items: request styles are labelled in the diagnostics", async () => {
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ item_id: String(from + i), name: "x", url: null, high_bid: 1, end_label: null }));
  const first = mk(1, 48), pagesData = { 2: mk(49, 48), 3: mk(97, 3) };
  const seenStyles = [];
  const r = await EBTH.collectPages({
    firstItems: first, itemCount: 99, maxPages: 20, variants: [{ label: "c0", url: "a" }, { label: "c0j", url: "a" }],
    sleep: async () => {}, delayMs: () => 0,
    fetchPage: async (n, v) => { seenStyles.push(v.label); return v.label === "c0j" ? { status: 200, items: pagesData[n] || [], info: "json 9kB json=48" } : { status: 200, items: [], info: "html 2kB html=0 s=<empty>" }; }
  });
  assert.equal(r.items.length, 99);
  assert.equal(r.variant, 1);
  assert.deepEqual(seenStyles, ["c0", "c0j", "c0j"]);
  assert.match(r.diag, /^c0:200 html 2kB html=0 s=<empty> new=0 \| c0j:200 json 9kB json=48 new=48 \| c0j:200/);
});
