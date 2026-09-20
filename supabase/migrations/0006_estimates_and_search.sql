-- 0006: find lots, and record what you think a lot is worth.
--   * lot_estimates: one current estimate per lot (low/high resale value, your max bid, confidence, notes, sources)
--   * lot_estimate_log: every change, with the bid at the time, so estimates can be compared with closing prices later
--   * dash_search: text search plus filters and sorting over every lot
--   * dash_set_estimate / dash_clear_estimate
--   * dash_lot now includes the lot's estimate

create table if not exists lot_estimates (
  item_id text primary key,
  est_low numeric, est_high numeric, max_bid numeric,
  confidence text check (confidence in ('low', 'medium', 'high')),
  notes text, sources text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lot_estimate_log (
  id bigserial primary key,
  item_id text not null,
  ts timestamptz not null default now(),
  action text not null,
  est_low numeric, est_high numeric, max_bid numeric, confidence text, notes text, sources text,
  high_bid_at_time numeric
);
create index if not exists ix_estimate_log_item on lot_estimate_log (item_id, id desc);

alter table lot_estimates enable row level security;
alter table lot_estimate_log enable row level security;
revoke all on lot_estimates, lot_estimate_log from anon, authenticated;
revoke all on sequence lot_estimate_log_id_seq from anon, authenticated;

-- ---------------------------------------------------------------- set / clear an estimate
create or replace function dash_set_estimate(
  p_token text, p_id text, p_low numeric, p_high numeric, p_max_bid numeric,
  p_confidence text, p_notes text, p_sources text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_bid numeric; v_notes text := nullif(left(trim(coalesce(p_notes, '')), 4000), '');
        v_sources text := nullif(left(trim(coalesce(p_sources, '')), 2000), '');
        v_conf text := nullif(trim(coalesce(p_confidence, '')), '');
begin
  perform assert_dash_token(p_token);
  if not exists (select 1 from lots where item_id = p_id) then raise exception 'unknown lot'; end if;
  if coalesce(p_low, 0) < 0 or coalesce(p_high, 0) < 0 or coalesce(p_max_bid, 0) < 0 then
    raise exception 'values must be zero or more';
  end if;
  if p_low is not null and p_high is not null and p_low > p_high then
    raise exception 'the low estimate is above the high estimate';
  end if;
  if v_conf is not null and v_conf not in ('low', 'medium', 'high') then
    raise exception 'confidence must be low, medium or high';
  end if;
  if p_low is null and p_high is null and p_max_bid is null and v_notes is null and v_sources is null then
    raise exception 'enter at least one value or a note';
  end if;
  select high_bid into v_bid from lot_latest where item_id = p_id;
  insert into lot_estimates (item_id, est_low, est_high, max_bid, confidence, notes, sources)
  values (p_id, p_low, p_high, p_max_bid, v_conf, v_notes, v_sources)
  on conflict (item_id) do update set est_low = excluded.est_low, est_high = excluded.est_high,
    max_bid = excluded.max_bid, confidence = excluded.confidence, notes = excluded.notes,
    sources = excluded.sources, updated_at = now();
  insert into lot_estimate_log (item_id, action, est_low, est_high, max_bid, confidence, notes, sources, high_bid_at_time)
  values (p_id, 'set', p_low, p_high, p_max_bid, v_conf, v_notes, v_sources, v_bid);
end $$;

create or replace function dash_clear_estimate(p_token text, p_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_bid numeric;
begin
  perform assert_dash_token(p_token);
  select high_bid into v_bid from lot_latest where item_id = p_id;
  if exists (select 1 from lot_estimates where item_id = p_id) then
    insert into lot_estimate_log (item_id, action, high_bid_at_time) values (p_id, 'clear', v_bid);
    delete from lot_estimates where item_id = p_id;
  end if;
end $$;

-- ---------------------------------------------------------------- lot page: now includes the estimate
create or replace function dash_lot(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  return jsonb_build_object(
    'lot', (select to_jsonb(l) from lot_latest l where l.item_id = p_id),
    'details', (select data from lot_details where item_id = p_id order by id desc limit 1),
    'estimate', (select to_jsonb(e) from lot_estimates e where e.item_id = p_id),
    'snapshots', coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
                             from (select id, ts, high_bid, bids_count, unique_bidders, state, extended
                                     from snapshots where item_id = p_id) s), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- search
-- p keys (all optional): q (words, all must match the title or your notes), status open|closed|all (default open),
-- min_bid, max_bid, within_hours (closes within), estimate any|with|without, tracked (bool), sale (sale id),
-- sort ends|bid_desc|bid_asc|gap|seen|name (default ends), limit (1-200, default 50), offset
create or replace function dash_search(p_token text, p jsonb default '{}'::jsonb, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_terms text[] := array(select t from unnest(regexp_split_to_array(lower(trim(coalesce(p->>'q', ''))), '\s+')) t where t <> '');
  v_status text := coalesce(nullif(p->>'status', ''), 'open');
  v_sort text := coalesce(nullif(p->>'sort', ''), 'ends');
  v_est text := coalesce(nullif(p->>'estimate', ''), 'any');
  v_sale text := nullif(p->>'sale', '');
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
    select l.*, e.est_low, e.est_high, e.max_bid, e.confidence, e.notes as est_notes, e.updated_at as est_updated,
           (e.est_low - coalesce(l.high_bid, 0)) as gap
      from lot_latest l left join lot_estimates e on e.item_id = l.item_id
     where (v_status = 'all' or (v_status = 'open' and l.ends_at > p_now) or (v_status = 'closed' and l.ends_at <= p_now))
       and (v_min is null or coalesce(l.high_bid, 0) >= v_min)
       and (v_max is null or coalesce(l.high_bid, 0) <= v_max)
       and (v_within is null or (l.ends_at > p_now and l.ends_at <= p_now + make_interval(secs => v_within * 3600)))
       and (v_est = 'any' or (v_est = 'with' and e.item_id is not null) or (v_est = 'without' and e.item_id is null))
       and (not v_tracked or l.tracked)
       and (v_sale is null or l.sale_id = v_sale)
       and not exists (select 1 from unnest(v_terms) t
                        where position(t in lower(coalesce(l.name, '') || ' ' || coalesce(e.notes, ''))) = 0)
  ), ranked as (
    select b.*, count(*) over () as total,
           row_number() over (order by
             case when v_sort = 'ends' then b.ends_at end asc nulls last,
             case when v_sort = 'bid_desc' then b.high_bid end desc nulls last,
             case when v_sort = 'bid_asc' then b.high_bid end asc nulls last,
             case when v_sort = 'gap' then b.gap end desc nulls last,
             case when v_sort = 'seen' then b.snapshot_ts end desc nulls last,
             case when v_sort = 'name' then lower(b.name) end asc nulls last,
             b.ends_at asc nulls last, b.item_id) as rn
      from base b
  )
  select coalesce(max(r.total), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' order by r.rn) filter (where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
    from ranked r;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end $$;

revoke all on function dash_set_estimate(text, text, numeric, numeric, numeric, text, text, text),
  dash_clear_estimate(text, text), dash_search(text, jsonb, timestamptz) from public;
grant execute on function dash_set_estimate(text, text, numeric, numeric, numeric, text, text, text),
  dash_clear_estimate(text, text), dash_search(text, jsonb, timestamptz) to anon, service_role;
