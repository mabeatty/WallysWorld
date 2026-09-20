-- 0004: (a) keep the extension's diagnostic text for each capture, (b) let the database hand the extension a
-- paging hint (a URL template and headers) so the request style can be corrected without updating the extension.
alter table fetches add column if not exists diag text;
insert into settings (key, value) values ('paging_hint', 'null'::jsonb) on conflict (key) do nothing;

do $$
declare d text;
begin
  select pg_get_functiondef('public.ingest_page(text,jsonb,timestamptz)'::regprocedure) into d;
  d := replace(d, 'verdict, note, n_items, pages)', 'verdict, note, n_items, pages, diag)');
  d := replace(d, 'jsonb_array_length(v_items), v_pages)', 'jsonb_array_length(v_items), v_pages, left(p->>''diag'', 2000))');
  if position('pages, diag)' in d) = 0 or position('left(p->>''diag'', 2000)' in d) = 0 then
    raise exception 'ingest_page definition did not match; migration 0004 not applied';
  end if;
  execute d;

  select pg_get_functiondef('public.next_job(text,timestamptz)'::regprocedure) into d;
  d := replace(d, '''item_id'', null, ''requires_login'', v_seed.requires_login', '''item_id'', null, ''requires_login'', v_seed.requires_login, ''hint'', cfg(''paging_hint'')');
  if position('''hint'', cfg(''paging_hint'')' in d) = 0 then
    raise exception 'next_job definition did not match; migration 0004 not applied';
  end if;
  execute d;
end $$;
