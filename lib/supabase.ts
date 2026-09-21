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
  est_low?: number | null; est_high?: number | null; max_bid?: number | null;
  confidence?: string | null; est_notes?: string | null; est_sources?: string | null; est_updated?: string | null; gap?: number | null;
};

export type Estimate = {
  est_low: number | null; est_high: number | null; max_bid: number | null;
  confidence: string | null; notes: string | null; sources: string | null; updated_at: string;
};

export type Search = { total: number; limit: number; offset: number; rows: Lot[] };
