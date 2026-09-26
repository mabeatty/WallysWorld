-- 0031: a minimum-ROI filter for the combined view, independent of sort. Sorting by "ends" (time
-- left) is how you browse what's closing soonest; filtering by min_roi is how you narrow that same
-- list down to only lots that clear a ROI floor first -- the two are separate axes, not tied to
-- each other, so you can sort by time left while still only seeing lots above whatever ROI you
-- consider worth bidding on. The filter checks worst-case ROI specifically (roi_worst), matching
-- both this function's own default sort key and the rest of the app's standing convention that
-- worst case is the number to act on, not base or best. min_roi arrives as a percentage (50 means
-- 50%, matching how every ROI is displayed) and is divided by 100 before comparing against
-- roi_worst, which is stored as a plain ratio (0.5).

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
  ), ebth as (
    select 'ebth'::text as source, r.item_id, r.name, r.url,
           unified_category(r.raw_category, r.name) as category,
           'USD'::text as currency, r.high_bid as bid_native, r.high_bid as bid_usd,
           r.ends_at, r.bids_count, r.starred, r.est_low, r.est_high, r.confidence,
           w.value as v_worst, w.max as max_worst, w.profit as profit_worst_native, w.roi as roi_worst,
           b.value as v_base, b.max as max_base, b.profit as profit_base_native, b.roi as roi_base,
           bb.value as v_best, bb.max as max_best, bb.profit as profit_best_native, bb.roi as roi_best
      from ebth_raw r
      left join lateral (select * from jsonb_to_record(coalesce(case_json(coalesce(r.est_low, r.est_high), r.high_bid), '{}'::jsonb))
                            as x(value numeric, fee numeric, max numeric, proceeds numeric, profit numeric, roi numeric)) w on true
      left join lateral (select * from jsonb_to_record(coalesce(case_json(base_case(r.est_low, r.est_high), r.high_bid), '{}'::jsonb))
                            as x(value numeric, fee numeric, max numeric, proceeds numeric, profit numeric, roi numeric)) b on true
      left join lateral (select * from jsonb_to_record(coalesce(case_json(coalesce(r.est_high, r.est_low), r.high_bid), '{}'::jsonb))
                            as x(value numeric, fee numeric, max numeric, proceeds numeric, profit numeric, roi numeric)) bb on true
  ), catawiki_raw as (
    select l.item_id, l.name, l.url, l.category as raw_category, l.high_bid, l.shipping_eur, l.ends_at, l.bids_count, l.starred,
           e.est_low, e.est_high, e.confidence
      from catawiki_lots l left join catawiki_estimates e on e.item_id = l.item_id
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and (v_min is null or coalesce(l.high_bid, 0) >= v_min)
       and (v_max is null or coalesce(l.high_bid, 0) <= v_max)
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
