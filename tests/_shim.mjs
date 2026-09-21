// Dev harness: serves the database functions over a PostgREST-shaped HTTP API, backed by a real Postgres
// (pglite) loaded with the migrations and your saved pages. Lets the dashboard be run and checked locally.
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION, EBTH, saleDoc, listDoc, salePayload, payload } from "./helpers.mjs";

const PORT = Number(process.env.SHIM_PORT || 54999);
const db = new PGlite();
await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
await db.exec(MIGRATION);
const tok = async (k) => (await db.query("select value #>> '{}' v from settings where key=$1", [k])).rows[0].v;
const ingestTok = await tok("ingest_token"), dashTok = await tok("dashboard_token");
const now = new Date().toISOString();
const ingest = (p) => db.query("select ingest_page($1,$2::jsonb,$3::timestamptz)", [ingestTok, JSON.stringify(p), now]);
const SALE = "https://www.ebth.com/sales/90479-september-remarkable-finds";
for (let pg = 1; pg <= 7; pg++) await ingest(salePayload(saleDoc(), { job: { kind: "list", url: SALE + (pg > 1 ? "?page=" + pg : "") }, page: pg }));
await ingest(payload(listDoc(), "/users/followed_items", { job: { kind: "list", url: "https://www.ebth.com/users/followed_items", item_id: null }, requiresLogin: true }));
const wiener = EBTH.cardItems(saleDoc()).find((c) => /Ed Wiener/.test(c.name)).item_id;
const est = (id, ...a) => db.query("select dash_set_estimate($1,$2,$3,$4,$5,$6,$7,$8)", [dashTok, id, ...a]);
await est(wiener, 800, 1500, 400, "medium", "Rago $4,063 (2021), Wright $3,024. Verify the signature.", "https://www.ragoarts.com/auctions/2021/05/jewels-watches/153");
await est("14568274", 3000, 4500, 3000, "low", "watch comps", null);
const still = (await db.query("select item_id from lot_latest where ends_at > now() order by ends_at desc limit 2")).rows;
if (still[0]) await est(still[0].item_id, 900, 1400, 700, "medium", "an open lot", null);
if (still[1]) await est(still[1].item_id, 100, 150, 120, "low", "another open lot", null);
console.log(JSON.stringify({ dashTok, wiener }));

const meta = async (fn) => (await db.query(
  `select p.proargnames n, array(select format_type(x,null) from unnest(p.proargtypes::oid[]) with ordinality u(x,i) order by i) t
     from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname=$1`, [fn])).rows[0];

http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const m = req.url.match(/\/rest\/v1\/rpc\/(\w+)/);
  if (!m) { res.writeHead(404); return res.end("{}"); }
  try {
    const args = body ? JSON.parse(body) : {};
    const mt = await meta(m[1]);
    const keys = Object.keys(args).filter((k) => mt.n.includes(k));
    const sql = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${mt.t[mt.n.indexOf(k)]}`).join(", ")}) as r`;
    const vals = keys.map((k) => (mt.t[mt.n.indexOf(k)] === "jsonb" ? JSON.stringify(args[k]) : args[k]));
    const out = (await db.query(sql, vals)).rows[0].r;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(out === null || out === undefined ? "" : JSON.stringify(out));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "P0001", message: String(e.message || e) }));
  }
}).listen(PORT);
