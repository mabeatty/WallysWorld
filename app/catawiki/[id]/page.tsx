import Link from "next/link";
import { notFound } from "next/navigation";
import { rpc, type CatawikiLotDetail } from "@/lib/supabase";
import { dateOnly, moneyEUR, when } from "@/lib/format";
import { clearCatawikiEstimate, setCatawikiEstimate } from "../actions";
import { StarToggle } from "../CatawikiTable";

export const dynamic = "force-dynamic";

export default async function CatawikiLotPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const flag = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const r = await rpc<CatawikiLotDetail>("dash_catawiki_lot", { p_id: id });
  if (!r.lot) notFound();
  const l = r.lot;
  const est = r.estimate;
  const open = !!l.ends_at && new Date(l.ends_at).getTime() > Date.now();
  const totalCost = l.high_bid != null ? l.high_bid + (l.buyer_protection_fee ?? 0) + (l.shipping_eur ?? 0) : null;

  return (
    <>
      <header className="top">
        <h1><StarToggle id={l.item_id} starred={!!l.starred} />{l.name}</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/catawiki">Catawiki</Link>{l.url && <a href={l.url} target="_blank" rel="noopener noreferrer">Open on Catawiki</a>}</nav>
      </header>
      <p className="note">
        {[l.category, l.auction_name, l.curator ? `curated by ${l.curator}` : null, l.catalog_number].filter(Boolean).join(", ")}
      </p>

      <div className="facts">
        <div><span>{open ? "Current bid" : "Final bid"}</span><b>{moneyEUR(l.high_bid)}</b>{l.is_starting_bid ? <span className="sub">starting bid, no bids yet</span> : null}</div>
        <div><span>Buyer protection fee</span><b>{moneyEUR(l.buyer_protection_fee)}</b></div>
        <div><span>Shipping to US</span><b>{moneyEUR(l.shipping_eur)}</b></div>
        <div><span>{open ? "Closes" : "Closed"}</span><b>{when(l.ends_at)}</b></div>
      </div>

      {l.estimate_low != null && (
        <p className="note" style={{ marginTop: 12 }}>
          Catawiki&apos;s own published estimate: <b>{l.estimate_low === l.estimate_high ? moneyEUR(l.estimate_low) : `${moneyEUR(l.estimate_low)}-${moneyEUR(l.estimate_high)}`}</b>
          {totalCost != null && <> against a total landed cost (bid + fee + shipping) of <b>{moneyEUR(Math.round(totalCost))}</b></>}
        </p>
      )}

      {flag("saved") && <div className="saved" role="status">Estimate saved.</div>}
      {flag("removed") && <div className="saved" role="status">Estimate removed.</div>}
      {flag("error") && <div className="banner" role="alert"><strong>Not saved</strong><p>{flag("error")}</p></div>}

      <h2 id="estimate">Our own estimate</h2>
      <p className="note">Separate from Catawiki&apos;s published estimate above -- use this for your own research when you want a second, independent number.</p>
      {est && (
        <p className="note">
          Valued {dateOnly(est.updated_at)}{est.confidence ? <>, <span className={`conf ${est.confidence}`} title={`${est.confidence} confidence`} aria-hidden="true" /> {est.confidence} confidence</> : null}.
          Range: <b>{moneyEUR(est.est_low)} to {moneyEUR(est.est_high)}</b>{est.max_bid != null && <>, your own max bid <b>{moneyEUR(est.max_bid)}</b></>}.
        </p>
      )}
      <form action={setCatawikiEstimate} className="estimate">
        <input type="hidden" name="id" value={l.item_id} />
        <label>Low estimate (&euro;)<input type="text" inputMode="decimal" name="low" defaultValue={est?.est_low ?? ""} placeholder="&euro;" /></label>
        <label>High estimate (&euro;)<input type="text" inputMode="decimal" name="high" defaultValue={est?.est_high ?? ""} placeholder="&euro;" /></label>
        <label>Your own max bid (&euro;)<input type="text" inputMode="decimal" name="max_bid" defaultValue={est?.max_bid ?? ""} placeholder="&euro;" /></label>
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
        <form action={clearCatawikiEstimate}>
          <input type="hidden" name="id" value={l.item_id} />
          <button className="quiet" type="submit">Remove estimate</button>
        </form>
      )}

      {(l.condition || l.catalog_number || l.description) && (
        <>
          <h2>Catalog details</h2>
          <dl className="specs">
            {l.catalog_number && <><dt>Catalogue number</dt><dd>{l.catalog_number}</dd></>}
            {l.condition && <><dt>Condition</dt><dd>{l.condition}</dd></>}
          </dl>
          {l.description && <p className="note">{l.description}</p>}
        </>
      )}

      <h2>Seller</h2>
      <p className="note">
        {l.seller_name ?? "Unknown"}{l.seller_location ? `, ${l.seller_location}` : ""}
        {l.seller_verified ? ", verified" : ""}
        {l.seller_objects_sold != null ? `, ${l.seller_objects_sold} objects sold` : ""}
        {l.seller_feedback_pct != null ? `, ${l.seller_feedback_pct}% feedback` : ""}
      </p>

      <h2>Bid history</h2>
      {r.snapshots.length === 0 ? (
        <p className="empty">No captures yet.</p>
      ) : (
        <table>
          <thead><tr><th>Captured</th><th className="num">Bid</th><th className="num">Bids</th><th className="num">Watchers</th></tr></thead>
          <tbody>
            {[...r.snapshots].reverse().slice(0, 60).map((s) => (
              <tr key={s.id}>
                <td>{when(s.ts)}</td>
                <td className="num">{moneyEUR(s.high_bid)}</td>
                <td className="num">{s.bids_count ?? "-"}</td>
                <td className="num">{s.watchers_count ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
