import Link from "next/link";
import { notFound } from "next/navigation";
import { rpc, type Estimate, type Lot } from "@/lib/supabase";
import { dateOnly, headroom, maxBidState, money, range, when } from "@/lib/format";
import { clearEstimate, saveEstimate } from "../../actions";

export const dynamic = "force-dynamic";

type Snap = { ts: string; high_bid: number | null; bids_count: number | null; unique_bidders: number | null; state: string | null; extended: boolean | null };
type Detail = {
  specs?: Record<string, string>; condition?: string | null; images?: string[];
  verified_by?: string | null; categories?: string[]; sale_name?: string | null; catalog_number?: string | null;
};

export default async function LotPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const flag = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const r = await rpc<{ lot: Lot | null; category: string | null; details: Detail | null; estimate: Estimate | null; snapshots: Snap[] }>("dash_lot", { p_id: id });
  if (!r.lot) notFound();
  const l = r.lot;
  const d = r.details ?? {};
  const history = r.snapshots;
  const est = r.estimate;
  const h = est ? headroom(est.est_low, l.high_bid) : null;
  const mb = est ? maxBidState({ max_bid: est.max_bid, min_next_bid: l.min_next_bid, high_bid: l.high_bid, ends_at: l.ends_at }) : null;

  return (
    <>
      <header className="top">
        <h1>{l.name ?? l.item_id}</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/lots">Find lots</Link>{l.url && <a href={l.url}>Open on EBTH</a>}</nav>
      </header>
      <p className="note">
        {[r.category, d.sale_name ?? l.sale_name, d.catalog_number].filter(Boolean).join(", ")}
      </p>

      <div className="facts">
        <div><span>{l.state && l.state !== "for_sale" ? "Last price" : "High bid"}</span><b>{money(l.high_bid)}</b></div>
        <div><span>Bids</span><b>{l.bids_count ?? "-"}</b></div>
        <div><span>Bidders</span><b>{l.unique_bidders ?? "-"}</b></div>
        <div><span>{l.closeout_done ? "Closed" : "Closes"}</span><b>{when(l.ends_at)}</b></div>
      </div>

      {d.images && d.images.length > 0 && (
        <div className="photos">
          {d.images.slice(0, 8).map((src) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src} src={src} alt="" loading="lazy" />
          ))}
        </div>
      )}

      <h2 id="estimate">Your estimate</h2>
      {flag("saved") && <div className="saved" role="status">Estimate saved.</div>}
      {flag("removed") && <div className="saved" role="status">Estimate removed.</div>}
      {flag("error") && <div className="banner" role="alert"><strong>Not saved</strong><p>{flag("error")}</p></div>}
      {est ? (
        <p className="note">
          Worth {range(est.est_low, est.est_high)}{est.confidence ? `, ${est.confidence} confidence` : ""}. Valued {dateOnly(est.updated_at)}.
          {h ? <> Headroom over the current bid: <span className={h.positive ? "pos" : "neg"}>{h.text}</span>.</> : null}
          {mb ? <> <span className={`chip ${mb.tone}`}>{mb.label}</span></> : null}
        </p>
      ) : (
        <p className="note">Nothing recorded yet. Add what you think this lot could resell for, and the most you would bid.</p>
      )}
      <form action={saveEstimate} className="estimate">
        <input type="hidden" name="id" value={l.item_id} />
        <label>Low estimate<input type="text" inputMode="decimal" name="low" defaultValue={est?.est_low ?? ""} placeholder="$" /></label>
        <label>High estimate<input type="text" inputMode="decimal" name="high" defaultValue={est?.est_high ?? ""} placeholder="$" /></label>
        <label>Most you would bid<input type="text" inputMode="decimal" name="max_bid" defaultValue={est?.max_bid ?? ""} placeholder="$" /></label>
        <label>Confidence
          <select name="confidence" defaultValue={est?.confidence ?? ""}>
            <option value="">Not set</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </label>
        <label className="wide">Notes and comps
          <textarea name="notes" defaultValue={est?.notes ?? ""} placeholder="What it is, what similar pieces sold for, what to verify" />
        </label>
        <label className="wide">Sources
          <textarea name="sources" defaultValue={est?.sources ?? ""} placeholder="One link per line" />
        </label>
        <div className="actions"><button type="submit">Save estimate</button></div>
      </form>
      {est && (
        <form action={clearEstimate}>
          <input type="hidden" name="id" value={l.item_id} />
          <button className="quiet" type="submit">Remove estimate</button>
        </form>
      )}

      <h2>Bid history</h2>
      {history.length === 0 ? (
        <p className="empty">No captures yet.</p>
      ) : (
        <>
          <Spark points={history} />
          <table>
            <thead><tr><th>Captured</th><th className="num">High bid</th><th className="num">Bids</th><th className="num">Bidders</th><th>State</th></tr></thead>
            <tbody>
              {[...history].reverse().slice(0, 60).map((h, i) => (
                <tr key={i}>
                  <td>{when(h.ts)}</td>
                  <td className="num">{money(h.high_bid)}</td>
                  <td className="num">{h.bids_count ?? "-"}</td>
                  <td className="num">{h.unique_bidders ?? "-"}</td>
                  <td>{h.state ?? "-"}{h.extended ? ", extended" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {d.specs && Object.keys(d.specs).length > 0 && (
        <>
          <h2>Catalog details</h2>
          <dl className="specs">
            {Object.entries(d.specs).map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>))}
          </dl>
          {d.condition && <p className="note">{d.condition}</p>}
          {d.verified_by && <p className="note">{d.verified_by}</p>}
        </>
      )}
    </>
  );
}

function Spark({ points }: { points: Snap[] }) {
  const pts = points.filter((p) => p.high_bid != null);
  if (pts.length < 2) return null;
  const W = 640, H = 90, pad = 4;
  const t0 = new Date(pts[0].ts).getTime();
  const t1 = new Date(pts[pts.length - 1].ts).getTime() || t0 + 1;
  const lo = Math.min(...pts.map((p) => Number(p.high_bid)));
  const hi = Math.max(...pts.map((p) => Number(p.high_bid)));
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(new Date(p.ts).getTime()).toFixed(1)},${y(Number(p.high_bid)).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`High bid from ${money(lo)} to ${money(hi)}`}>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}
