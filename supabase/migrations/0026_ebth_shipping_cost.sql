-- 0026: EBTH charges no buyer's premium, but nearly every lot has a mandatory shipping cost --
-- roughly $40 regardless of hammer price -- that you pay on top of it to take the lot home.
-- Economically that functions exactly like a buyer's premium: a cost added on winning, not
-- proportional to what you resell it for. Until now nothing in the math accounted for it at all.
--
-- EBTH's real per-lot shipping cost is a live, ZIP-code-based carrier quote generated client-side
-- (confirmed by inspecting a real lot page: there's a "Get Estimate" form with a ZIP field, not a
-- static number in the page source) -- the extension can't read it without simulating that quote
-- flow, a materially harder scrape than anything built so far. Until that exists, this uses one
-- assumed flat shipping cost across every lot, configurable on the Setup page like premium/margin.
--
-- This touches suggested_max_bid, case_json and dealer_case_json (the canonical, single-lot-at-a-
-- time functions dash_lot calls) AND dash_search, which -- pre-existing, not introduced here --
-- duplicates case_json's and dealer_case_json's profit/roi/max_dealer formulas inline rather than
-- calling them. Both copies need the same fix or the search/sort view and the single-lot detail
-- page would show different numbers for the same lot.

insert into settings (key, value) values ('assumed_shipping', '40'::jsonb) on conflict (key) do nothing;

-- The most you can pay at the hammer: resale proceeds after fees and margin, less the assumed
-- shipping cost, divided by (1 + buyer's premium).
create or replace function suggested_max_bid(p_low numeric) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select case when p_low is null or p_low <= 0 then null else
    floor((
      (p_low - resale_fee(p_low))
      * (1 - coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15))
      - coalesce((select (value #>> '{}')::numeric from settings where key = 'assumed_shipping'), 40)
    ) / (1 + coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25))) end;
$$;

create or replace function case_json(p_value numeric, p_bid numeric) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_value is null or p_value <= 0 then null else jsonb_build_object(
    'value', p_value,
    'fee', resale_fee(p_value),
    'max', suggested_max_bid(p_value),
    'proceeds', p_value - resale_fee(p_value),
    'profit', (p_value - resale_fee(p_value)) - (coalesce(p_bid, 0) * (1 + p.prem) + p.ship),
    'roi', case when coalesce(p_bid, 0) > 0
                then ((p_value - resale_fee(p_value)) - (p_bid * (1 + p.prem) + p.ship)) / (p_bid * (1 + p.prem) + p.ship) end)
  end
  from (select coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25) as prem,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'assumed_shipping'), 40) as ship) p;
$$;

create or replace function dealer_case_json(p_worst numeric, p_bid numeric) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_worst is null or p_worst <= 0 then null else jsonb_build_object(
    'value', d.v,
    'fee', 0,
    'max', floor((d.v * (1 - p.marg) - p.ship) / (1 + p.prem)),
    'proceeds', d.v,
    'profit', d.v - (coalesce(p_bid, 0) * (1 + p.prem) + p.ship),
    'roi', case when coalesce(p_bid, 0) > 0 then (d.v - (p_bid * (1 + p.prem) + p.ship)) / (p_bid * (1 + p.prem) + p.ship) end)
  end
  from (select coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25) as prem,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15) as marg,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'dealer_discount'), 0.15) as disc,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'assumed_shipping'), 40) as ship) p,
       lateral (select round(p_worst * (1 - p.disc)) as v) d;
$$;

create or replace function dash_bid_math(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'premium', (select (value #>> '{}')::numeric from settings where key = 'buyer_premium'),
    'margin', (select (value #>> '{}')::numeric from settings where key = 'target_margin'),
    'dealer', (select (value #>> '{}')::numeric from settings where key = 'dealer_discount'),
    'shipping', (select (value #>> '{}')::numeric from settings where key = 'assumed_shipping'),
    'tiers', (select value from settings where key = 'fee_tiers'));
end $$;

drop function if exists dash_set_bid_math(text, numeric, numeric, numeric);
create or replace function dash_set_bid_math(p_token text, p_premium numeric, p_margin numeric, p_dealer numeric default null, p_shipping numeric default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  if p_premium is null or p_premium < 0 or p_premium > 1 then raise exception 'buyer''s premium must be between 0%% and 100%%'; end if;
  if p_margin is null or p_margin < 0 or p_margin >= 0.9 then raise exception 'margin must be between 0%% and 90%%'; end if;
  if p_dealer is not null and (p_dealer < 0 or p_dealer >= 0.9) then raise exception 'dealer discount must be between 0%% and 90%%'; end if;
  if p_shipping is not null and (p_shipping < 0 or p_shipping > 1000) then raise exception 'assumed shipping must be between $0 and $1,000'; end if;
  update settings set value = to_jsonb(p_premium) where key = 'buyer_premium';
  update settings set value = to_jsonb(p_margin) where key = 'target_margin';
  if p_dealer is not null then update settings set value = to_jsonb(p_dealer) where key = 'dealer_discount'; end if;
  if p_shipping is not null then update settings set value = to_jsonb(p_shipping) where key = 'assumed_shipping'; end if;
end $$;

-- dash_search: identical to 0021's version except v_ship is now fetched once up front (matching
-- how v_prem/v_marg/v_disc already are, for the same reason -- avoiding a per-row settings lookup)
-- and folded into max_dealer, profit_worst/base/best/dealer and roi_worst/base/best/dealer, the
-- five computed columns that duplicate case_json/dealer_case_json's formulas inline rather than
-- calling them. max_worst/base/best already call suggested_max_bid() and pick up the fix for free.
create or replace function dash_search(p_token text, p jsonb default '{}'::jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_terms text[] := array(select t from unnest(regexp_split_to_array(lower(trim(coalesce(p->>'q', ''))), '\s+')) t where t <> '');
  v_status text := coalesce(nullif(p->>'status', ''), 'open');
  v_sort_raw text := coalesce(nullif(p->>'sort', ''), 'ends');
  v_key text := case v_sort_raw when 'bid_asc' then 'bid' when 'bid_desc' then 'bid'
                  when 'estimate' then 'worst' when 'gap' then 'worst_gap' when 'room' then 'worst_room' when 'max' then 'worst_room'
                  else v_sort_raw end;
  v_dir text := case when p->>'dir' in ('asc', 'desc') then p->>'dir'
                     when v_sort_raw = 'bid_asc' then 'asc'
                     when v_sort_raw in ('ends', 'name', 'category') then 'asc'
                     else 'desc' end;
  v_est text := coalesce(nullif(p->>'estimate', ''), 'any');
  v_sale text := nullif(p->>'sale', '');
  v_cat text := nullif(p->>'category', '');
  v_cats text[] := case when jsonb_typeof(p->'categories') = 'array' then array(select jsonb_array_elements_text(p->'categories')) else null end;
  v_min numeric := nullif(p->>'min_bid', '')::numeric;
  v_max numeric := nullif(p->>'max_bid', '')::numeric;
  v_within numeric := nullif(p->>'within_hours', '')::numeric;
  v_tracked boolean := coalesce(nullif(p->>'tracked', '')::boolean, false);
  v_starred boolean := coalesce(nullif(p->>'starred', '')::boolean, false);
  v_limit int := least(greatest(coalesce(nullif(p->>'limit', '')::int, 50), 1), 200);
  v_offset int := greatest(coalesce(nullif(p->>'offset', '')::int, 0), 0);
  v_prem numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25);
  v_disc numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'dealer_discount'), 0.15);
  v_marg numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15);
  v_ship numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'assumed_shipping'), 40);
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           coalesce(e.est_low, e.est_high) as v_worst, base_case(e.est_low, e.est_high) as v_base, coalesce(e.est_high, e.est_low) as v_best,
           round(coalesce(e.est_low, e.est_high) * (1 - v_disc)) as v_dealer,
           coalesce(l.min_next_bid, coalesce(l.high_bid, 0) + 1) as next_bid
      from lot_latest l left join lots lo on lo.item_id = l.item_id
           left join lot_estimates e on e.item_id = l.item_id
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_min is null or coalesce(l.high_bid, 0) >= v_min)
       and (v_max is null or coalesce(l.high_bid, 0) <= v_max)
       and (v_within is null or (l.ends_at > p_now and l.ends_at <= p_now + make_interval(secs => v_within * 3600)))
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and (not v_tracked or l.tracked)
       and (not v_starred or l.starred)
       and (v_sale is null or l.sale_id = v_sale)
       and (v_cat is null or lo.category = v_cat)
       and (v_cats is null or lo.category = any(v_cats))
       and not exists (select 1 from unnest(v_terms) t
                        where position(dash_unaccent(t) in dash_unaccent(lower(coalesce(l.name, '') || ' ' || coalesce(e.notes, '')))) = 0)
  ), calc as (
    select b.*,
           suggested_max_bid(b.v_worst) as max_worst, suggested_max_bid(b.v_base) as max_base, suggested_max_bid(b.v_best) as max_best,
           (b.v_worst - coalesce(b.high_bid, 0)) as gap_worst, (b.v_base - coalesce(b.high_bid, 0)) as gap_base, (b.v_best - coalesce(b.high_bid, 0)) as gap_best,
           (b.v_dealer - coalesce(b.high_bid, 0)) as gap_dealer,
           floor((b.v_dealer * (1 - v_marg) - v_ship) / (1 + v_prem)) as max_dealer,
           (b.v_worst - resale_fee(b.v_worst)) - (coalesce(b.high_bid, 0) * (1 + v_prem) + v_ship) as profit_worst,
           (b.v_base - resale_fee(b.v_base)) - (coalesce(b.high_bid, 0) * (1 + v_prem) + v_ship) as profit_base,
           (b.v_best - resale_fee(b.v_best)) - (coalesce(b.high_bid, 0) * (1 + v_prem) + v_ship) as profit_best,
           b.v_dealer - (coalesce(b.high_bid, 0) * (1 + v_prem) + v_ship) as profit_dealer
      from base b
  ), rooms as (
    select c.*, (c.max_worst - c.next_bid) as room_worst, (c.max_base - c.next_bid) as room_base, (c.max_best - c.next_bid) as room_best, (c.max_dealer - c.next_bid) as room_dealer,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_worst / (c.high_bid * (1 + v_prem) + v_ship) end as roi_worst,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_base / (c.high_bid * (1 + v_prem) + v_ship) end as roi_base,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_best / (c.high_bid * (1 + v_prem) + v_ship) end as roi_best,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_dealer / (c.high_bid * (1 + v_prem) + v_ship) end as roi_dealer
      from calc c
  ), ranked as (
    select b.*, count(*) over () as total,
           row_number() over (order by
             case when v_key = 'ends' and v_dir = 'asc' then b.ends_at end asc nulls last,
             case when v_key = 'ends' and v_dir = 'desc' then b.ends_at end desc nulls last,
             case when v_key = 'bid' and v_dir = 'asc' then b.high_bid end asc nulls last,
             case when v_key = 'bid' and v_dir = 'desc' then b.high_bid end desc nulls last,
             case when v_key = 'bids' and v_dir = 'asc' then b.bids_count end asc nulls last,
             case when v_key = 'bids' and v_dir = 'desc' then b.bids_count end desc nulls last,
             case when v_key = 'bidders' and v_dir = 'asc' then b.unique_bidders end asc nulls last,
             case when v_key = 'bidders' and v_dir = 'desc' then b.unique_bidders end desc nulls last,
             case when v_key = 'source' and v_dir = 'asc' then b.est_updated end asc nulls last,
             case when v_key = 'source' and v_dir = 'desc' then b.est_updated end desc nulls last,
             case when v_key = 'name' and v_dir = 'asc' then lower(b.name) end asc nulls last,
             case when v_key = 'name' and v_dir = 'desc' then lower(b.name) end desc nulls last,
             case when v_key = 'category' and v_dir = 'asc' then lower(b.category) end asc nulls last,
             case when v_key = 'category' and v_dir = 'desc' then lower(b.category) end desc nulls last,
             case when v_key = 'seen' and v_dir = 'asc' then b.snapshot_ts end asc nulls last,
             case when v_key = 'seen' and v_dir = 'desc' then b.snapshot_ts end desc nulls last,
             case when v_key = 'worst' and v_dir = 'asc' then b.v_worst end asc nulls last,
             case when v_key = 'worst' and v_dir = 'desc' then b.v_worst end desc nulls last,
             case when v_key = 'worst_gap' and v_dir = 'asc' then b.gap_worst end asc nulls last,
             case when v_key = 'worst_gap' and v_dir = 'desc' then b.gap_worst end desc nulls last,
             case when v_key = 'worst_room' and v_dir = 'asc' then b.room_worst end asc nulls last,
             case when v_key = 'worst_room' and v_dir = 'desc' then b.room_worst end desc nulls last,
             case when v_key = 'base' and v_dir = 'asc' then b.v_base end asc nulls last,
             case when v_key = 'base' and v_dir = 'desc' then b.v_base end desc nulls last,
             case when v_key = 'base_gap' and v_dir = 'asc' then b.gap_base end asc nulls last,
             case when v_key = 'base_gap' and v_dir = 'desc' then b.gap_base end desc nulls last,
             case when v_key = 'base_room' and v_dir = 'asc' then b.room_base end asc nulls last,
             case when v_key = 'base_room' and v_dir = 'desc' then b.room_base end desc nulls last,
             case when v_key = 'best' and v_dir = 'asc' then b.v_best end asc nulls last,
             case when v_key = 'best' and v_dir = 'desc' then b.v_best end desc nulls last,
             case when v_key = 'best_gap' and v_dir = 'asc' then b.gap_best end asc nulls last,
             case when v_key = 'best_gap' and v_dir = 'desc' then b.gap_best end desc nulls last,
             case when v_key = 'best_room' and v_dir = 'asc' then b.room_best end asc nulls last,
             case when v_key = 'best_room' and v_dir = 'desc' then b.room_best end desc nulls last,
             case when v_key = 'worst_roi' and v_dir = 'asc' then b.roi_worst end asc nulls last,
             case when v_key = 'worst_roi' and v_dir = 'desc' then b.roi_worst end desc nulls last,
             case when v_key = 'base_roi' and v_dir = 'asc' then b.roi_base end asc nulls last,
             case when v_key = 'base_roi' and v_dir = 'desc' then b.roi_base end desc nulls last,
             case when v_key = 'best_roi' and v_dir = 'asc' then b.roi_best end asc nulls last,
             case when v_key = 'best_roi' and v_dir = 'desc' then b.roi_best end desc nulls last,
             case when v_key = 'dealer' and v_dir = 'asc' then b.v_dealer end asc nulls last,
             case when v_key = 'dealer' and v_dir = 'desc' then b.v_dealer end desc nulls last,
             case when v_key = 'dealer_gap' and v_dir = 'asc' then b.gap_dealer end asc nulls last,
             case when v_key = 'dealer_gap' and v_dir = 'desc' then b.gap_dealer end desc nulls last,
             case when v_key = 'dealer_room' and v_dir = 'asc' then b.room_dealer end asc nulls last,
             case when v_key = 'dealer_room' and v_dir = 'desc' then b.room_dealer end desc nulls last,
             case when v_key = 'dealer_roi' and v_dir = 'asc' then b.roi_dealer end asc nulls last,
             case when v_key = 'dealer_roi' and v_dir = 'desc' then b.roi_dealer end desc nulls last,
             b.ends_at asc nulls last, b.item_id) as rn
      from rooms b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' - 'next_bid' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'sort', v_key, 'dir', v_dir, 'rows', v_rows);
end $$;
