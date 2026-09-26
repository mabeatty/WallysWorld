import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION } from "./helpers.mjs";

async function fresh() {
  const db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await db.exec(MIGRATION);
  const token = (await db.query("select value #>> '{}' t from settings where key='dashboard_token'")).rows[0].t;
  const set = async (k, v) => db.query("update settings set value=$2::jsonb where key=$1", [k, JSON.stringify(v)]);
  await set("min_gap_seconds", 0);
  await set("quiet_hours", null);
  await set("assumed_shipping", 0); // EBTH cost math stays simple for these tests

  let seq = 1;
  const addEbth = async ({ item_id, name, category, high_bid = 0, ends_at = "2099-01-01T00:00:00Z", bids_count = 0 }) => {
    item_id = item_id || "e" + seq++;
    await db.query("insert into lots (item_id, url, name, category, ends_at) values ($1,$2,$3,$4,$5)",
      [item_id, "https://www.ebth.com/items/" + item_id, name, category, ends_at]);
    await db.query("insert into snapshots (item_id, high_bid, bids_count, ends_at) values ($1,$2,$3,$4)",
      [item_id, high_bid, bids_count, ends_at]);
    return item_id;
  };
  const addCatawiki = async ({ item_id, name, category = "Stamps", high_bid = 0, shipping_eur = 0, ends_at = "2099-01-01T00:00:00Z", bids_count = 0 }) => {
    item_id = item_id || "c" + seq++;
    await db.query(
      `insert into catawiki_lots (item_id, name, url, category, high_bid, shipping_eur, ends_at, bids_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [item_id, name, "https://www.catawiki.com/en/l/" + item_id, category, high_bid, shipping_eur, ends_at, bids_count]);
    return item_id;
  };
  const setEbthEstimate = (id, low, high, confidence = "medium") =>
    db.query("select dash_set_estimate($1,$2,$3,$4,null,$5,'t','t')", [token, id, low, high, confidence]);
  const setCatawikiEstimate = (id, low, high, confidence = "medium") =>
    db.query("select dash_catawiki_set_estimate($1,$2,$3,$4,null,$5,'t','t')", [token, id, low, high, confidence]);
  const search = async (p = {}) => (await db.query("select dash_combined_search($1,$2::jsonb) r", [token, JSON.stringify(p)])).rows[0].r;
  const categories = async () => (await db.query("select dash_combined_categories($1) r", [token])).rows[0].r;
  const unifiedCategory = async (cat, name = null) =>
    (await db.query("select unified_category($1,$2) c", [cat, name])).rows[0].c;

  return { db, token, set, addEbth, addCatawiki, setEbthEstimate, setCatawikiEstimate, search, categories, unifiedCategory };
}

test("unified_category maps every raw EBTH category to its own bucket, merges the jewelry subcategories, and splits trading cards out of collectibles by name", async () => {
  const t = await fresh();
  // categories that keep their own name unchanged
  for (const cat of [
    "Art", "Furniture", "Decorative objects", "Ceramics and glass", "Handbags and fashion",
    "Sterling and silver", "Books, maps and ephemera", "Rugs and textiles", "Lighting",
    "Antiquities and natural history", "Native American, tribal and folk art",
    "Cameras, music and electronics", "Tools, sporting and military", "Asian art",
    "Mixed lots", "Kitchen and household", "Watches", "Stamps",
  ]) {
    assert.equal(await t.unifiedCategory(cat), cat, `${cat} should pass through unchanged`);
  }
  assert.equal(await t.unifiedCategory("Coins and currency"), "Coins");
  // the six jewelry-adjacent categories all fold into one bucket
  for (const cat of ["Jewelry, gold", "Jewelry, silver", "Jewelry, other", "Jewelry, Southwest", "Lab-grown stones and jewelry", "Loose stones"]) {
    assert.equal(await t.unifiedCategory(cat), "Jewelry", `${cat} should fold into Jewelry`);
  }
  // Collectibles and memorabilia: trading-card-shaped names get split out, everything else doesn't
  assert.equal(await t.unifiedCategory("Collectibles and memorabilia", "Four Storage Boxes of 1980 Topps Baseball Cards"), "Trading cards");
  assert.equal(await t.unifiedCategory("Collectibles and memorabilia", "Magic: The Gathering Trading Cards Including Creatures"), "Trading cards");
  assert.equal(await t.unifiedCategory("Collectibles and memorabilia", "Pokémon Card Collection Featuring Holos"), "Trading cards");
  assert.equal(await t.unifiedCategory("Collectibles and memorabilia", "Nine Bo Nix Denver Broncos Rookie Football Cards"), "Trading cards");
  assert.equal(await t.unifiedCategory("Collectibles and memorabilia", "Montblanc Meisterstruck #149 Fountain Pen"), "Collectibles and memorabilia");
  assert.equal(await t.unifiedCategory("Collectibles and memorabilia", "Walt Disney Signed Mickey Mouse Matchbook"), "Collectibles and memorabilia");
  // unrecognized or missing category falls into Other rather than being dropped
  assert.equal(await t.unifiedCategory("Other"), "Other");
  assert.equal(await t.unifiedCategory(null), "Other");
  assert.equal(await t.unifiedCategory("Something Brand New Nobody Mapped Yet"), "Other");
});

test("unified_category maps Catawiki's own stamp category wording (not just the literal string 'Stamps') to Stamps -- regression for a real production mismatch", async () => {
  const t = await fresh();
  // Catawiki's real raw category value is "World Stamps", not "Stamps" -- confirmed against
  // production data, where it was silently falling into "Other" before this fix.
  assert.equal(await t.unifiedCategory("World Stamps"), "Stamps");
  assert.equal(await t.unifiedCategory("European Stamps"), "Stamps");
});

test("dash_combined_categories aggregates open/total counts across both platforms into the unified buckets", async () => {
  const t = await fresh();
  await t.addEbth({ name: "A gold ring", category: "Jewelry, gold", ends_at: "2099-01-01T00:00:00Z" });
  await t.addEbth({ name: "A silver bangle", category: "Jewelry, silver", ends_at: "2000-01-01T00:00:00Z" }); // closed
  await t.addCatawiki({ name: "A rare stamp", category: "Stamps", ends_at: "2099-01-01T00:00:00Z" });
  const cats = await t.categories();
  const jewelry = cats.find((c) => c.category === "Jewelry");
  assert.equal(jewelry.total, 2, "both jewelry subcategories count toward one Jewelry bucket");
  assert.equal(jewelry.open, 1, "only the still-open one counts as open");
  const stamps = cats.find((c) => c.category === "Stamps");
  assert.equal(stamps.total, 1);
  assert.equal(stamps.open, 1);
});

test("dash_combined_search returns rows from both platforms together, converts Catawiki's EUR figures to USD, and sorts by ROI rather than raw currency", async () => {
  const t = await fresh();
  await t.set("eur_usd_rate", 2); // a deliberately round, easy-to-check rate for this test
  await t.set("buyer_premium", 0); // isolate the ROI comparison from EBTH's premium/fee mechanics
  await t.set("target_margin", 0);

  // EBTH lot: bid $100, estimate $100-$100 (worst case value = $100) -> modest ROI
  const e1 = await t.addEbth({ name: "EBTH modest lot", category: "Coins and currency", high_bid: 100 });
  await t.setEbthEstimate(e1, 100, 100);

  // Catawiki lot: bid EUR100, estimate EUR300 (worst case) -> a much bigger ROI, but in EUR
  const c1 = await t.addCatawiki({ name: "Catawiki big gap lot", category: "Stamps", high_bid: 100, shipping_eur: 0 });
  await t.setCatawikiEstimate(c1, 300, 300);

  const r = await t.search({ status: "all", sort: "worst_roi", dir: "desc", limit: 10 });
  assert.equal(r.rows.length, 2);
  assert.equal(r.fx_rate, 2);

  const catawikiRow = r.rows.find((row) => row.source === "catawiki");
  const ebthRow = r.rows.find((row) => row.source === "ebth");
  assert.equal(catawikiRow.currency, "EUR");
  assert.equal(Number(catawikiRow.bid_native), 100);
  assert.equal(Number(catawikiRow.bid_usd), 200, "EUR100 converted at rate 2 is USD200");
  assert.equal(Number(catawikiRow.v_worst_usd), 600, "EUR300 worst-case value converted at rate 2 is USD600");

  // the Catawiki lot has the much bigger ROI (200% vs 0%), so it must rank first even though
  // its absolute converted profit or bid size isn't what's being compared
  assert.equal(r.rows[0].source, "catawiki", "higher-ROI row sorts first regardless of currency");
  assert.ok(Number(catawikiRow.roi_worst) > Number(ebthRow.roi_worst));
});

test("dash_combined_search category filter matches the unified category, not the raw platform category", async () => {
  const t = await fresh();
  const gold = await t.addEbth({ name: "Gold bracelet", category: "Jewelry, gold" });
  const silver = await t.addEbth({ name: "Silver cuff", category: "Jewelry, silver" });
  const watch = await t.addEbth({ name: "A watch", category: "Watches" });
  const r = await t.search({ status: "all", category: "Jewelry", limit: 10 });
  const ids = r.rows.map((row) => row.item_id).sort();
  assert.deepEqual(ids, [gold, silver].sort());
  assert.ok(!ids.includes(watch));
});

test("dash_combined_search status and estimate filters behave as they do in the single-platform search", async () => {
  const t = await fresh();
  const openNoEst = await t.addEbth({ name: "Open, unvalued", category: "Art", ends_at: "2099-01-01T00:00:00Z" });
  const openWithEst = await t.addEbth({ name: "Open, valued", category: "Art", ends_at: "2099-01-01T00:00:00Z" });
  await t.setEbthEstimate(openWithEst, 10, 20);
  const closed = await t.addEbth({ name: "Closed lot", category: "Art", ends_at: "2000-01-01T00:00:00Z" });

  const open = await t.search({ status: "open", limit: 10 });
  assert.deepEqual(open.rows.map((r) => r.item_id).sort(), [openNoEst, openWithEst].sort());

  const withEst = await t.search({ status: "all", estimate: "with", limit: 10 });
  assert.deepEqual(withEst.rows.map((r) => r.item_id), [openWithEst]);

  const all = await t.search({ status: "all", limit: 10 });
  assert.deepEqual(all.rows.map((r) => r.item_id).sort(), [openNoEst, openWithEst, closed].sort());
});

test("dash_combined_search's min_roi filter narrows the list independently of sort -- sorting by time left still only returns lots clearing the ROI floor", async () => {
  const t = await fresh();
  await t.set("buyer_premium", 0);
  await t.set("assumed_shipping", 0);
  // resale_fee is a real tiered fee (15% under $1,000, independent of target_margin), so these
  // worst-case ROIs are: flat (100-15-100)/100 = -15%; modest (200-30-100)/100 = 70%;
  // strong (400-60-100)/100 = 240%.
  const flat = await t.addEbth({ name: "Flat lot", category: "Art", high_bid: 100, ends_at: "2099-01-03T00:00:00Z" });
  await t.setEbthEstimate(flat, 100, 100);
  const modest = await t.addEbth({ name: "Modest lot", category: "Art", high_bid: 100, ends_at: "2099-01-02T00:00:00Z" });
  await t.setEbthEstimate(modest, 200, 200);
  const strong = await t.addEbth({ name: "Strong lot", category: "Art", high_bid: 100, ends_at: "2099-01-01T00:00:00Z" });
  await t.setEbthEstimate(strong, 400, 400);

  // sorting by time left (soonest first) with a 100% minimum ROI: only the strong lot (240%)
  // clears the bar, and the filter must apply even though the sort key is "ends", not an ROI key
  const r = await t.search({ status: "all", sort: "ends", dir: "asc", min_roi: "100", limit: 10 });
  assert.deepEqual(r.rows.map((row) => row.item_id), [strong]);

  // a lower floor (50%) lets the 70% lot back in too, still ordered by time left
  const r2 = await t.search({ status: "all", sort: "ends", dir: "asc", min_roi: "50", limit: 10 });
  assert.deepEqual(r2.rows.map((row) => row.item_id), [strong, modest]);

  // no min_roi at all returns everything, unfiltered
  const r3 = await t.search({ status: "all", sort: "ends", dir: "asc", limit: 10 });
  assert.deepEqual(r3.rows.map((row) => row.item_id), [strong, modest, flat]);
});
