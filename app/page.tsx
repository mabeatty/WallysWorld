import Link from "next/link";
import { rpc, type Lot } from "@/lib/supabase";
import { ago, money, timeLeft, when } from "@/lib/format";
import { resume, setPaused } from "./actions";

export const dynamic = "force-dynamic";

type Fetch = { id: number; ts: string; source: string; kind: string | null; url: string | null; verdict: string; note: string | null; n_items: number };

type Home = {
  halt: { reason?: string; at?: string } | null; paused: boolean;
  lots: number; snapshots: number; closeouts: number; jobs_24h: number;
  closing: Lot[]; closed: Lot[]; fetches: Fetch[];
};

export default async function Home() {
  const d = await rpc<Home>("dash_home");
  const now = new Date();
  const halt = d.halt;
  const paused = d.paused === true;
  const recent = d.fetches;
  const lastOk = recent.find((f) => f.verdict === "ok");
  const state = halt ? "halted" : paused ? "paused" : "collecting";

  return (
    <>
      <meta httpEquiv="refresh" content="60" />
      <header className="top">
        <h1>EBTH Watch</h1>
        <nav className="links"><Link href="/setup">Setup</Link></nav>
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

      <div className="facts">
        <div><span>Lots tracked</span><b>{d.lots}</b></div>
        <div><span>Bid snapshots</span><b>{d.snapshots}</b></div>
        <div><span>Closing prices captured</span><b>{d.closeouts}</b></div>
        <div><span>Page loads, last 24h</span><b>{d.jobs_24h}</b></div>
      </div>

      <h2>Closing soon</h2>
      <p className="note">Bars show time left out of the next 24 hours. Bid counts and bidders are from the latest capture.</p>
      <LotTable lots={d.closing} now={now.getTime()} mode="open" />

      <h2>Recently closed</h2>
      <p className="note">Last known price. A closing price is confirmed once the collector loads the lot after it ends.</p>
      <LotTable lots={d.closed} now={now.getTime()} mode="closed" />

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

function LotTable({ lots, now, mode }: { lots: Lot[]; now: number; mode: "open" | "closed" }) {
  if (lots.length === 0) return <p className="empty">{mode === "open" ? "No open lots captured yet." : "No closed lots yet."}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Lot</th>
          <th className="num">{mode === "open" ? "High bid" : "Last price"}</th>
          <th className="num hide-sm">Bids</th>
          <th className="num hide-sm">Bidders</th>
          <th>{mode === "open" ? "Time left" : "Closed"}</th>
        </tr>
      </thead>
      <tbody>
        {lots.map((l) => {
          const left = timeLeft(l.ends_at, now);
          return (
            <tr key={l.item_id}>
              <td className="name"><Link href={`/lots/${l.item_id}`}>{l.name ?? l.item_id}</Link></td>
              <td className="num">{money(l.high_bid)}</td>
              <td className="num hide-sm">{l.bids_count ?? "-"}</td>
              <td className="num hide-sm">{l.unique_bidders ?? "-"}</td>
              <td>
                {mode === "open" ? (
                  <div className="left">
                    <span className="t">{left.label}</span>
                    <span className={`bar ${left.pct < 5 ? "urgent" : ""}`}><i style={{ width: `${left.pct}%` }} /></span>
                  </div>
                ) : (
                  <span className={`tag ${l.closeout_done ? "good" : ""}`}>{when(l.ends_at)}{l.closeout_done ? ", price confirmed" : ""}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
