-- 0020: fixes the Followed feature. The `tracked` column already had its own meaning (which lots
-- get detail/closeout crawls), set true by passive browsing, the refresh button, and an old
-- backfill -- none of that is "the user starred this." A separate `starred` column, changed only
-- by the star toggle, replaces `tracked` as what the Followed page and dash_set_tracked used.
alter table lots add column if not exists starred boolean not null default false;

-- Views expand `l.*` at CREATE VIEW time, not per-query -- adding a column to `lots` alone does
-- not make it visible through lot_latest. The view has to be rebuilt (drop, not "or replace":
-- l.* would otherwise insert the new column in the middle of the view's column list, which
-- CREATE OR REPLACE VIEW disallows).
drop view lot_latest;
create view lot_latest as
select l.*, s.state, s.high_bid, s.min_next_bid,
       coalesce(s.bids_count, b.bids_count) as bids_count,
       coalesce(s.unique_bidders, b.unique_bidders) as unique_bidders,
       s.extended, s.ts as snapshot_ts
from lots l
left join lateral (
  select * from snapshots where item_id = l.item_id order by id desc limit 1
) s on true
left join lateral (
  select bids_count, unique_bidders from snapshots
   where item_id = l.item_id and bids_count is not null order by id desc limit 1
) b on true;
revoke all on lot_latest from anon, authenticated;

drop function if exists dash_set_tracked(text, text, boolean);

create or replace function dash_set_starred(p_token text, p_id text, p_starred boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  -- starring also gives the lot full crawl coverage, same as tracked always has; unstarring
  -- leaves tracked alone, since other things may still have a reason to track it closely.
  update lots set starred = p_starred, tracked = (tracked or p_starred) where item_id = p_id;
end $$;

revoke all on function dash_set_starred(text, text, boolean) from public;
grant execute on function dash_set_starred(text, text, boolean) to anon, service_role;

-- Also drops the redundant "lo.category" from the base CTE: lot_latest's l.* already carries
-- category (lots has had that column since migration 0010), so selecting it a second time via
-- the lo join gave the CTE two identically-named columns. Harmless until the view above was
-- rebuilt forced a fresh query plan, which surfaced it as an ambiguous-column-reference error.
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
