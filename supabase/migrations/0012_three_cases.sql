-- 0012: every valuation is shown three ways: worst case (your low estimate), base case (the midpoint of low and high)
-- and best case (your high estimate). For each case the search returns the value (v_*), headroom over the current bid
-- (gap_*), the calculated max bid at your margin (max_*) and how far the next bid sits under or over it (room_*).
-- New sort keys: worst, base, best, and each with _gap and _room. The old keys estimate, gap, room and max still work.

create or replace function base_case(p_low numeric, p_high numeric) returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select coalesce((p_low + p_high) / 2, p_low, p_high);
$$;

create or replace function case_json(p_value numeric) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select case when p_value is null or p_value <= 0 then null
    else jsonb_build_object('value', p_value, 'fee', resale_fee(p_value), 'max', suggested_max_bid(p_value)) end;
$$;

create or replace function dash_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'lot', (select to_jsonb(l) from lot_latest l where l.item_id = p_id),
    'category', (select category from lots where item_id = p_id),
    'details', (select data from lot_details where item_id = p_id order by id desc limit 1),
    'estimate', (select to_jsonb(e) || jsonb_build_object('cases', jsonb_build_object(
                          'worst', case_json(coalesce(e.est_low, e.est_high)),
                          'base', case_json(base_case(e.est_low, e.est_high)),
                          'best', case_json(coalesce(e.est_high, e.est_low))))
                  from lot_estimates e where e.item_id = p_id),
    'bid_math', (select jsonb_build_object('premium', (select (value #>> '{}')::numeric from settings where key = 'buyer_premium'),
                                           'margin', (select (value #>> '{}')::numeric from settings where key = 'target_margin'))),
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
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*, lo.category,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           coalesce(e.est_low, e.est_high) as v_worst, base_case(e.est_low, e.est_high) as v_base, coalesce(e.est_high, e.est_low) as v_best,
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
           (b.v_worst - coalesce(b.high_bid, 0)) as gap_worst, (b.v_base - coalesce(b.high_bid, 0)) as gap_base, (b.v_best - coalesce(b.high_bid, 0)) as gap_best
      from base b
  ), rooms as (
    select c.*, (c.max_worst - c.next_bid) as room_worst, (c.max_base - c.next_bid) as room_base, (c.max_best - c.next_bid) as room_best
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
             b.ends_at asc nulls last, b.item_id) as rn
      from rooms b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' - 'next_bid' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'sort', v_key, 'dir', v_dir, 'rows', v_rows);
end $$;
