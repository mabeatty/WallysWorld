import Link from "next/link";
import { rpc, type Search } from "@/lib/supabase";
import { headroom, maxBidState, money, range, timeLeft, when } from "@/lib/format";

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
  const rawSort = get("sort");
  const sort = rawSort === "bid_asc" || rawSort === "bid_desc" ? "bid"
    : ["ends", "bid", "estimate", "gap", "seen", "name"].includes(rawSort) ? rawSort : "ends";
  const defaultDir = (k: string) => (k === "ends" || k === "name" ? "asc" : "desc");
  const dir = get("dir") === "asc" || get("dir") === "desc" ? get("dir")
    : rawSort === "bid_asc" ? "asc" : defaultDir(sort);
  const estimate = ["any", "with", "without"].includes(get("estimate")) ? get("estimate") : "any";
  const within = digits(get("within"));
  const minBid = digits(get("min_bid"));
  const maxBid = digits(get("max_bid"));
  const tracked = get("tracked") === "on";
  const page = Math.max(1, parseInt(get("page") || "1", 10) || 1);

  const r = await rpc<Search>("dash_search", {
    p: {
      q, status, sort, dir, estimate,
      min_bid: minBid, max_bid: maxBid, within_hours: within,
      tracked: tracked ? true : undefined,
      limit: PER_PAGE, offset: (page - 1) * PER_PAGE,
    },
  });
  const now = Date.now();

  const link = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("status", status); u.set("sort", sort); u.set("dir", dir); u.set("estimate", estimate);
    if (within) u.set("within", within);
    if (minBid) u.set("min_bid", minBid);
    if (maxBid) u.set("max_bid", maxBid);
    if (tracked) u.set("tracked", "on");
    u.set("page", String(p));
    return `/lots?${u.toString()}`;
  };
  // Clicking the active column flips its direction; clicking another column starts in that column's natural direction.
  const sortLink = (key: string) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    u.set("status", status); u.set("estimate", estimate);
    if (within) u.set("within", within);
    if (minBid) u.set("min_bid", minBid);
    if (maxBid) u.set("max_bid", maxBid);
    if (tracked) u.set("tracked", "on");
    u.set("sort", key);
    u.set("dir", key === sort ? (dir === "asc" ? "desc" : "asc") : defaultDir(key));
    return `/lots?${u.toString()}`;
  };
  const head = (key: string, label: string, cls = "") => (
    <th className={`${cls} ${key === sort ? "active" : ""}`.trim()} aria-sort={key === sort ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <Link href={sortLink(key)} className="sortlink">
        {label}<span className="sortmark" aria-hidden="true">{key === sort ? (dir === "asc" ? "\u25B2" : "\u25BC") : ""}</span>
      </Link>
    </th>
  );
  const from = r.total === 0 ? 0 : r.offset + 1;
  const to = Math.min(r.offset + r.rows.length, r.total);

  return (
    <>
      <header className="top">
        <h1>Find lots</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/setup">Setup</Link></nav>
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

      <p className="note" style={{ marginTop: 18 }}>
        {r.total === 0 ? "No lots match." : `Showing ${from}-${to} of ${r.total.toLocaleString("en-US")} lots.`}
        {r.total === 0 && (q || status !== "open") ? " Try fewer words, or show all lots." : " Click a column heading to sort. Estimates sort by the low value, and lots without one stay at the bottom."}
      </p>

      {r.rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {head("name", "Lot")}
              {head("bid", "Bid", "num")}
              {head("estimate", "Your estimate")}
              {head("gap", "Headroom", "hide-sm")}
              {head("ends", "Closes")}
            </tr>
          </thead>
          <tbody>
            {r.rows.map((l) => {
              const h = headroom(l.est_low, l.high_bid);
              const mb = maxBidState(l, now);
              const left = timeLeft(l.ends_at, now);
              return (
                <tr key={l.item_id}>
                  <td className="name"><Link href={`/lots/${l.item_id}`}>{l.name ?? l.item_id}</Link></td>
                  <td className="num">{money(l.high_bid)}</td>
                  <td>
                    {l.est_low != null || l.est_high != null ? (
                      <>{range(l.est_low, l.est_high)}{l.confidence ? <span className="sub">{l.confidence} confidence</span> : null}</>
                    ) : <span className="neg">none</span>}
                  </td>
                  <td className="hide-sm">
                    {h ? <span className={h.positive ? "pos" : "neg"}>{h.text}</span> : null}
                    {mb ? <span className={`chip ${mb.tone}`} style={{ marginLeft: h ? 8 : 0 }}>{mb.label}</span> : null}
                  </td>
                  <td>{left.label === "closed" ? <span className="tag">closed {when(l.ends_at)}</span> : <><span>{left.label}</span><span className="sub">{when(l.ends_at)}</span></>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {r.total > PER_PAGE && (
        <div className="pager">
          <span>{page > 1 ? <Link href={link(page - 1)}>Previous</Link> : ""}</span>
          <span>Page {page} of {Math.ceil(r.total / PER_PAGE)}</span>
          <span>{r.offset + r.rows.length < r.total ? <Link href={link(page + 1)}>Next</Link> : ""}</span>
        </div>
      )}
    </>
  );
}
