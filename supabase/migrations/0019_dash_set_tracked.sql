-- 0019: lets the dashboard toggle a lot's tracked flag directly, so the user can build a personal
-- watchlist by clicking a star in any results table, not just via the extension's passive-browse
-- or followed-items detection. Reuses the existing tracked column and its search filter untouched.
create or replace function dash_set_tracked(p_token text, p_id text, p_tracked boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_dash_token(p_token);
  update lots set tracked = p_tracked where item_id = p_id;
end $$;

revoke all on function dash_set_tracked(text, text, boolean) from public;
grant execute on function dash_set_tracked(text, text, boolean) to anon, service_role;
