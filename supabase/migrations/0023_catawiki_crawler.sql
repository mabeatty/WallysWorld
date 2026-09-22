-- 0023: Catawiki crawler scheduling. Reuses the SAME shared pacing (min_gap_seconds,
-- daily_request_cap, quiet_hours, paused, halt) that governs the EBTH extension, rather than a
-- parallel budget -- the real constraint is "how much is this one browser doing in the
-- background," not a per-site allowance, so both platforms draw against one shared clock via the
-- same `fetches` log (now tagged with which platform each row came from).

alter table fetches add column if not exists platform text not null default 'ebth';

create table catawiki_seeds (
  name text primary key,
  url text not null,
  kind text not null default 'auction' check (kind in ('auction', 'category')),
  enabled boolean not null default true,
  last_job_at timestamptz
);
revoke all on catawiki_seeds from anon, authenticated;

insert into settings (key, value) values
  ('catawiki_last_job_kind', '"list"'::jsonb)
on conflict (key) do nothing;

-- Alternates between a "list" job (visit a seed auction/category page -- cheap, finds and
-- refreshes many lots at once) and a "detail" job (visit one open lot's own page -- the only
-- place Catawiki's own published estimate appears). Falls back to whichever kind still has
-- candidates if the other is exhausted, so the extension always has something to do when there
-- is real work and pacing allows it.
create or replace function catawiki_next_job(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text := coalesce(cfg_text('timezone'), 'UTC');
  v_q jsonb := cfg('quiet_hours');
  v_hr int;
  v_last_kind text := cfg_text('catawiki_last_job_kind');
  v_item_id text; v_url text;
  v_seed_name text; v_seed_url text;
begin
  perform assert_token(p_token);
  if cfg('paused') = 'true'::jsonb or cfg('halt') is distinct from 'null'::jsonb then return null; end if;
  if v_q is not null and jsonb_array_length(v_q) = 2 then
    v_hr := extract(hour from p_now at time zone v_tz);
    if v_hr >= (v_q->>0)::int and v_hr < (v_q->>1)::int then return null; end if;
  end if;
  if (select count(*) from fetches
       where source = 'job' and ts > date_trunc('day', p_now at time zone v_tz) at time zone v_tz) >= cfg_int('daily_request_cap')
  then return null; end if;
  if exists (select 1 from fetches where source = 'job' and ts > p_now - make_interval(secs => cfg_int('min_gap_seconds')))
  then return null; end if;

  if v_last_kind is distinct from 'detail' then
    select item_id, url into v_item_id, v_url from catawiki_lots
     where ends_at > p_now and estimate_low is null order by first_seen asc limit 1;
    if v_item_id is not null then
      update settings set value = '"detail"'::jsonb where key = 'catawiki_last_job_kind';
      return jsonb_build_object('kind', 'detail', 'url', v_url, 'item_id', v_item_id);
    end if;
  end if;

  select name, url into v_seed_name, v_seed_url from catawiki_seeds
   where enabled order by last_job_at asc nulls first limit 1;
  if v_seed_name is not null then
    update settings set value = '"list"'::jsonb where key = 'catawiki_last_job_kind';
    return jsonb_build_object('kind', 'list', 'url', v_seed_url, 'seed_name', v_seed_name);
  end if;

  select item_id, url into v_item_id, v_url from catawiki_lots
   where ends_at > p_now and estimate_low is null order by first_seen asc limit 1;
  if v_item_id is not null then
    return jsonb_build_object('kind', 'detail', 'url', v_url, 'item_id', v_item_id);
  end if;

  return null;
end $$;

-- The extension's report from one page load: a "list" job carries many lot summaries (bid,
-- time left, no catalog/estimate), a "detail" job carries one lot with everything, including
-- Catawiki's own estimate. Logs to the shared fetches table either way, and always logs even on
-- a bad verdict so blocks are visible the same way they are for EBTH.
create or replace function catawiki_ingest_page(p_token text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := p->>'kind';
  v_verdict text := coalesce(p->>'verdict', 'ok');
  v_item jsonb;
  v_n int := 0;
begin
  perform assert_token(p_token);

  if v_verdict = 'ok' and p->'auction' is not null and p->'auction'->>'id' is not null then
    insert into catawiki_auctions (auction_id, name, url, category, curator, ends_at, last_crawled_at)
    values (p->'auction'->>'id', p->'auction'->>'name', p->'auction'->>'url', p->'auction'->>'category',
            p->'auction'->>'curator', (p->'auction'->>'ends_at')::timestamptz, now())
    on conflict (auction_id) do update set
      last_crawled_at = now(),
      name = coalesce(excluded.name, catawiki_auctions.name),
      category = coalesce(excluded.category, catawiki_auctions.category),
      curator = coalesce(excluded.curator, catawiki_auctions.curator),
      ends_at = coalesce(excluded.ends_at, catawiki_auctions.ends_at);
  end if;

  if v_verdict = 'ok' then
    for v_item in select * from jsonb_array_elements(coalesce(p->'lots', '[]'::jsonb)) loop
      v_n := v_n + 1;
      insert into catawiki_lots (
        item_id, auction_id, name, url, category, ends_at, live_format, no_reserve, reserve_met,
        high_bid, is_starting_bid, watchers_count, bids_count, estimate_low, estimate_high, shipping_eur,
        catalog_number, condition, description, seller_name, seller_location, seller_verified,
        seller_feedback_pct, seller_objects_sold, snapshot_ts
      ) values (
        v_item->>'item_id', coalesce(v_item->>'auction_id', p->'auction'->>'id'),
        v_item->>'name', v_item->>'url', coalesce(v_item->>'category', p->'auction'->>'category'),
        (v_item->>'ends_at')::timestamptz, coalesce((v_item->>'live_format')::boolean, false),
        coalesce((v_item->>'no_reserve')::boolean, false), (v_item->>'reserve_met')::boolean,
        (v_item->>'high_bid')::numeric, coalesce((v_item->>'is_starting_bid')::boolean, false),
        (v_item->>'watchers_count')::int, (v_item->>'bids_count')::int,
        (v_item->>'estimate_low')::numeric, (v_item->>'estimate_high')::numeric, (v_item->>'shipping_eur')::numeric,
        v_item->>'catalog_number', v_item->>'condition', v_item->>'description',
        v_item->>'seller_name', v_item->>'seller_location', (v_item->>'seller_verified')::boolean,
        (v_item->>'seller_feedback_pct')::numeric, (v_item->>'seller_objects_sold')::int, now()
      )
      on conflict (item_id) do update set
        auction_id = coalesce(excluded.auction_id, catawiki_lots.auction_id),
        name = coalesce(excluded.name, catawiki_lots.name),
        category = coalesce(excluded.category, catawiki_lots.category),
        high_bid = excluded.high_bid, is_starting_bid = excluded.is_starting_bid,
        watchers_count = coalesce(excluded.watchers_count, catawiki_lots.watchers_count),
        bids_count = coalesce(excluded.bids_count, catawiki_lots.bids_count),
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
      values (v_item->>'item_id', (v_item->>'high_bid')::numeric, (v_item->>'watchers_count')::int, (v_item->>'bids_count')::int);
    end loop;
  end if;

  insert into fetches (source, platform, kind, url, item_id, verdict, note, n_items)
  values (coalesce(p->>'source', 'job'), 'catawiki', v_kind, p->>'url', p->>'item_id', v_verdict, p->>'note', v_n);

  if p ? 'seed_name' and p->>'seed_name' is not null then
    update catawiki_seeds set last_job_at = now() where name = p->>'seed_name';
  end if;

  return jsonb_build_object('ok', true, 'n_items', v_n);
end $$;

create or replace function dash_add_catawiki_seed(p_token text, p_url text, p_kind text default 'auction')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  perform assert_dash_token(p_token);
  v_name := regexp_replace(p_url, '^https?://(www\.)?catawiki\.com/', '');
  insert into catawiki_seeds (name, url, kind) values (v_name, p_url, p_kind)
  on conflict (name) do update set url = excluded.url, kind = excluded.kind, enabled = true;
end $$;

create or replace function dash_remove_catawiki_seed(p_token text, p_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  delete from catawiki_seeds where name = p_name;
end $$;

create or replace function dash_catawiki_setup(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_seeds jsonb; v_recent jsonb;
begin
  perform assert_dash_token(p_token);
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'url', url, 'kind', kind, 'enabled', enabled, 'last_job_at', last_job_at) order by name), '[]'::jsonb)
    into v_seeds from catawiki_seeds;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ts', ts, 'source', source, 'kind', kind, 'url', url, 'verdict', verdict, 'note', note, 'n_items', n_items) order by ts desc), '[]'::jsonb)
    into v_recent from (select * from fetches where platform = 'catawiki' order by ts desc limit 20) f;
  return jsonb_build_object('seeds', v_seeds, 'recent', v_recent);
end $$;

revoke all on function catawiki_next_job(text, timestamptz), catawiki_ingest_page(text, jsonb) from public;
grant execute on function catawiki_next_job(text, timestamptz), catawiki_ingest_page(text, jsonb) to anon, service_role;
revoke all on function dash_add_catawiki_seed(text, text, text), dash_remove_catawiki_seed(text, text), dash_catawiki_setup(text) from public;
grant execute on function dash_add_catawiki_seed(text, text, text), dash_remove_catawiki_seed(text, text), dash_catawiki_setup(text) to anon, service_role;
