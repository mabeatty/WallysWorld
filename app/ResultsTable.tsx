import Link from "next/link";
import type { Lot } from "@/lib/supabase";
import { headroom, money, overUnder, roiText, signedMoney, timeLeft, when } from "@/lib/format";
import ValuationCell from "./ValuationCell";
import { setTracked } from "./actions";

type Case = "worst" | "base" | "best";
export type ColKey = "name" | "category" | "bid" | "bids" | "bidders" | "source" | "ends" | Case;

const LABELS: Record<string, string> = {
  name: "Lot", category: "Category", bid: "Bid", bids: "Bids", bidders: "Bidders", source: "Source and date", ends: "Time left",
};
const CASE_LABEL: Record<Case, string> = { worst: "Worst case", base: "Base case", best: "Best case" };
const HIDE_SM: ColKey[] = ["category", "bids", "bidders", "source"];
const NUM: ColKey[] = ["bid", "bids", "bidders"];
const isCase = (k: ColKey): k is Case => k === "worst" || k === "base" || k === "best";
// the worst, base and best cases are each a cluster of four columns
const isGroup = (k: ColKey) => isCase(k);

const FIELDS = {
  worst: { v: "v_worst", gap: "gap_worst", max: "max_worst", room: "room_worst", roi: "roi_worst", profit: "profit_worst" },
  base: { v: "v_base", gap: "gap_base", max: "max_base", room: "room_base", roi: "roi_base", profit: "profit_base" },
  best: { v: "v_best", gap: "gap_best", max: "max_best", room: "room_best", roi: "roi_best", profit: "profit_best" },
} as const;

// One lot table for the whole dashboard. Every column heading sorts; clicking the active one flips the direction.
// Each case is a cluster of four numbers: its value, the headroom over the current bid, over or under its max bid,
// and the ROI you would make at the current bid.
export default function ResultsTable({ rows, cols, sort, dir, sortHref, now, endsStyle = "text", trackReturnTo }: {
  rows: Lot[]; cols: ColKey[]; sort: string; dir: string; sortHref: (key: string) => string; now: number; endsStyle?: "text" | "bar"; trackReturnTo?: string;
}) {
  const sortLink = (key: string, label: string) => (
    <Link href={sortHref(key)} className="sortlink">
      {label}<span className="sortmark" aria-hidden="true">{key === sort ? (dir === "asc" ? "\u25B2" : "\u25BC") : ""}</span>
    </Link>
  );
  const aria = (key: string) => (key === sort ? (dir === "asc" ? "ascending" : "descending") : "none");
  const groups = cols.filter(isGroup);

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {cols.map((key) =>
              isCase(key) ? (
                <th key={key} colSpan={4} className="group">{CASE_LABEL[key]}</th>
              ) : (
                <th
                  key={key} rowSpan={groups.length ? 2 : 1}
                  className={[NUM.includes(key) ? "num" : "", HIDE_SM.includes(key) ? "hide-sm" : "", key === sort ? "active" : ""].filter(Boolean).join(" ")}
                  aria-sort={aria(key)}
                >
                  {sortLink(key, LABELS[key])}
                </th>
              ),
            )}
          </tr>
          {groups.length > 0 && (
            <tr>
              {groups.flatMap((c) => [
                <th key={c + "v"} className={"grp" + (sort === c ? " active" : "")} aria-sort={aria(c)}>{sortLink(c, "Value")}</th>,
                <th key={c + "g"} className={sort === c + "_gap" ? "active" : ""} aria-sort={aria(c + "_gap")}>{sortLink(c + "_gap", "Headroom")}</th>,
                <th key={c + "r"} className={sort === c + "_room" ? "active" : ""} aria-sort={aria(c + "_room")}>{sortLink(c + "_room", "Over / under")}</th>,
                <th key={c + "i"} className={sort === c + "_roi" ? "active" : ""} aria-sort={aria(c + "_roi")}>{sortLink(c + "_roi", "ROI")}</th>,
              ])}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.item_id}>
              {cols.map((key) => (isCase(key) ? <CaseCells key={key} c={key} l={l} now={now} /> : <Cell key={key} col={key} l={l} now={now} endsStyle={endsStyle} trackReturnTo={trackReturnTo} />))}
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
    return <><td className="grp"><span className="neg">-</span></td><td><span className="neg">-</span></td><td><span className="neg">-</span></td><td><span className="neg">-</span></td></>;
  }
  const h = headroom(value, l.high_bid);
  const max = l[f.max];
  const ou = overUnder({ room: l[f.room], max_used: max, ends_at: l.ends_at }, now);
  const roi = roiText(l[f.roi]);
  return (
    <>
      <td className="grp">{money(value)}{c === "base" && l.confidence ? <span className="sub"><span className={`conf ${l.confidence}`} title={`${l.confidence} confidence`} aria-hidden="true" /> {l.confidence} confidence</span> : null}</td>
      <td>{h ? <span className={h.positive ? "pos" : "neg"}>{h.text}</span> : <span className="neg">-</span>}</td>
      <td>
        {ou ? <span className={`chip ${ou.tone}`}>{ou.label}</span> : <span className="neg">-</span>}
        {max != null && ou ? <span className="sub">max {money(max)}</span> : null}
      </td>
      <td>
        {roi ? <><span className={roi.positive ? "pos" : "loss"}>{roi.text}</span><span className="sub">{signedMoney(l[f.profit])}</span></> : <span className="neg">-</span>}
      </td>
    </>
  );
}


// A star that adds or removes a lot from the Followed list. Submits immediately on click.
export function TrackToggle({ id, tracked, returnTo }: { id: string; tracked: boolean; returnTo: string }) {
  return (
    <form action={setTracked} className="track">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="next" value={tracked ? "0" : "1"} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className={tracked ? "on" : ""} aria-label={tracked ? "Remove from Followed" : "Add to Followed"} title={tracked ? "Remove from Followed" : "Add to Followed"}>
        {tracked ? "\u2605" : "\u2606"}
      </button>
    </form>
  );
}

function Cell({ col, l, now, endsStyle, trackReturnTo }: { col: Exclude<ColKey, Case>; l: Lot; now: number; endsStyle: "text" | "bar"; trackReturnTo?: string }) {
  switch (col) {
    case "name":
      return (
        <td className="name">
          {trackReturnTo ? <TrackToggle id={l.item_id} tracked={!!l.tracked} returnTo={trackReturnTo} /> : null}
          <Link href={`/lots/${l.item_id}`}>{l.name ?? l.item_id}</Link>
        </td>
      );
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
