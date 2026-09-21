import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION, HAVE_FIXTURES, HAVE_SALE, SALE_URL, LOT_ID, EBTH, lotDoc, listDoc, saleDoc, salePayload, payload } from "./helpers.mjs";

const skip = !HAVE_FIXTURES && "save a lot page (filename contains Rolex) and the Followed Items page into tests/fixtures";
const LOT_PATH = "/items/14568274-1970-rolex";
const LIST_PATH = "/users/followed_items";
const T0 = "2026-09-20T07:00:00Z";                 // ~17h before the Rolex closes at 20:03:20 ET
const at = (base, mins) => new Date(new Date(base).getTime() + mins * 60000).toISOString();

async function fresh(settings = {}) {
  const db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await db.exec(MIGRATION);
  const token = (await db.query("select value #>> '{}' t from settings where key='ingest_token'")).rows[0].t;
  const set = async (k, v) => db.query("update settings set value=$2::jsonb where key=$1", [k, JSON.stringify(v)]);
  await set("min_gap_seconds", 0); await set("timezone", "UTC"); await set("quiet_hours", null);
  for (const [k, v] of Object.entries(settings)) await set(k, v);
  const api = {
    db, token, set,
    ingest: async (p, now) => (await db.query("select ingest_page($1,$2::jsonb,$3::timestamptz) r", [token, JSON.stringify(p), now])).rows[0].r,
    next: async (now) => (await db.query("select next_job($1,$2::timestamptz) r", [token, now])).rows[0].r,
    one: async (sql, params) => (await db.query(sql, params)).rows[0],
    count: async (t, where = "true") => Number((await db.query(`select count(*) c from ${t} where ${where}`)).rows[0].c),
  };
  return api;
}
const listJob = { kind: "list", url: "https://www.ebth.com/users/followed_items", item_id: null, requires_login: true };
const listPayload = (job = listJob) => payload(listDoc(), LIST_PATH, { job, requiresLogin: true });
const lotPayload = (job, mutate) => payload(lotDoc(), LOT_PATH, { job, mutate });

test("list capture stores lots and snapshots; soonest-closing lot gets its detail page first", { skip }, async () => {
  const t = await fresh();
  const r = await t.ingest(listPayload(), T0);
  assert.equal(r.n_items, 20);
  assert.equal(await t.count("lots"), 20);
  assert.equal(await t.count("snapshots"), 20);
  const j = await t.next(at(T0, 1));
  assert.equal(j.kind, "detail");
  assert.equal(j.item_id, LOT_ID);
  await t.ingest(lotPayload({ kind: "detail", url: j.url, item_id: j.item_id }), at(T0, 1));
  const d = await t.one("select data->'specs'->>'Brand' b from lot_details where item_id=$1", [LOT_ID]);
  assert.equal(d.b, "Rolex");
  assert.equal((await t.one("select detail_done from lots where item_id=$1", [LOT_ID])).detail_done, true);
  const j2 = await t.next(at(T0, 2));
  assert.equal(j2.kind, "detail");
  assert.notEqual(j2.item_id, LOT_ID);
  await t.ingest({ kind: "lot", url: j2.url, verdict: "gone", note: "http 404", items: [], lot: null,
                   job: { kind: "detail", url: j2.url, item_id: j2.item_id } }, at(T0, 2));
  assert.equal((await t.one("select detail_done from lots where item_id=$1", [j2.item_id])).detail_done, true);
  assert.equal(await t.one("select value from settings where key='halt'").then((r) => r.value), null, "404 must not halt");
});

test("hot refresh: list is reloaded every 5 minutes once a lot is within an hour of closing", { skip }, async () => {
  const t = await fresh();
  const base = "2026-09-20T23:20:00Z";               // Rolex closes 43 minutes later
  await t.ingest(listPayload(), base);
  assert.notEqual((await t.next(at(base, 3))).kind, "list", "hot interval not reached");
  const j = await t.next(at(base, 6));
  assert.equal(j.kind, "list");
  assert.equal(j.url, "https://www.ebth.com/users/followed_items");
});

test("close-out retries while the lot still shows for_sale, completes once it does not", { skip }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);
  const after = "2026-09-21T00:07:00Z";              // Rolex ended 00:03:20Z
  const j = await t.next(after);
  assert.deepEqual([j.kind, j.item_id], ["closeout", LOT_ID]);
  const job = { kind: "closeout", url: j.url, item_id: LOT_ID };
  await t.ingest(lotPayload(job), after);
  let row = await t.one("select closeout_done d, closeout_tries n from lots where item_id=$1", [LOT_ID]);
  assert.deepEqual([row.d, row.n], [false, 1]);
  const again = await t.next(after);
  assert.ok(!(again && again.kind === "closeout" && again.item_id === LOT_ID), "retry waits");
  const later = at(after, 6);
  await t.ingest(lotPayload(job, (p) => { p.items[0].state = "sold"; p.items[0].high_bid = 4100; }), later);
  row = await t.one("select closeout_done d from lots where item_id=$1", [LOT_ID]);
  assert.equal(row.d, true);
  const snap = await t.one("select state, high_bid from snapshots where item_id=$1 order by id desc limit 1", [LOT_ID]);
  assert.deepEqual([snap.state, Number(snap.high_bid)], ["sold", 4100]);
});

test("extended bidding: a changed end time resets the close-out clock", { skip }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);
  await t.db.query("update lots set closeout_tries=3, closeout_next=$2 where item_id=$1", [LOT_ID, "2026-09-21T00:30:00Z"]);
  await t.ingest(listPayload(), at(T0, 30 * 60), );
  const same = await t.one("select closeout_tries n from lots where item_id=$1", [LOT_ID]);
  assert.equal(same.n, 3, "unchanged end time keeps the counter");
  await t.ingest(listPayload(null), at(T0, 31 * 60));
  const p = listPayload(null);
  p.items.find((i) => i.item_id === LOT_ID).ends_at = "2026-09-20T20:08:20.000-04:00";
  await t.ingest(p, at(T0, 32 * 60));
  const moved = await t.one("select closeout_tries n, closeout_next x from lots where item_id=$1", [LOT_ID]);
  assert.equal(moved.n, 0);
  assert.equal(moved.x, null);
});

test("blocks and logouts halt everything; one odd page is tolerated, two are not", { skip }, async () => {
  for (const verdict of ["blocked", "logged_out"]) {
    const t = await fresh();
    await t.ingest(listPayload(), T0);
    const r = await t.ingest({ kind: "list", url: listJob.url, verdict, note: "test", items: [], lot: null, job: listJob }, at(T0, 40));
    assert.equal(r.halted, true, verdict);
    assert.equal(await t.next(at(T0, 90)), null, "no more jobs while halted");
    const ping = await t.one("select ping($1,$2::timestamptz) p", [t.token, at(T0, 91)]);
    assert.match(ping.p.halt.reason, new RegExp(verdict));
  }
  const t = await fresh();
  const odd = { kind: "list", url: listJob.url, verdict: "unexpected", note: "odd", items: [], lot: null, job: listJob };
  assert.equal((await t.ingest(odd, T0)).halted, false);
  await t.ingest(listPayload(), at(T0, 5));                                    // a good page resets the streak
  assert.equal((await t.ingest(odd, at(T0, 40))).halted, false);
  assert.equal((await t.ingest(odd, at(T0, 80))).halted, true);
});

test("dashboard functions: one token for the dashboard, another for the extension, neither works for the other", { skip }, async () => {
  const t = await fresh();
  const dash = (await t.one("select value #>> '{}' v from settings where key='dashboard_token'")).v;
  assert.notEqual(dash, t.token);
  await t.ingest(listPayload(), T0);
  await t.ingest(lotPayload({ kind: "detail", url: "https://www.ebth.com" + LOT_PATH, item_id: LOT_ID }), at(T0, 1));
  const q = async (sql, ...a) => (await t.db.query(sql, a)).rows[0].r;

  await t.db.exec("set role anon");
  const home = await q("select dash_home($1,$2::timestamptz) r", dash, at(T0, 2));
  assert.equal(home.lots, 20);
  assert.ok(home.snapshots >= 21);
  assert.equal(home.closing[0].item_id, LOT_ID, "soonest-closing lot first");
  assert.equal(home.closing[0].high_bid, 3300);
  assert.equal(home.halt, null);
  assert.ok(home.fetches.length >= 2 && home.fetches[0].id > home.fetches[1].id, "newest capture first");

  const lot = await q("select dash_lot($1,$2) r", dash, LOT_ID);
  assert.equal(lot.details.specs.Brand, "Rolex");
  assert.ok(lot.snapshots.length >= 2);
  assert.equal((await q("select dash_lot($1,'nope') r", dash)).lot, null);

  const setup = await q("select dash_setup($1) r", dash);
  assert.equal(setup.ingest_token, t.token);
  assert.equal(setup.seeds.length, 2);

  await t.db.query("select dash_add_seed($1,$2,false)", [dash, "https://www.ebth.com/categories/4228-sterling-silver-auctions#top"]);
  assert.equal((await q("select dash_setup($1) r", dash)).seeds.length, 3);
  await assert.rejects(() => t.db.query("select dash_add_seed($1,'https://example.com/x',false)", [dash]), /only https:\/\/www.ebth.com/);
  await t.db.query("select dash_remove_seed($1,$2)", [dash, "categories-4228-sterling-silver-auctions"]);
  assert.equal((await q("select dash_setup($1) r", dash)).seeds.length, 2);

  for (const bad of ["wrong", t.token]) {
    await assert.rejects(() => t.db.query("select dash_home($1)", [bad]), /invalid token/);
    await assert.rejects(() => t.db.query("select dash_setup($1)", [bad]), /invalid token/);
  }
  await assert.rejects(() => t.db.query("select ping($1)", [dash]), /invalid token/);
  await assert.rejects(() => t.db.query("select next_job($1)", [dash]), /invalid token/);

  await t.db.query("select dash_set_paused($1,true)", [dash]);
  assert.equal((await q("select dash_home($1) r", dash)).paused, true);
  await t.db.query("select dash_set_paused($1,false)", [dash]);
  await t.db.exec("reset role");
});

test("resume clears a halt from the dashboard", { skip }, async () => {
  const t = await fresh();
  const dash = (await t.one("select value #>> '{}' v from settings where key='dashboard_token'")).v;
  await t.ingest(listPayload(), T0);
  await t.ingest({ kind: "list", url: listJob.url, verdict: "blocked", note: "test", items: [], lot: null, job: listJob }, at(T0, 40));
  assert.equal(await t.next(at(T0, 90)), null);
  await t.db.exec("set role anon");
  await assert.rejects(() => t.db.query("select dash_resume($1)", [t.token]), /invalid token/);
  await t.db.query("select dash_resume($1)", [dash]);
  await t.db.exec("reset role");
  assert.ok(await t.next(at(T0, 90)), "jobs flow again after resume");
});

test("pacing: daily cap, quiet hours, minimum gap, pause; passive browsing does not count", { skip }, async () => {
  let t = await fresh({ daily_request_cap: 1 });
  await t.ingest(listPayload(), T0);
  assert.equal(await t.next(at(T0, 40)), null, "daily cap");

  t = await fresh({ quiet_hours: [0, 24] });
  assert.equal(await t.next(T0), null, "quiet hours");

  t = await fresh({ min_gap_seconds: 45 });
  await t.ingest(listPayload(), T0);
  assert.equal(await t.next(at(T0, 0.2)), null, "inside minimum gap");
  assert.ok(await t.next(at(T0, 1.5)), "after minimum gap");

  t = await fresh({ daily_request_cap: 1 });
  await t.ingest(listPayload(null), T0);                                       // passive: you opened the page yourself
  assert.equal(await t.count("fetches", "source='passive'"), 1);
  assert.ok(await t.next(at(T0, 40)), "passive capture does not use up the daily cap");

  t = await fresh();
  await t.set("paused", true);
  assert.equal(await t.next(T0), null, "paused");
});

test("a lot you view yourself after it closed completes its close-out", { skip }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);
  await t.ingest(lotPayload(null, (p) => { p.items[0].state = "sold"; }), "2026-09-21T01:00:00Z");
  assert.equal((await t.one("select closeout_done d from lots where item_id=$1", [LOT_ID])).d, true);
});

test("lockdown: the extension's key can call the three functions and nothing else", { skip }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);
  await t.db.exec("set role anon");
  const ok = await t.db.query("select ping($1) p", [t.token]);
  assert.equal(ok.rows[0].p.ok, true);
  await assert.rejects(() => t.db.query("select * from settings"), /permission denied/);
  await assert.rejects(() => t.db.query("select * from lots"), /permission denied/);
  await assert.rejects(() => t.db.query("select * from lot_latest"), /permission denied/);
  await assert.rejects(() => t.db.query("select cfg('ingest_token')"), /permission denied/);
  await assert.rejects(() => t.db.query("select ping('wrong-token')"), /invalid token/);
  await assert.rejects(() => t.db.query("select next_job('wrong-token')"), /invalid token/);
  await assert.rejects(() => t.db.query("select ingest_page('wrong-token','{}'::jsonb)"), /invalid token/);
  await t.db.exec("reset role");
});

const skipSale = !(HAVE_FIXTURES && HAVE_SALE) && "save the sale page into tests/fixtures";
const saleJob = { kind: "list", url: SALE_URL, item_id: null, requires_login: false };

test("sale page: hundreds of lots stored cheaply; only followed lots get detail and close-out loads", { skip: skipSale }, async () => {
  const t = await fresh();
  const t1 = "2026-09-20T19:45:00Z";
  for (let pg = 1; pg <= 7; pg++) await t.ingest(salePayload(saleDoc(), { job: saleJob, page: pg }), at(t1, pg * 0.1));
  assert.equal(await t.count("lots"), 318);
  assert.equal(await t.count("snapshots"), 318);
  assert.equal(await t.count("lots", "tracked"), 0, "sale lots are not tracked by default");
  assert.equal(await t.count("lots", "ends_at is not null"), 318);
  assert.equal(await t.count("lots", "sale_id = '90479'"), 318);
  const first = await t.one("select min(ends_at) e from lots");
  assert.equal(new Date(first.e).toISOString(), "2026-09-21T00:00:00.000Z");

  await t.ingest(listPayload(), at(t1, 1));                     // your followed lots become tracked
  assert.equal(await t.count("lots", "tracked"), 20);
  const followed = new Set((await t.db.query("select item_id from lots where tracked")).rows.map((r) => r.item_id));
  for (let i = 0; i < 40; i++) {
    const j = await t.next(at(t1, 2 + i));
    if (!j || j.kind !== "detail") break;
    assert.ok(followed.has(j.item_id), "detail jobs are only for tracked lots");
    await t.ingest({ kind: "lot", url: j.url, verdict: "gone", note: "", items: [], lot: null, job: { kind: "detail", url: j.url, item_id: j.item_id } }, at(t1, 2 + i));
  }
  const late = "2026-09-21T00:30:00Z";                          // after most of the sale has closed
  const j = await t.next(late);
  assert.ok(j && (j.kind !== "closeout" || followed.has(j.item_id)), "no close-out page loads for untracked lots");
});

test("sale page: minute-rounded card times never overwrite an exact end time", { skip: skipSale }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);                            // exact: 20:03:20 ET
  await t.ingest(salePayload(saleDoc(), { job: saleJob }), at(T0, 5));
  let r = await t.one("select ends_at e, closeout_tries n from lots where item_id=$1", [LOT_ID]);
  assert.equal(new Date(r.e).toISOString(), "2026-09-21T00:03:20.000Z", "exact time kept");
  await t.db.query("update lots set closeout_tries=2 where item_id=$1", [LOT_ID]);
  await t.ingest(salePayload(saleDoc(), { job: saleJob }), at(T0, 40));
  r = await t.one("select closeout_tries n from lots where item_id=$1", [LOT_ID]);
  assert.equal(r.n, 2, "rounding noise does not reset the close-out clock");
  const moved = salePayload(saleDoc(), { job: saleJob, mutate: (p) => { p.items.find((i) => i.item_id === LOT_ID).ends_at = "2026-09-21T00:08:00.000Z"; } });
  await t.ingest(moved, at(T0, 50));                            // a real extension: five minutes later
  r = await t.one("select ends_at e, closeout_tries n from lots where item_id=$1", [LOT_ID]);
  assert.equal(new Date(r.e).toISOString(), "2026-09-21T00:08:00.000Z");
  assert.equal(r.n, 0, "a real move resets it");
});

test("sale page: the lot view keeps bid counts from lot pages while showing the newest price", { skip: skipSale }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);                            // 40 bids, 13 bidders, $3,300
  await t.ingest(salePayload(saleDoc(), { job: saleJob, mutate: (p) => { p.items.find((i) => i.item_id === LOT_ID).high_bid = 3400; } }), at(T0, 60));
  const r = await t.one("select high_bid, bids_count, unique_bidders from lot_latest where item_id=$1", [LOT_ID]);
  assert.deepEqual([Number(r.high_bid), r.bids_count, r.unique_bidders], [3400, 40, 13]);
});

test("pages count toward the daily cap, so a big sale refresh uses more of it", { skip: skipSale }, async () => {
  const t = await fresh({ daily_request_cap: 20 });
  await t.ingest(salePayload(saleDoc(), { job: saleJob, mutate: (p) => { p.pages = 15; } }), T0);     // 15 pages read
  assert.ok(await t.next(at(T0, 10)), "15 of 20 used");
  await t.ingest(salePayload(saleDoc(), { job: saleJob, mutate: (p) => { p.pages = 15; } }), at(T0, 20));
  assert.equal(await t.next(at(T0, 30)), null, "30 of 20 used");
});

test("sale pages refresh every 10 minutes near closing time, other lists every 5", { skip: skipSale }, async () => {
  const t = await fresh();
  const base = "2026-09-20T23:20:00Z";                          // first sale lots close at 00:00Z, 40 minutes away
  await t.ingest(salePayload(saleDoc(), { job: saleJob }), base);
  await t.ingest(listPayload(), at(base, 0.1));
  const early = await t.next(at(base, 7));
  assert.equal(early.url, "https://www.ebth.com/users/followed_items", "followed list is due at 5 minutes; sale is not due until 10");
  await t.ingest(listPayload(), at(base, 8));
  const due = await t.next(at(base, 11));
  assert.equal(due.url, SALE_URL);
  assert.equal(due.kind, "list");
});

test("adding a sale or category page from the dashboard sets the slower near-close cadence", { skip }, async () => {
  const t = await fresh();
  const dash = (await t.one("select value #>> '{}' v from settings where key='dashboard_token'")).v;
  await t.db.exec("set role anon");
  await t.db.query("select dash_add_seed($1,$2,false)", [dash, "https://www.ebth.com/categories/4228-sterling-silver-auctions"]);
  await t.db.query("select dash_add_seed($1,$2,true)", [dash, "https://www.ebth.com/users/followed_items?ref=x"]);
  await t.db.exec("reset role");
  const cat = await t.one("select hot_interval_min h from seeds where name = 'categories-4228-sterling-silver-auctions'");
  assert.equal(cat.h, 10);
  const other = await t.one("select hot_interval_min h from seeds where name = 'users-followed-items'");
  assert.equal(other.h, null);
});

test("a partial sale page you open yourself does not reset the schedule for the full read", { skip: skipSale }, async () => {
  const t = await fresh();
  const base = "2026-09-20T19:00:00Z";                          // far from any close: regular 30-minute cadence
  await t.ingest(salePayload(saleDoc(), { job: saleJob }), base);
  await t.ingest(listPayload(), at(base, 1));                    // followed list, fetched by a job
  await t.db.query("update lots set detail_done = true");        // keep detail loads out of this test
  await t.ingest(listPayload(), at(base, 25));                   // keep the followed list fresh so only the sale is due
  await t.ingest(salePayload(saleDoc(), { job: null }), at(base, 29));      // you browse the sale: page 1 only
  const due = await t.next(at(base, 31));
  assert.equal(due.url, SALE_URL, "the full read is still due 30 minutes after the last full read");
  await t.ingest(listPayload(null), at(base, 45));               // a followed-items page you open yourself still counts
  const next = await t.next(at(base, 46));
  assert.ok(!(next && next.url === "https://www.ebth.com/users/followed_items"), "followed list was just refreshed");
});

test("diagnostics are stored with the capture, and the paging hint reaches the extension", { skip }, async () => {
  const t = await fresh();
  await t.ingest(listPayload(), T0);
  const long = "read 48 of 319. cand=[\"/api/items?page=1\"] " + "x".repeat(1200);
  await t.ingest({ kind: "list", url: listJob.url, verdict: "ok", note: "short note", diag: long, items: [], lot: null, job: listJob }, at(T0, 40));
  const r = await t.one("select note, length(diag) n, left(diag, 12) d from fetches order by id desc limit 1");
  assert.deepEqual([r.note, r.n, r.d], ["short note", long.length, "read 48 of 3"]);
  await t.ingest({ kind: "list", url: listJob.url, verdict: "ok", note: "", diag: "y".repeat(5000), items: [], lot: null, job: listJob }, at(T0, 41));
  assert.equal((await t.one("select length(diag) n from fetches order by id desc limit 1")).n, 2000, "capped at 2000 characters");
  const noDiag = await t.one("select diag from fetches order by id asc limit 1");
  assert.equal(noDiag.diag, null);

  await t.db.query("update lots set detail_done = true");         // so the next job is a list read
  let job = await t.next(at(T0, 100));
  assert.equal(job.kind, "list");
  assert.ok("hint" in job && job.hint === null, "no hint by default");
  await t.set("paging_hint", { urlTemplate: "https://www.ebth.com/api/items?sale_id=90479&page={page}", headers: { "X-Requested-With": "XMLHttpRequest" } });
  job = await t.next(at(T0, 100));
  assert.equal(job.hint.urlTemplate, "https://www.ebth.com/api/items?sale_id=90479&page={page}");
  assert.equal(job.hint.headers["X-Requested-With"], "XMLHttpRequest");
});

const pageJob = (url) => ({ kind: "list", url, item_id: null });
const pageNo = (url) => Number((url.match(/page=(\d+)/) || [0, 1])[1]);
async function readNext(t, when) {                       // do what the extension does: take the next job, read that page, report it
  const j = await t.next(when);
  const total = t.pages ? t.pages * 48 : 319;
  if (j) await t.ingest(salePayload(saleDoc(), { job: pageJob(j.url), page: pageNo(j.url), mutate: (p) => { p.sale.item_count = total; } }), when);
  return j;
}
async function paged(pages, extra = {}) {
  const t = await fresh(extra);
  t.pages = pages;
  await t.db.query("update seeds set page_count = $1 where name = 'sale-90479'", [pages]);
  await t.db.query("update seeds set enabled = false where name = 'followed'");
  return t;
}

test("paged sale: each page is its own read, walked in order and refreshed on its own schedule", { skip: skipSale }, async () => {
  const t = await paged(3);
  const base = "2026-09-20T19:00:00Z";
  const seen = [];
  for (let i = 0; i < 3; i++) seen.push((await readNext(t, at(base, i))).url);
  assert.deepEqual(seen, [SALE_URL, SALE_URL + "?page=2", SALE_URL + "?page=3"]);
  assert.equal(await t.next(at(base, 5)), null, "everything was just read");
  assert.equal((await t.next(at(base, 31))).url, SALE_URL, "page 1 comes round again after 30 minutes");
  assert.equal(await t.count("lots"), 144, "three pages of 48 lots");
});

test("paged sale: pages closing soonest are refreshed every 10 minutes, later pages stay on 30", { skip: skipSale }, async () => {
  const t = await paged(7);
  const base = "2026-09-20T23:20:00Z";                         // first lots close at 00:00Z
  for (let pg = 1; pg <= 7; pg++) await t.ingest(salePayload(saleDoc(), { job: pageJob(SALE_URL + (pg > 1 ? "?page=" + pg : "")), page: pg }), at(base, pg * 0.1));
  assert.equal(await t.next(at(base, 5)), null, "hot pages wait their 10 minutes");
  const first = await readNext(t, at(base, 11));
  assert.equal(first.url, SALE_URL);
  const second = await readNext(t, at(base, 11.2));
  assert.equal(second.url, SALE_URL + "?page=2");
  assert.equal(await t.next(at(base, 11.4)), null, "page 3 closes later, so it is not hot yet; page 7 even less so");
  const later = await t.next(at(base, 31));
  assert.ok(later, "the slower pages come due at 30 minutes");
});

test("paged sale: a page is retired after a read taken once all of its lots closed, and when its lots vanish", { skip: skipSale }, async () => {
  const t = await paged(2);
  await readNext(t, "2026-09-21T00:30:00Z");                    // page 1 lots closed 00:00-00:16Z: this read is the final capture
  const next = await t.next("2026-09-21T02:00:00Z");
  assert.equal(next.url, SALE_URL + "?page=2", "page 1 is retired; page 2 was never read");
  await t.ingest(salePayload(saleDoc(), { job: pageJob(next.url), page: 2 }), "2026-09-21T00:20:00Z");   // read while page 2 was still open
  await t.ingest(salePayload(saleDoc(), { job: pageJob(next.url), page: 2, mutate: (p) => { p.items = []; } }), "2026-09-21T00:50:00Z");  // then the lots vanish
  assert.equal(await t.next("2026-09-21T03:00:00Z"), null, "nothing left to read");
});

test("the page count is learned from the sale's lot count on page 1, and only from page 1", { skip: skipSale }, async () => {
  const t = await fresh();
  const count = async () => (await t.one("select page_count c from seeds where name = 'sale-90479'")).c;
  assert.equal(await count(), null);
  await t.ingest(salePayload(saleDoc(), { job: pageJob(SALE_URL), page: 1 }), T0);
  assert.equal(await count(), 7, "319 lots at 48 a page");
  await t.db.query("update seeds set page_count = null where name = 'sale-90479'");
  await t.ingest(salePayload(saleDoc(), { job: pageJob(SALE_URL + "?page=2"), page: 2 }), at(T0, 1));
  await t.ingest(salePayload(saleDoc(), { job: null, page: 1 }), at(T0, 2));
  assert.equal(await count(), null, "a later page or a page you browsed yourself does not change it");
});

// ---------------------------------------------------------------- find lots and value estimates
async function loaded() {
  const t = await fresh();
  const dash = (await t.one("select value #>> '{}' v from settings where key='dashboard_token'")).v;
  const pageSizeJob = (pg) => ({ kind: "list", url: SALE_URL + (pg > 1 ? "?page=" + pg : ""), item_id: null });
  for (let pg = 1; pg <= 7; pg++) await t.ingest(salePayload(saleDoc(), { job: pageSizeJob(pg), page: pg }), at(T0, pg * 0.1));
  await t.ingest(listPayload(), at(T0, 5));                                   // followed lots: exact end times, bid counts
  // what the database should now know, computed independently from the saved pages
  const sale = EBTH.saleMeta(saleDoc());
  const cards = EBTH.withEndTimes(EBTH.cardItems(saleDoc()), sale.ends_at);
  const followed = EBTH.listItems(listDoc());
  const lots = new Map();
  for (const c of cards) lots.set(c.item_id, { name: c.name, bid: c.high_bid, end: new Date(c.ends_at) });
  for (const f of followed) lots.set(f.item_id, { name: f.name, bid: f.high_bid, end: new Date(f.ends_at) });
  const search = async (obj, now = at(T0, 10)) => (await t.db.query("select dash_search($1,$2::jsonb,$3::timestamptz) r", [dash, JSON.stringify(obj), now])).rows[0].r;
  const setEst = (id, low, high, max, conf, notes, src) =>
    t.db.query("select dash_set_estimate($1,$2,$3,$4,$5,$6,$7,$8)", [dash, id, low, high, max, conf, notes, src]);
  return { t, dash, lots, search, setEst };
}
const WIENER = () => EBTH.cardItems(saleDoc()).find((c) => /Ed Wiener/.test(c.name)).item_id;

test("find lots: words must all match, case doesn't matter, and % or _ are just characters", { skip: skipSale }, async () => {
  const { lots, search } = await loaded();
  const names = [...lots.values()].map((l) => l.name.toLowerCase());
  const count = (f) => names.filter(f).length;
  const all = await search({ status: "all", limit: 1 });
  assert.equal(all.total, lots.size, "every sale lot and every followed lot is searchable");
  assert.equal((await search({ q: "STERLING", status: "all", limit: 1 })).total, count((n) => n.includes("sterling")));
  assert.equal((await search({ q: "14k  ring", status: "all", limit: 1 })).total, count((n) => n.includes("14k") && n.includes("ring")));
  assert.equal((await search({ q: "wiener", status: "all" })).rows.length, 1);
  assert.equal((await search({ q: "%", status: "all", limit: 1 })).total, count((n) => n.includes("%")), "% is not a wildcard");
  assert.equal((await search({ q: "_", status: "all", limit: 1 })).total, count((n) => n.includes("_")), "_ is not a wildcard");
  assert.equal((await search({ q: "no such lot anywhere", status: "all" })).total, 0);
});

test("find lots: open and closed, bid range, closing soon, tracked, sale", { skip: skipSale }, async () => {
  const { lots, search } = await loaded();
  const now = new Date("2026-09-21T00:30:00Z");
  const arr = [...lots.values()];
  assert.equal((await search({ status: "open", limit: 1 }, now.toISOString())).total, arr.filter((l) => l.end > now).length);
  assert.equal((await search({ status: "closed", limit: 1 }, now.toISOString())).total, arr.filter((l) => l.end <= now).length);
  assert.equal((await search({ status: "all", min_bid: 1000, limit: 1 })).total, arr.filter((l) => Number(l.bid) >= 1000).length);
  assert.equal((await search({ status: "all", max_bid: 50, limit: 1 })).total, arr.filter((l) => Number(l.bid) <= 50).length);
  const soon = new Date("2026-09-20T23:30:00Z");
  assert.equal((await search({ within_hours: 1 }, soon.toISOString())).total,
    arr.filter((l) => l.end > soon && l.end <= new Date(soon.getTime() + 3600e3)).length, "closing within the hour");
  assert.equal((await search({ status: "all", tracked: true, limit: 1 })).total, 20, "the 20 followed lots");
  assert.equal((await search({ status: "all", sale: "90479", limit: 1 })).total, 318);
  const byEnd = (await search({ status: "all", limit: 200 })).rows.map((r) => new Date(r.ends_at).getTime());
  assert.deepEqual(byEnd, [...byEnd].sort((a, b) => a - b), "soonest closing first by default");
});

test("find lots: sorting, paging, and limits", { skip: skipSale }, async () => {
  const { lots, search } = await loaded();
  const p1 = await search({ status: "all", limit: 10, offset: 0, sort: "bid_desc" });
  const p2 = await search({ status: "all", limit: 10, offset: 10, sort: "bid_desc" });
  assert.equal(p1.rows.length, 10);
  assert.equal(p1.total, p2.total);
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.item_id)).size, 20, "pages do not overlap");
  const bids = p1.rows.map((r) => Number(r.high_bid));
  assert.deepEqual(bids, [...bids].sort((a, b) => b - a));
  assert.equal(bids[0], Math.max(...[...lots.values()].map((l) => Number(l.bid))));
  assert.equal((await search({ status: "all", limit: 500 })).limit, 200, "capped at 200 a page");
  assert.equal((await search({ status: "all", sort: "name", limit: 3 })).rows.length, 3);
});

test("estimates: saved, shown in search and on the lot, searchable, sortable by gap, and logged", { skip: skipSale }, async () => {
  const { t, dash, search, setEst } = await loaded();
  const w = WIENER();
  await setEst(w, 800, 1500, 400, "medium", "Rago $4,063 (2021), Wright $3,024. Verify signature.", "https://www.ragoarts.com/x");
  await setEst(LOT_ID, 3000, 4500, 3400, "low", "watch comps", null);
  const withEst = await search({ status: "all", estimate: "with" });
  assert.equal(withEst.total, 2);
  assert.equal((await search({ status: "all", estimate: "without", limit: 1 })).total, (await search({ status: "all", limit: 1 })).total - 2);
  const byGap = await search({ status: "all", estimate: "with", sort: "gap" });
  assert.equal(byGap.rows[0].item_id, w, "the lot with the most headroom first");
  assert.equal(Number(byGap.rows[0].gap_worst), 800 - Number(byGap.rows[0].high_bid));
  assert.equal(Number(byGap.rows[0].max_bid), 400);
  assert.ok(Number(byGap.rows[1].gap_worst) < 0, "the Rolex is already above its low estimate");
  assert.equal((await search({ status: "all", q: "signature" })).rows[0].item_id, w, "your notes are searchable");
  assert.equal(byGap.rows[0].est_sources, "https://www.ragoarts.com/x", "search rows carry the sources");
  assert.ok(byGap.rows[0].est_updated, "and the date saved");
  const lot = (await t.db.query("select dash_lot($1,$2) r", [dash, w])).rows[0].r;
  assert.deepEqual([Number(lot.estimate.est_low), Number(lot.estimate.est_high), lot.estimate.confidence], [800, 1500, "medium"]);
  await setEst(w, 900, 1500, 450, "high", "revised", null);                   // update in place
  assert.equal((await search({ status: "all", estimate: "with", limit: 1 })).total, 2);
  const log = (await t.db.query("select action, est_low, high_bid_at_time from lot_estimate_log where item_id=$1 order by id", [w])).rows;
  assert.deepEqual(log.map((r) => Number(r.est_low)), [800, 900], "every change is kept");
  assert.ok(Number(log[0].high_bid_at_time) > 0, "with the bid at that moment");
  await t.db.query("select dash_clear_estimate($1,$2)", [dash, w]);
  assert.equal((await search({ status: "all", estimate: "with", limit: 1 })).total, 1);
  assert.equal((await t.db.query("select action from lot_estimate_log where item_id=$1 order by id desc limit 1", [w])).rows[0].action, "clear");
});

test("estimates: bad input is refused with a reason", { skip: skipSale }, async () => {
  const { t, dash, setEst } = await loaded();
  const w = WIENER();
  await assert.rejects(() => setEst(w, 900, 800, null, null, null, null), /low estimate is above/);
  await assert.rejects(() => setEst(w, -5, 100, null, null, null, null), /zero or more/);
  await assert.rejects(() => setEst(w, 100, 200, null, "certain", null, null), /confidence must be/);
  await assert.rejects(() => setEst("nope", 100, 200, null, null, null, null), /unknown lot/);
  await assert.rejects(() => setEst(w, null, null, null, null, "  ", ""), /at least one value or a note/);
  await setEst(w, 100, null, null, null, null, null);                          // low only is fine
  await setEst(w, null, null, null, null, "just a note", null);                // note only is fine
  const r = (await t.db.query("select est_low, notes from lot_estimates where item_id=$1", [w])).rows[0];
  assert.deepEqual([r.est_low, r.notes], [null, "just a note"]);
  await t.db.query("select dash_clear_estimate($1,$2)", [dash, "not-a-lot"]);   // clearing something that isn't there is harmless
});

test("search and estimates are dashboard-only", { skip: skipSale }, async () => {
  const { t, dash } = await loaded();
  await t.db.exec("set role anon");
  await assert.rejects(() => t.db.query("select dash_search($1)", [t.token]), /invalid token/);
  await assert.rejects(() => t.db.query("select dash_set_estimate($1,$2,1,2,null,null,'x',null)", [t.token, LOT_ID]), /invalid token/);
  await assert.rejects(() => t.db.query("select * from lot_estimates"), /permission denied/);
  await assert.rejects(() => t.db.query("select * from lot_estimate_log"), /permission denied/);
  assert.ok((await t.db.query("select dash_search($1) r", [dash])).rows[0].r.total > 0);
  await t.db.exec("reset role");
});

test("every column sorts both ways, and lots without an estimate stay at the bottom", { skip: skipSale }, async () => {
  const { lots, search, setEst } = await loaded();
  const w = WIENER();
  await setEst(w, 800, 1500, 400, "medium", "n", null);
  await setEst(LOT_ID, 3000, 4500, 3000, "low", "n", null);
  const third = [...lots.keys()].find((id) => id !== w && id !== LOT_ID);
  await setEst(third, 50, null, null, null, "low only", null);                       // a low estimate with no high
  const ids = async (o) => (await search({ status: "all", limit: 200, ...o })).rows.map((r) => r.item_id);

  const estDesc = await ids({ sort: "estimate", dir: "desc" });
  assert.deepEqual(estDesc.slice(0, 3), [LOT_ID, w, third], "highest low-estimate first");
  const estAsc = await ids({ sort: "estimate", dir: "asc" });
  assert.deepEqual(estAsc.slice(0, 3), [third, w, LOT_ID], "lowest first");
  assert.equal(estAsc.length, 200, "a full page comes back after the estimated lots");

  const gapAsc = (await search({ status: "all", estimate: "with", sort: "gap", dir: "asc" })).rows.map((r) => Number(r.gap_worst));
  assert.deepEqual(gapAsc, [...gapAsc].sort((a, b) => a - b));
  const gapDesc = (await search({ status: "all", estimate: "with", sort: "gap", dir: "desc" })).rows.map((r) => Number(r.gap_worst));
  assert.deepEqual(gapDesc, [...gapDesc].sort((a, b) => b - a));

  const ends = (await search({ status: "all", limit: 200, sort: "ends", dir: "desc" })).rows.map((r) => new Date(r.ends_at).getTime());
  assert.deepEqual(ends, [...ends].sort((a, b) => b - a), "latest closing first when descending");
  const names = (await search({ status: "all", limit: 200, sort: "name", dir: "desc" })).rows.map((r) => r.name.toLowerCase());
  assert.deepEqual(names, [...names].sort().reverse());
  const bidAsc = (await search({ status: "all", limit: 200, sort: "bid", dir: "asc" })).rows.map((r) => Number(r.high_bid));
  assert.deepEqual(bidAsc, [...bidAsc].sort((a, b) => a - b));

  const defaults = await search({ status: "all", limit: 1, sort: "estimate" });
  assert.deepEqual([defaults.sort, defaults.dir], ["worst", "desc"], "the old estimate key is the worst case, highest first");
  assert.equal((await search({ status: "all", limit: 1, sort: "ends" })).dir, "asc");
  assert.equal((await search({ status: "all", limit: 1, sort: "bid_asc" })).dir, "asc", "the older names still work");
  assert.equal((await search({ status: "all", limit: 1, sort: "bid", dir: "sideways" })).dir, "desc", "a bad direction falls back to the default");
  assert.equal((await search({ status: "all", limit: 1, sort: "nonsense" })).rows.length, 1, "an unknown sort still returns lots");
});

test("a lot's address is always a real item address, whatever the collector sends", { skip }, async () => {
  const t = await fresh();
  const bad = "https://www.ebth.commailto:";
  await t.ingest(payload(listDoc(), "/users/followed_items", { job: { kind: "list", url: "https://www.ebth.com/users/followed_items", item_id: null }, requiresLogin: true,
    mutate: (p) => { p.items[0].url = bad; } }), at(T0, 1));
  const first = (await t.one("select item_id, url from lots order by item_id limit 1")).url;
  assert.match(first, /^https:\/\/www\.ebth\.com\/items\/\d+/, "a bad address on arrival becomes the plain item address");
  assert.equal((await t.one("select count(*) n from lots where url !~ '^https://www\\.ebth\\.com/items/\\d+'")).n, 0);
  // a good address already stored is not overwritten by a later bad one
  await t.db.query("update lots set url = 'https://www.ebth.com/items/1-good-slug' where item_id = (select item_id from lots order by item_id limit 1)");
  await t.ingest(payload(listDoc(), "/users/followed_items", { job: { kind: "list", url: "https://www.ebth.com/users/followed_items", item_id: null }, requiresLogin: true,
    mutate: (p) => { p.items.forEach((i) => { i.url = bad; }); } }), at(T0, 2));
  assert.equal((await t.one("select url from lots order by item_id limit 1")).url, "https://www.ebth.com/items/1-good-slug");
  // and a closing-price job never gets handed a broken address
  const jobs = [];
  for (let i = 0; i < 6; i++) { const j = await t.next(at(T0, 10 + i * 5)); if (j && j.url) jobs.push(j.url); }
  assert.ok(jobs.length > 0, "there are jobs to check");
  assert.ok(jobs.every((u) => /^https:\/\/www\.ebth\.com\//.test(u) && !/mailto/.test(u)), jobs.join(" "));
});

// ---------------------------------------------------------------- categories
test("categories: every lot gets one, from its title, and a rename re-sorts it", { skip: skipSale }, async () => {
  const { t, dash, lots, search } = await loaded();
  assert.equal(await t.count("lots", "category is null"), 0, "no lot is left without a category");
  assert.equal((await t.one("select category from lots where item_id=$1", [LOT_ID])).category, "Watches");
  assert.equal((await t.one("select category from lots where item_id=$1", [WIENER()])).category, "Jewelry, silver");
  await t.db.query("update lots set name = 'Sterling Silver Pitcher' where item_id = $1", [WIENER()]);
  assert.equal((await t.one("select category from lots where item_id=$1", [WIENER()])).category, "Sterling and silver");
  const lot = (await t.db.query("select dash_lot($1,$2) r", [dash, WIENER()])).rows[0].r;
  assert.equal(lot.category, "Sterling and silver", "the lot page gets it too");
  const other = await t.one("select count(*)::int n from lots where category = 'Other'");
  assert.ok(other.n < lots.size * 0.15, "few lots are left as Other");
});

test("categories: filter, sort, and the list with open counts", { skip: skipSale }, async () => {
  const { t, dash, search } = await loaded();
  const cats = (await t.db.query("select dash_categories($1, $2::timestamptz) r", [dash, at(T0, 10)])).rows[0].r;
  assert.ok(cats.some((c) => c.category === "Watches"));
  assert.equal(cats.reduce((n, c) => n + c.total, 0), await t.count("lots"), "every lot is counted once");
  assert.equal(cats.reduce((n, c) => n + c.open, 0), (await search({ status: "open", limit: 1 })).total, "open counts add up to the open lots");
  const jew = await search({ status: "all", category: "Jewelry, gold", limit: 200 });
  assert.ok(jew.total > 0);
  assert.ok(jew.rows.every((r) => r.category === "Jewelry, gold"), "only that category comes back");
  assert.equal(jew.total, await t.count("lots", "category = 'Jewelry, gold'"));
  const asc = (await search({ status: "all", sort: "category", limit: 200 })).rows.map((r) => (r.category || "").toLowerCase());
  assert.deepEqual(asc, [...asc].sort(), "A to Z by default");
  const desc = (await search({ status: "all", sort: "category", dir: "desc", limit: 200 })).rows.map((r) => (r.category || "").toLowerCase());
  assert.deepEqual(desc, [...desc].sort().reverse());
  assert.equal((await search({ status: "all", category: "No Such Category", limit: 5 })).total, 0);
});

// ---------------------------------------------------------------- bid math
test("resale fee follows the tiers and the calculated max bid follows from it", async () => {
  const t = await fresh();
  const dash = (await t.one("select value #>> '{}' v from settings where key='dashboard_token'")).v;
  const fee = async (p) => Number((await t.db.query("select resale_fee($1) f", [p])).rows[0].f);
  const max = async (low) => Number((await t.db.query("select suggested_max_bid($1) m", [low])).rows[0].m);
  assert.equal(await fee(0), 0);
  assert.equal(await fee(500), 75, "15% up to $1,000");
  assert.equal(await fee(1000), 150);
  assert.equal(await fee(2000), 215, "then 6.5% on the next dollars");
  assert.equal(await fee(8000), 587.5, "then 3% above $7,500");
  assert.equal(await fee(100000), 3347.5);
  assert.equal(await max(14000), 8998, "(14,000 - 767.50) x 85% / 1.25");
  assert.equal(await max(9000), 5700);
  assert.equal(await max(5500), 3439);
  assert.equal(await max(2300), 1404);
  assert.equal((await t.db.query("select suggested_max_bid(null) m")).rows[0].m, null);
  const bc = async (lo, hi) => (await t.db.query("select base_case($1, $2) b", [lo, hi])).rows[0].b;
  assert.equal(Number(await bc(14000, 20000)), 17000, "base case is the midpoint");
  assert.equal(Number(await bc(14000, null)), 14000, "only a low estimate: it is the base case");
  assert.equal(Number(await bc(null, 20000)), 20000, "only a high estimate: it is the base case");
  await t.db.query("select dash_set_bid_math($1, 0.20, 0.10)", [dash]);
  assert.equal(await max(14000), 9924, "a lower premium and margin raise the ceiling");
  const m = (await t.db.query("select dash_bid_math($1) r", [dash])).rows[0].r;
  assert.deepEqual([Number(m.premium), Number(m.margin), m.tiers.length], [0.2, 0.1, 3]);
  await assert.rejects(() => t.db.query("select dash_set_bid_math($1, 1.5, 0.1)", [dash]), /premium must be between/);
  await assert.rejects(() => t.db.query("select dash_set_bid_math($1, 0.25, 0.95)", [dash]), /margin must be between/);
  await assert.rejects(() => t.db.query("select dash_set_bid_math($1, 0.25, 0.15)", [t.token]), /invalid token/);
});

test("three cases: worst, base and best each carry a value, headroom, max bid and room; every column sorts", { skip: skipSale }, async () => {
  const { t, dash, lots, search, setEst } = await loaded();
  const w = WIENER();
  const third = [...lots.keys()].find((id) => id !== w && id !== LOT_ID);
  await setEst(w, 800, 1500, null, null, "n", null);
  await setEst(LOT_ID, 3000, 4500, null, null, "n", null);
  await setEst(third, 50000, 90000, null, null, "n", "https://example.com");
  const rows = (await search({ status: "all", estimate: "with", limit: 10 })).rows;
  const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));
  const n = (x) => Number(x);

  // worst is the low estimate, best the high, base the midpoint
  assert.deepEqual([n(by[LOT_ID].v_worst), n(by[LOT_ID].v_base), n(by[LOT_ID].v_best)], [3000, 3750, 4500]);
  // max bid per case, at the 15% margin: (value - resale fee) x 85% / 1.25
  assert.deepEqual([n(by[LOT_ID].max_worst), n(by[LOT_ID].max_base), n(by[LOT_ID].max_best)], [1849, 2326, 2803]);
  assert.deepEqual([n(by[w].max_worst), n(by[w].max_base), n(by[w].max_best)], [462, 673, 895]);
  // headroom is the case value less the current bid; room is the case's max bid less the next bid
  for (const r of rows) {
    for (const c of ["worst", "base", "best"]) {
      assert.equal(n(r["gap_" + c]), n(r["v_" + c]) - n(r.high_bid ?? 0), c + " headroom");
      assert.equal(n(r["room_" + c]), n(r["max_" + c]) - n(r.min_next_bid ?? (n(r.high_bid ?? 0) + 1)), c + " room");
    }
  }
  assert.ok(n(by[LOT_ID].room_worst) < 0 && n(by[LOT_ID].room_best) < 0, "the Rolex is over even in the best case");
  assert.ok(n(by[w].room_worst) > 0, "Wiener is under in every case");
  assert.equal(by[LOT_ID].max_used, undefined, "the single max column is gone");

  // profit and ROI at the current bid: cost is the bid plus the 25% premium, proceeds are the value less its resale fee
  const fee = async (v) => n((await t.db.query("select resale_fee($1) f", [v])).rows[0].f);
  for (const r of rows) {
    const bid = n(r.high_bid ?? 0);
    for (const c of ["worst", "base", "best"]) {
      const v = n(r["v_" + c]);
      const profit = v - (await fee(v)) - bid * 1.25;
      assert.ok(Math.abs(n(r["profit_" + c]) - profit) < 0.01, c + " profit");
      if (bid > 0) assert.ok(Math.abs(n(r["roi_" + c]) - profit / (bid * 1.25)) < 1e-9, c + " roi");
      else assert.equal(r["roi_" + c], null, c + " roi is blank while the bid is $0");
    }
  }
  const rolex = by[LOT_ID];
  assert.ok(n(rolex.roi_worst) < 0 && n(rolex.roi_worst) < n(rolex.roi_base) && n(rolex.roi_base) < n(rolex.roi_best), "the Rolex loses money at the low value and improves with each case");
  assert.ok(Math.abs(n(rolex.profit_base) - (3421.25 - 3300 * 1.25)) < 0.01, "base case: 3,421.25 net less 4,125 cost");

  const ids = async (o) => (await search({ status: "all", estimate: "with", limit: 10, ...o })).rows.map((r) => r.item_id);
  assert.deepEqual((await ids({ sort: "worst_room", dir: "desc" })).slice(0, 3), [third, w, LOT_ID], "most room first");
  assert.deepEqual((await ids({ sort: "worst_room", dir: "asc" })).slice(0, 3), [LOT_ID, w, third], "most over first");
  assert.deepEqual(await ids({ sort: "room", dir: "desc" }), await ids({ sort: "worst_room", dir: "desc" }), "old key still works");
  assert.deepEqual(await ids({ sort: "estimate", dir: "desc" }), await ids({ sort: "worst", dir: "desc" }), "old key still works");
  for (const k of ["worst", "base", "best"]) {
    assert.deepEqual((await ids({ sort: k, dir: "desc" })).slice(0, 3), [third, LOT_ID, w], k + " value sorts");
    assert.deepEqual((await ids({ sort: k, dir: "asc" })).slice(0, 3), [w, LOT_ID, third], k + " value sorts ascending");
    const gaps = (await search({ status: "all", estimate: "with", limit: 10, sort: k + "_gap", dir: "desc" })).rows.map((r) => n(r["gap_" + k]));
    assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a), k + " headroom sorts");
    const rms = (await search({ status: "all", estimate: "with", limit: 10, sort: k + "_room", dir: "asc" })).rows.map((r) => n(r["room_" + k]));
    assert.deepEqual(rms, [...rms].sort((a, b) => a - b), k + " over/under sorts");
    for (const dir of ["desc", "asc"]) {
      const rr = (await search({ status: "all", estimate: "with", limit: 10, sort: k + "_roi", dir })).rows.map((r) => r["roi_" + k]);
      const have = rr.filter((x) => x != null).map(n);
      assert.deepEqual(have, [...have].sort((a, b) => (dir === "desc" ? b - a : a - b)), k + " ROI sorts " + dir);
      assert.equal(rr.slice(have.length).every((x) => x == null), true, "a blank ROI sorts after the numbers");
    }
  }
  assert.deepEqual((await ids({ sort: "source", dir: "desc" })).slice(0, 3), [third, LOT_ID, w], "newest valuation first");
  const all = await search({ status: "all", limit: 200, sort: "worst_room" });
  assert.equal(all.rows.slice(3).every((r) => r.room_worst == null), true, "lots with no estimate sort after the ones that have one");
  const bids = (await search({ status: "all", limit: 200, sort: "bids", dir: "desc" })).rows.map((r) => r.bids_count == null ? -1 : Number(r.bids_count));
  const present = bids.filter((b) => b >= 0);
  assert.deepEqual(present, [...present].sort((a, b) => b - a), "bids sorts, empties last");

  // your own max bid is still stored and returned, but the cases do not change with it
  await setEst(w, 800, 1500, 300, null, "n", null);
  const w2 = (await search({ status: "all", estimate: "with", limit: 10 })).rows.find((r) => r.item_id === w);
  assert.equal(n(w2.max_bid), 300);
  assert.equal(n(w2.max_base), 673);
  // only one estimate: all three cases are that number
  await setEst(w, 800, null, null, null, "n", null);
  const w3 = (await search({ status: "all", estimate: "with", limit: 10 })).rows.find((r) => r.item_id === w);
  assert.deepEqual([n(w3.v_worst), n(w3.v_base), n(w3.v_best)], [800, 800, 800]);

  const lot = (await t.db.query("select dash_lot($1,$2) r", [dash, LOT_ID])).rows[0].r;
  const c = lot.estimate.cases;
  assert.deepEqual([n(c.worst.value), n(c.base.value), n(c.best.value)], [3000, 3750, 4500]);
  assert.deepEqual([n(c.worst.max), n(c.base.max), n(c.best.max)], [1849, 2326, 2803]);
  assert.equal(n(c.base.fee), 328.75, "the resale fee on the $3,750 base case");
  assert.ok(Math.abs(n(c.base.profit) - (n(c.base.proceeds) - n(lot.lot.high_bid) * 1.25)) < 0.01, "the lot's base-case profit");
  assert.ok(Math.abs(n(c.base.roi) - n(c.base.profit) / (n(lot.lot.high_bid) * 1.25)) < 1e-9, "and its ROI");
  assert.equal(n(c.base.proceeds), 3421.25);
  assert.equal(Number(lot.bid_math.premium), 0.25);
});

test("refresh: chosen lots are reloaded first, once each, and closing prices follow", { skip: skipSale }, async () => {
  const { t, dash, lots, setEst } = await loaded();
  const w = WIENER();
  const third = [...lots.keys()].find((id) => id !== w && id !== LOT_ID);
  const req = async (ids, when) => (await t.db.query("select dash_request_refresh($1,$2::text[],$3::timestamptz) r", [dash, ids, when])).rows[0].r;

  // only open lots with an address are queued; unknown ones are skipped
  let r = await req([w, "no-such-lot"], at(T0, 11));
  assert.deepEqual([r.asked, r.queued, r.skipped, r.waiting], [2, 1, 1, 1]);
  r = await req([LOT_ID], at(T0, 12));
  assert.equal(r.waiting, 2);
  assert.equal((await req([w, LOT_ID], at(T0, 60 * 24 * 10))).queued, 0, "lots that have already closed are not queued");
  await assert.rejects(() => t.db.query("select dash_request_refresh($1,$2::text[])", [dash, Array.from({ length: 61 }, (_, i) => "x" + i)]), /at most 60/);
  assert.equal(await t.count("lots", "tracked and item_id in ('" + w + "')"), 1, "a refreshed lot gets its closing price captured too");

  // a close-out is due, but the refresh goes first
  await t.db.query("update lots set tracked = true, closeout_done = false, ends_at = $2 where item_id = $1", [third, at(T0, -30)]);
  const j1 = await t.next(at(T0, 20));
  assert.deepEqual([j1.kind, j1.item_id], ["detail", w], "the oldest request first");
  assert.match(j1.url, /^https:\/\/www\.ebth\.com\/items\/\d+/);
  const j2 = await t.next(at(T0, 21));
  assert.deepEqual([j2.kind, j2.item_id], ["detail", LOT_ID]);
  // the collector reports back: a lot page records a fresh bid snapshot
  const before = await t.count("snapshots", `item_id = '${LOT_ID}'`);
  await t.ingest(payload(lotDoc(), "/items/14568274-1970-rolex", { job: { kind: "detail", url: j2.url, item_id: LOT_ID } }), at(T0, 22));
  assert.equal(await t.count("snapshots", `item_id = '${LOT_ID}'`), before + 1);
  const j3 = await t.next(at(T0, 23));
  assert.equal(j3.kind, "closeout", "then the ordinary work resumes");
  assert.equal(j3.item_id, third);
  assert.equal(await t.count("refresh_requests", "served_at is null"), 0, "each request is served once");

  // asking again requeues it
  assert.equal((await req([w], at(T0, 30))).queued, 1);
  const st = (await t.db.query("select dash_refresh_status($1, $2::timestamptz) r", [dash, at(T0, 30)])).rows[0].r;
  assert.deepEqual([st.waiting, st.halted, st.paused, st.gap_seconds], [1, false, false, 0]);
  // nothing loads while the collector is stopped, and the status says so
  await t.set("halt", { reason: "test", at: at(T0, 31) });
  assert.equal(await t.next(at(T0, 40)), null);
  assert.equal((await t.db.query("select dash_refresh_status($1, $2::timestamptz) r", [dash, at(T0, 31)])).rows[0].r.halted, true);
  await t.set("halt", null);
  await t.db.exec("set role anon");
  await assert.rejects(() => t.db.query("select dash_request_refresh($1,'{1}'::text[])", [t.token]), /invalid token/);
  await assert.rejects(() => t.db.query("select * from refresh_requests"), /permission denied/);
  await t.db.exec("reset role");
});

test("dealer bid: the worst case less the dealer discount, taken as net cash", async () => {
  const t = await fresh();
  const dash = (await t.one("select value #>> '{}' v from settings where key='dashboard_token'")).v;
  const dc = async (w, bid) => (await t.db.query("select dealer_case_json($1, $2) c", [w, bid])).rows[0].c;
  const n = (x) => Number(x);
  // defaults: 15% dealer discount, 15% margin, 25% premium
  let c = await dc(10000, 4000);
  assert.deepEqual([c.value, c.fee, c.proceeds].map(n), [8500, 0, 8500], "no resale fee comes off a dealer bid");
  assert.equal(n(c.max), 5780, "8,500 x 85% / 1.25");
  assert.equal(n(c.profit), 3500, "8,500 less 4,000 x 1.25");
  assert.equal(n(c.roi), 0.7);
  assert.equal((await dc(10000, 0)).roi, null, "no ROI while the bid is $0");
  assert.equal(await dc(null, 100), null, "no worst case, no dealer bid");
  const m0 = (await t.db.query("select dash_bid_math($1) r", [dash])).rows[0].r;
  assert.equal(n(m0.dealer), 0.15, "the discount is part of the bid math");

  await t.db.query("select dash_set_bid_math($1, 0.25, 0.15, 0.20)", [dash]);
  c = await dc(10000, 4000);
  assert.equal(n(c.value), 8000, "a bigger discount lowers the dealer bid");
  assert.equal(n(c.max), 5440);
  assert.equal(n(c.roi), 0.6);
  await t.db.query("select dash_set_bid_math($1, 0.25, 0.15)", [dash]);
  assert.equal(n((await t.db.query("select dash_bid_math($1) r", [dash])).rows[0].r.dealer), 0.2, "leaving the discount out keeps it");
  await assert.rejects(() => t.db.query("select dash_set_bid_math($1, 0.25, 0.15, 0.95)", [dash]), /dealer discount must be between/);
  await assert.rejects(() => t.db.query("select dash_set_bid_math($1, 0.25, 0.15, 0.1)", [t.token]), /invalid token/);
});

test("dealer bid: on every lot with an estimate, sortable, and on the lot page", { skip: skipSale }, async () => {
  const { t, dash, lots, search, setEst } = await loaded();
  const w = WIENER();
  const third = [...lots.keys()].find((id) => id !== w && id !== LOT_ID);
  await setEst(w, 800, 1500, null, null, "n", null);
  await setEst(LOT_ID, 3000, 4500, null, null, "n", null);
  await setEst(third, 50000, 90000, null, null, "n", null);
  const n = (x) => Number(x);
  const rows = (await search({ status: "all", estimate: "with", limit: 10 })).rows;
  const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));

  assert.deepEqual([w, LOT_ID, third].map((id) => n(by[id].v_dealer)), [680, 2550, 42500], "85% of each worst case");
  for (const id of [w, LOT_ID, third]) {
    const r = by[id];
    const bid = n(r.high_bid ?? 0), next = r.min_next_bid != null ? n(r.min_next_bid) : bid + 1;
    assert.equal(n(r.gap_dealer), n(r.v_dealer) - bid, "headroom over the current bid");
    assert.equal(n(r.max_dealer), Math.floor((n(r.v_dealer) * 0.85) / 1.25), "no resale fee in the dealer max bid");
    assert.equal(n(r.room_dealer), n(r.max_dealer) - next);
    assert.equal(n(r.profit_dealer), n(r.v_dealer) - bid * 1.25);
    if (bid > 0) assert.ok(Math.abs(n(r.roi_dealer) - n(r.profit_dealer) / (bid * 1.25)) < 1e-9);
    else assert.equal(r.roi_dealer, null);
  }

  const all = async (o) => (await search({ status: "all", limit: 200, ...o })).rows;
  const vals = (rs, k) => rs.map((r) => r[k]).filter((v) => v != null).map(n);
  const dDesc = await all({ sort: "dealer", dir: "desc" });
  assert.deepEqual(vals(dDesc, "v_dealer"), [...vals(dDesc, "v_dealer")].sort((a, b) => b - a));
  assert.deepEqual(dDesc.slice(0, 3).map((r) => r.item_id), [third, LOT_ID, w]);
  assert.ok(dDesc.slice(3, 20).every((r) => r.v_dealer == null), "lots without an estimate stay at the bottom");
  const dAsc = await all({ sort: "dealer", dir: "asc" });
  assert.deepEqual(dAsc.slice(0, 3).map((r) => r.item_id), [w, LOT_ID, third]);
  for (const key of ["dealer_gap", "dealer_room", "dealer_roi"]) {
    const field = key === "dealer_gap" ? "gap_dealer" : key === "dealer_room" ? "room_dealer" : "roi_dealer";
    const asc = vals(await all({ sort: key, dir: "asc" }), field), desc = vals(await all({ sort: key, dir: "desc" }), field);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b), `${key} ascending`);
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a), `${key} descending`);
  }

  const lot = (await t.db.query("select dash_lot($1, $2) r", [dash, LOT_ID])).rows[0].r;
  const d = lot.estimate.cases.dealer;
  assert.deepEqual([n(d.value), n(d.fee), n(d.proceeds), n(d.max)], [2550, 0, 2550, 1734], "the lot page carries a dealer case");
  assert.equal(n(lot.bid_math.dealer), 0.15);
  assert.equal(n(lot.estimate.cases.worst.value), 3000, "the other cases are unchanged");
});
