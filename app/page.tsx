import Link from "next/link";
import { rpc, type CategoryCount, type CombinedSearch, type RefreshStatus } from "@/lib/supabase";
import { ago, when } from "@/lib/format";
import { resume, setPaused } from "./actions";
import { RefreshNote } from "./RefreshControls";
import CombinedTable from "./all/CombinedTable";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const PER_PAGE = 50;
const digits = (s: string) => s.replace(/[^0-9.]/g, "");
const SORT_KEYS = new Set(["ends", "name", "category", "bid", "worst_roi", "base_roi", "best_roi"]);

type Fetch = { id: number; ts: string; source: string; kind: string | null; url: string | null; verdict: string; note: string | null; n_items: number };
type Home = { halt: { reason?: string; at?: string } | null; paused: boolean; lots: number; snapshots: number; closeouts: number; jobs_24h: number; fetches: Fetch[] };

export default async function HomePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const get = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const q = get("q").trim();
  const sort = SORT_KEYS.has(get("sort")) ? get("sort") : "worst_roi";
  const dir = get("dir") === "asc" || get("dir") === "desc" ? get("dir") : (sort === "ends" || sort === "name" || sort === "category" ? "asc" : "desc");
  const estimate = ["any", "with", "without"].includes(get("estimate")) ? get("estimate") : "any";
  const source = ["ebth", "catawiki"].includes(get("source")) ? get("source") : "";
  const starred = get("starred") === "on";
  const category = get("category");
  const minBid = digits(get("min_bid"));
  const maxBid = digits(get("max_bid"));
  const minRoi = digits(get("min_roi"));
  const page = Math.max(1, parseInt(get("page") || "1", 10) || 1);

  const [d, r, cats, refresh] = await Promise.all([
    rpc<Home>("dash_home"),
    rpc<CombinedSearch>("dash_combined_search", {
      p: { q, status: "open", sort, dir, estimate, category, source, starred: starred ? true : undefined, min_bid: minBid, max_bid: maxBid, min_roi: minRoi, limit: PER_PAGE, offset: (page - 1) * PER_PAGE },
    }),
    rpc<CategoryCount[]>("dash_combined_categories"),
    rpc<RefreshStatus>("dash_refresh_status"),
  ]);
  const now = Date.now();
  const halt = d.halt;
  const paused = d.paused === true;
  const recent = d.fetches;
  const lastOk = recent.find((f) => f.verdict === "ok");
  const state = halt ? "halted" : paused ? "paused" : "collecting";

  const base = (over: Record<string, string> = {}) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("estimate", estimate);
    if (source) u.set("source", source);
    if (starred) u.set("starred", "on");
    if (minBid) u.set("min_bid", minBid);
    if (maxBid) u.set("max_bid", maxBid);
    if (minRoi) u.set("min_roi", minRoi);
    if (category) u.set("category", category);
    u.set("sort", sort);
    u.set("dir", dir);
    for (const [k, v] of Object.entries(over)) u.set(k, v);
    return `/?${u.toString()}`;
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
      <meta httpEquiv="refresh" content="60" />
      <header className="top">
        <h1>Auction Arbitrage Dashboard</h1>
        <nav className="links"><Link href="/closed">Closed auctions</Link></nav>
      </header>

      <p className="status">
        <span className={`dot ${state === "collecting" ? "" : state}`} />
        {state === "collecting" && <><b>Collecting.</b> Last capture {ago(lastOk?.ts)}.</>}
        {state === "paused" && <><b>Paused.</b> Nothing is being loaded until you resume.</>}
        {state === "halted" && <><b>Stopped.</b> The collector stopped itself and will not load anything until you resume it.</>}
      </p>

      {halt && (
        <div className="banner" role="alert">
          <strong>Why it stopped</strong>
          <p>{halt.reason}{halt.at ? ` (${when(halt.at)})` : ""}</p>
          <p>Check that EBTH loads normally and you are signed in in the browser that runs the extension, then resume.</p>
          <form action={resume}><button type="submit">Resume collecting</button></form>
        </div>
      )}

      <RefreshNote status={refresh} refreshed={get("refreshed")} failed={get("rerror")} />

      <div className="facts">
        <div><span>Lots tracked</span><b>{d.lots}</b></div>
        <div><span>Bid snapshots</span><b>{d.snapshots}</b></div>
        <div><span>Closing prices captured</span><b>{d.closeouts}</b></div>
        <div><span>Page loads, last 24h</span><b>{d.jobs_24h}</b></div>
      </div>

      <p className="note">
        Every open lot from EBTH and Catawiki in one list. Catawiki bids are shown in euros with the
        converted dollar figure alongside; sorting is always by ROI (a currency-free ratio), not by
        raw dollars, so the two platforms compare fairly. Currently converting at {r.fx_rate ? `\u20ac1 = $${r.fx_rate}` : "the rate set on Setup"} &mdash;{" "}
        <Link href="/setup#fxrate">update it</Link> if it has drifted.
      </p>

      <form method="get" action="/" className="search">
        <input type="search" name="q" defaultValue={q} placeholder="Words from the title, for example sterling cuff" aria-label="Search lots" />
        <button type="submit">Search</button>
      </form>

      <form method="get" action="/" className="filters">
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
        <label className="check"><input type="checkbox" name="starred" defaultChecked={starred} /> Followed lots only</label>
        <div><button type="submit">Apply filters</button></div>
      </form>

      <p className="note" style={{ marginTop: 18 }}>
        {r.total === 0 ? "No open lots match." : `Showing ${from}-${to} of ${r.total.toLocaleString("en-US")} open lots.`}
        {r.total === 0 && (q || minRoi) ? " Try fewer words, or a lower minimum ROI." : " Click a column heading to sort."}
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

      <h2>Recent captures</h2>
      {recent.length === 0 ? (
        <p className="empty">Nothing captured yet. Install the extension from the Setup page, then open ebth.com in that browser.</p>
      ) : (
        <table>
          <thead><tr><th>When</th><th>What</th><th className="hide-sm">Page</th><th className="num">Lots</th><th>Result</th></tr></thead>
          <tbody>
            {recent.map((f) => (
              <tr key={f.id}>
                <td>{when(f.ts)}</td>
                <td>{f.source === "passive" ? "You browsed" : f.kind}</td>
                <td className="hide-sm name">{(f.url ?? "").replace("https://www.ebth.com", "")}</td>
                <td className="num">{f.n_items}</td>
                <td><span className={`tag ${f.verdict === "ok" ? "good" : f.verdict === "gone" ? "" : "bad"}`}>{f.verdict}{f.note ? `: ${f.note}` : ""}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form action={setPaused} className="inline" style={{ marginTop: 32 }}>
        <input type="hidden" name="pause" value={paused ? "0" : "1"} />
        <button className="quiet" type="submit">{paused ? "Resume collecting" : "Pause collecting"}</button>
      </form>
      <p className="note" style={{ marginTop: 8 }}><Link href="/setup">Setup</Link></p>
    </>
  );
}
