export const TZ = process.env.DASHBOARD_TZ ?? "America/Chicago";

export function money(n: number | null | undefined) {
  return n == null ? "-" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function when(ts: string | null | undefined) {
  if (!ts) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(ts));
}

export function ago(ts: string | null | undefined, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function timeLeft(ts: string | null | undefined, now = Date.now()) {
  if (!ts) return { label: "-", pct: 0 };
  const ms = new Date(ts).getTime() - now;
  if (ms <= 0) return { label: "closed", pct: 0 };
  const m = Math.floor(ms / 60000);
  const label = m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
  return { label, pct: Math.min(100, Math.round((ms / 86400000) * 100)) };
}

export function range(low: number | null | undefined, high: number | null | undefined) {
  if (low == null && high == null) return "-";
  if (low != null && high != null) return Number(low) === Number(high) ? money(low) : `${money(low)} to ${money(high)}`;
  return low != null ? `${money(low)}+` : `up to ${money(high)}`;
}

// How far the low estimate sits above the current bid: "+$688 (7.1x)". Null without an estimate.
export function headroom(low: number | null | undefined, bid: number | null | undefined) {
  if (low == null) return null;
  const b = Number(bid ?? 0), l = Number(low);
  const gap = l - b;
  const sign = gap >= 0 ? "+" : "-";
  const mult = b > 0 ? ` (${(l / b).toFixed(1)}x)` : "";
  return { text: `${sign}$${Math.abs(Math.round(gap)).toLocaleString("en-US")}${mult}`, positive: gap > 0 };
}

// Where the next bid sits against your max: "Under by $349" (you can still bid) or "Over by $1,501".
export function overUnder(l: { room?: number | null; max_used?: number | null; ends_at?: string | null }, now = Date.now()) {
  if (l.max_used == null || l.room == null) return null;
  if (l.ends_at && new Date(l.ends_at).getTime() <= now) return null;
  const r = Number(l.room);
  return r >= 0
    ? { label: `Under by ${money(r)}`, tone: "go" as const, room: r }
    : { label: `Over by ${money(-r)}`, tone: "over" as const, room: r };
}

// Return on cost as a signed percent: "+118%" or "-34%". Null when there is no bid to measure against.
export function roiText(r: number | null | undefined) {
  if (r == null || !Number.isFinite(Number(r))) return null;
  const pct = Math.round(Number(r) * 100);
  return { text: `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toLocaleString("en-US")}%`, positive: Number(r) >= 0 };
}

// "+$8,045" or "-$1,405".
export function signedMoney(n: number | null | undefined) {
  if (n == null) return "-";
  const v = Math.round(Number(n));
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US")}`;
}

// "Sep 20": the day something was recorded.
export function dateOnly(ts: string | null | undefined) {
  if (!ts) return "-";
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(ts));
}

// Turns the free-text sources of a valuation (one per line, usually links) into a short label for a table cell:
// the first source, as a site name when it is a link, and how many more there are. Only http(s) links become links.
export function valuationSource(sources: string | null | undefined) {
  const lines = (sources ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const first = lines[0];
  let label = first.length > 30 ? first.slice(0, 29) + "\u2026" : first;
  let href: string | null = null;
  if (/^https?:\/\//i.test(first)) {
    try {
      const u = new URL(first);
      label = u.hostname.replace(/^www\./, "");
      href = u.href;
    } catch {
      /* not a usable link: show it as text */
    }
  }
  return { label, href, more: lines.length - 1, title: lines.join("\n") };
}
