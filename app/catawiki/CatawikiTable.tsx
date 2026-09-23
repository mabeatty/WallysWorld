import Link from "next/link";
import type { CatawikiLot } from "@/lib/supabase";
import { moneyEUR, roiText, signedMoney, timeLeft, when } from "@/lib/format";
import { setCatawikiStarred } from "./actions";

export type ColKey = "name" | "category" | "ends" | "bid" | "fee" | "our_estimate" | "our_gap" | "catawiki_estimate" | "gap";

const LABELS: Record<ColKey, string> = {
  name: "Lot", category: "Category", ends: "Time left", bid: "Bid", fee: "Buyer fee",
  our_estimate: "Our estimate", our_gap: "Our gap (worst case)", catawiki_estimate: "Catawiki estimate", gap: "Catawiki's gap",
};
const HIDE_SM: ColKey[] = ["category", "fee", "catawiki_estimate"];
const NUM: ColKey[] = ["bid", "fee", "our_estimate", "our_gap", "catawiki_estimate", "gap"];

// A star that adds or removes a lot from Followed. Submits immediately, no page reload (the action
// itself doesn't redirect, so Next.js patches the row in place).
export function StarToggle({ id, starred }: { id: string; starred: boolean }) {
  return (
    <form action={setCatawikiStarred} className="track">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="next" value={starred ? "0" : "1"} />
      <button type="submit" className={starred ? "on" : ""} aria-label={starred ? "Remove from Followed" : "Add to Followed"} title={starred ? "Remove from Followed" : "Add to Followed"}>
        {starred ? "\u2605" : "\u2606"}
      </button>
    </form>
  );
}

export default function CatawikiTable({ rows, cols, sort, dir, sortHref, now }: {
  rows: CatawikiLot[]; cols: ColKey[]; sort: string; dir: string; sortHref: (key: string) => string; now: number;
}) {
  const sortable: Record<ColKey, string | null> = {
    name: "name", category: "category", ends: "ends", bid: "bid", fee: null,
    our_estimate: null, our_gap: "worst_gap", catawiki_estimate: "estimate_low", gap: "gap",
  };
  const sortLink = (key: string, label: string) => (
    <Link href={sortHref(key)} className="sortlink">
      {label}<span className="sortmark" aria-hidden="true">{key === sort ? (dir === "asc" ? "\u25B2" : "\u25BC") : ""}</span>
    </Link>
  );
  const aria = (key: string) => (key === sort ? (dir === "asc" ? "ascending" : "descending") : "none");

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {cols.map((key) => {
              const sortKey = sortable[key];
              return (
                <th key={key}
                    className={[NUM.includes(key) ? "num" : "", HIDE_SM.includes(key) ? "hide-sm" : "", sortKey === sort ? "active" : ""].filter(Boolean).join(" ")}
                    aria-sort={sortKey ? aria(sortKey) : undefined}>
                  {sortKey ? sortLink(sortKey, LABELS[key]) : LABELS[key]}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.item_id}>
              {cols.map((key) => <Cell key={key} col={key} l={l} now={now} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ col, l, now }: { col: ColKey; l: CatawikiLot; now: number }) {
  switch (col) {
    case "name":
      return (
        <td className="name">
          <StarToggle id={l.item_id} starred={!!l.starred} />
          <Link href={`/catawiki/${l.item_id}`}>{l.name}</Link>
        </td>
      );
    case "category":
      return <td className="hide-sm">{l.category ?? "-"}</td>;
    case "ends": {
      const left = timeLeft(l.ends_at, now);
      return <td>{left.label === "closed" ? <span className="tag">closed {when(l.ends_at)}</span> : <><span>{left.label}</span><span className="sub">{when(l.ends_at)}</span></>}</td>;
    }
    case "bid":
      return <td className="num">{moneyEUR(l.high_bid)}{l.is_starting_bid ? <span className="sub">starting bid</span> : null}</td>;
    case "fee":
      return <td className="num hide-sm">{moneyEUR(l.buyer_protection_fee)}</td>;
    case "catawiki_estimate":
      return (
        <td className="num hide-sm">
          {l.estimate_low == null ? <span className="neg">-</span> : l.estimate_low === l.estimate_high ? moneyEUR(l.estimate_low) : `${moneyEUR(l.estimate_low)}-${moneyEUR(l.estimate_high)}`}
          {l.curator ? <span className="sub">by {l.curator}</span> : null}
        </td>
      );
    case "gap": {
      const g = l.gap_to_catawiki_estimate;
      if (g == null) return <td className="num"><span className="neg">-</span></td>;
      return <td className="num"><span className={g >= 0 ? "pos" : "neg"}>{signedMoney(g).replace("$", "\u20ac")}</span></td>;
    }
    case "our_estimate":
      return (
        <td className="num">
          {l.est_low == null ? <span className="neg">-</span> : l.est_low === l.est_high ? moneyEUR(l.est_low) : `${moneyEUR(l.est_low)}-${moneyEUR(l.est_high)}`}
          {l.confidence ? <span className="sub"><span className={`conf ${l.confidence}`} title={`${l.confidence} confidence`} aria-hidden="true" /> {l.confidence}</span> : null}
        </td>
      );
    case "our_gap": {
      const g = l.gap_worst;
      if (g == null) return <td className="num"><span className="neg">-</span></td>;
      const roi = roiText(l.roi_worst);
      return (
        <td className="num">
          <span className={g >= 0 ? "pos" : "neg"}>{signedMoney(g).replace("$", "\u20ac")}</span>
          {roi ? <span className="sub"><span className={roi.positive ? "pos" : "loss"}>{roi.text}</span> ROI</span> : null}
        </td>
      );
    }
  }
}
