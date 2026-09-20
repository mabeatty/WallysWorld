import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION, HAVE_FIXTURES, LOT_ID, lotDoc, listDoc, payload } from "./helpers.mjs";

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
