import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const EBTH = require("../extension/lib/ebth.js");
export const MIGRATION = fs.readFileSync(path.join(here, "../supabase/migrations/0001_init.sql"), "utf8");

const fx = path.join(here, "fixtures");
const find = (re) => fs.readdirSync(fx).filter((f) => re.test(f)).map((f) => path.join(fx, f))[0];
export const LOT_FILE = find(/Rolex.*\.html$/);
export const LIST_FILE = find(/^Followed_Items.*\.html$/);
export const HAVE_FIXTURES = !!(LOT_FILE && LIST_FILE);
export const LOT_ID = "14568274";

export function load(file, url) {
  return new JSDOM(fs.readFileSync(file, "utf8"), { url }).window.document;
}
export const lotDoc = () => load(LOT_FILE, "https://www.ebth.com/items/14568274-1970-rolex");
export const listDoc = () => load(LIST_FILE, "https://www.ebth.com/users/followed_items");

// Exactly what content.js + background.js would send for a page.
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
