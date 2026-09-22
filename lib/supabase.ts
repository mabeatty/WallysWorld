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
  sale_id?: string | null; sale_name: string | null; closeout_done: boolean; tracked?: boolean; starred?: boolean;
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
  // what a dealer might pay outright: the worst case less the dealer discount, net cash (no resale fee)
  v_dealer?: number | null; gap_dealer?: number | null; max_dealer?: number | null; room_dealer?: number | null;
  profit_dealer?: number | null; roi_dealer?: number | null;
  est_low?: number | null; est_high?: number | null; max_bid?: number | null;
  confidence?: string | null; est_notes?: string | null; est_sources?: string | null; est_updated?: string | null; gap?: number | null;
};

export type Estimate = {
  est_low: number | null; est_high: number | null; max_bid: number | null;
  confidence: string | null; notes: string | null; sources: string | null; updated_at: string;
  cases?: Partial<Record<"worst" | "base" | "best" | "dealer", { value: number; fee: number; max: number; proceeds: number; profit: number; roi: number | null } | null>>;
};

export type Search = { total: number; limit: number; offset: number; rows: Lot[] };

export type CategoryCount = { category: string; open: number; total: number };

export type BidMath = { premium: number; margin: number; dealer: number; tiers: { up_to: number | null; rate: number }[] };

export type RefreshStatus = { waiting: number; halted: boolean; paused: boolean; gap_seconds: number };

// Catawiki: a separate platform, separate currency (EUR), separate fee structure (a flat buyer
// protection fee, not EBTH's tiered resale fee), and Catawiki publishes its own expert estimate on
// every lot -- gap_to_catawiki_estimate is that estimate's low end minus what you'd actually pay
// (bid, with the buyer protection fee added), the core arbitrage signal for this platform.
export type CatawikiLot = {
  item_id: string; name: string; url: string; category: string | null;
  ends_at: string | null; high_bid: number | null; is_starting_bid: boolean;
  no_reserve: boolean; reserve_met: boolean | null; live_format: boolean;
  watchers_count: number | null; bids_count: number | null;
  estimate_low: number | null; estimate_high: number | null;
  shipping_eur: number | null; catalog_number: string | null; condition: string | null;
  description: string | null; seller_name: string | null; seller_location: string | null;
  seller_verified: boolean | null; seller_feedback_pct: number | null; seller_objects_sold: number | null;
  auction_id: string | null; auction_name: string | null; curator: string | null;
  buyer_protection_fee: number | null; gap_to_catawiki_estimate?: number | null;
  starred: boolean; tracked: boolean; first_seen: string; snapshot_ts: string | null;
  est_low?: number | null; est_high?: number | null; max_bid?: number | null;
  confidence?: string | null; est_notes?: string | null; est_sources?: string | null; est_updated?: string | null;
};

export type CatawikiSearch = { total: number; limit: number; offset: number; rows: CatawikiLot[] };
export type CatawikiCategoryCount = { category: string; open: number; total: number };
export type CatawikiEstimate = {
  est_low: number | null; est_high: number | null; max_bid: number | null;
  confidence: string | null; notes: string | null; sources: string | null; updated_at: string;
};
export type CatawikiSnapshot = { id: number; ts: string; high_bid: number | null; watchers_count: number | null; bids_count: number | null };
export type CatawikiLotDetail = { lot: CatawikiLot | null; estimate: CatawikiEstimate | null; snapshots: CatawikiSnapshot[] };

export type CatawikiSeed = { name: string; url: string; kind: "auction" | "category"; enabled: boolean; last_job_at: string | null };
export type CatawikiFetch = { id: number; ts: string; source: string; kind: string | null; url: string | null; verdict: string; note: string | null; n_items: number };
export type CatawikiSetupData = { seeds: CatawikiSeed[]; recent: CatawikiFetch[] };
