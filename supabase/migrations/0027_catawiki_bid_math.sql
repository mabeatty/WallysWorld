-- 0027: Catawiki's own worst/base/best-case math, mirroring EBTH's (0012/0013/0015) but built on
-- catawiki_estimates.est_low/est_high -- the user's OWN independent valuation -- rather than
-- Catawiki's own published expert estimate. That published estimate (gap_to_catawiki_estimate,
-- 0022) is left completely unchanged and still shown, but it's the party with a revenue interest
-- in a higher hammer price publishing it, so it stays a labeled reference point, not the primary
-- signal driving sort or the headline number.
--
-- Catawiki has no resale-fee concept the way EBTH does (no tiered schedule has been established
-- for reselling these stamp lots), so a case's value is treated as all-in worth with nothing
-- deducted from it before costs, unlike EBTH where resale_fee(value) comes off first. Catawiki
-- also has no "dealer" quick-flip concept -- nothing here builds one.
--
-- Cost to win at hammer price bid, with shipping_eur specific to that actual lot (not an assumed
-- flat number the way EBTH's is, since Catawiki really does publish a per-lot shipping rate):
--   cost = bid x (1 + buyer_protection_pct) + buyer_protection_flat + shipping_eur
-- Margin is a haircut applied to the case's value before solving for max bid, the same role it
-- plays in EBTH's suggested_max_bid.

insert into settings (key, value) values ('catawiki_target_margin', '0.15'::jsonb) on conflict (key) do nothing;

-- The most you can bid at hammer for a given case value and that lot's actual shipping cost, such
-- that cost stays within (1 - margin) of the value.
create or replace function catawiki_suggested_max_bid(p_value numeric, p_shipping numeric default 0) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select case when p_value is null or p_value <= 0 then null else
    floor((
      p_value * (1 - coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_target_margin'), 0.15))
      - coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_flat'), 3)
      - coalesce(p_shipping, 0)
    ) / (1 + coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_pct'), 0.09))) end;
$$;

-- fee is the buyer protection fee at the given bid (matches the buyer_protection_fee already shown
-- elsewhere) -- it's the same across worst/base/best since it depends on bid, not case value,
-- unlike EBTH's per-case resale fee. proceeds is left out: with no resale fee, it would just equal
-- value, which would be a redundant field rather than a meaningful one.
create or replace function catawiki_case_json(p_value numeric, p_bid numeric, p_shipping numeric default 0) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_value is null or p_value <= 0 then null else jsonb_build_object(
    'value', p_value,
    'fee', round(coalesce(p_bid, 0) * p.pct + p.flat, 2),
    'shipping', coalesce(p_shipping, 0),
    'max', catawiki_suggested_max_bid(p_value, p_shipping),
    'profit', p_value - (coalesce(p_bid, 0) * (1 + p.pct) + p.flat + coalesce(p_shipping, 0)),
    'roi', case when coalesce(p_bid, 0) > 0
                then (p_value - (p_bid * (1 + p.pct) + p.flat + coalesce(p_shipping, 0))) / (p_bid * (1 + p.pct) + p.flat + coalesce(p_shipping, 0)) end)
  end
  from (select coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_pct'), 0.09) as pct,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_flat'), 3) as flat) p;
$$;

create or replace function dash_catawiki_bid_math(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'margin', coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_target_margin'), 0.15),
    'buyer_protection_pct', coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_pct'), 0.09),
    'buyer_protection_flat', coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_flat'), 3));
end $$;

-- Only margin is settable: buyer_protection_pct/flat are facts about Catawiki's real published fee
-- (9% + EUR3), not an assumption to tune the way EBTH's premium/margin/shipping are.
create or replace function dash_set_catawiki_bid_math(p_token text, p_margin numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  if p_margin is null or p_margin < 0 or p_margin >= 0.9 then raise exception 'margin must be between 0%% and 90%%'; end if;
  update settings set value = to_jsonb(p_margin) where key = 'catawiki_target_margin';
end $$;

-- dash_catawiki_lot: adds a 'cases' object (worst/base/best) to the estimate, built from the same
-- catawiki_case_json used per-lot above, and a 'bid_math' object mirroring EBTH's dash_lot shape.
create or replace function dash_catawiki_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lot jsonb; v_est jsonb; v_snaps jsonb; v_bp_pct numeric; v_bp_flat numeric; v_bid numeric; v_ship numeric;
begin
  perform assert_dash_token(p_token);
  v_bp_pct := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_pct'), 0.09);
  v_bp_flat := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_flat'), 3);
  select to_jsonb(l) || jsonb_build_object(
           'auction_name', a.name, 'curator', a.curator,
           'buyer_protection_fee', round(coalesce(l.high_bid, 0) * v_bp_pct + v_bp_flat, 2)
         ), l.high_bid, l.shipping_eur
    into v_lot, v_bid, v_ship
    from catawiki_lots l left join catawiki_auctions a on a.auction_id = l.auction_id
   where l.item_id = p_id;
  select to_jsonb(e) || jsonb_build_object('cases', jsonb_build_object(
           'worst', catawiki_case_json(coalesce(e.est_low, e.est_high), v_bid, v_ship),
           'base', catawiki_case_json(base_case(e.est_low, e.est_high), v_bid, v_ship),
           'best', catawiki_case_json(coalesce(e.est_high, e.est_low), v_bid, v_ship)))
    into v_est
    from catawiki_estimates e where e.item_id = p_id;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.ts), '[]'::jsonb) into v_snaps
    from catawiki_snapshots s where s.item_id = p_id;
  return jsonb_build_object(
    'lot', v_lot,
    'estimate', v_est,
    'bid_math', jsonb_build_object('margin', coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_target_margin'), 0.15),
                                    'buyer_protection_pct', v_bp_pct, 'buyer_protection_flat', v_bp_flat),
    'snapshots', v_snaps
  );
end $$;

-- dash_catawiki_search: adds v_worst/v_base/v_best (from OUR estimate), their max/gap/profit/roi,
-- and new sort keys worst/base/best, worst_gap/base_gap/best_gap, worst_roi/base_roi/best_roi.
-- gap_to_catawiki_estimate and its own 'gap'/'estimate_low' sort keys are untouched -- both
-- figures coexist; the frontend decides which one is the default.
create or replace function dash_catawiki_search(p_token text, p jsonb default '{}'::jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_terms text[] := array(select t from unnest(regexp_split_to_array(lower(trim(coalesce(p->>'q', ''))), '\s+')) t where t <> '');
  v_status text := coalesce(nullif(p->>'status', ''), 'open');
  v_sort_raw text := coalesce(nullif(p->>'sort', ''), 'ends');
  v_dir text := case when p->>'dir' in ('asc', 'desc') then p->>'dir'
                     when v_sort_raw in ('ends', 'name', 'category') then 'asc'
                     else 'desc' end;
  v_cat text := nullif(p->>'category', '');
  v_starred boolean := coalesce(nullif(p->>'starred', '')::boolean, false);
  v_live boolean := coalesce(nullif(p->>'live_format', '')::boolean, false);
  v_est text := coalesce(nullif(p->>'estimate', ''), 'any');
  v_limit int := least(greatest(coalesce(nullif(p->>'limit', '')::int, 50), 1), 200);
  v_offset int := greatest(coalesce(nullif(p->>'offset', '')::int, 0), 0);
  v_bp_pct numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_pct'), 0.09);
  v_bp_flat numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_flat'), 3);
  v_marg numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_target_margin'), 0.15);
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*, a.name as auction_name, a.curator,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           round(coalesce(l.high_bid, 0) * v_bp_pct + v_bp_flat, 2) as buyer_protection_fee,
           case when l.estimate_low is not null then round(l.estimate_low - (coalesce(l.high_bid, 0) * (1 + v_bp_pct) + v_bp_flat), 2) end as gap_to_catawiki_estimate,
           coalesce(e.est_low, e.est_high) as v_worst, base_case(e.est_low, e.est_high) as v_base, coalesce(e.est_high, e.est_low) as v_best
      from catawiki_lots l
      left join catawiki_auctions a on a.auction_id = l.auction_id
      left join catawiki_estimates e using (item_id)
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_cat is null or l.category = v_cat)
       and (not v_starred or l.starred)
       and (not v_live or l.live_format)
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and not exists (select 1 from unnest(v_terms) t
                        where position(dash_unaccent(t) in dash_unaccent(lower(coalesce(l.name, '') || ' ' || coalesce(e.notes, '')))) = 0)
  ), calc as (
    select b.*,
           catawiki_suggested_max_bid(b.v_worst, b.shipping_eur) as max_worst,
           catawiki_suggested_max_bid(b.v_base, b.shipping_eur) as max_base,
           catawiki_suggested_max_bid(b.v_best, b.shipping_eur) as max_best,
           (b.v_worst - coalesce(b.high_bid, 0)) as gap_worst,
           (b.v_base - coalesce(b.high_bid, 0)) as gap_base,
           (b.v_best - coalesce(b.high_bid, 0)) as gap_best,
           b.v_worst - (coalesce(b.high_bid, 0) * (1 + v_bp_pct) + v_bp_flat + coalesce(b.shipping_eur, 0)) as profit_worst,
           b.v_base - (coalesce(b.high_bid, 0) * (1 + v_bp_pct) + v_bp_flat + coalesce(b.shipping_eur, 0)) as profit_base,
           b.v_best - (coalesce(b.high_bid, 0) * (1 + v_bp_pct) + v_bp_flat + coalesce(b.shipping_eur, 0)) as profit_best
      from base b
  ), rooms as (
    select c.*,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_worst / (c.high_bid * (1 + v_bp_pct) + v_bp_flat + coalesce(c.shipping_eur, 0)) end as roi_worst,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_base / (c.high_bid * (1 + v_bp_pct) + v_bp_flat + coalesce(c.shipping_eur, 0)) end as roi_base,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_best / (c.high_bid * (1 + v_bp_pct) + v_bp_flat + coalesce(c.shipping_eur, 0)) end as roi_best
      from calc c
  ), ranked as (
    select b.*, count(*) over () as total,
           row_number() over (order by
             case when v_sort_raw = 'ends' and v_dir = 'asc' then b.ends_at end asc nulls last,
             case when v_sort_raw = 'ends' and v_dir = 'desc' then b.ends_at end desc nulls last,
             case when v_sort_raw = 'bid' and v_dir = 'asc' then b.high_bid end asc nulls last,
             case when v_sort_raw = 'bid' and v_dir = 'desc' then b.high_bid end desc nulls last,
             case when v_sort_raw = 'estimate_low' and v_dir = 'asc' then b.estimate_low end asc nulls last,
             case when v_sort_raw = 'estimate_low' and v_dir = 'desc' then b.estimate_low end desc nulls last,
             case when v_sort_raw = 'gap' and v_dir = 'asc' then b.gap_to_catawiki_estimate end asc nulls last,
             case when v_sort_raw = 'gap' and v_dir = 'desc' then b.gap_to_catawiki_estimate end desc nulls last,
             case when v_sort_raw = 'worst' and v_dir = 'asc' then b.v_worst end asc nulls last,
             case when v_sort_raw = 'worst' and v_dir = 'desc' then b.v_worst end desc nulls last,
             case when v_sort_raw = 'base' and v_dir = 'asc' then b.v_base end asc nulls last,
             case when v_sort_raw = 'base' and v_dir = 'desc' then b.v_base end desc nulls last,
             case when v_sort_raw = 'best' and v_dir = 'asc' then b.v_best end asc nulls last,
             case when v_sort_raw = 'best' and v_dir = 'desc' then b.v_best end desc nulls last,
             case when v_sort_raw = 'worst_gap' and v_dir = 'asc' then b.gap_worst end asc nulls last,
             case when v_sort_raw = 'worst_gap' and v_dir = 'desc' then b.gap_worst end desc nulls last,
             case when v_sort_raw = 'base_gap' and v_dir = 'asc' then b.gap_base end asc nulls last,
             case when v_sort_raw = 'base_gap' and v_dir = 'desc' then b.gap_base end desc nulls last,
             case when v_sort_raw = 'best_gap' and v_dir = 'asc' then b.gap_best end asc nulls last,
             case when v_sort_raw = 'best_gap' and v_dir = 'desc' then b.gap_best end desc nulls last,
             case when v_sort_raw = 'worst_roi' and v_dir = 'asc' then b.roi_worst end asc nulls last,
             case when v_sort_raw = 'worst_roi' and v_dir = 'desc' then b.roi_worst end desc nulls last,
             case when v_sort_raw = 'base_roi' and v_dir = 'asc' then b.roi_base end asc nulls last,
             case when v_sort_raw = 'base_roi' and v_dir = 'desc' then b.roi_base end desc nulls last,
             case when v_sort_raw = 'best_roi' and v_dir = 'asc' then b.roi_best end asc nulls last,
             case when v_sort_raw = 'best_roi' and v_dir = 'desc' then b.roi_best end desc nulls last,
             case when v_sort_raw = 'name' and v_dir = 'asc' then lower(b.name) end asc nulls last,
             case when v_sort_raw = 'name' and v_dir = 'desc' then lower(b.name) end desc nulls last,
             b.ends_at asc nulls last, b.item_id) as rn
      from rooms b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end $$;

revoke all on function dash_catawiki_bid_math(text), dash_set_catawiki_bid_math(text, numeric) from public;
grant execute on function dash_catawiki_bid_math(text), dash_set_catawiki_bid_math(text, numeric) to anon, service_role;
