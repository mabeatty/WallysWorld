import Link from "next/link";
import { rpc, type CatawikiCategoryCount, type CatawikiSearch } from "@/lib/supabase";
import { readSort, nextDir } from "@/lib/sort";
import CatawikiTable from "./CatawikiTable";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const PER_PAGE = 50;
const digits = (s: string) => s.replace(/[^0-9.]/g, "");

export default async function Catawiki({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const get = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const q = get("q").trim();
  const status = ["open", "closed", "all"].includes(get("status")) ? get("status") : "open";
  const rawSort = get("sort");
  // Our own worst-case gap is the default signal now, not Catawiki's own published estimate --
  // see /areas/catawiki-stamps.md: Catawiki has a revenue interest in a higher hammer price.
  const sortKey = ["ends", "bid", "name", "category", "estimate_low", "gap", "worst", "worst_gap", "worst_roi", "base", "base_gap", "base_roi", "best", "best_gap", "best_roi"].includes(rawSort) ? rawSort : "worst_gap";
  const dir = get("dir") === "asc" || get("dir") === "desc" ? get("dir") : (["gap", "worst_gap", "base_gap", "best_gap", "worst_roi", "base_roi", "best_roi"].includes(sortKey) ? "desc" : nextDir(sortKey, "", sortKey));
  const category = get("category");
  const estimate = ["any", "with", "without"].includes(get("estimate")) ? get("estimate") : "any";
  const starred = get("starred") === "on";
  const liveFormat = get("live") === "on";
  const page = Math.max(1, parseInt(get("page") || "1", 10) || 1);

  const [r, cats] = await Promise.all([
    rpc<CatawikiSearch>("dash_catawiki_search", {
      p: { q, status, sort: sortKey, dir, category, estimate, starred: starred ? true : undefined, live_format: liveFormat ? true : undefined, limit: PER_PAGE, offset: (page - 1) * PER_PAGE },
    }),
    rpc<CatawikiCategoryCount[]>("dash_catawiki_categories"),
  ]);
  const now = Date.now();

  const base = (over: Record<string, string> = {}) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("status", status); u.set("estimate", estimate);
    if (category) u.set("category", category);
    if (starred) u.set("starred", "on");
    if (liveFormat) u.set("live", "on");
    u.set("sort", sortKey); u.set("dir", dir);
    for (const [k, v] of Object.entries(over)) u.set(k, v);
    return `/catawiki?${u.toString()}`;
  };
  const pageHref = (p: number) => base({ page: String(p) });
  const sortHref = (key: string) => base({ sort: key, dir: nextDir(sortKey, dir, key), page: "1" });
  const from = r.total === 0 ? 0 : r.offset + 1;
  const to = Math.min(r.offset + r.rows.length, r.total);

  return (
    <>
      <header className="top">
        <h1>Catawiki</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/watches">Watches</Link><Link href="/collectibles">Collectibles</Link><Link href="/followed">Followed</Link><Link href="/lots">Find lots</Link><Link href="/setup">Setup</Link></nav>
      </header>

      <p className="note">
        Bid and estimate figures are in euros. Buyer fee is Catawiki&apos;s 9% + &euro;3 buyer protection fee on the hammer price.
        &ldquo;Our gap&rdquo; is worst case (your low estimate) minus what you&apos;d actually pay -- bid, fee, and this lot&apos;s real
        shipping cost, plus a margin -- so a positive number is a real bargain by your own judgment, not Catawiki&apos;s. Catawiki&apos;s own
        published estimate and its gap are shown too, for reference only: Catawiki has a revenue interest in a higher hammer price, so
        treat its estimate skeptically rather than as ground truth.
      </p>

      <form method="get" action="/catawiki" className="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search lots, for example scott, yvert, sg" aria-label="Search Catawiki lots" />
        <button type="submit">Search</button>
      </form>

      <form method="get" action="/catawiki" className="filters">
        <input type="hidden" name="q" value={q} />
        <label>Show
          <select name="status" defaultValue={status}>
            <option value="open">Open lots</option><option value="closed">Closed lots</option><option value="all">All lots</option>
          </select>
        </label>
        <label>Category
          <select name="category" defaultValue={category}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.open} open)</option>)}
          </select>
        </label>
        <label>Our estimate
          <select name="estimate" defaultValue={estimate}>
            <option value="any">Any</option><option value="with">Has our estimate</option><option value="without">No estimate yet</option>
          </select>
        </label>
        <input type="hidden" name="sort" value={sortKey} />
        <input type="hidden" name="dir" value={dir} />
        <label className="check"><input type="checkbox" name="starred" defaultChecked={starred} /> Followed lots only</label>
        <label className="check"><input type="checkbox" name="live" defaultChecked={liveFormat} /> Live (rapid-bid) lots only</label>
        <div><button type="submit">Apply filters</button></div>
      </form>

      <p className="note" style={{ marginTop: 18 }}>
        {r.total === 0 ? "No lots match." : `Showing ${from}-${to} of ${r.total.toLocaleString("en-US")} lots.`}
        {r.total > 0 && " Click a column heading to sort. Sorted by our own worst-case gap by default -- the biggest bargains by your own estimate first."}
      </p>

      {r.rows.length > 0 && (
        <>
          <CatawikiTable
            rows={r.rows} now={now} sort={sortKey} dir={dir} sortHref={sortHref}
            cols={["name", "category", "ends", "bid", "fee", "our_estimate", "our_gap", "catawiki_estimate", "gap"]}
          />
          {r.total > PER_PAGE && (
            <div className="pager">
              <span>{page > 1 ? <Link href={pageHref(page - 1)}>Previous</Link> : ""}</span>
              <span>Page {page} of {Math.ceil(r.total / PER_PAGE)}</span>
              <span>{r.offset + r.rows.length < r.total ? <Link href={pageHref(page + 1)}>Next</Link> : ""}</span>
            </div>
          )}
        </>
      )}
    </>
  );
}
