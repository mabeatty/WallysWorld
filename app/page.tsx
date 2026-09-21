import Link from "next/link";
import { rpc, type CategoryCount, type Lot, type RefreshStatus, type Search } from "@/lib/supabase";
import { ago, money, when } from "@/lib/format";
import { readSort, nextDir } from "@/lib/sort";
import { resume, setPaused } from "./actions";
import ResultsTable from "./ResultsTable";
import { RefreshButton, RefreshNote } from "./RefreshControls";

export const dynamic = "force-dynamic";

type Fetch = { id: number; ts: string; source: string; kind: string | null; url: string | null; verdict: string; note: string | null; n_items: number };

type Home = {
  halt: { reason?: string; at?: string } | null; paused: boolean;
  lots: number; snapshots: number; closeouts: number; jobs_24h: number;
  closing: Lot[]; closed: Lot[]; fetches: Fetch[];
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const cs = readSort(one("sort"), one("dir"));          // Closing soon
  const es = readSort(one("esort"), one("edir"));        // Your estimates
  const [d, ests, closing, status, cats] = await Promise.all([
    rpc<Home>("dash_home"),
    rpc<Search>("dash_search", { p: { status: "open", estimate: "with", sort: es.sort, dir: es.dir, limit: 30 } }),
    rpc<Search>("dash_search", { p: { status: "open", sort: cs.sort, dir: cs.dir, limit: 40 } }),
    rpc<RefreshStatus>("dash_refresh_status"),
    rpc<CategoryCount[]>("dash_categories"),
  ]);
  const watches = cats.find((c) => c.category === "Watches");
  const watchesHref = "/lots?category=Watches&sort=bid&dir=desc";
  const now = new Date();
  const halt = d.halt;
  const paused = d.paused === true;
  const recent = d.fetches;
  const lastOk = recent.find((f) => f.verdict === "ok");
  const state = halt ? "halted" : paused ? "paused" : "collecting";

  // both tables keep their own sort in the address, so sorting one does not reset the other
  const here = (over: Record<string, string> = {}) =>
    "/?" + new URLSearchParams({ sort: cs.sort, dir: cs.dir, esort: es.sort, edir: es.dir, ...over }).toString();
  const closingHref = (key: string) => here({ sort: key, dir: nextDir(cs.sort, cs.dir, key) }) + "#closing";
  const estimatesHref = (key: string) => here({ esort: key, edir: nextDir(es.sort, es.dir, key) }) + "#estimates";

  return (
    <>
      <meta httpEquiv="refresh" content="60" />
      <header className="top">
        <h1>EBTH Watch</h1>
        <nav className="links"><Link href={watchesHref}>Watches</Link><Link href="/lots">Find lots</Link><Link href="/setup">Setup</Link></nav>
      </header>

      <form method="get" action="/lots" className="search">
        <input type="search" name="q" placeholder="Find lots: try sterling, rookwood, wiener" aria-label="Find lots" />
        <button type="submit">Find lots</button>
      </form>

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

      <RefreshNote status={status} refreshed={one("refreshed")} failed={one("rerror")} />

      <div className="facts">
        <div><span>Lots tracked</span><b>{d.lots}</b></div>
        <div><span>Bid snapshots</span><b>{d.snapshots}</b></div>
        <div><span>Closing prices captured</span><b>{d.closeouts}</b></div>
        <div><span>Page loads, last 24h</span><b>{d.jobs_24h}</b></div>
      </div>

      <h2 id="estimates">Your estimates</h2>
      <p className="note">Only the {ests.rows.length} open lot{ests.rows.length === 1 ? "" : "s"} you have valued are listed here. {watches ? <>All {watches.open} open watches: <Link href={watchesHref}>see the full list</Link>. </> : null}Click a heading to sort, for example Over / under to see which are still under your max.</p>
      {ests.rows.length === 0 ? (
        <p className="empty">No estimates yet. Open any lot, or <Link href="/lots">find one</Link>, and add what you think it is worth.</p>
      ) : (
        <>
          <div className="tools"><RefreshButton ids={ests.rows.map((r) => r.item_id)} returnTo={here()} anchor="estimates" /></div>
          <ResultsTable
            rows={ests.rows} now={now.getTime()} sort={es.sort} dir={es.dir} sortHref={estimatesHref}
            cols={["name", "category", "bid", "estimate", "source", "gap", "max", "room", "ends"]}
          />
        </>
      )}

      <h2 id="closing">Closing soon</h2>
      <p className="note">The next 40 lots to close. Click a heading to sort by it. A bid older than half an hour says when it was captured.</p>
      {closing.rows.length === 0 ? (
        <p className="empty">No open lots captured yet.</p>
      ) : (
        <>
          <div className="tools"><RefreshButton ids={closing.rows.map((r) => r.item_id)} returnTo={here()} anchor="closing" /></div>
          <ResultsTable
            rows={closing.rows} now={now.getTime()} sort={cs.sort} dir={cs.dir} sortHref={closingHref} endsStyle="bar"
            cols={["name", "category", "bid", "bids", "bidders", "estimate", "source", "gap", "max", "room", "ends"]}
          />
        </>
      )}

      <h2>Recently closed</h2>
      <p className="note">Last known price. A closing price is confirmed once the collector loads the lot after it ends.</p>
      <ClosedTable lots={d.closed} />

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
    </>
  );
}

function ClosedTable({ lots }: { lots: Lot[] }) {
  if (lots.length === 0) return <p className="empty">No closed lots yet.</p>;
  return (
    <table>
      <thead>
        <tr><th>Lot</th><th className="num">Last price</th><th className="num hide-sm">Bids</th><th className="num hide-sm">Bidders</th><th>Closed</th></tr>
      </thead>
      <tbody>
        {lots.map((l) => (
          <tr key={l.item_id}>
            <td className="name"><Link href={`/lots/${l.item_id}`}>{l.name ?? l.item_id}</Link></td>
            <td className="num">{money(l.high_bid)}</td>
            <td className="num hide-sm">{l.bids_count ?? "-"}</td>
            <td className="num hide-sm">{l.unique_bidders ?? "-"}</td>
            <td><span className={`tag ${l.closeout_done ? "good" : ""}`}>{when(l.ends_at)}{l.closeout_done ? ", price confirmed" : ""}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
