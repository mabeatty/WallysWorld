-- 0022: Catawiki auction-arbitrage tables. Entirely separate from the EBTH lots/estimates schema --
-- different currency (EUR), different fee structure (9% + EUR3 buyer protection fee on the hammer
-- price only, no EBTH-style tiered resale fee), different category taxonomy, and Catawiki publishes
-- its own expert estimate on every lot, which EBTH has no equivalent of. Reuses the same token
-- functions (assert_dash_token) and the same dash_unaccent search fold already built for EBTH.

create table catawiki_auctions (
  auction_id text primary key,
  name text not null,
  url text not null,
  category text,
  curator text,
  ends_at timestamptz,
  first_seen timestamptz not null default now(),
  last_crawled_at timestamptz
);

create table catawiki_lots (
  item_id text primary key,
  auction_id text references catawiki_auctions(auction_id),
  name text not null,
  url text not null,
  category text,
  ends_at timestamptz,
  live_format boolean not null default false,     -- rapid-bid lots (tens of minutes, not days)
  no_reserve boolean not null default false,
  reserve_met boolean,
  high_bid numeric,                                -- EUR
  is_starting_bid boolean not null default false,  -- true when no bids yet ("Starting bid", not "Current bid")
  watchers_count int,
  bids_count int,
  estimate_low numeric,                            -- Catawiki's own published expert estimate, EUR
  estimate_high numeric,
  shipping_eur numeric,                             -- shown shipping cost to the US, when visible
  catalog_number text,                              -- e.g. "US Scott # 23", "SG 178/179", "Yvert 16/24"
  condition text,
  description text,
  seller_name text,
  seller_location text,
  seller_verified boolean,
  seller_feedback_pct numeric,
  seller_objects_sold int,
  starred boolean not null default false,
  tracked boolean not null default false,
  first_seen timestamptz not null default now(),
  snapshot_ts timestamptz
);
create index catawiki_lots_ends_at_idx on catawiki_lots(ends_at);
create index catawiki_lots_category_idx on catawiki_lots(category);
create index catawiki_lots_auction_idx on catawiki_lots(auction_id);

create table catawiki_snapshots (
  id bigserial primary key,
  item_id text not null references catawiki_lots(item_id),
  ts timestamptz not null default now(),
  high_bid numeric,
  watchers_count int,
  bids_count int
);
create index catawiki_snapshots_item_idx on catawiki_snapshots(item_id, ts desc);

create table catawiki_estimates (
  item_id text primary key references catawiki_lots(item_id),
  est_low numeric,
  est_high numeric,
  max_bid numeric,
  confidence text,
  notes text,
  sources text,
  updated_at timestamptz not null default now()
);

revoke all on catawiki_auctions, catawiki_lots, catawiki_snapshots, catawiki_estimates from anon, authenticated;

insert into settings (key, value) values
  ('catawiki_buyer_protection_pct', '0.09'::jsonb),
  ('catawiki_buyer_protection_flat', '3'::jsonb)
on conflict (key) do nothing;

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
  v_total int; v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  with base as (
    select l.*, a.name as auction_name, a.curator,
           e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.sources as est_sources, e.updated_at as est_updated,
           round(coalesce(l.high_bid, 0) * v_bp_pct + v_bp_flat, 2) as buyer_protection_fee,
           case when l.estimate_low is not null then round(l.estimate_low - (coalesce(l.high_bid, 0) * (1 + v_bp_pct) + v_bp_flat), 2) end as gap_to_catawiki_estimate
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
             case when v_sort_raw = 'name' and v_dir = 'asc' then lower(b.name) end asc nulls last,
             case when v_sort_raw = 'name' and v_dir = 'desc' then lower(b.name) end desc nulls last,
             b.ends_at asc nulls last, b.item_id) as rn
      from base b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end $$;

create or replace function dash_catawiki_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lot jsonb; v_est jsonb; v_snaps jsonb; v_bp_pct numeric; v_bp_flat numeric;
begin
  perform assert_dash_token(p_token);
  v_bp_pct := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_pct'), 0.09);
  v_bp_flat := coalesce((select (value #>> '{}')::numeric from settings where key = 'catawiki_buyer_protection_flat'), 3);
  select to_jsonb(l) || jsonb_build_object(
           'auction_name', a.name, 'curator', a.curator,
           'buyer_protection_fee', round(coalesce(l.high_bid, 0) * v_bp_pct + v_bp_flat, 2)
         )
    into v_lot
    from catawiki_lots l left join catawiki_auctions a on a.auction_id = l.auction_id
   where l.item_id = p_id;
  select to_jsonb(e) into v_est from catawiki_estimates e where e.item_id = p_id;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.ts), '[]'::jsonb) into v_snaps
    from catawiki_snapshots s where s.item_id = p_id;
  return jsonb_build_object('lot', v_lot, 'estimate', v_est, 'snapshots', v_snaps);
end $$;

create or replace function dash_catawiki_set_estimate(p_token text, p_id text, p_low numeric, p_high numeric, p_max_bid numeric, p_confidence text, p_notes text, p_sources text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  insert into catawiki_estimates (item_id, est_low, est_high, max_bid, confidence, notes, sources, updated_at)
  values (p_id, p_low, p_high, p_max_bid, p_confidence, p_notes, p_sources, now())
  on conflict (item_id) do update set
    est_low = excluded.est_low, est_high = excluded.est_high, max_bid = excluded.max_bid,
    confidence = excluded.confidence, notes = excluded.notes, sources = excluded.sources, updated_at = now();
end $$;

create or replace function dash_catawiki_clear_estimate(p_token text, p_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  delete from catawiki_estimates where item_id = p_id;
end $$;

create or replace function dash_catawiki_set_starred(p_token text, p_id text, p_starred boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  update catawiki_lots set starred = p_starred, tracked = (tracked or p_starred) where item_id = p_id;
end $$;

create or replace function dash_catawiki_categories(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows jsonb;
begin
  perform assert_dash_token(p_token);
  select coalesce(jsonb_agg(jsonb_build_object('category', category, 'open', open, 'total', total) order by total desc), '[]'::jsonb)
    into v_rows
    from (
      select coalesce(category, 'Other') as category,
             count(*) filter (where ends_at > p_now) as open,
             count(*) as total
        from catawiki_lots
       group by coalesce(category, 'Other')
    ) c;
  return v_rows;
end $$;

-- Ingest: upserts one lot plus a snapshot row, called by the crawler. Reuses the ingest token
-- (not the dashboard token) since this writes data rather than reading it.
create or replace function catawiki_ingest_lot(p_token text, p_lot jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item_id text := p_lot->>'item_id';
begin
  perform assert_token(p_token);
  if p_lot ? 'auction_id' and p_lot->>'auction_id' is not null then
    insert into catawiki_auctions (auction_id, name, url, category, curator, ends_at, last_crawled_at)
    values (p_lot->>'auction_id', p_lot->>'auction_name', p_lot->>'auction_url', p_lot->>'category',
            p_lot->>'curator', (p_lot->>'auction_ends_at')::timestamptz, now())
    on conflict (auction_id) do update set
      last_crawled_at = now(),
      ends_at = coalesce(excluded.ends_at, catawiki_auctions.ends_at);
  end if;

  insert into catawiki_lots (
    item_id, auction_id, name, url, category, ends_at, live_format, no_reserve, reserve_met,
    high_bid, is_starting_bid, watchers_count, bids_count, estimate_low, estimate_high, shipping_eur,
    catalog_number, condition, description, seller_name, seller_location, seller_verified,
    seller_feedback_pct, seller_objects_sold, snapshot_ts
  ) values (
    v_item_id, p_lot->>'auction_id', p_lot->>'name', p_lot->>'url', p_lot->>'category',
    (p_lot->>'ends_at')::timestamptz, coalesce((p_lot->>'live_format')::boolean, false),
    coalesce((p_lot->>'no_reserve')::boolean, false), (p_lot->>'reserve_met')::boolean,
    (p_lot->>'high_bid')::numeric, coalesce((p_lot->>'is_starting_bid')::boolean, false),
    (p_lot->>'watchers_count')::int, (p_lot->>'bids_count')::int,
    (p_lot->>'estimate_low')::numeric, (p_lot->>'estimate_high')::numeric, (p_lot->>'shipping_eur')::numeric,
    p_lot->>'catalog_number', p_lot->>'condition', p_lot->>'description',
    p_lot->>'seller_name', p_lot->>'seller_location', (p_lot->>'seller_verified')::boolean,
    (p_lot->>'seller_feedback_pct')::numeric, (p_lot->>'seller_objects_sold')::int, now()
  )
  on conflict (item_id) do update set
    auction_id = coalesce(excluded.auction_id, catawiki_lots.auction_id),
    high_bid = excluded.high_bid, is_starting_bid = excluded.is_starting_bid,
    watchers_count = excluded.watchers_count, bids_count = excluded.bids_count,
    reserve_met = coalesce(excluded.reserve_met, catawiki_lots.reserve_met),
    ends_at = coalesce(excluded.ends_at, catawiki_lots.ends_at),
    estimate_low = coalesce(excluded.estimate_low, catawiki_lots.estimate_low),
    estimate_high = coalesce(excluded.estimate_high, catawiki_lots.estimate_high),
    shipping_eur = coalesce(excluded.shipping_eur, catawiki_lots.shipping_eur),
    catalog_number = coalesce(excluded.catalog_number, catawiki_lots.catalog_number),
    condition = coalesce(excluded.condition, catawiki_lots.condition),
    description = coalesce(excluded.description, catawiki_lots.description),
    seller_name = coalesce(excluded.seller_name, catawiki_lots.seller_name),
    seller_location = coalesce(excluded.seller_location, catawiki_lots.seller_location),
    seller_verified = coalesce(excluded.seller_verified, catawiki_lots.seller_verified),
    seller_feedback_pct = coalesce(excluded.seller_feedback_pct, catawiki_lots.seller_feedback_pct),
    seller_objects_sold = coalesce(excluded.seller_objects_sold, catawiki_lots.seller_objects_sold),
    snapshot_ts = now();

  insert into catawiki_snapshots (item_id, high_bid, watchers_count, bids_count)
  values (v_item_id, (p_lot->>'high_bid')::numeric, (p_lot->>'watchers_count')::int, (p_lot->>'bids_count')::int);
end $$;

revoke all on function dash_catawiki_search(text, jsonb, timestamptz), dash_catawiki_lot(text, text),
  dash_catawiki_set_estimate(text, text, numeric, numeric, numeric, text, text, text),
  dash_catawiki_clear_estimate(text, text), dash_catawiki_set_starred(text, text, boolean),
  dash_catawiki_categories(text, timestamptz), catawiki_ingest_lot(text, jsonb) from public;
grant execute on function dash_catawiki_search(text, jsonb, timestamptz), dash_catawiki_lot(text, text),
  dash_catawiki_set_estimate(text, text, numeric, numeric, numeric, text, text, text),
  dash_catawiki_clear_estimate(text, text), dash_catawiki_set_starred(text, text, boolean),
  dash_catawiki_categories(text, timestamptz), catawiki_ingest_lot(text, jsonb) to anon, service_role;
