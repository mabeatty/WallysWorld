// Server-only. The dashboard holds no database master key: it calls token-protected functions
// with the project's public key plus its own DASHBOARD_TOKEN.
export function publicKeys() {
  return {
    url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    anonKey:
      process.env.SUPABASE_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      "",
  };
}

export async function rpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { url, anonKey } = publicKeys();
  const token = process.env.DASHBOARD_TOKEN;
  if (!url || !anonKey || !token) {
    throw new Error("Missing SUPABASE_URL, SUPABASE_ANON_KEY or DASHBOARD_TOKEN in the Vercel environment variables.");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: anonKey };
  if (anonKey.startsWith("eyJ")) headers.Authorization = `Bearer ${anonKey}`;
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_token: token, ...args }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${name} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}

export type Lot = {
  item_id: string; name: string | null; url: string | null; ends_at: string | null;
  sale_id?: string | null; sale_name: string | null; closeout_done: boolean; tracked?: boolean;
  state: string | null; high_bid: number | null; min_next_bid: number | null;
  bids_count: number | null; unique_bidders: number | null; extended: boolean | null; snapshot_ts: string | null;
  // present on search results when you have entered an estimate
  category?: string | null;
  // worst case (your low estimate), base case (the midpoint) and best case (your high estimate):
  // value, headroom over the current bid, calculated max bid, and how far the next bid sits under that max
  v_worst?: number | null; v_base?: number | null; v_best?: number | null;
  gap_worst?: number | null; gap_base?: number | null; gap_best?: number | null;
  max_worst?: number | null; max_base?: number | null; max_best?: number | null;
  room_worst?: number | null; room_base?: number | null; room_best?: number | null;
  // profit and ROI if you won at the current bid: value less resale fee, less the bid plus buyer's premium
  profit_worst?: number | null; profit_base?: number | null; profit_best?: number | null;
  roi_worst?: number | null; roi_base?: number | null; roi_best?: number | null;
  est_low?: number | null; est_high?: number | null; max_bid?: number | null;
  confidence?: string | null; est_notes?: string | null; est_sources?: string | null; est_updated?: string | null; gap?: number | null;
};

export type Estimate = {
  est_low: number | null; est_high: number | null; max_bid: number | null;
  confidence: string | null; notes: string | null; sources: string | null; updated_at: string;
  cases?: Partial<Record<"worst" | "base" | "best", { value: number; fee: number; max: number; proceeds: number; profit: number; roi: number | null } | null>>;
};

export type Search = { total: number; limit: number; offset: number; rows: Lot[] };

export type CategoryCount = { category: string; open: number; total: number };

export type BidMath = { premium: number; margin: number; tiers: { up_to: number | null; rate: number }[] };

export type RefreshStatus = { waiting: number; halted: boolean; paused: boolean; gap_seconds: number };
