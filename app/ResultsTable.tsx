import Link from "next/link";
import type { Lot } from "@/lib/supabase";
import { headroom, money, overUnder, timeLeft, when } from "@/lib/format";
import ValuationCell from "./ValuationCell";

type Case = "worst" | "base" | "best";
export type ColKey = "name" | "category" | "bid" | "bids" | "bidders" | "source" | "ends" | Case;

const LABELS: Record<string, string> = {
  name: "Lot", category: "Category", bid: "Bid", bids: "Bids", bidders: "Bidders", source: "Source and date", ends: "Time left",
};
const CASE_LABEL: Record<Case, string> = { worst: "Worst case", base: "Base case", best: "Best case" };
const HIDE_SM: ColKey[] = ["category", "bids", "bidders", "source"];
const NUM: ColKey[] = ["bid", "bids", "bidders"];
const isCase = (k: ColKey): k is Case => k === "worst" || k === "base" || k === "best";

const FIELDS = {
  worst: { v: "v_worst", gap: "gap_worst", max: "max_worst", room: "room_worst" },
  base: { v: "v_base", gap: "gap_base", max: "max_base", room: "room_base" },
  best: { v: "v_best", gap: "gap_best", max: "max_best", room: "room_best" },
} as const;

// One lot table for the whole dashboard. Every column heading sorts; clicking the active one flips the direction.
// Each case is a cluster of three numbers: its value, the headroom over the current bid, and over or under its max bid.
export default function ResultsTable({ rows, cols, sort, dir, sortHref, now, endsStyle = "text" }: {
  rows: Lot[]; cols: ColKey[]; sort: string; dir: string; sortHref: (key: string) => string; now: number; endsStyle?: "text" | "bar";
}) {
  const sortLink = (key: string, label: string) => (
    <Link href={sortHref(key)} className="sortlink">
      {label}<span className="sortmark" aria-hidden="true">{key === sort ? (dir === "asc" ? "\u25B2" : "\u25BC") : ""}</span>
    </Link>
  );
  const aria = (key: string) => (key === sort ? (dir === "asc" ? "ascending" : "descending") : "none");
  const cases = cols.filter(isCase);

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {cols.map((key) =>
              isCase(key) ? (
                <th key={key} colSpan={3} className="group">{CASE_LABEL[key]}</th>
              ) : (
                <th
                  key={key} rowSpan={cases.length ? 2 : 1}
                  className={[NUM.includes(key) ? "num" : "", HIDE_SM.includes(key) ? "hide-sm" : "", key === sort ? "active" : ""].filter(Boolean).join(" ")}
                  aria-sort={aria(key)}
                >
                  {sortLink(key, LABELS[key])}
                </th>
              ),
            )}
          </tr>
          {cases.length > 0 && (
            <tr>
              {cases.flatMap((c) => [
                <th key={c + "v"} className={"grp" + (sort === c ? " active" : "")} aria-sort={aria(c)}>{sortLink(c, "Value")}</th>,
                <th key={c + "g"} className={sort === c + "_gap" ? "active" : ""} aria-sort={aria(c + "_gap")}>{sortLink(c + "_gap", "Headroom")}</th>,
                <th key={c + "r"} className={sort === c + "_room" ? "active" : ""} aria-sort={aria(c + "_room")}>{sortLink(c + "_room", "Over / under")}</th>,
              ])}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.item_id}>
              {cols.map((key) => (isCase(key) ? <CaseCells key={key} c={key} l={l} now={now} /> : <Cell key={key} col={key} l={l} now={now} endsStyle={endsStyle} />))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseCells({ c, l, now }: { c: Case; l: Lot; now: number }) {
  const f = FIELDS[c];
  const value = l[f.v];
  if (value == null) {
    return <><td className="grp"><span className="neg">-</span></td><td><span className="neg">-</span></td><td><span className="neg">-</span></td></>;
  }
  const h = headroom(value, l.high_bid);
  const max = l[f.max];
  const ou = overUnder({ room: l[f.room], max_used: max, ends_at: l.ends_at }, now);
  return (
    <>
      <td className="grp">{money(value)}{c === "base" && l.confidence ? <span className="sub">{l.confidence} confidence</span> : null}</td>
      <td>{h ? <span className={h.positive ? "pos" : "neg"}>{h.text}</span> : <span className="neg">-</span>}</td>
      <td>
        {ou ? <span className={`chip ${ou.tone}`}>{ou.label}</span> : <span className="neg">-</span>}
        {max != null && ou ? <span className="sub">max {money(max)}</span> : null}
      </td>
    </>
  );
}

function Cell({ col, l, now, endsStyle }: { col: Exclude<ColKey, Case>; l: Lot; now: number; endsStyle: "text" | "bar" }) {
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
    case "source":
      return <td className="hide-sm"><ValuationCell l={l} /></td>;
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
