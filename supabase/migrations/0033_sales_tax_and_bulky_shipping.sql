-- 0033: two real buyer-side costs that were missing everywhere -- sales tax (not modeled at all,
-- on either function) and a shipping figure that scales with what the item actually is, rather
-- than one flat number applied to a $50 stamp lot and a large piece of furniture alike.
--
-- assumed_shipping (a flat $40) was a reasonable stand-in for the categories valued so far --
-- stamps, coins, watches, sterling silver, small collectibles -- where real shipping genuinely
-- clusters in that range. It understates real freight cost badly for Furniture, large Decorative
-- objects, Art, Rugs and textiles, and Lighting, where real shipping commonly runs $150-500+.
-- shipping_for_category() is the one place that decision lives now; every function that computes
-- a cost calls it, rather than each re-deciding bulky-vs-standard on its own.
--
-- Sales tax: applied to the full pre-tax landed cost (hammer * (1 + buyer's premium) + shipping),
-- which is the more conservative assumption where a state's exact tax treatment of shipping is
-- unclear -- worst case should not require guessing generously in your own favor. sales_tax_rate
-- defaults to a generic placeholder (8%) since actual rate depends on the buyer's own state/locality,
-- which this system has no way to know -- update it on Setup to your real combined rate.
--
-- This touches every function that has ever computed an EBTH buyer-side cost, deliberately, because
-- 0026 already flagged the risk of these formulas drifting apart across call sites once shipping
-- alone was added -- adding two more cost terms without touching all of them the same way would
-- reintroduce exactly that class of bug.

insert into settings (key, value) values ('sales_tax_rate', '0.08'::jsonb) on conflict (key) do nothing;
insert into settings (key, value) values ('bulky_shipping', '175'::jsonb) on conflict (key) do nothing;
insert into settings (key, value) values ('bulky_categories', '["Furniture","Rugs and textiles","Lighting","Decorative objects","Art"]'::jsonb) on conflict (key) do nothing;

create or replace function shipping_for_category(p_category text) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select case
    when p_category is not null and p_category = any(array(
           select jsonb_array_elements_text(coalesce((select value from settings where key = 'bulky_categories'), '[]'::jsonb))))
      then coalesce((select (value #>> '{}')::numeric from settings where key = 'bulky_shipping'), 175)
    else coalesce((select (value #>> '{}')::numeric from settings where key = 'assumed_shipping'), 40)
  end;
$$;

-- these three all gained an extra p_category parameter, which Postgres treats as a distinct
-- overload rather than a replacement of the 2-argument version (CREATE OR REPLACE only replaces
-- a function whose argument types exactly match) -- leaving the old overloads in place makes any
-- 2-argument call ambiguous between old and new, so they're dropped first. Same pattern this file
-- already uses below for dash_set_bid_math. Order matters here: the old case_json(numeric,numeric)
-- calls the old suggested_max_bid(numeric) internally, so case_json must be dropped before
-- suggested_max_bid, or the suggested_max_bid drop fails on that dependency.
drop function if exists case_json(numeric, numeric);
drop function if exists suggested_max_bid(numeric);
create or replace function suggested_max_bid(p_low numeric, p_category text default null) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select case when p_low is null or p_low <= 0 then null else
    floor((
      (p_low - resale_fee(p_low))
      * (1 - coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15))
      - shipping_for_category(p_category)
    ) / ((1 + coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25))
         * (1 + coalesce((select (value #>> '{}')::numeric from settings where key = 'sales_tax_rate'), 0.08)))) end;
$$;

create or replace function case_json(p_value numeric, p_bid numeric, p_category text default null) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_value is null or p_value <= 0 then null else jsonb_build_object(
    'value', p_value,
    'fee', resale_fee(p_value),
    'max', suggested_max_bid(p_value, p_category),
    'proceeds', p_value - resale_fee(p_value),
    'profit', (p_value - resale_fee(p_value)) - (coalesce(p_bid, 0) * (1 + p.prem) + p.ship) * (1 + p.tax),
    'roi', case when coalesce(p_bid, 0) > 0
                then ((p_value - resale_fee(p_value)) - (p_bid * (1 + p.prem) + p.ship) * (1 + p.tax))
                     / ((p_bid * (1 + p.prem) + p.ship) * (1 + p.tax)) end)
  end
  from (select coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25) as prem,
               shipping_for_category(p_category) as ship,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'sales_tax_rate'), 0.08) as tax) p;
$$;

drop function if exists dealer_case_json(numeric, numeric);
create or replace function dealer_case_json(p_worst numeric, p_bid numeric, p_category text default null) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_worst is null or p_worst <= 0 then null else jsonb_build_object(
    'value', d.v,
    'fee', 0,
    'max', floor((d.v * (1 - p.marg) - p.ship) / ((1 + p.prem) * (1 + p.tax))),
    'proceeds', d.v,
    'profit', d.v - (coalesce(p_bid, 0) * (1 + p.prem) + p.ship) * (1 + p.tax),
    'roi', case when coalesce(p_bid, 0) > 0
                then (d.v - (p_bid * (1 + p.prem) + p.ship) * (1 + p.tax)) / ((p_bid * (1 + p.prem) + p.ship) * (1 + p.tax)) end)
  end
  from (select coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25) as prem,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15) as marg,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'dealer_discount'), 0.15) as disc,
               shipping_for_category(p_category) as ship,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'sales_tax_rate'), 0.08) as tax) p,
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
    'tax', (select (value #>> '{}')::numeric from settings where key = 'sales_tax_rate'),
    'bulky_shipping', (select (value #>> '{}')::numeric from settings where key = 'bulky_shipping'),
    'bulky_categories', (select value from settings where key = 'bulky_categories'),
    'tiers', (select value from settings where key = 'fee_tiers'));
end $$;

drop function if exists dash_set_bid_math(text, numeric, numeric, numeric, numeric);
create or replace function dash_set_bid_math(p_token text, p_premium numeric, p_margin numeric, p_dealer numeric default null,
                                              p_shipping numeric default null, p_tax numeric default null, p_bulky_shipping numeric default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  if p_premium is null or p_premium < 0 or p_premium > 1 then raise exception 'buyer''s premium must be between 0%% and 100%%'; end if;
  if p_margin is null or p_margin < 0 or p_margin >= 0.9 then raise exception 'margin must be between 0%% and 90%%'; end if;
  if p_dealer is not null and (p_dealer < 0 or p_dealer >= 0.9) then raise exception 'dealer discount must be between 0%% and 90%%'; end if;
  if p_shipping is not null and (p_shipping < 0 or p_shipping > 1000) then raise exception 'assumed shipping must be between $0 and $1,000'; end if;
  if p_tax is not null and (p_tax < 0 or p_tax > 0.5) then raise exception 'sales tax rate must be between 0%% and 50%%'; end if;
  if p_bulky_shipping is not null and (p_bulky_shipping < 0 or p_bulky_shipping > 3000) then raise exception 'bulky-item shipping must be between $0 and $3,000'; end if;
  update settings set value = to_jsonb(p_premium) where key = 'buyer_premium';
  update settings set value = to_jsonb(p_margin) where key = 'target_margin';
  if p_dealer is not null then update settings set value = to_jsonb(p_dealer) where key = 'dealer_discount'; end if;
  if p_shipping is not null then update settings set value = to_jsonb(p_shipping) where key = 'assumed_shipping'; end if;
  if p_tax is not null then update settings set value = to_jsonb(p_tax) where key = 'sales_tax_rate'; end if;
  if p_bulky_shipping is not null then update settings set value = to_jsonb(p_bulky_shipping) where key = 'bulky_shipping'; end if;
end $$;

-- dash_search: same restructure as 0026 did for shipping alone -- v_ship becomes per-row (it now
-- depends on each lot's own category, not one constant), and v_tax_rate is folded into every cost
-- term the same way v_ship already was. max_worst/base/best still call suggested_max_bid(), which
-- picks up both changes for free; the five inline-duplicated fields (max_dealer, profit_worst/
-- base/best/dealer, roi_worst/base/best/dealer) are updated explicitly here, same as before.
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
  v_tax numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'sales_tax_rate'), 0.08);
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           coalesce(e.est_low, e.est_high) as v_worst, base_case(e.est_low, e.est_high) as v_base, coalesce(e.est_high, e.est_low) as v_best,
           round(coalesce(e.est_low, e.est_high) * (1 - v_disc)) as v_dealer,
           shipping_for_category(lo.category) as v_ship,
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
           suggested_max_bid(b.v_worst, b.category) as max_worst, suggested_max_bid(b.v_base, b.category) as max_base, suggested_max_bid(b.v_best, b.category) as max_best,
           (b.v_worst - coalesce(b.high_bid, 0)) as gap_worst, (b.v_base - coalesce(b.high_bid, 0)) as gap_base, (b.v_best - coalesce(b.high_bid, 0)) as gap_best,
           (b.v_dealer - coalesce(b.high_bid, 0)) as gap_dealer,
           floor((b.v_dealer * (1 - v_marg) - b.v_ship) / ((1 + v_prem) * (1 + v_tax))) as max_dealer,
           (b.v_worst - resale_fee(b.v_worst)) - (coalesce(b.high_bid, 0) * (1 + v_prem) + b.v_ship) * (1 + v_tax) as profit_worst,
           (b.v_base - resale_fee(b.v_base)) - (coalesce(b.high_bid, 0) * (1 + v_prem) + b.v_ship) * (1 + v_tax) as profit_base,
           (b.v_best - resale_fee(b.v_best)) - (coalesce(b.high_bid, 0) * (1 + v_prem) + b.v_ship) * (1 + v_tax) as profit_best,
           b.v_dealer - (coalesce(b.high_bid, 0) * (1 + v_prem) + b.v_ship) * (1 + v_tax) as profit_dealer
      from base b
  ), rooms as (
    select c.*, (c.max_worst - c.next_bid) as room_worst, (c.max_base - c.next_bid) as room_base, (c.max_best - c.next_bid) as room_best, (c.max_dealer - c.next_bid) as room_dealer,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_worst / ((c.high_bid * (1 + v_prem) + c.v_ship) * (1 + v_tax)) end as roi_worst,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_base / ((c.high_bid * (1 + v_prem) + c.v_ship) * (1 + v_tax)) end as roi_base,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_best / ((c.high_bid * (1 + v_prem) + c.v_ship) * (1 + v_tax)) end as roi_best,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_dealer / ((c.high_bid * (1 + v_prem) + c.v_ship) * (1 + v_tax)) end as roi_dealer
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

-- dash_combined_search: identical to 0032's version except the three EBTH-side case_json() calls
-- now pass each lot's category through, so bulky-category shipping applies on the combined view
-- too, not just on /lots and its siblings. Tax needs no extra wiring here -- it's inside case_json
-- itself now, applied unconditionally regardless of whether a category is passed.
create or replace function dash_combined_search(p_token text, p jsonb default '{}'::jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_terms text[] := array(select t from unnest(regexp_split_to_array(lower(trim(coalesce(p->>'q', ''))), '\s+')) t where t <> '');
  v_status text := coalesce(nullif(p->>'status', ''), 'open');
  v_sort text := coalesce(nullif(p->>'sort', ''), 'worst_roi');
  v_dir text := case when p->>'dir' in ('asc', 'desc') then p->>'dir'
                     when v_sort in ('ends', 'name', 'category') then 'asc'
                     else 'desc' end;
  v_est text := coalesce(nullif(p->>'estimate', ''), 'any');
  v_cat text := nullif(p->>'category', '');
  v_source text := nullif(p->>'source', '');
  v_starred boolean := coalesce(nullif(p->>'starred', '')::boolean, false);
  v_min numeric := nullif(p->>'min_bid', '')::numeric;
  v_max numeric := nullif(p->>'max_bid', '')::numeric;
  v_min_roi numeric := case when nullif(p->>'min_roi', '') is not null then (p->>'min_roi')::numeric / 100 else null end;
  v_limit int := least(greatest(coalesce(nullif(p->>'limit', '')::int, 50), 1), 200);
  v_offset int := greatest(coalesce(nullif(p->>'offset', '')::int, 0), 0);
  v_fx numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'eur_usd_rate'), 1.14);
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with ebth_raw as (
    select l.item_id, l.name, l.url, l.category as raw_category, l.high_bid, l.ends_at, l.bids_count, l.starred,
           e.est_low, e.est_high, e.confidence
      from lot_latest l left join lot_estimates e on e.item_id = l.item_id
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and (v_min is null or coalesce(l.high_bid, 0) >= v_min)
       and (v_max is null or coalesce(l.high_bid, 0) <= v_max)
       and (not v_starred or l.starred)
  ), ebth as (
    select 'ebth'::text as source, r.item_id, r.name, r.url,
           unified_category(r.raw_category, r.name) as category,
           'USD'::text as currency, r.high_bid as bid_native, r.high_bid as bid_usd,
           r.ends_at, r.bids_count, r.starred, r.est_low, r.est_high, r.confidence,
           w.value as v_worst, w.max as max_worst, w.profit as profit_worst_native, w.roi as roi_worst,
           b.value as v_base, b.max as max_base, b.profit as profit_base_native, b.roi as roi_base,
           bb.value as v_best, bb.max as max_best, bb.profit as profit_best_native, bb.roi as roi_best
      from ebth_raw r
      left join lateral (select * from jsonb_to_record(coalesce(case_json(coalesce(r.est_low, r.est_high), r.high_bid, r.raw_category), '{}'::jsonb))
                            as x(value numeric, fee numeric, max numeric, proceeds numeric, profit numeric, roi numeric)) w on true
      left join lateral (select * from jsonb_to_record(coalesce(case_json(base_case(r.est_low, r.est_high), r.high_bid, r.raw_category), '{}'::jsonb))
                            as x(value numeric, fee numeric, max numeric, proceeds numeric, profit numeric, roi numeric)) b on true
      left join lateral (select * from jsonb_to_record(coalesce(case_json(coalesce(r.est_high, r.est_low), r.high_bid, r.raw_category), '{}'::jsonb))
                            as x(value numeric, fee numeric, max numeric, proceeds numeric, profit numeric, roi numeric)) bb on true
  ), catawiki_raw as (
    select l.item_id, l.name, l.url, l.category as raw_category, l.high_bid, l.shipping_eur, l.ends_at, l.bids_count, l.starred,
           e.est_low, e.est_high, e.confidence
      from catawiki_lots l left join catawiki_estimates e on e.item_id = l.item_id
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and (v_min is null or coalesce(l.high_bid, 0) >= v_min)
       and (v_max is null or coalesce(l.high_bid, 0) <= v_max)
       and (not v_starred or l.starred)
  ), catawiki as (
    select 'catawiki'::text as source, r.item_id, r.name, r.url,
           unified_category(r.raw_category, r.name) as category,
           'EUR'::text as currency, r.high_bid as bid_native, round(coalesce(r.high_bid, 0) * v_fx, 2) as bid_usd,
           r.ends_at, r.bids_count, r.starred, r.est_low, r.est_high, r.confidence,
           w.value as v_worst, w.max as max_worst, w.profit as profit_worst_native, w.roi as roi_worst,
           b.value as v_base, b.max as max_base, b.profit as profit_base_native, b.roi as roi_base,
           bb.value as v_best, bb.max as max_best, bb.profit as profit_best_native, bb.roi as roi_best
      from catawiki_raw r
      left join lateral (select * from jsonb_to_record(coalesce(catawiki_case_json(coalesce(r.est_low, r.est_high), r.high_bid, r.shipping_eur), '{}'::jsonb))
                            as x(value numeric, fee numeric, shipping numeric, max numeric, profit numeric, roi numeric)) w on true
      left join lateral (select * from jsonb_to_record(coalesce(catawiki_case_json(base_case(r.est_low, r.est_high), r.high_bid, r.shipping_eur), '{}'::jsonb))
                            as x(value numeric, fee numeric, shipping numeric, max numeric, profit numeric, roi numeric)) b on true
      left join lateral (select * from jsonb_to_record(coalesce(catawiki_case_json(coalesce(r.est_high, r.est_low), r.high_bid, r.shipping_eur), '{}'::jsonb))
                            as x(value numeric, fee numeric, shipping numeric, max numeric, profit numeric, roi numeric)) bb on true
  ), combined as (
    select * from ebth union all select * from catawiki
  ), filtered as (
    select * from combined c
     where (v_cat is null or c.category = v_cat)
       and (v_source is null or c.source = v_source)
       and (v_min_roi is null or c.roi_worst >= v_min_roi)
       and not exists (select 1 from unnest(v_terms) t where position(t in lower(coalesce(c.name, ''))) = 0)
  ), withusd as (
    select f.*,
           (case when f.currency = 'EUR' then round(f.v_worst * v_fx, 2) else f.v_worst end) as v_worst_usd,
           (case when f.currency = 'EUR' then round(f.v_base * v_fx, 2) else f.v_base end) as v_base_usd,
           (case when f.currency = 'EUR' then round(f.v_best * v_fx, 2) else f.v_best end) as v_best_usd,
           (case when f.currency = 'EUR' then round(f.profit_worst_native * v_fx, 2) else f.profit_worst_native end) as profit_worst_usd,
           (case when f.currency = 'EUR' then round(f.profit_base_native * v_fx, 2) else f.profit_base_native end) as profit_base_usd,
           (case when f.currency = 'EUR' then round(f.profit_best_native * v_fx, 2) else f.profit_best_native end) as profit_best_usd
      from filtered f
  ), ranked as (
    select w.*, count(*) over () as total,
           row_number() over (order by
             case when v_sort = 'ends' and v_dir = 'asc' then w.ends_at end asc nulls last,
             case when v_sort = 'ends' and v_dir = 'desc' then w.ends_at end desc nulls last,
             case when v_sort = 'name' and v_dir = 'asc' then lower(w.name) end asc nulls last,
             case when v_sort = 'name' and v_dir = 'desc' then lower(w.name) end desc nulls last,
             case when v_sort = 'category' and v_dir = 'asc' then lower(w.category) end asc nulls last,
             case when v_sort = 'category' and v_dir = 'desc' then lower(w.category) end desc nulls last,
             case when v_sort = 'bid' and v_dir = 'asc' then w.bid_usd end asc nulls last,
             case when v_sort = 'bid' and v_dir = 'desc' then w.bid_usd end desc nulls last,
             case when v_sort = 'worst_roi' and v_dir = 'asc' then w.roi_worst end asc nulls last,
             case when v_sort = 'worst_roi' and v_dir = 'desc' then w.roi_worst end desc nulls last,
             case when v_sort = 'base_roi' and v_dir = 'asc' then w.roi_base end asc nulls last,
             case when v_sort = 'base_roi' and v_dir = 'desc' then w.roi_base end desc nulls last,
             case when v_sort = 'best_roi' and v_dir = 'asc' then w.roi_best end asc nulls last,
             case when v_sort = 'best_roi' and v_dir = 'desc' then w.roi_best end desc nulls last,
             w.ends_at asc nulls last, w.item_id) as rn
      from withusd w
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'sort', v_sort, 'dir', v_dir, 'fx_rate', v_fx, 'rows', v_rows);
end $$;
