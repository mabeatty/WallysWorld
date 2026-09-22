import Link from "next/link";
import { rpc, type CategoryCount, type RefreshStatus, type Search } from "@/lib/supabase";
import { readSort, nextDir } from "@/lib/sort";
import ResultsTable from "../ResultsTable";
import { RefreshButton, RefreshNote } from "../RefreshControls";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const PER_PAGE = Number(process.env.WATCHES_PER_PAGE) || 50;

// First page, last page, and a window around the current one, with gaps marked.
function pageList(page: number, pages: number) {
  const keep = new Set<number>([1, pages, page - 1, page, page + 1]);
  const out: (number | "gap")[] = [];
  let last = 0;
  for (const p of [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)) {
    if (p - last > 1) out.push("gap");
    out.push(p);
    last = p;
  }
  return out;
}

function Pager({ page, pages, href }: { page: number; pages: number; href: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav className="pages" aria-label="Pages of watches">
      {page > 1 ? <Link href={href(page - 1)}>Previous</Link> : <span className="off">Previous</span>}
      {pageList(page, pages).map((p, i) =>
        p === "gap" ? <span key={"g" + i} className="off">&hellip;</span>
        : p === page ? <b key={p} aria-current="page">{p}</b>
        : <Link key={p} href={href(p)}>{p}</Link>,
      )}
      {page < pages ? <Link href={href(page + 1)}>Next</Link> : <span className="off">Next</span>}
    </nav>
  );
}

export default async function Watches({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const get = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const status = ["open", "closed", "all"].includes(get("status")) ? get("status") : "open";
  const q = get("q").trim();
  const rawSort = get("sort");
  // closed watches read best with the most recent first; everything else with the soonest closing first
  const { sort, dir } = readSort(rawSort, get("dir") || (!rawSort && status === "closed" ? "desc" : ""));
  const page = Math.max(1, parseInt(get("page") || "1", 10) || 1);

  const [r, cats, refresh] = await Promise.all([
    rpc<Search>("dash_search", { p: { q, status, sort, dir, category: "Watches", limit: PER_PAGE, offset: (page - 1) * PER_PAGE } }),
    rpc<CategoryCount[]>("dash_categories"),
    rpc<RefreshStatus>("dash_refresh_status"),
  ]);
  const now = Date.now();
  const w = cats.find((c) => c.category === "Watches");
  const counts = { open: w?.open ?? 0, all: w?.total ?? 0, closed: (w?.total ?? 0) - (w?.open ?? 0) };
  const pages = Math.max(1, Math.ceil(r.total / PER_PAGE));

  const href = (over: Record<string, string> = {}) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("status", status);
    if (rawSort) { u.set("sort", sort); u.set("dir", dir); }
    for (const [k, v] of Object.entries(over)) u.set(k, v);
    return `/watches?${u.toString()}`;
  };
  const sortHref = (key: string) => href({ sort: key, dir: nextDir(sort, dir, key), page: "1" });
  const pageHref = (p: number) => href({ page: String(p) });
  const tabHref = (s: string) => `/watches?${new URLSearchParams({ ...(q ? { q } : {}), status: s }).toString()}`;
  const from = r.total === 0 ? 0 : r.offset + 1;
  const to = Math.min(r.offset + r.rows.length, r.total);
  const openIds = r.rows.filter((l) => l.ends_at && new Date(l.ends_at).getTime() > now).map((l) => l.item_id);
  const word = status === "all" ? "" : status + " ";

  return (
    <>
      <header className="top">
        <h1>Watches</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/collectibles">Collectibles</Link><Link href="/lots">Find lots</Link><Link href="/setup">Setup</Link></nav>
      </header>

      <nav className="tabs" aria-label="Which watches">
        {(["open", "closed", "all"] as const).map((s) => (
          <Link key={s} href={tabHref(s)} className={s === status ? "on" : ""} aria-current={s === status ? "page" : undefined}>
            {s === "open" ? "Open" : s === "closed" ? "Closed" : "All"} <span className="count">{counts[s]}</span>
          </Link>
        ))}
      </nav>

      <form method="get" action="/watches" className="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search the watches, for example rolex, 14K, pocket" aria-label="Search watches" />
        <input type="hidden" name="status" value={status} />
        <button type="submit">Search</button>
      </form>

      <RefreshNote status={refresh} refreshed={get("refreshed")} failed={get("rerror")} />

      <p className="note" style={{ marginTop: 18 }}>
        {r.total === 0
          ? q ? "No watches match that search." : "No watches here."
          : `Showing ${from}-${to} of ${r.total.toLocaleString("en-US")} ${word}watches${q ? ` matching "${q}"` : ""}.`}
        {r.total > 0 && " Click a column heading to sort. Lots you have not valued show dashes in the case columns. Dealer is the worst case less the dealer discount, what a dealer might pay outright."}
      </p>

      {r.rows.length > 0 && (
        <>
          <div className="tools"><RefreshButton ids={openIds} returnTo={pageHref(page)} label="Refresh bids on this page" /></div>
          <Pager page={page} pages={pages} href={pageHref} />
          <ResultsTable
            rows={r.rows} now={now} sort={sort} dir={dir} sortHref={sortHref}
            cols={["name", "ends", "bid", "bids", "bidders", "source", "dealer", "worst", "base", "best"]}
          />
          <Pager page={page} pages={pages} href={pageHref} />
        </>
      )}
    </>
  );
}
