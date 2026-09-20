-- 0003: a sale or category page you happen to open yourself only shows its first page (48 lots),
-- so it must not reset the schedule for the full, paged read. Followed-items captures still count.
do $$
declare d text;
begin
  select pg_get_functiondef('public.next_job(text,timestamptz)'::regprocedure) into d;
  d := replace(d,
    'select max(ts) into v_last_any from fetches where url = v_seed.url;',
    'select max(ts) into v_last_any from fetches where url = v_seed.url and (source = ''job'' or v_seed.url !~ ''^https://www\.ebth\.com/(sales|categories)/'');');
  d := replace(d,
    'select id into v_last_ok from fetches where url = v_seed.url and verdict = ''ok'' order by id desc limit 1;',
    'select id into v_last_ok from fetches where url = v_seed.url and verdict = ''ok'' and (source = ''job'' or v_seed.url !~ ''^https://www\.ebth\.com/(sales|categories)/'') order by id desc limit 1;');
  if position('source = ''job'' or v_seed.url' in d) = 0 then
    raise exception 'next_job definition did not match; migration 0003 not applied';
  end if;
  execute d;
end $$;
