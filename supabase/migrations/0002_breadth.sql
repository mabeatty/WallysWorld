-- 0002: breadth. Sale and category pages (many lots per page load), slower cadence for them,
-- "tracked" lots (only those get detail and close-out page loads), and a page-aware daily cap.

alter table fetches add column if not exists pages int not null default 1;
alter table lots add column if not exists tracked boolean not null default false;
alter table seeds add column if not exists interval_min int;
alter table seeds add column if not exists hot_interval_min int;

-- Everything captured before this migration came from the followed-items page.
update lots set tracked = true;
update seeds set hot_interval_min = 10 where url like 'https://www.ebth.com/sales/%' or url like 'https://www.ebth.com/categories/%';

-- Bid counts and bidders come from lot pages, not sale cards, so show the latest known values.
drop view if exists lot_latest;
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

-- ---------------------------------------------------------------- next_job
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

  -- the daily cap counts every page read, so a 15-page sale refresh uses 15
  v_mid := date_trunc('day', v_local) at time zone v_tz;
  select coalesce(sum(pages), 0)::int into v_n from fetches where source = 'job' and ts >= v_mid;
  if v_n >= cfg_int('daily_request_cap') then return null; end if;

  if exists (select 1 from fetches
             where source = 'job' and ts > p_now - make_interval(secs => cfg_int('min_gap_seconds'))) then
    return null;
  end if;

  -- 1. close-outs for tracked lots only; other lots get their final price from list captures
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
    v_interval := case when v_hot then coalesce(v_seed.hot_interval_min, cfg_int('hot_interval_min'))
                       else coalesce(v_seed.interval_min, cfg_int('list_interval_min')) end;
    if p_now - v_last_any >= make_interval(mins => v_interval) then
      if v_hot then
        return jsonb_build_object('kind', 'list', 'url', v_seed.url,
                                  'item_id', null, 'requires_login', v_seed.requires_login);
      end if;
      v_regular := coalesce(v_regular, jsonb_build_object('kind', 'list', 'url', v_seed.url,
                            'item_id', null, 'requires_login', v_seed.requires_login));
    end if;
  end loop;

  -- 3. one-time detail page for tracked lots closing within the horizon
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

-- ---------------------------------------------------------------- ingest_page
create or replace function ingest_page(p_token text, p jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job jsonb := case when jsonb_typeof(p->'job') = 'object' then p->'job' else null end;
  v_source text := case when v_job is null then 'passive' else 'job' end;
  v_verdict text := coalesce(p->>'verdict', 'ok');
  v_items jsonb := coalesce(p->'items', '[]'::jsonb);
  v_sale jsonb := case when jsonb_typeof(p->'sale') = 'object' then p->'sale' else null end;
  v_pages int := greatest(coalesce((p->>'pages')::int, 1), 1);
  v_followed boolean := coalesce(v_job->>'url', p->>'url', '') like '%/users/followed_items%';
  v_it jsonb; v_fid bigint; v_id text; v_state text; v_tries int; v_closed boolean;
  v_end timestamptz; v_old_end timestamptz; v_new_end timestamptz; v_approx boolean; v_moved boolean;
  v_streak int; v_halt boolean := false; v_reason text;
begin
  perform assert_token(p_token);

  insert into fetches (ts, source, kind, url, item_id, verdict, note, n_items, pages)
  values (p_now, v_source, coalesce(v_job->>'kind', p->>'kind'), coalesce(v_job->>'url', p->>'url'),
          v_job->>'item_id', v_verdict, left(p->>'note', 300), jsonb_array_length(v_items), v_pages)
  returning id into v_fid;

  if v_verdict = 'ok' then
    update settings set value = '0'::jsonb where key = 'bad_streak';

    for v_it in select value from jsonb_array_elements(v_items) loop
      v_id := v_it->>'item_id';
      continue when v_id is null;

      v_end := nullif(v_it->>'ends_at', '')::timestamptz;
      v_approx := coalesce((v_it->>'ends_at_approx')::boolean, false);
      select ends_at into v_old_end from lots where item_id = v_id;
      -- exact end times: any change counts (extended bidding). Card times are minute-rounded: only a move over 90s counts.
      v_moved := v_end is not null and v_old_end is not null
                 and abs(extract(epoch from (v_end - v_old_end))) > case when v_approx then 90 else 0 end;
      v_new_end := case when v_end is null then v_old_end
                        when v_old_end is null then v_end
                        when v_approx and not v_moved then v_old_end
                        else v_end end;

      insert into lots (item_id, url, name, first_seen, ends_at, sale_id, sale_name, tracked)
      values (v_id, nullif(v_it->>'url', ''), v_it->>'name', p_now, v_new_end,
              v_sale->>'id', v_sale->>'name', v_followed)
      on conflict (item_id) do update set
        url = coalesce(excluded.url, lots.url),
        name = coalesce(excluded.name, lots.name),
        sale_id = coalesce(excluded.sale_id, lots.sale_id),
        sale_name = coalesce(excluded.sale_name, lots.sale_name),
        tracked = lots.tracked or excluded.tracked,
        closeout_tries = case when v_moved then 0 else lots.closeout_tries end,
        closeout_next = case when v_moved then null else lots.closeout_next end,
        ends_at = coalesce(v_new_end, lots.ends_at);

      insert into snapshots (item_id, ts, fetch_id, state, high_bid, min_next_bid, bids_count,
                             unique_bidders, extended, ends_at, bidder_ids)
      values (v_id, p_now, v_fid, v_it->>'state', (v_it->>'high_bid')::numeric, (v_it->>'min_next_bid')::numeric,
              (v_it->>'bids_count')::int, (v_it->>'unique_bidders')::int, (v_it->>'extended')::boolean,
              v_new_end, coalesce(v_it->'bidder_ids', '[]'::jsonb));
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
                        tracked = tracked or v_source = 'passive',   -- a lot you opened yourself is one you care about
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
          update lots set closeout_done = true where item_id = v_id;
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

  else
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

-- ---------------------------------------------------------------- dashboard: sale and category pages read faster while lots close
create or replace function dash_add_seed(p_token text, p_url text, p_login boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_name text;
begin
  perform assert_dash_token(p_token);
  v_url := regexp_replace(trim(p_url), '#.*$', '');
  if v_url !~ '^https://www\.ebth\.com/' then raise exception 'only https://www.ebth.com pages can be watched'; end if;
  v_name := left(regexp_replace(trim(both '/' from coalesce(substring(v_url from 'https://www\.ebth\.com(/[^?#]*)'), '')), '[^a-zA-Z0-9]+', '-', 'g'), 40);
  if v_name = '' then v_name := 'home'; end if;
  insert into seeds (name, url, requires_login, enabled, hot_interval_min)
  values (v_name, v_url, coalesce(p_login, false), true, case when v_url ~ '^https://www\.ebth\.com/(sales|categories)/' then 10 end)
  on conflict (name) do update set url = excluded.url, requires_login = excluded.requires_login, enabled = true,
                                   hot_interval_min = excluded.hot_interval_min;
end $$;

revoke all on function next_job(text, timestamptz), ingest_page(text, jsonb, timestamptz), dash_add_seed(text, text, boolean) from public;
grant execute on function next_job(text, timestamptz), ingest_page(text, jsonb, timestamptz) to anon, service_role;
grant execute on function dash_add_seed(text, text, boolean) to anon, service_role;
