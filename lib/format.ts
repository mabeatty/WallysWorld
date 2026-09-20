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
