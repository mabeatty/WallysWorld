import Link from "next/link";
import type { Lot } from "@/lib/supabase";
import { headroom, money, overUnder, range, timeLeft, when } from "@/lib/format";
import ValuationCell from "./ValuationCell";

export type ColKey = "name" | "category" | "bid" | "bids" | "bidders" | "estimate" | "source" | "gap" | "max" | "room" | "ends";

const LABELS: Record<ColKey, string> = {
  name: "Lot", category: "Category", bid: "Bid", bids: "Bids", bidders: "Bidders", estimate: "Your estimate",
  source: "Source and date", gap: "Headroom", max: "Max bid", room: "Over / under", ends: "Time left",
};
const HIDE_SM: ColKey[] = ["category", "bids", "bidders", "source", "gap", "max"];
const NUM: ColKey[] = ["bid", "bids", "bidders"];

// One lot table for the whole dashboard. Every column heading sorts; clicking the active one flips the direction.
export default function ResultsTable({ rows, cols, sort, dir, sortHref, now, endsStyle = "text" }: {
  rows: Lot[]; cols: ColKey[]; sort: string; dir: string; sortHref: (key: string) => string; now: number; endsStyle?: "text" | "bar";
}) {
  return (
    <table>
      <thead>
        <tr>
          {cols.map((key) => (
            <th
              key={key}
              className={[NUM.includes(key) ? "num" : "", HIDE_SM.includes(key) ? "hide-sm" : "", key === sort ? "active" : ""].filter(Boolean).join(" ")}
              aria-sort={key === sort ? (dir === "asc" ? "ascending" : "descending") : "none"}
            >
              <Link href={sortHref(key)} className="sortlink">
                {LABELS[key]}<span className="sortmark" aria-hidden="true">{key === sort ? (dir === "asc" ? "\u25B2" : "\u25BC") : ""}</span>
              </Link>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.item_id}>
            {cols.map((key) => <Cell key={key} col={key} l={l} now={now} endsStyle={endsStyle} />)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cell({ col, l, now, endsStyle }: { col: ColKey; l: Lot; now: number; endsStyle: "text" | "bar" }) {
  switch (col) {
    case "name":
      return <td className="name"><Link href={`/lots/${l.item_id}`}>{l.name ?? l.item_id}</Link></td>;
    case "category":
      return <td className="hide-sm">{l.category ?? "-"}</td>;
    case "bid": {
      const stale = l.snapshot_ts && now - new Date(l.snapshot_ts).getTime() > 30 * 60 * 1000;
      return <td className="num">{money(l.high_bid)}{stale ? <span className="sub">as of {when(l.snapshot_ts)}</span> : null}</td>;
    }
    case "bids":
      return <td className="num hide-sm">{l.bids_count ?? "-"}</td>;
    case "bidders":
      return <td className="num hide-sm">{l.unique_bidders ?? "-"}</td>;
    case "estimate":
      return (
        <td>
          {l.est_low != null || l.est_high != null
            ? <>{range(l.est_low, l.est_high)}{l.confidence ? <span className="sub">{l.confidence} confidence</span> : null}</>
            : <span className="neg">none</span>}
        </td>
      );
    case "source":
      return <td className="hide-sm"><ValuationCell l={l} /></td>;
    case "gap": {
      const h = headroom(l.est_low, l.high_bid);
      return <td className="hide-sm">{h ? <span className={h.positive ? "pos" : "neg"}>{h.text}</span> : <span className="neg">-</span>}</td>;
    }
    case "max":
      return (
        <td className="hide-sm">
          {l.max_used != null ? <>{money(l.max_used)}<span className="sub">{l.max_kind === "yours" ? "your number" : "calculated"}</span></> : <span className="neg">-</span>}
        </td>
      );
    case "room": {
      const ou = overUnder(l, now);
      return <td>{ou ? <span className={`chip ${ou.tone}`}>{ou.label}</span> : <span className="neg">-</span>}</td>;
    }
    case "ends": {
      const left = timeLeft(l.ends_at, now);
      if (endsStyle === "bar") {
        return (
          <td>
            <div className="left">
              <span className="t">{left.label}</span>
              <span className={`bar ${left.pct < 5 ? "urgent" : ""}`}><i style={{ width: `${left.pct}%` }} /></span>
            </div>
          </td>
        );
      }
      return <td>{left.label === "closed" ? <span className="tag">closed {when(l.ends_at)}</span> : <><span>{left.label}</span><span className="sub">{when(l.ends_at)}</span></>}</td>;
    }
  }
}
