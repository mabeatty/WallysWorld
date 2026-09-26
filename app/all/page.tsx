import Link from "next/link";
import { rpc, type CategoryCount, type CombinedSearch } from "@/lib/supabase";
import CombinedTable from "./CombinedTable";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const PER_PAGE = 50;
const digits = (s: string) => s.replace(/[^0-9.]/g, "");
const SORT_KEYS = new Set(["ends", "name", "category", "bid", "worst_roi", "base_roi", "best_roi"]);

export default async function AllItems({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const q = get("q").trim();
  const status = ["open", "closed", "all"].includes(get("status")) ? get("status") : "open";
  const sort = SORT_KEYS.has(get("sort")) ? get("sort") : "worst_roi";
  const dir = get("dir") === "asc" || get("dir") === "desc" ? get("dir") : (sort === "ends" || sort === "name" || sort === "category" ? "asc" : "desc");
  const estimate = ["any", "with", "without"].includes(get("estimate")) ? get("estimate") : "any";
  const source = ["ebth", "catawiki"].includes(get("source")) ? get("source") : "";
  const category = get("category");
  const minBid = digits(get("min_bid"));
  const maxBid = digits(get("max_bid"));
  const minRoi = digits(get("min_roi"));
  const page = Math.max(1, parseInt(get("page") || "1", 10) || 1);

  const [r, cats] = await Promise.all([
    rpc<CombinedSearch>("dash_combined_search", {
      p: { q, status, sort, dir, estimate, category, source, min_bid: minBid, max_bid: maxBid, min_roi: minRoi, limit: PER_PAGE, offset: (page - 1) * PER_PAGE },
    }),
    rpc<CategoryCount[]>("dash_combined_categories"),
  ]);
  const now = Date.now();

  const base = (over: Record<string, string> = {}) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("status", status);
    u.set("estimate", estimate);
    if (source) u.set("source", source);
    if (minBid) u.set("min_bid", minBid);
    if (maxBid) u.set("max_bid", maxBid);
    if (minRoi) u.set("min_roi", minRoi);
    if (category) u.set("category", category);
    u.set("sort", sort);
    u.set("dir", dir);
    for (const [k, v] of Object.entries(over)) u.set(k, v);
    return `/all?${u.toString()}`;
  };
  const pageHref = (p: number) => base({ page: String(p) });
  const sortHref = (key: string) => {
    const nextDirFor = key === sort ? (dir === "asc" ? "desc" : "asc") : (key === "ends" || key === "name" || key === "category" ? "asc" : "desc");
    return base({ sort: key, dir: nextDirFor, page: "1" });
  };
  const from = r.total === 0 ? 0 : r.offset + 1;
  const to = Math.min(r.offset + r.rows.length, r.total);

  return (
    <>
      <header className="top">
        <h1>All items</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/lots">Find lots (EBTH)</Link><Link href="/catawiki">Catawiki</Link><Link href="/followed">Followed</Link><Link href="/setup">Setup</Link></nav>
      </header>

      <p className="note">
        Every open lot from EBTH and Catawiki in one list. Catawiki bids are shown in euros with the
        converted dollar figure alongside; sorting is always by ROI (a currency-free ratio), not by
        raw dollars, so the two platforms compare fairly. Currently converting at {r.fx_rate ? `\u20ac1 = $${r.fx_rate}` : "the rate set on Setup"} &mdash;{" "}
        <Link href="/setup#fxrate">update it</Link> if it has drifted.
      </p>

      <form method="get" action="/all" className="search">
        <input type="search" name="q" defaultValue={q} placeholder="Words from the title, for example sterling cuff" aria-label="Search lots" />
        <button type="submit">Search</button>
      </form>

      <form method="get" action="/all" className="filters">
        <input type="hidden" name="q" value={q} />
        <label>Category
          <select name="category" defaultValue={category}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.open} open)</option>)}
          </select>
        </label>
        <label>Source
          <select name="source" defaultValue={source}>
            <option value="">Both</option>
            <option value="ebth">EBTH only</option>
            <option value="catawiki">Catawiki only</option>
          </select>
        </label>
        <label>Show
          <select name="status" defaultValue={status}>
            <option value="open">Open lots</option><option value="closed">Closed lots</option><option value="all">All lots</option>
          </select>
        </label>
        <label>Current bid from
          <input type="text" inputMode="decimal" name="min_bid" defaultValue={minBid} placeholder="$0" />
        </label>
        <label>Current bid up to
          <input type="text" inputMode="decimal" name="max_bid" defaultValue={maxBid} placeholder="no limit" />
        </label>
        <label>Minimum ROI, % (worst case)
          <input type="text" inputMode="decimal" name="min_roi" defaultValue={minRoi} placeholder="no minimum" />
        </label>
        <label>Your estimate
          <select name="estimate" defaultValue={estimate}>
            <option value="any">Any</option><option value="with">Has an estimate</option><option value="without">No estimate yet</option>
          </select>
        </label>
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <div><button type="submit">Apply filters</button></div>
      </form>

      <p className="note" style={{ marginTop: 18 }}>
        {r.total === 0 ? "No lots match." : `Showing ${from}-${to} of ${r.total.toLocaleString("en-US")} lots.`}
        {r.total === 0 && (q || status !== "open" || minRoi) ? " Try fewer words, a lower minimum ROI, or show all lots." : " Click a column heading to sort."}
      </p>

      {r.rows.length > 0 && (
        <CombinedTable
          rows={r.rows} now={now} sort={sort} dir={dir} sortHref={sortHref}
          cols={["name", "category", "ends", "bid", "worst", "base", "best"]}
          trackReturnTo={pageHref(page)}
        />
      )}

      {r.total > PER_PAGE && (
        <div className="pager">
          <span>{page > 1 ? <Link href={pageHref(page - 1)}>Previous</Link> : ""}</span>
          <span>Page {page} of {Math.ceil(r.total / PER_PAGE)}</span>
          <span>{r.offset + r.rows.length < r.total ? <Link href={pageHref(page + 1)}>Next</Link> : ""}</span>
        </div>
      )}
    </>
  );
}
