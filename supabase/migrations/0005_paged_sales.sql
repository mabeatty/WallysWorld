-- 0005: a sale is many pages. Each page of a paged sale (?page=2, ?page=3, ...) is its own unit of work: the
-- database decides which page to load next, and the browser just reads the page it is given.
--   * seeds.page_count: how many pages the sale has (null = a single page)
--   * next_job walks a paged seed one page at a time, each page on its own schedule; pages whose lots are
--     closer to closing are refreshed faster, and a page is retired after a read taken once all its lots closed
--   * ingest_page works out page_count from the sale's lot count when it reads the first page
alter table seeds add column if not exists page_count int;

do $migrate$
declare d text; i int; j int; new_loop text;
begin
  -- ------------------------------------------------------------ next_job: walk pages
  select pg_get_functiondef('public.next_job(text,timestamptz)'::regprocedure) into d;
  d := replace(d, 'v_tz text;', 'v_tz text; v_page int; v_unit text; v_maxend timestamptz; v_last_ok_ts timestamptz; v_data bigint;');
  i := position('  for v_seed in select * from seeds where enabled order by name loop' in d);
  j := position('  end loop;' in substr(d, i));
  if i = 0 or j = 0 then raise exception 'next_job seed loop not found; migration 0005 not applied'; end if;
  j := i + j - 1 + length('  end loop;');
  new_loop := $loop$
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
        -- paged sale: once every lot on this page had closed before the latest read, its final capture is done
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
  end loop;$loop$;
  d := substr(d, 1, i - 1) || new_loop || substr(d, j);
  execute d;

  -- ------------------------------------------------------------ ingest_page: learn the page count from page 1
  select pg_get_functiondef('public.ingest_page(text,jsonb,timestamptz)'::regprocedure) into d;
  d := replace(d, E'    if p->>''kind'' = ''lot'' then',
$learn$    if v_job is not null and v_sale is not null and (v_sale->>'item_count') is not null
       and jsonb_array_length(v_items) >= 24 and coalesce(v_job->>'url', '') !~ '[?&]page=' then
      update seeds set page_count = case when ceil((v_sale->>'item_count')::numeric / jsonb_array_length(v_items)) > 1
                                         then ceil((v_sale->>'item_count')::numeric / jsonb_array_length(v_items))::int end
       where url = v_job->>'url';
    end if;

    if p->>'kind' = 'lot' then$learn$);
  if position('learn' in d) = 0 and position('update seeds set page_count' in d) = 0 then
    raise exception 'ingest_page block not found; migration 0005 not applied';
  end if;
  execute d;
end $migrate$;
