import Link from "next/link";
import type { CombinedRow } from "@/lib/supabase";
import { money, moneyEUR, roiText, signedMoney, timeLeft, when } from "@/lib/format";
import { setStarredCombined } from "./actions";

type Case = "worst" | "base" | "best";
export type ColKey = "name" | "category" | "bid" | "ends" | Case;

const LABELS: Record<Exclude<ColKey, Case>, string> = { name: "Lot", category: "Category", bid: "Bid", ends: "Time left" };
const CASE_LABEL: Record<Case, string> = { worst: "Worst case", base: "Base case", best: "Best case" };
const isCase = (k: ColKey): k is Case => k === "worst" || k === "base" || k === "best";

// Every EBTH lot is already in USD; Catawiki lots carry their native EUR bid alongside the
// USD-converted figure so nothing is hidden, but ROI (currency-free) is what you compare and sort
// by across the two -- the converted dollars are for reading a row, not for ranking it.
export default function CombinedTable({ rows, cols, sort, dir, sortHref, now, trackReturnTo }: {
  rows: CombinedRow[]; cols: ColKey[]; sort: string; dir: string; sortHref: (key: string) => string; now: number; trackReturnTo?: string;
}) {
  const sortLink = (key: string, label: string) => (
    <Link href={sortHref(key)} className="sortlink">
      {label}<span className="sortmark" aria-hidden="true">{key === sort ? (dir === "asc" ? "\u25B2" : "\u25BC") : ""}</span>
    </Link>
  );
  const aria = (key: string) => (key === sort ? (dir === "asc" ? "ascending" : "descending") : "none");
  const groups = cols.filter(isCase);

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {cols.map((key) =>
              isCase(key) ? (
                <th key={key} colSpan={2} className="group">{CASE_LABEL[key]}</th>
              ) : (
                <th key={key} rowSpan={groups.length ? 2 : 1} className={key === sort ? "active" : ""} aria-sort={aria(key)}>
                  {sortLink(key, LABELS[key])}
                </th>
              ),
            )}
          </tr>
          {groups.length > 0 && (
            <tr>
              {groups.flatMap((c) => [
                <th key={c + "v"} className={"grp" + (sort === c ? " active" : "")}>Value (USD)</th>,
                <th key={c + "r"} className={sort === c + "_roi" ? "active" : ""} aria-sort={aria(c + "_roi")}>{sortLink(c + "_roi", "ROI")}</th>,
              ])}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.source + ":" + l.item_id}>
              {cols.map((key) => (isCase(key) ? <CaseCells key={key} c={key} l={l} /> : <Cell key={key} col={key} l={l} now={now} trackReturnTo={trackReturnTo} />))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseCells({ c, l }: { c: Case; l: CombinedRow }) {
  const value = l[`v_${c}_usd` as const];
  const profit = l[`profit_${c}_usd` as const];
  const roi = roiText(l[`roi_${c}` as const]);
  if (value == null) return <><td className="grp"><span className="neg">-</span></td><td><span className="neg">-</span></td></>;
  return (
    <>
      <td className="grp">{money(value)}{c === "base" && l.confidence ? <span className="sub"><span className={`conf ${l.confidence}`} title={`${l.confidence} confidence`} aria-hidden="true" /> {l.confidence} confidence</span> : null}</td>
      <td>{roi ? <><span className={roi.positive ? "pos" : "loss"}>{roi.text}</span><span className="sub">{signedMoney(profit)}</span></> : <span className="neg">-</span>}</td>
    </>
  );
}

function SourceBadge({ source }: { source: CombinedRow["source"] }) {
  return <span className={`chip ${source === "catawiki" ? "" : "go"}`}>{source === "catawiki" ? "Catawiki" : "EBTH"}</span>;
}

export function StarToggle({ id, source, starred, returnTo }: { id: string; source: string; starred: boolean; returnTo: string }) {
  return (
    <form action={setStarredCombined} className="track">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="next" value={starred ? "0" : "1"} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className={starred ? "on" : ""} aria-label={starred ? "Remove from Followed" : "Add to Followed"} title={starred ? "Remove from Followed" : "Add to Followed"}>
        {starred ? "\u2605" : "\u2606"}
      </button>
    </form>
  );
}

function Cell({ col, l, now, trackReturnTo }: { col: Exclude<ColKey, Case>; l: CombinedRow; now: number; trackReturnTo?: string }) {
  switch (col) {
    case "name": {
      const href = l.source === "catawiki" ? `/catawiki/${l.item_id}` : `/lots/${l.item_id}`;
      return (
        <td className="name">
          {trackReturnTo ? <StarToggle id={l.item_id} source={l.source} starred={!!l.starred} returnTo={trackReturnTo} /> : null}
          <SourceBadge source={l.source} />
          <Link href={href}>{l.name ?? l.item_id}</Link>
        </td>
      );
    }
    case "category":
      return <td className="hide-sm">{l.category ?? "-"}</td>;
    case "bid":
      return (
        <td className="num">
          {l.currency === "EUR" ? moneyEUR(l.bid_native) : money(l.bid_native)}
          {l.currency === "EUR" ? <span className="sub">{money(l.bid_usd)}</span> : null}
        </td>
      );
    case "ends": {
      const left = timeLeft(l.ends_at, now);
      return left.label === "closed"
        ? <td><span className="tag">closed {when(l.ends_at)}</span></td>
        : <td><span>{left.label}</span><span className="sub">{when(l.ends_at)}</span></td>;
    }
  }
}
