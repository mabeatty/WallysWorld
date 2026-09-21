-- 0011: bid math with a tiered resale fee, sortable over/under, and a way to refresh current bids.
--   * settings: buyer_premium, target_margin, fee_tiers (eBay's watch schedule: 15% to $1,000, 6.5% to $7,500, 3% above)
--   * resale_fee(price), suggested_max_bid(low estimate): what you could pay at the hammer and still keep your margin
--   * dash_search: every row carries max_used (your override, else calculated), max_kind and room (max minus next bid);
--     new sort keys bids, bidders, source, max, room
--   * refresh queue: dash_request_refresh asks the collector to reload chosen lots; next_job serves those first

insert into settings (key, value) values
  ('buyer_premium', '0.25'::jsonb),
  ('target_margin', '0.15'::jsonb),
  ('fee_tiers', '[{"up_to": 1000, "rate": 0.15}, {"up_to": 7500, "rate": 0.065}, {"up_to": null, "rate": 0.03}]'::jsonb)
on conflict (key) do nothing;

create or replace function resale_fee(p_price numeric) returns numeric
language plpgsql stable set search_path = public, pg_temp as $$
declare v_fee numeric := 0; v_lo numeric := 0; v_hi numeric; t record;
begin
  if p_price is null or p_price <= 0 then return 0; end if;
  for t in select e.value as tier from jsonb_array_elements((select value from settings where key = 'fee_tiers')) with ordinality as e(value, ord) order by e.ord loop
    v_hi := nullif(t.tier->>'up_to', '')::numeric;
    v_fee := v_fee + greatest(least(p_price, coalesce(v_hi, p_price)) - v_lo, 0) * (t.tier->>'rate')::numeric;
    exit when v_hi is null or p_price <= v_hi;
    v_lo := v_hi;
  end loop;
  return round(v_fee, 2);
end $$;

-- The most you can pay at the hammer: resale proceeds after fees, less your margin, divided by (1 + buyer's premium).
create or replace function suggested_max_bid(p_low numeric) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select case when p_low is null or p_low <= 0 then null else
    floor((p_low - resale_fee(p_low))
          * (1 - coalesce((select (value #>> '{}')::numeric from settings where key = 'target_margin'), 0.15))
          / (1 + coalesce((select (value #>> '{}')::numeric from settings where key = 'buyer_premium'), 0.25))) end;
$$;

create or replace function dash_bid_math(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'premium', (select (value #>> '{}')::numeric from settings where key = 'buyer_premium'),
    'margin', (select (value #>> '{}')::numeric from settings where key = 'target_margin'),
    'tiers', (select value from settings where key = 'fee_tiers'));
end $$;

create or replace function dash_set_bid_math(p_token text, p_premium numeric, p_margin numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  if p_premium is null or p_premium < 0 or p_premium > 1 then raise exception 'buyer''s premium must be between 0%% and 100%%'; end if;
  if p_margin is null or p_margin < 0 or p_margin >= 0.9 then raise exception 'margin must be between 0%% and 90%%'; end if;
  update settings set value = to_jsonb(p_premium) where key = 'buyer_premium';
  update settings set value = to_jsonb(p_margin) where key = 'target_margin';
end $$;

-- ---------------------------------------------------------------- refresh queue
create table if not exists refresh_requests (
  item_id text primary key,
  requested_at timestamptz not null default now(),
  served_at timestamptz
);
alter table refresh_requests enable row level security;
revoke all on refresh_requests from anon, authenticated;

create or replace function dash_request_refresh(p_token text, p_ids text[], p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids text[]; v_asked int; v_queued int;
begin
  perform assert_dash_token(p_token);
  select array_agg(distinct i) into v_ids from unnest(coalesce(p_ids, '{}'::text[])) i where i is not null and i <> '';
  v_asked := coalesce(array_length(v_ids, 1), 0);
  if v_asked > 60 then raise exception 'refresh at most 60 lots at a time'; end if;
  with ok as (
    select item_id from lots where item_id = any(coalesce(v_ids, '{}'::text[])) and url is not null and ends_at > p_now
  ), up as (
    insert into refresh_requests (item_id, requested_at, served_at)
    select item_id, p_now, null from ok
    on conflict (item_id) do update
      set requested_at = case when refresh_requests.served_at is null then refresh_requests.requested_at else p_now end,
          served_at = null
    returning item_id)
  select count(*) into v_queued from up;
  -- lots you care enough to refresh also get their closing price captured after they end
  update lots set tracked = true
   where tracked = false and item_id in (select item_id from refresh_requests where served_at is null);
  return jsonb_build_object('asked', v_asked, 'queued', v_queued, 'skipped', v_asked - v_queued,
                            'waiting', (select count(*) from refresh_requests where served_at is null));
end $$;

create or replace function dash_refresh_status(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'waiting', (select count(*) from refresh_requests r join lots l using (item_id) where r.served_at is null and l.ends_at > p_now),
    'halted', (select value is distinct from 'null'::jsonb from settings where key = 'halt'),
    'paused', (select value = 'true'::jsonb from settings where key = 'paused'),
    'gap_seconds', (select (value #>> '{}')::int from settings where key = 'min_gap_seconds'));
end $$;

create or replace function next_job(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row record; v_seed record;
  v_local timestamp; v_q jsonb; v_h int; v_n int; v_mid timestamptz;
  v_last_any timestamptz; v_last_ok bigint; v_soonest timestamptz;
  v_hot boolean; v_interval int; v_regular jsonb := null;
  v_tz text; v_page int; v_unit text; v_maxend timestamptz; v_last_ok_ts timestamptz; v_data bigint;
begin
  perform assert_token(p_token);
  v_tz := cfg_text('timezone');

  if cfg('paused') = 'true'::jsonb or cfg('halt') is distinct from 'null'::jsonb then
    return null;
  end if;

  v_local := p_now at time zone v_tz;
  v_h := extract(hour from v_local)::int;
  v_q := cfg('quiet_hours');
  if jsonb_typeof(v_q) = 'array' and v_h >= (v_q->>0)::int and v_h < (v_q->>1)::int then
    return null;
  end if;

  v_mid := date_trunc('day', v_local) at time zone v_tz;
  select coalesce(sum(pages), 0)::int into v_n from fetches where source = 'job' and ts >= v_mid;
  if v_n >= cfg_int('daily_request_cap') then return null; end if;

  if exists (select 1 from fetches
             where source = 'job' and ts > p_now - make_interval(secs => cfg_int('min_gap_seconds'))) then
    return null;
  end if;

  -- lots you asked to refresh come first, oldest request first. A lot page load records a fresh bid snapshot.
  select r.item_id, l.url into v_row
    from refresh_requests r join lots l on l.item_id = r.item_id
   where r.served_at is null and l.url is not null and l.ends_at > p_now
   order by r.requested_at, r.item_id limit 1;
  if found then
    update refresh_requests set served_at = p_now where item_id = v_row.item_id;
    return jsonb_build_object('kind', 'detail', 'url', v_row.url,
                              'item_id', v_row.item_id, 'requires_login', false);
  end if;

  select item_id, url into v_row from lots
   where tracked and not closeout_done and url is not null and ends_at is not null
     and ends_at <= p_now - make_interval(mins => cfg_int('closeout_delay_min'))
     and (closeout_next is null or closeout_next <= p_now)
     and closeout_tries < cfg_int('closeout_max_tries')
   order by ends_at limit 1;
  if found then
    return jsonb_build_object('kind', 'closeout', 'url', v_row.url,
                              'item_id', v_row.item_id, 'requires_login', false);
  end if;

  for v_seed in select * from seeds where enabled order by name loop
    for v_page in 1..coalesce(v_seed.page_count, 1) loop
      v_unit := case when v_page = 1 then v_seed.url
                     else v_seed.url || case when position('?' in v_seed.url) > 0 then '&' else '?' end || 'page=' || v_page end;
      select max(ts) into v_last_any from fetches
       where url = v_unit and (source = 'job' or v_seed.url !~ '^https://www\.ebth\.com/(sales|categories)/');
      if v_last_any is null then
        v_regular := coalesce(v_regular, jsonb_build_object('kind', 'list', 'url', v_unit, 'item_id', null,
                              'requires_login', v_seed.requires_login, 'hint', cfg('paging_hint')));
        continue;
      end if;
      select id, ts into v_last_ok, v_last_ok_ts from fetches
       where url = v_unit and verdict = 'ok' and (source = 'job' or v_seed.url !~ '^https://www\.ebth\.com/(sales|categories)/')
       order by id desc limit 1;
      select id into v_data from fetches
       where url = v_unit and verdict = 'ok' and n_items > 0 and (source = 'job' or v_seed.url !~ '^https://www\.ebth\.com/(sales|categories)/')
       order by id desc limit 1;
      v_soonest := null; v_maxend := null;
      if v_data is not null then
        select min(ends_at) filter (where ends_at > p_now), max(ends_at) into v_soonest, v_maxend
          from snapshots where fetch_id = v_data;
        if v_seed.page_count is not null and v_maxend is not null
           and v_maxend < v_last_ok_ts - make_interval(mins => cfg_int('closeout_delay_min')) then
          continue;
        end if;
      end if;
      v_hot := v_soonest is not null and v_soonest <= p_now + make_interval(mins => cfg_int('hot_window_min'));
      v_interval := case when v_hot then coalesce(v_seed.hot_interval_min, cfg_int('hot_interval_min'))
                         else coalesce(v_seed.interval_min, cfg_int('list_interval_min')) end;
      if p_now - v_last_any >= make_interval(mins => v_interval) then
        if v_hot then
          return jsonb_build_object('kind', 'list', 'url', v_unit, 'item_id', null,
                                    'requires_login', v_seed.requires_login, 'hint', cfg('paging_hint'));
        end if;
        v_regular := coalesce(v_regular, jsonb_build_object('kind', 'list', 'url', v_unit, 'item_id', null,
                              'requires_login', v_seed.requires_login, 'hint', cfg('paging_hint')));
      end if;
    end loop;
  end loop;

  select item_id, url into v_row from lots
   where tracked and not detail_done and url is not null and ends_at > p_now
     and ends_at <= p_now + make_interval(hours => cfg_int('detail_horizon_hours'))
   order by ends_at limit 1;
  if found then
    return jsonb_build_object('kind', 'detail', 'url', v_row.url,
                              'item_id', v_row.item_id, 'requires_login', false);
  end if;

  return v_regular;
end $$;

create or replace function dash_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'lot', (select to_jsonb(l) from lot_latest l where l.item_id = p_id),
    'category', (select category from lots where item_id = p_id),
    'details', (select data from lot_details where item_id = p_id order by id desc limit 1),
    'estimate', (select to_jsonb(e) || jsonb_build_object('max_calc', suggested_max_bid(e.est_low),
                                        'max_used', coalesce(e.max_bid, suggested_max_bid(e.est_low)),
                                        'fee', resale_fee(e.est_low))
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
  v_key text := case v_sort_raw when 'bid_asc' then 'bid' when 'bid_desc' then 'bid' else v_sort_raw end;
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
           coalesce(e.max_bid, suggested_max_bid(e.est_low)) as max_used,
           case when e.max_bid is not null then 'yours' when e.est_low is not null then 'calculated' end as max_kind,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           (e.est_low - coalesce(l.high_bid, 0)) as gap
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
    select b.*, (b.max_used - coalesce(b.min_next_bid, coalesce(b.high_bid, 0) + 1)) as room from base b
  ), ranked as (
    select b.*, count(*) over () as total,
           row_number() over (order by
             case when v_key = 'ends' and v_dir = 'asc' then b.ends_at end asc nulls last,
             case when v_key = 'ends' and v_dir = 'desc' then b.ends_at end desc nulls last,
             case when v_key = 'bid' and v_dir = 'asc' then b.high_bid end asc nulls last,
             case when v_key = 'bid' and v_dir = 'desc' then b.high_bid end desc nulls last,
             case when v_key = 'estimate' and v_dir = 'asc' then b.est_low end asc nulls last,
             case when v_key = 'estimate' and v_dir = 'desc' then b.est_low end desc nulls last,
             case when v_key = 'estimate' and v_dir = 'asc' then b.est_high end asc nulls last,
             case when v_key = 'estimate' and v_dir = 'desc' then b.est_high end desc nulls last,
             case when v_key = 'gap' and v_dir = 'asc' then b.gap end asc nulls last,
             case when v_key = 'gap' and v_dir = 'desc' then b.gap end desc nulls last,
             case when v_key = 'name' and v_dir = 'asc' then lower(b.name) end asc nulls last,
             case when v_key = 'name' and v_dir = 'desc' then lower(b.name) end desc nulls last,
             case when v_key = 'category' and v_dir = 'asc' then lower(b.category) end asc nulls last,
             case when v_key = 'category' and v_dir = 'desc' then lower(b.category) end desc nulls last,
             case when v_key = 'bids' and v_dir = 'asc' then b.bids_count end asc nulls last,
             case when v_key = 'bids' and v_dir = 'desc' then b.bids_count end desc nulls last,
             case when v_key = 'bidders' and v_dir = 'asc' then b.unique_bidders end asc nulls last,
             case when v_key = 'bidders' and v_dir = 'desc' then b.unique_bidders end desc nulls last,
             case when v_key = 'source' and v_dir = 'asc' then b.est_updated end asc nulls last,
             case when v_key = 'source' and v_dir = 'desc' then b.est_updated end desc nulls last,
             case when v_key = 'max' and v_dir = 'asc' then b.max_used end asc nulls last,
             case when v_key = 'max' and v_dir = 'desc' then b.max_used end desc nulls last,
             case when v_key = 'room' and v_dir = 'asc' then b.room end asc nulls last,
             case when v_key = 'room' and v_dir = 'desc' then b.room end desc nulls last,
             case when v_key = 'seen' and v_dir = 'asc' then b.snapshot_ts end asc nulls last,
             case when v_key = 'seen' and v_dir = 'desc' then b.snapshot_ts end desc nulls last,
             b.ends_at asc nulls last, b.item_id) as rn
      from calc b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'sort', v_key, 'dir', v_dir, 'rows', v_rows);
end $$;


revoke all on function dash_bid_math(text), dash_set_bid_math(text, numeric, numeric),
  dash_request_refresh(text, text[], timestamptz), dash_refresh_status(text, timestamptz) from public;
grant execute on function dash_bid_math(text), dash_set_bid_math(text, numeric, numeric),
  dash_request_refresh(text, text[], timestamptz), dash_refresh_status(text, timestamptz) to anon, service_role;
