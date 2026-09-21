import Link from "next/link";
import type { RefreshStatus } from "@/lib/supabase";
import { refreshBids } from "./actions";

// Asks the collector to reload these lots' pages so their current bids are recorded.
export function RefreshButton({ ids, returnTo, anchor = "", label = "Refresh bids on these lots" }: { ids: string[]; returnTo: string; anchor?: string; label?: string }) {
  const list = [...new Set(ids)].slice(0, 60);
  if (list.length === 0) return null;
  return (
    <form action={refreshBids} className="refresh">
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="anchor" value={anchor} />
      {list.map((id) => <input key={id} type="hidden" name="id" value={id} />)}
      <button className="quiet" type="submit">{label}{ids.length > 60 ? " (first 60)" : ""}</button>
    </form>
  );
}

export function RefreshNote({ status, refreshed, failed }: { status: RefreshStatus; refreshed: string; failed?: string }) {
  const n = refreshed === "" ? null : Number(refreshed);
  const lines: string[] = [];
  if (failed) lines.push(`Could not queue the refresh: ${failed}`);
  else if (n != null && Number.isFinite(n)) lines.push(n > 0 ? `Asked the collector to reload ${n} lot${n === 1 ? "" : "s"}.` : "Nothing queued: those lots have already closed.");
  if (status.waiting > 0) lines.push(`${status.waiting} lot${status.waiting === 1 ? "" : "s"} waiting to refresh, loaded about one every ${status.gap_seconds} seconds. Reload the page to see new bids.`);
  if (status.halted) lines.push("The collector is stopped, so nothing will load until you resume it on the dashboard.");
  else if (status.paused) lines.push("Collecting is paused, so nothing will load until you resume it on the dashboard.");
  if (lines.length === 0) return null;
  const warn = failed || status.halted || status.paused;
  return (
    <div className={warn ? "banner" : "saved"} role="status">
      {lines.map((t) => <p key={t} style={{ margin: "0 0 4px" }}>{t}</p>)}
      {(status.halted || status.paused) && <Link href="/">Go to the dashboard</Link>}
    </div>
  );
}
