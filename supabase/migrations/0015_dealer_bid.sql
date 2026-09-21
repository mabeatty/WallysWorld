-- 0015: a dealer bid for every valued lot.
--   dealer bid = the worst case less the dealer discount (settings.dealer_discount, 15%), taken as net cash:
--   a dealer pays outright, so no resale fee comes off it.
--   profit / ROI at the current bid, calculated max bid and room follow the other cases.
-- dash_search returns v_dealer, gap_dealer, max_dealer, room_dealer, profit_dealer, roi_dealer and sorts by
-- dealer, dealer_gap, dealer_room and dealer_roi. dash_lot's cases carry a dealer case, and bid_math the discount.
-- dash_set_bid_math takes an optional fourth argument, the dealer discount.

insert into settings (key, value) values ('dealer_discount', '0.15'::jsonb) on conflict (key) do nothing;

create or replace function dealer_case_json(p_worst numeric, p_bid numeric) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_worst is null or p_worst <= 0 then null else jsonb_build_object(
    'value', d.v,
    'fee', 0,
    'max', floor(d.v * (1 - p.marg) / (1 + p.prem)),
    'proceeds', d.v,
    'profit', d.v - coalesce(p_bid, 0) * (1 + p.prem),
    'roi', case when coalesce(p_bid, 0) > 0 then (d.v - p_bid * (1 + p.prem)) / (p_bid * (1 + p.prem)) end)
  end
  from (select coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25) as prem,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15) as marg,
               coalesce((select (value #>> '{}')::numeric from settings where key = 'dealer_discount'), 0.15) as disc) p,
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
    'tiers', (select value from settings where key = 'fee_tiers'));
end $$;

drop function if exists dash_set_bid_math(text, numeric, numeric);
create or replace function dash_set_bid_math(p_token text, p_premium numeric, p_margin numeric, p_dealer numeric default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  if p_premium is null or p_premium < 0 or p_premium > 1 then raise exception 'buyer''s premium must be between 0%% and 100%%'; end if;
  if p_margin is null or p_margin < 0 or p_margin >= 0.9 then raise exception 'margin must be between 0%% and 90%%'; end if;
  if p_dealer is not null and (p_dealer < 0 or p_dealer >= 0.9) then raise exception 'dealer discount must be between 0%% and 90%%'; end if;
  update settings set value = to_jsonb(p_premium) where key = 'buyer_premium';
  update settings set value = to_jsonb(p_margin) where key = 'target_margin';
  if p_dealer is not null then update settings set value = to_jsonb(p_dealer) where key = 'dealer_discount'; end if;
end $$;

create or replace function dash_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'lot', (select to_jsonb(l) from lot_latest l where l.item_id = p_id),
    'category', (select category from lots where item_id = p_id),
    'details', (select data from lot_details where item_id = p_id order by id desc limit 1),
    'estimate', (select to_jsonb(e) || jsonb_build_object('cases', jsonb_build_object(
                          'worst', case_json(coalesce(e.est_low, e.est_high), (select high_bid from lot_latest where item_id = p_id)),
                          'base', case_json(base_case(e.est_low, e.est_high), (select high_bid from lot_latest where item_id = p_id)),
                          'best', case_json(coalesce(e.est_high, e.est_low), (select high_bid from lot_latest where item_id = p_id)),
                          'dealer', dealer_case_json(coalesce(e.est_low, e.est_high), (select high_bid from lot_latest where item_id = p_id))))
                  from lot_estimates e where e.item_id = p_id),
    'bid_math', (select jsonb_build_object('premium', (select (value #>> '{}')::numeric from settings where key = 'buyer_premium'),
                                           'margin', (select (value #>> '{}')::numeric from settings where key = 'target_margin'),
                                           'dealer', (select (value #>> '{}')::numeric from settings where key = 'dealer_discount'))),
    'snapshots', coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
                             from (select id, ts, high_bid, bids_count, unique_bidders, state, extended
                                     from snapshots where item_id = p_id) s), '[]'::jsonb)
  );
end $$;

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
  v_min numeric := nullif(p->>'min_bid', '')::numeric;
  v_max numeric := nullif(p->>'max_bid', '')::numeric;
  v_within numeric := nullif(p->>'within_hours', '')::numeric;
  v_tracked boolean := coalesce(nullif(p->>'tracked', '')::boolean, false);
  v_limit int := least(greatest(coalesce(nullif(p->>'limit', '')::int, 50), 1), 200);
  v_offset int := greatest(coalesce(nullif(p->>'offset', '')::int, 0), 0);
  v_prem numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25);
  v_disc numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'dealer_discount'), 0.15);
  v_marg numeric := coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15);
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*, lo.category,
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
       and (v_sale is null or l.sale_id = v_sale)
       and (v_cat is null or lo.category = v_cat)
       and not exists (select 1 from unnest(v_terms) t
                        where position(t in lower(coalesce(l.name, '') || ' ' || coalesce(e.notes, ''))) = 0)
  ), calc as (
    select b.*,
           suggested_max_bid(b.v_worst) as max_worst, suggested_max_bid(b.v_base) as max_base, suggested_max_bid(b.v_best) as max_best,
           (b.v_worst - coalesce(b.high_bid, 0)) as gap_worst, (b.v_base - coalesce(b.high_bid, 0)) as gap_base, (b.v_best - coalesce(b.high_bid, 0)) as gap_best,
           (b.v_dealer - coalesce(b.high_bid, 0)) as gap_dealer,
           floor(b.v_dealer * (1 - v_marg) / (1 + v_prem)) as max_dealer,
           (b.v_worst - resale_fee(b.v_worst)) - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_worst,
           (b.v_base - resale_fee(b.v_base)) - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_base,
           (b.v_best - resale_fee(b.v_best)) - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_best,
           b.v_dealer - coalesce(b.high_bid, 0) * (1 + v_prem) as profit_dealer
      from base b
  ), rooms as (
    select c.*, (c.max_worst - c.next_bid) as room_worst, (c.max_base - c.next_bid) as room_base, (c.max_best - c.next_bid) as room_best, (c.max_dealer - c.next_bid) as room_dealer,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_worst / (c.high_bid * (1 + v_prem)) end as roi_worst,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_base / (c.high_bid * (1 + v_prem)) end as roi_base,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_best / (c.high_bid * (1 + v_prem)) end as roi_best,
           case when coalesce(c.high_bid, 0) > 0 then c.profit_dealer / (c.high_bid * (1 + v_prem)) end as roi_dealer
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

revoke all on function dash_set_bid_math(text, numeric, numeric, numeric) from public;
grant execute on function dash_set_bid_math(text, numeric, numeric, numeric) to anon, service_role;
