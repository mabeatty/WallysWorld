-- 0030: a single combined view across both platforms (EBTH, USD; Catawiki, EUR), with one
-- category taxonomy and one ROI-based sort, so the dashboard no longer requires visiting two
-- separate pages to see everything currently worth a look.
--
-- Category taxonomy: every existing EBTH category keeps its own bucket, EXCEPT the six jewelry-
-- adjacent categories (Jewelry, gold/silver/other/Southwest, Lab-grown stones and jewelry, Loose
-- stones) which fold into one "Jewelry" bucket, and "Trading cards" is split out of Collectibles
-- and memorabilia by name pattern (Topps/Bowman/Fleer/Donruss/Panini, Pokemon, Magic: The
-- Gathering, and generic baseball/football/basketball/hockey/rookie/relic/trading-card wording).
-- Catawiki's only active raw category (Stamps) maps straight across since EBTH already has a
-- Stamps bucket. Anything unrecognized (or null) falls into "Other" rather than being dropped.
--
-- Currency: Catawiki's case math (catawiki_case_json) is EUR-native and EBTH's (case_json) is
-- USD-native. Rather than re-deriving either formula a third time (exactly the duplication problem
-- 0026 already flagged once for dash_search vs case_json), this calls both canonical functions via
-- a LATERAL join and converts only the EUR results to USD afterward, using a single settings-based
-- eur_usd_rate (an assumption you can update on the Setup page, not a live feed -- there's no FX
-- API wired up, and a stale hardcoded rate would be worse than an editable approximate one).
-- ROI itself needs no conversion -- it's already a currency-free ratio -- so it is the sort key,
-- not a converted dollar amount; the converted dollar figures are for the person reading the row,
-- not for ranking it.

insert into settings (key, value) values ('eur_usd_rate', '1.14'::jsonb) on conflict (key) do nothing;

create or replace function unified_category(p_category text, p_name text default null) returns text
language sql immutable as $$
  select case
    when p_category = 'Coins and currency' then 'Coins'
    when p_category = 'Stamps' then 'Stamps'
    when p_category ilike '%stamp%' then 'Stamps' -- Catawiki's own category wording ("World Stamps" etc.) varies and its integration is stamps-only, so any stamp-flavored raw category collapses here rather than needing every Catawiki variant enumerated
    when p_category = 'Watches' then 'Watches'
    when p_category in ('Jewelry, gold', 'Jewelry, silver', 'Jewelry, other', 'Jewelry, Southwest',
                         'Lab-grown stones and jewelry', 'Loose stones') then 'Jewelry'
    when p_category = 'Collectibles and memorabilia'
         and p_name ~* '(topps|bowman|fleer|donruss|panini|upper deck|pok[eé]mon|magic:?\s*the\s*gathering|baseball card|football card|basketball card|hockey card|trading card|rookie.{0,15}card|relic card|graded.{0,10}card)'
      then 'Trading cards'
    when p_category = 'Collectibles and memorabilia' then 'Collectibles and memorabilia'
    when p_category = 'Art' then 'Art'
    when p_category = 'Furniture' then 'Furniture'
    when p_category = 'Decorative objects' then 'Decorative objects'
    when p_category = 'Ceramics and glass' then 'Ceramics and glass'
    when p_category = 'Handbags and fashion' then 'Handbags and fashion'
    when p_category = 'Sterling and silver' then 'Sterling and silver'
    when p_category = 'Books, maps and ephemera' then 'Books, maps and ephemera'
    when p_category = 'Rugs and textiles' then 'Rugs and textiles'
    when p_category = 'Lighting' then 'Lighting'
    when p_category = 'Antiquities and natural history' then 'Antiquities and natural history'
    when p_category = 'Native American, tribal and folk art' then 'Native American, tribal and folk art'
    when p_category = 'Cameras, music and electronics' then 'Cameras, music and electronics'
    when p_category = 'Tools, sporting and military' then 'Tools, sporting and military'
    when p_category = 'Asian art' then 'Asian art'
    when p_category = 'Mixed lots' then 'Mixed lots'
    when p_category = 'Kitchen and household' then 'Kitchen and household'
    else 'Other'
  end;
$$;

create or replace function dash_fx_rate(p_token text) returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return coalesce((select (value #>> '{}')::numeric from settings where key = 'eur_usd_rate'), 1.14);
end $$;

create or replace function dash_set_fx_rate(p_token text, p_rate numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  if p_rate is null or p_rate <= 0 or p_rate > 5 then raise exception 'EUR/USD rate must be a positive number under 5'; end if;
  update settings set value = to_jsonb(p_rate) where key = 'eur_usd_rate';
end $$;

create or replace function dash_combined_categories(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return coalesce((
    with all_lots as (
      select unified_category(l.category, l.name) as category, l.ends_at from lot_latest l
      union all
      select unified_category(c.category, c.name) as category, c.ends_at from catawiki_lots c
    )
    select jsonb_agg(jsonb_build_object('category', a.category, 'open', a.open_n, 'total', a.total) order by a.category)
      from (select category, count(*) as total, count(*) filter (where ends_at > p_now) as open_n
              from all_lots group by 1) a
  ), '[]'::jsonb);
end $$;

-- One row shape across both platforms: source, native currency + amount, a USD-converted amount
-- for at-a-glance comparison, and worst/base/best value/max/profit/roi from each platform's own
-- canonical case function (never re-derived here). Sort keys: ends, name, category, bid (USD),
-- worst_roi, base_roi, best_roi -- the ROI keys are the intended default way to rank a mixed-
-- currency list. estimate filter and a text search over the name are supported, matching the
-- shape of dash_search's own filters; a q/estimate/category/source/min_bid/max_bid absent means
-- no filtering on that dimension.
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

revoke all on function dash_fx_rate(text), dash_set_fx_rate(text, numeric),
                        dash_combined_categories(text, timestamptz), dash_combined_search(text, jsonb, timestamptz) from public;
grant execute on function dash_fx_rate(text), dash_set_fx_rate(text, numeric),
                           dash_combined_categories(text, timestamptz), dash_combined_search(text, jsonb, timestamptz) to anon, service_role;
