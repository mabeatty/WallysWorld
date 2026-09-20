-- EBTH watch: schema, lockdown, and the functions the Chrome extension talks to.
-- Paste this whole file into the Supabase SQL editor and run it once.

-- ---------------------------------------------------------------- settings
create table if not exists settings (key text primary key, value jsonb not null);

insert into settings (key, value) values
  ('ingest_token',         to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))),
  ('dashboard_token',      to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))),
  ('paused',               'false'::jsonb),
  ('halt',                 'null'::jsonb),
  ('bad_streak',           '0'::jsonb),
  ('timezone',             '"America/Chicago"'::jsonb),
  ('quiet_hours',          '[1,6]'::jsonb),      -- local hours [start,end) with no fetching
  ('min_gap_seconds',      '45'::jsonb),         -- minimum spacing between page loads
  ('daily_request_cap',    '400'::jsonb),
  ('list_interval_min',    '30'::jsonb),
  ('hot_window_min',       '60'::jsonb),         -- a lot closing within this window...
  ('hot_interval_min',     '5'::jsonb),          -- ...makes its list refresh this often
  ('detail_horizon_hours', '72'::jsonb),
  ('closeout_delay_min',   '3'::jsonb),
  ('closeout_retry_min',   '5'::jsonb),
  ('closeout_max_tries',   '6'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table if not exists seeds (
  name text primary key,
  url text not null unique,
  requires_login boolean not null default false,
  enabled boolean not null default true
);

insert into seeds (name, url, requires_login) values
  ('followed',   'https://www.ebth.com/users/followed_items', true),
  ('sale-90479', 'https://www.ebth.com/sales/90479-september-remarkable-finds', false)
on conflict do nothing;

create table if not exists fetches (
  id bigserial primary key,
  ts timestamptz not null default now(),
  source text not null,                 -- 'job' (scheduled) or 'passive' (a page you opened yourself)
  kind text, url text, item_id text,
  verdict text not null, note text,
  n_items int not null default 0
);
create index if not exists ix_fetches_url on fetches (url, id desc);
create index if not exists ix_fetches_ts on fetches (ts);

create table if not exists lots (
  item_id text primary key,
  url text, name text,
  first_seen timestamptz not null default now(),
  ends_at timestamptz,
  sale_id text, sale_name text,
  detail_done boolean not null default false,
  closeout_done boolean not null default false,
  closeout_tries int not null default 0,
  closeout_next timestamptz
);
create index if not exists ix_lots_ends on lots (ends_at);

create table if not exists snapshots (
  id bigserial primary key,
  item_id text not null,
  ts timestamptz not null default now(),
  fetch_id bigint,
  state text,
  high_bid numeric, min_next_bid numeric,
  bids_count int, unique_bidders int,
  extended boolean, ends_at timestamptz,
  bidder_ids jsonb
);
create index if not exists ix_snap_item on snapshots (item_id, id desc);
create index if not exists ix_snap_fetch on snapshots (fetch_id);

create table if not exists lot_details (
  id bigserial primary key,
  item_id text not null,
  ts timestamptz not null default now(),
  kind text,
  data jsonb not null
);
create index if not exists ix_details_item on lot_details (item_id, id desc);

create or replace view lot_latest as
select l.*, s.state, s.high_bid, s.min_next_bid, s.bids_count, s.unique_bidders,
       s.extended, s.ts as snapshot_ts
from lots l
left join lateral (
  select * from snapshots where item_id = l.item_id order by id desc limit 1
) s on true;

-- ---------------------------------------------------------------- helpers (not callable by the extension)
create or replace function cfg(k text) returns jsonb language sql stable as
$$ select value from settings where key = k $$;

create or replace function cfg_int(k text) returns int language sql stable as
$$ select (value #>> '{}')::int from settings where key = k $$;

create or replace function cfg_text(k text) returns text language sql stable as
$$ select value #>> '{}' from settings where key = k $$;

create or replace function assert_token(t text) returns void language plpgsql as $$
begin
  if t is null or t is distinct from cfg_text('ingest_token') then
    raise exception 'invalid token' using errcode = '28000';
  end if;
end $$;

create or replace function assert_dash_token(t text) returns void language plpgsql as $$
begin
  if t is null or t is distinct from cfg_text('dashboard_token') then
    raise exception 'invalid token' using errcode = '28000';
  end if;
end $$;

-- ---------------------------------------------------------------- ping: connection check for the extension
create or replace function ping(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mid timestamptz;
begin
  perform assert_token(p_token);
  v_mid := date_trunc('day', p_now at time zone cfg_text('timezone')) at time zone cfg_text('timezone');
  return jsonb_build_object(
    'ok', true,
    'paused', cfg('paused'),
    'halt', cfg('halt'),
    'last_fetch', (select max(ts) from fetches),
    'jobs_today', (select count(*) from fetches where source = 'job' and ts >= v_mid)
  );
end $$;

-- ---------------------------------------------------------------- next_job: what should the browser load next?
create or replace function next_job(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row record; v_seed record;
  v_local timestamp; v_q jsonb; v_h int; v_n int; v_mid timestamptz;
  v_last_any timestamptz; v_last_ok bigint; v_soonest timestamptz;
  v_hot boolean; v_interval int; v_regular jsonb := null;
  v_tz text;
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
  select count(*) into v_n from fetches where source = 'job' and ts >= v_mid;
  if v_n >= cfg_int('daily_request_cap') then return null; end if;

  if exists (select 1 from fetches
             where source = 'job' and ts > p_now - make_interval(secs => cfg_int('min_gap_seconds'))) then
    return null;
  end if;

  -- 1. close-outs: capture the final state shortly after a lot ends
  select item_id, url into v_row from lots
   where not closeout_done and url is not null and ends_at is not null
     and ends_at <= p_now - make_interval(mins => cfg_int('closeout_delay_min'))
     and (closeout_next is null or closeout_next <= p_now)
     and closeout_tries < cfg_int('closeout_max_tries')
   order by ends_at limit 1;
  if found then
    return jsonb_build_object('kind', 'closeout', 'url', v_row.url,
                              'item_id', v_row.item_id, 'requires_login', false);
  end if;

  -- 2. list pages; refresh faster while a lot on the list is about to close
  for v_seed in select * from seeds where enabled order by name loop
    select max(ts) into v_last_any from fetches where url = v_seed.url;
    if v_last_any is null then
      v_regular := coalesce(v_regular, jsonb_build_object('kind', 'list', 'url', v_seed.url,
                            'item_id', null, 'requires_login', v_seed.requires_login));
      continue;
    end if;
    select id into v_last_ok from fetches where url = v_seed.url and verdict = 'ok' order by id desc limit 1;
    v_soonest := null;
    if v_last_ok is not null then
      select min(ends_at) into v_soonest from snapshots where fetch_id = v_last_ok and ends_at > p_now;
    end if;
    v_hot := v_soonest is not null and v_soonest <= p_now + make_interval(mins => cfg_int('hot_window_min'));
    v_interval := case when v_hot then cfg_int('hot_interval_min') else cfg_int('list_interval_min') end;
    if p_now - v_last_any >= make_interval(mins => v_interval) then
      if v_hot then
        return jsonb_build_object('kind', 'list', 'url', v_seed.url,
                                  'item_id', null, 'requires_login', v_seed.requires_login);
      end if;
      v_regular := coalesce(v_regular, jsonb_build_object('kind', 'list', 'url', v_seed.url,
                            'item_id', null, 'requires_login', v_seed.requires_login));
    end if;
  end loop;

  -- 3. one-time detail page for lots closing within the horizon
  select item_id, url into v_row from lots
   where not detail_done and url is not null and ends_at > p_now
     and ends_at <= p_now + make_interval(hours => cfg_int('detail_horizon_hours'))
   order by ends_at limit 1;
  if found then
    return jsonb_build_object('kind', 'detail', 'url', v_row.url,
                              'item_id', v_row.item_id, 'requires_login', false);
  end if;

  return v_regular;
end $$;

-- ---------------------------------------------------------------- ingest_page: store what the browser saw
create or replace function ingest_page(p_token text, p jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job jsonb := case when jsonb_typeof(p->'job') = 'object' then p->'job' else null end;
  v_source text := case when v_job is null then 'passive' else 'job' end;
  v_verdict text := coalesce(p->>'verdict', 'ok');
  v_items jsonb := coalesce(p->'items', '[]'::jsonb);
  v_it jsonb; v_fid bigint; v_id text; v_state text; v_tries int; v_closed boolean;
  v_streak int; v_halt boolean := false; v_reason text;
begin
  perform assert_token(p_token);

  insert into fetches (ts, source, kind, url, item_id, verdict, note, n_items)
  values (p_now, v_source, coalesce(v_job->>'kind', p->>'kind'), coalesce(v_job->>'url', p->>'url'),
          v_job->>'item_id', v_verdict, left(p->>'note', 300), jsonb_array_length(v_items))
  returning id into v_fid;

  if v_verdict = 'ok' then
    update settings set value = '0'::jsonb where key = 'bad_streak';

    for v_it in select value from jsonb_array_elements(v_items) loop
      v_id := v_it->>'item_id';
      continue when v_id is null;
      insert into lots (item_id, url, name, first_seen, ends_at)
      values (v_id, nullif(v_it->>'url', ''), v_it->>'name', p_now, nullif(v_it->>'ends_at', '')::timestamptz)
      on conflict (item_id) do update set
        url = coalesce(excluded.url, lots.url),
        name = coalesce(excluded.name, lots.name),
        closeout_tries = case when excluded.ends_at is not null and excluded.ends_at is distinct from lots.ends_at
                              then 0 else lots.closeout_tries end,
        closeout_next = case when excluded.ends_at is not null and excluded.ends_at is distinct from lots.ends_at
                             then null else lots.closeout_next end,
        ends_at = coalesce(excluded.ends_at, lots.ends_at);

      insert into snapshots (item_id, ts, fetch_id, state, high_bid, min_next_bid, bids_count,
                             unique_bidders, extended, ends_at, bidder_ids)
      values (v_id, p_now, v_fid, v_it->>'state', (v_it->>'high_bid')::numeric, (v_it->>'min_next_bid')::numeric,
              (v_it->>'bids_count')::int, (v_it->>'unique_bidders')::int, (v_it->>'extended')::boolean,
              nullif(v_it->>'ends_at', '')::timestamptz, coalesce(v_it->'bidder_ids', '[]'::jsonb));
    end loop;

    if p->>'kind' = 'lot' then
      v_id := coalesce(p->'lot'->>'item_id', v_job->>'item_id');
      if v_id is not null then
        insert into lots (item_id, url, first_seen) values (v_id, p->>'url', p_now) on conflict (item_id) do nothing;
        if jsonb_typeof(p->'lot') = 'object' and coalesce(p->'lot'->'specs', '{}'::jsonb) <> '{}'::jsonb then
          insert into lot_details (item_id, ts, kind, data)
          values (v_id, p_now, coalesce(v_job->>'kind', 'passive'), p->'lot');
        end if;
        update lots set detail_done = true,
                        url = coalesce(url, p->>'url'),
                        sale_id = coalesce(p->'lot'->>'sale_id', sale_id),
                        sale_name = coalesce(p->'lot'->>'sale_name', sale_name)
         where item_id = v_id;

        select it->>'state' into v_state from jsonb_array_elements(v_items) it where it->>'item_id' = v_id limit 1;
        select closeout_tries into v_tries from lots where item_id = v_id;
        if v_job->>'kind' = 'closeout' then
          v_closed := (v_state is not null and v_state <> 'for_sale') or (v_state is null and v_tries >= 1);
          if v_closed then
            update lots set closeout_done = true where item_id = v_id;
          else
            update lots set closeout_tries = closeout_tries + 1,
                            closeout_next = p_now + make_interval(mins => cfg_int('closeout_retry_min'))
             where item_id = v_id;
          end if;
        elsif v_state is not null and v_state <> 'for_sale' then
          update lots set closeout_done = true where item_id = v_id;   -- you happened to view it after close
        end if;
      end if;
    end if;

  elsif v_verdict = 'gone' then
    if v_job->>'kind' = 'detail' then update lots set detail_done = true where item_id = v_job->>'item_id';
    elsif v_job->>'kind' = 'closeout' then update lots set closeout_done = true where item_id = v_job->>'item_id';
    end if;

  elsif v_verdict in ('blocked', 'logged_out') then
    v_halt := true;
    v_reason := v_verdict || ': ' || coalesce(p->>'note', '') || ' (' || coalesce(v_job->>'url', p->>'url', '') || ')';

  else  -- unexpected / transient: tolerate one, halt on two in a row
    v_streak := coalesce(cfg_int('bad_streak'), 0) + 1;
    update settings set value = to_jsonb(v_streak) where key = 'bad_streak';
    if v_streak >= 2 then
      v_halt := true;
      v_reason := v_verdict || ' twice in a row: ' || coalesce(p->>'note', '') || ' (' || coalesce(v_job->>'url', p->>'url', '') || ')';
    end if;
  end if;

  if v_halt then
    insert into settings (key, value)
    values ('halt', jsonb_build_object('reason', v_reason, 'at', p_now))
    on conflict (key) do update set value = excluded.value;
  end if;

  return jsonb_build_object('ok', true, 'fetch_id', v_fid, 'n_items', jsonb_array_length(v_items), 'halted', v_halt);
end $$;

-- ---------------------------------------------------------------- lockdown
alter table settings     enable row level security;
alter table seeds        enable row level security;
alter table fetches      enable row level security;
alter table lots         enable row level security;
alter table snapshots    enable row level security;
alter table lot_details  enable row level security;

revoke all on settings, seeds, fetches, lots, snapshots, lot_details, lot_latest from anon, authenticated;
revoke all on sequence fetches_id_seq, snapshots_id_seq, lot_details_id_seq from anon, authenticated;

revoke all on function cfg(text), cfg_int(text), cfg_text(text), assert_token(text), assert_dash_token(text) from public, anon, authenticated;
revoke all on function ping(text, timestamptz), next_job(text, timestamptz), ingest_page(text, jsonb, timestamptz) from public;
grant execute on function ping(text, timestamptz), next_job(text, timestamptz), ingest_page(text, jsonb, timestamptz) to anon, service_role;

-- ---------------------------------------------------------------- dashboard functions
-- The dashboard never holds a database master key. It calls these with the public key plus its own token.
create or replace function dash_home(p_token text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'halt', cfg('halt'), 'paused', cfg('paused'),
    'lots', (select count(*) from lots),
    'snapshots', (select count(*) from snapshots),
    'closeouts', (select count(*) from lots where closeout_done),
    'jobs_24h', (select count(*) from fetches where source = 'job' and ts >= p_now - interval '24 hours'),
    'closing', coalesce((select jsonb_agg(to_jsonb(x) order by x.ends_at)
                           from (select * from lot_latest where ends_at > p_now order by ends_at limit 40) x), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(to_jsonb(x) order by x.ends_at desc)
                          from (select * from lot_latest where ends_at <= p_now order by ends_at desc limit 15) x), '[]'::jsonb),
    'fetches', coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc)
                           from (select * from fetches order by id desc limit 12) x), '[]'::jsonb)
  );
end $$;

create or replace function dash_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'lot', (select to_jsonb(l) from lot_latest l where l.item_id = p_id),
    'details', (select data from lot_details where item_id = p_id order by id desc limit 1),
    'snapshots', coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
                             from (select id, ts, high_bid, bids_count, unique_bidders, state, extended
                                     from snapshots where item_id = p_id) s), '[]'::jsonb)
  );
end $$;

create or replace function dash_setup(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'ingest_token', cfg_text('ingest_token'),
    'seeds', coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (select name, url, requires_login, enabled from seeds) x), '[]'::jsonb)
  );
end $$;

create or replace function dash_add_seed(p_token text, p_url text, p_login boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_name text;
begin
  perform assert_dash_token(p_token);
  v_url := regexp_replace(trim(p_url), '#.*$', '');
  if v_url !~ '^https://www\.ebth\.com/' then raise exception 'only https://www.ebth.com pages can be watched'; end if;
  v_name := left(regexp_replace(trim(both '/' from coalesce(substring(v_url from 'https://www\.ebth\.com(/[^?#]*)'), '')), '[^a-zA-Z0-9]+', '-', 'g'), 40);
  if v_name = '' then v_name := 'home'; end if;
  insert into seeds (name, url, requires_login, enabled) values (v_name, v_url, coalesce(p_login, false), true)
  on conflict (name) do update set url = excluded.url, requires_login = excluded.requires_login, enabled = true;
end $$;

create or replace function dash_remove_seed(p_token text, p_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  delete from seeds where name = p_name;
end $$;

create or replace function dash_resume(p_token text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  update settings set value = 'null'::jsonb where key = 'halt';
  update settings set value = '0'::jsonb where key = 'bad_streak';
end $$;

create or replace function dash_set_paused(p_token text, p_paused boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  update settings set value = to_jsonb(coalesce(p_paused, false)) where key = 'paused';
end $$;

revoke all on function dash_home(text, timestamptz), dash_lot(text, text), dash_setup(text),
  dash_add_seed(text, text, boolean), dash_remove_seed(text, text), dash_resume(text), dash_set_paused(text, boolean) from public;
grant execute on function dash_home(text, timestamptz), dash_lot(text, text), dash_setup(text),
  dash_add_seed(text, text, boolean), dash_remove_seed(text, text), dash_resume(text), dash_set_paused(text, boolean)
  to anon, service_role;
