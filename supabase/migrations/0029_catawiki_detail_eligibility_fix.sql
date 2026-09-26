-- 0029: catawiki_next_job picked its next detail-job candidate with `estimate_low is null` --
-- meaning "Catawiki hasn't published its own expert estimate for this lot yet". But most ordinary
-- lots never get one at all, detailed or not (confirmed against live data: 26 real lots, all
-- detail-visited or not, zero with estimate_low populated) -- so that condition never actually
-- turns false once a lot IS detailed. Combined with all 26 lots sharing one identical first_seen
-- (inserted together in one list-job batch), `order by first_seen asc limit 1` had no real
-- tiebreak, so the crawler kept re-visiting whichever handful of lots won ties rather than ever
-- reaching the rest -- 148 successful detail visits produced data for only 3 of 26 real lots.
--
-- seller_name is only ever populated by an actual detail-page parse (a list-job payload never
-- carries it), so "seller_name is null" is what "never detailed" actually means. Same fix in both
-- of this function's two occurrences of the old check.

-- Also fixes a latent crash in the same function: the quiet-hours check used
-- `v_q is not null and jsonb_array_length(v_q)`, which throws if quiet_hours is ever a JSON null
-- (not the same thing as a SQL NULL) rather than a real array -- EBTH's own next_job already
-- avoids exactly this with `jsonb_typeof(v_q) = 'array'`, which this now matches.

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
  if jsonb_typeof(v_q) = 'array' then
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
     where ends_at > p_now and seller_name is null order by first_seen asc, item_id asc limit 1;
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
   where ends_at > p_now and seller_name is null order by first_seen asc, item_id asc limit 1;
  if v_item_id is not null then
    return jsonb_build_object('kind', 'detail', 'url', v_url, 'item_id', v_item_id);
  end if;

  return null;
end $$;
