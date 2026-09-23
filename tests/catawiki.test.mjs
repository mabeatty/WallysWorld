import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION, HAVE_CATAWIKI_FIXTURES, Catawiki, catawikiListDoc, catawikiLotDoc } from "./helpers.mjs";

const skip = !HAVE_CATAWIKI_FIXTURES && "save a Catawiki auction-list page and a lot page into tests/fixtures_catawiki";

// ---------------------------------------------------------------- parser unit tests (no DB)

test("parseAuctionList reads the auction and every lot's identity/condition from __NEXT_DATA__, with no bid data anywhere", { skip }, () => {
  const { auction, lots } = Catawiki.parseAuctionList(catawikiListDoc());
  assert.equal(auction.id, "1270330");
  assert.equal(auction.name, "Italian Stamp Auction (FilArte) · No Reserve");
  assert.equal(auction.category, "Italian Stamps");
  assert.equal(auction.curator, "Manuela Sorani");
  assert.equal(auction.ends_at, "2026-09-22T18:00:00Z");
  assert.ok(lots.length > 0);
  assert.ok(lots.every((l) => l.auction_id === "1270330"));
  assert.ok(lots.every((l) => !("high_bid" in l)), "a list page carries no bid data for any lot -- see parseAuctionList's own comment");
});

test("parseLotDetail reads live bid, bid-history length, reserve, shipping, seller and the new verified/live_format/catalog_number fields from one JSON parse", { skip }, () => {
  const lot = Catawiki.parseLotDetail(catawikiLotDoc());
  assert.equal(lot.item_id, "106581719");
  assert.equal(lot.auction_id, "1270330");
  assert.equal(lot.high_bid, 38);
  assert.equal(lot.bids_count, 10);
  assert.equal(lot.is_starting_bid, false);
  assert.equal(lot.no_reserve, true);
  assert.equal(lot.reserve_met, null);
  assert.equal(lot.watchers_count, 12);
  assert.equal(lot.shipping_eur, 12);
  assert.equal(lot.live_format, false, "this lot's auction.liveStream is null");
  assert.equal(lot.catalog_number, null, "no catalog-number-shaped specification on this real lot yet");
  assert.equal(lot.seller.name, "FILARTE");
  assert.equal(lot.seller.country, "Italy");
  assert.equal(lot.seller.verified, true, "sellerInfo.badges includes {name:\"verified\"}");
  assert.equal(lot.seller.is_pro, true);
  assert.equal(lot.seller.is_top, true);
  assert.equal(lot.seller.score, 100);
  assert.equal(lot.seller.objects_sold, 3162);
});

test("auctionFromPage returns the identical auction descriptor whether read off a list page or a lot page", { skip }, () => {
  assert.deepEqual(Catawiki.auctionFromPage(catawikiListDoc()), Catawiki.auctionFromPage(catawikiLotDoc()));
});

test("toIngestLot maps a detail-parsed lot onto catawiki_ingest_page's exact flat column names", { skip }, () => {
  const row = Catawiki.toIngestLot(Catawiki.parseLotDetail(catawikiLotDoc()));
  assert.equal(row.item_id, "106581719");
  assert.equal(row.high_bid, 38);
  assert.equal(row.is_starting_bid, false);
  assert.equal(row.seller_name, "FILARTE");
  assert.equal(row.seller_location, "Italy");
  assert.equal(row.seller_verified, true);
  assert.equal(row.seller_feedback_pct, 100);
  assert.equal(row.seller_objects_sold, 3162);
});

test("toIngestLot maps a bare list-item onto the same column names, with every bid/seller-only field null", { skip }, () => {
  const { lots } = Catawiki.parseAuctionList(catawikiListDoc());
  const row = Catawiki.toIngestLot(lots[0]);
  assert.equal(row.item_id, lots[0].item_id);
  assert.equal(row.condition, lots[0].condition);
  assert.equal(row.high_bid, null);
  assert.equal(row.is_starting_bid, null);
  assert.equal(row.seller_name, null);
  assert.equal(row.category, null, "list items carry no per-lot category; the RPC falls back to the auction's own");
});

// ---------------------------------------------------------- catawiki_ingest_page DB-level tests

async function fresh() {
  const db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await db.exec(MIGRATION);
  const token = (await db.query("select value #>> '{}' t from settings where key='ingest_token'")).rows[0].t;
  const dash = (await db.query("select value #>> '{}' t from settings where key='dashboard_token'")).rows[0].t;
  return {
    db, token, dash,
    ingest: async (p) => (await db.query("select catawiki_ingest_page($1,$2::jsonb) r", [token, JSON.stringify(p)])).rows[0].r,
    one: async (sql, params) => (await db.query(sql, params)).rows[0],
    set: async (k, v) => db.query("update settings set value=$2::jsonb where key=$1", [k, JSON.stringify(v)]),
  };
}

test("a list-job re-crawl does not wipe out high_bid/is_starting_bid captured by an earlier detail job (regression for the 0024 fix)", { skip }, async () => {
  const t = await fresh();
  const lot = Catawiki.parseLotDetail(catawikiLotDoc());
  const auction = Catawiki.auctionFromPage(catawikiLotDoc());

  await t.ingest({ kind: "detail", verdict: "ok", auction, lots: [Catawiki.toIngestLot(lot)] });
  let row = await t.one("select high_bid, is_starting_bid from catawiki_lots where item_id=$1", [lot.item_id]);
  assert.equal(Number(row.high_bid), 38);
  assert.equal(row.is_starting_bid, false);

  // The same lot turns up again on a plain list-job crawl of its auction: a bare identity row,
  // genuinely with no bid fields at all -- exactly what parseAuctionList ever produces.
  const listItem = { item_id: lot.item_id, name: lot.name, url: lot.url, condition: lot.condition, auction_id: lot.auction_id };
  const listRow = Catawiki.toIngestLot(listItem);
  assert.equal(listRow.high_bid, null, "sanity check: a list-item genuinely carries no bid data");
  assert.equal(listRow.is_starting_bid, null);

  await t.ingest({ kind: "list", verdict: "ok", auction, lots: [listRow] });
  row = await t.one("select high_bid, is_starting_bid from catawiki_lots where item_id=$1", [lot.item_id]);
  assert.equal(Number(row.high_bid), 38, "high_bid must survive a list-job re-crawl -- this was the exact 0024 bug");
  assert.equal(row.is_starting_bid, false, "is_starting_bid must survive a list-job re-crawl -- this was the exact 0024 bug");
});

test("a non-ok verdict is logged to fetches but never writes an auction or lot row", { skip }, async () => {
  const t = await fresh();
  const r = await t.ingest({ kind: "detail", verdict: "blocked", note: "captcha page", item_id: "999999", auction: null, lots: [] });
  assert.equal(r.n_items, 0);
  assert.equal(Number((await t.one("select count(*) c from catawiki_lots")).c), 0);
  const f = await t.one("select verdict, note, platform from fetches where item_id=$1", ["999999"]);
  assert.equal(f.verdict, "blocked");
  assert.equal(f.platform, "catawiki");
});

test("a list-job ingest carrying seed_name bumps that seed's last_job_at", { skip }, async () => {
  const t = await fresh();
  await t.db.query("insert into catawiki_seeds (name, url) values ($1, $2)", ["italian-stamps", "https://www.catawiki.com/en/a/1270330"]);
  assert.equal((await t.one("select last_job_at from catawiki_seeds where name=$1", ["italian-stamps"])).last_job_at, null);
  await t.ingest({ kind: "list", verdict: "ok", seed_name: "italian-stamps", auction: Catawiki.auctionFromPage(catawikiListDoc()), lots: [] });
  assert.ok((await t.one("select last_job_at from catawiki_seeds where name=$1", ["italian-stamps"])).last_job_at);
});

test("catawiki_suggested_max_bid and catawiki_case_json: margin, buyer protection fee, and this lot's real shipping all come off, mirroring EBTH's premium/margin/shipping treatment", async () => {
  const t = await fresh();
  const n = (x) => Number(x);
  const max = async (v, ship) => {
    const m = (await t.db.query("select catawiki_suggested_max_bid($1, $2) m", [v, ship])).rows[0].m;
    return m == null ? null : Number(m);
  };
  // defaults: 9% + EUR3 buyer protection fee, 15% margin
  assert.equal(await max(1000, 50), Math.floor((1000 * 0.85 - 3 - 50) / 1.09), "(value x 85%) less the EUR3 flat fee and this lot's own shipping, / 1.09");
  assert.equal(await max(1000, 0), Math.floor((1000 * 0.85 - 3) / 1.09), "no shipping on this particular lot: nothing extra comes off");
  assert.equal(await max(null, 50), null);

  const cj = async (v, bid, ship) => (await t.db.query("select catawiki_case_json($1, $2, $3) c", [v, bid, ship])).rows[0].c;
  const c = await cj(1000, 200, 50);
  assert.equal(n(c.fee), 21, "9% of the EUR200 bid plus the EUR3 flat fee");
  assert.equal(n(c.shipping), 50, "this lot's own real shipping cost, not an assumption");
  assert.equal(n(c.max), Math.floor((1000 * 0.85 - 3 - 50) / 1.09));
  const cost = 200 * 1.09 + 3 + 50;
  assert.ok(Math.abs(n(c.profit) - (1000 - cost)) < 0.01, "profit nets out the buyer protection fee and shipping, not just the bid");
  assert.ok(Math.abs(n(c.roi) - (1000 - cost) / cost) < 1e-9);
  assert.equal((await cj(1000, 0, 50)).roi, null, "no ROI while the bid is EUR0");
  assert.equal(await cj(null, 100, 50), null, "no value, no case");
});

test("dash_catawiki_bid_math / dash_set_catawiki_bid_math: margin is settable, the buyer protection fee is not", async () => {
  const t = await fresh();
  const n = (x) => Number(x);
  const bm = (await t.db.query("select dash_catawiki_bid_math($1) r", [t.dash])).rows[0].r;
  assert.deepEqual([n(bm.margin), n(bm.buyer_protection_pct), n(bm.buyer_protection_flat)], [0.15, 0.09, 3]);
  await t.db.query("select dash_set_catawiki_bid_math($1, 0.25)", [t.dash]);
  assert.equal(n((await t.db.query("select dash_catawiki_bid_math($1) r", [t.dash])).rows[0].r.margin), 0.25);
  await assert.rejects(() => t.db.query("select dash_set_catawiki_bid_math($1, 0.95)", [t.dash]), /margin must be between/);
  await assert.rejects(() => t.db.query("select dash_set_catawiki_bid_math($1, 0.15)", [t.token]), /invalid token/);
});

test("dash_catawiki_lot carries worst/base/best cases built from our own estimate and this lot's real shipping, alongside the unchanged Catawiki-estimate gap", { skip }, async () => {
  const t = await fresh();
  const lot = Catawiki.parseLotDetail(catawikiLotDoc());
  const auction = Catawiki.auctionFromPage(catawikiLotDoc());
  await t.ingest({ kind: "detail", verdict: "ok", auction, lots: [Catawiki.toIngestLot(lot)] });
  await t.db.query("select dash_catawiki_set_estimate($1,$2,$3,$4,$5,$6,$7,$8)", [t.dash, lot.item_id, 30, 50, null, "medium", "n", null]);
  const r = (await t.db.query("select dash_catawiki_lot($1, $2) r", [t.dash, lot.item_id])).rows[0].r;
  const n = (x) => Number(x);
  assert.equal(n(r.estimate.cases.worst.value), 30);
  assert.equal(n(r.estimate.cases.best.value), 50);
  assert.equal(n(r.estimate.cases.base.value), 40);
  const bid = n(r.lot.high_bid ?? 0), ship = n(r.lot.shipping_eur ?? 0);
  const cost = bid * 1.09 + 3 + ship;
  assert.ok(Math.abs(n(r.estimate.cases.worst.profit) - (30 - cost)) < 0.01, "worst-case profit nets out this lot's own shipping and the buyer protection fee");
  assert.equal(n(r.bid_math.margin), 0.15);
});

test("dash_catawiki_search: worst/base/best sort and match catawiki_case_json's formula exactly, including its own inline duplicate of profit/roi/max", { skip }, async () => {
  const t = await fresh();
  const lot = Catawiki.parseLotDetail(catawikiLotDoc());
  const auction = Catawiki.auctionFromPage(catawikiLotDoc());
  await t.ingest({ kind: "detail", verdict: "ok", auction, lots: [Catawiki.toIngestLot(lot)] });
  await t.db.query("select dash_catawiki_set_estimate($1,$2,$3,$4,$5,$6,$7,$8)", [t.dash, lot.item_id, 30, 50, null, "medium", "n", null]);
  const search = async (obj) => (await t.db.query("select dash_catawiki_search($1,$2::jsonb) r", [t.dash, JSON.stringify(obj)])).rows[0].r;
  const rows = (await search({ status: "all", estimate: "with", limit: 10 })).rows;
  const row = rows.find((r) => r.item_id === lot.item_id);
  const n = (x) => Number(x);
  assert.deepEqual([n(row.v_worst), n(row.v_base), n(row.v_best)], [30, 40, 50]);

  const canonical = await t.db.query("select catawiki_case_json($1, $2, $3) c", [row.v_worst, row.high_bid, row.shipping_eur]);
  const c = canonical.rows[0].c;
  assert.equal(n(row.max_worst), n(c.max), "dash_search's max_worst must match catawiki_case_json's max exactly");
  assert.ok(Math.abs(n(row.profit_worst) - n(c.profit)) < 0.01, "dash_search's profit_worst must match catawiki_case_json's profit");
  if (Number(row.high_bid ?? 0) > 0) {
    assert.ok(Math.abs(n(row.roi_worst) - n(c.roi)) < 1e-9, "dash_search's roi_worst must match too");
  } else {
    assert.equal(row.roi_worst, null, "no ROI while the bid is EUR0");
  }
  assert.equal(n(row.gap_worst), 30 - Number(row.high_bid ?? 0));

  // sorting by the new keys
  const ids = async (sort, dir) => (await search({ status: "all", estimate: "with", limit: 10, sort, dir })).rows.map((r) => r.item_id);
  for (const key of ["worst", "base", "best", "worst_gap", "base_gap", "best_gap"]) {
    assert.ok((await ids(key, "desc")).length > 0, `${key} sort returns rows`);
  }

  // gap_to_catawiki_estimate is completely unaffected by any of this
  const before = (await search({ status: "all", limit: 10 })).rows.find((r) => r.item_id === lot.item_id);
  assert.equal(before.gap_to_catawiki_estimate, row.gap_to_catawiki_estimate);
});
