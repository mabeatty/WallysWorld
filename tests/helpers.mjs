import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
export const domFrom = (html) => new JSDOM(html, { url: "https://www.ebth.com/users/followed_items" }).window.document;

process.env.TZ = "America/Chicago";   // card end times are shown in the browser's zone

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const EBTH = require("../extension/lib/ebth.js");
const mig = (f) => fs.readFileSync(path.join(here, "../supabase/migrations", f), "utf8");
export const MIGRATION_0001 = mig("0001_init.sql");
export const MIGRATION = [MIGRATION_0001, mig("0002_breadth.sql"), mig("0003_full_reads_only.sql"), mig("0004_diagnostics_and_hint.sql"), mig("0005_paged_sales.sql"), mig("0006_estimates_and_search.sql"), mig("0007_sortable_columns.sql"), mig("0008_repair_lot_urls.sql"), mig("0009_estimate_source_in_search.sql"), mig("0010_categories.sql"), mig("0011_bid_math_and_refresh.sql"), mig("0012_three_cases.sql")].join("\n");

const fx = path.join(here, "fixtures");
const find = (re) => fs.readdirSync(fx).filter((f) => re.test(f)).map((f) => path.join(fx, f))[0];
export const LOT_FILE = find(/Rolex.*\.html$/);
export const LIST_FILE = find(/^Followed_Items.*\.html$/);
export const SALE_FILE = find(/^SEPTEMBER_REMARKABLE.*\.html$/);
export const HAVE_FIXTURES = !!(LOT_FILE && LIST_FILE);
export const HAVE_SALE = !!SALE_FILE;
export const LOT_ID = "14568274";

export function load(file, url) {
  return new JSDOM(fs.readFileSync(file, "utf8"), { url }).window.document;
}
export const lotDoc = () => load(LOT_FILE, "https://www.ebth.com/items/14568274-1970-rolex");
export const listDoc = () => load(LIST_FILE, "https://www.ebth.com/users/followed_items");
export const SALE_URL = "https://www.ebth.com/sales/90479-september-remarkable-finds";
export const saleDoc = () => load(SALE_FILE, SALE_URL);

// What content.js sends for one page of a sale (page 1 is the plain sale address; later pages are ?page=N).
export function salePayload(doc, { job = null, page = 1, pageSize = 48, mutate } = {}) {
  const sale = EBTH.saleMeta(doc);
  const cards = EBTH.cardItems(doc).slice((page - 1) * pageSize, page * pageSize);
  const items = EBTH.withEndTimes(cards, sale && sale.ends_at);
  const p = { kind: "list", url: SALE_URL, verdict: "ok", note: "", items, lot: null,
              sale: { id: sale.id, name: sale.name, item_count: sale.item_count }, pages: 1,
              job: job ? { ...job, url: SALE_URL + (page > 1 ? "?page=" + page : "") } : null };
  if (mutate) mutate(p);
  return p;
}

// Exactly what content.js + background.js would send for a lot or followed-items page.
export function payload(doc, pathname, { job = null, status = 200, requiresLogin = false, mutate } = {}) {
  const kind = EBTH.pageKind(doc, pathname) || (job && job.kind === "list" ? "list" : "lot");
  const [verdict, note] = EBTH.verdictFrom(EBTH.signals(doc, status), requiresLogin);
  const p = { kind, url: "https://www.ebth.com" + pathname, verdict, note,
              items: EBTH.listItems(doc), lot: kind === "lot" ? EBTH.parseLot(doc) : null, job };
  if (mutate) mutate(p);
  return p;
}

export function sensitiveStrings(file) {
  const doc = load(file, "https://www.ebth.com/");
  const out = new Set();
  doc.querySelectorAll("[data-react-props]").forEach((el) => {
    const d = JSON.parse(el.getAttribute("data-react-props"));
    const u = d.user || {};
    (u.addresses || []).forEach((a) => { if (a.name) out.add(a.name); if (a.line1) out.add(a.line1); });
    [u.bidderNumber, d.stripe_api_key, d.pubnub && d.pubnub.subscribeKey].forEach((x) => { if (x) out.add(String(x)); });
  });
  return [...out];
}
