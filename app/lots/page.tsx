import Link from "next/link";
import { rpc, type CategoryCount, type RefreshStatus, type Search } from "@/lib/supabase";
import { readSort, nextDir } from "@/lib/sort";
import ResultsTable from "../ResultsTable";
import { RefreshButton, RefreshNote } from "../RefreshControls";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const PER_PAGE = 50;

const digits = (s: string) => s.replace(/[^0-9.]/g, "");

export default async function FindLots({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const q = get("q").trim();
  const status = ["open", "closed", "all"].includes(get("status")) ? get("status") : "open";
  const { sort, dir } = readSort(get("sort"), get("dir"));
  const estimate = ["any", "with", "without"].includes(get("estimate")) ? get("estimate") : "any";
  const within = digits(get("within"));
  const minBid = digits(get("min_bid"));
  const maxBid = digits(get("max_bid"));
  const tracked = get("tracked") === "on";
  const category = get("category");
  const page = Math.max(1, parseInt(get("page") || "1", 10) || 1);

  const [r, cats, refresh] = await Promise.all([
    rpc<Search>("dash_search", {
      p: {
        q, status, sort, dir, estimate, category,
        min_bid: minBid, max_bid: maxBid, within_hours: within,
        tracked: tracked ? true : undefined,
        limit: PER_PAGE, offset: (page - 1) * PER_PAGE,
      },
    }),
    rpc<CategoryCount[]>("dash_categories"),
    rpc<RefreshStatus>("dash_refresh_status"),
  ]);
  const now = Date.now();

  const base = (over: Record<string, string> = {}) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("status", status); u.set("estimate", estimate);
    if (within) u.set("within", within);
    if (minBid) u.set("min_bid", minBid);
    if (maxBid) u.set("max_bid", maxBid);
    if (tracked) u.set("tracked", "on");
    if (category) u.set("category", category);
    u.set("sort", sort); u.set("dir", dir);
    for (const [k, v] of Object.entries(over)) u.set(k, v);
    return `/lots?${u.toString()}`;
  };
  const pageHref = (p: number) => base({ page: String(p) });
  // clicking a heading starts over at page 1
  const sortHref = (key: string) => base({ sort: key, dir: nextDir(sort, dir, key), page: "1" });
  const from = r.total === 0 ? 0 : r.offset + 1;
  const to = Math.min(r.offset + r.rows.length, r.total);
  const openIds = r.rows.filter((l) => l.ends_at && new Date(l.ends_at).getTime() > now).map((l) => l.item_id);

  return (
    <>
      <header className="top">
        <h1>Find lots</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/watches">Watches</Link><Link href="/setup">Setup</Link></nav>
      </header>

      <form method="get" action="/lots" className="search">
        <input type="search" name="q" defaultValue={q} placeholder="Words from the title or your notes, for example sterling cuff" aria-label="Search lots" autoFocus />
        <button type="submit">Search</button>
      </form>

      <form method="get" action="/lots" className="filters">
        <input type="hidden" name="q" value={q} />
        <label>Show
          <select name="status" defaultValue={status}>
            <option value="open">Open lots</option><option value="closed">Closed lots</option><option value="all">All lots</option>
          </select>
        </label>
        <label>Closes within
          <select name="within" defaultValue={within}>
            <option value="">Any time</option><option value="1">1 hour</option><option value="3">3 hours</option>
            <option value="6">6 hours</option><option value="24">24 hours</option><option value="72">3 days</option>
          </select>
        </label>
        <label>Current bid from
          <input type="text" inputMode="decimal" name="min_bid" defaultValue={minBid} placeholder="$0" />
        </label>
        <label>Current bid up to
          <input type="text" inputMode="decimal" name="max_bid" defaultValue={maxBid} placeholder="no limit" />
        </label>
        <label>Category
          <select name="category" defaultValue={category}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.open} open)</option>)}
          </select>
        </label>
        <label>Your estimate
          <select name="estimate" defaultValue={estimate}>
            <option value="any">Any</option><option value="with">Has an estimate</option><option value="without">No estimate yet</option>
          </select>
        </label>
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <label className="check"><input type="checkbox" name="tracked" defaultChecked={tracked} /> Followed lots only</label>
        <div><button type="submit">Apply filters</button></div>
      </form>

      <RefreshNote status={refresh} refreshed={get("refreshed")} failed={get("rerror")} />

      <p className="note" style={{ marginTop: 18 }}>
        {r.total === 0 ? "No lots match." : `Showing ${from}-${to} of ${r.total.toLocaleString("en-US")} lots.`}
        {r.total === 0 && (q || status !== "open") ? " Try fewer words, or show all lots." : " Click a column heading to sort. Lots without an estimate stay at the bottom when you sort by a case."}
      </p>

      {r.rows.length > 0 && (
        <>
          <div className="tools"><RefreshButton ids={openIds} returnTo={pageHref(page)} label="Refresh bids on these results" /></div>
          <ResultsTable
            rows={r.rows} now={now} sort={sort} dir={dir} sortHref={sortHref}
            cols={["name", "category", "ends", "bid", "bids", "bidders", "source", "worst", "base", "best", "dealer"]}
          />
        </>
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
