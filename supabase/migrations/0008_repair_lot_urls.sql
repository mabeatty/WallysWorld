-- 0008: some followed lots were stored with the address "https://www.ebth.commailto:" (a share-by-email link was read
-- instead of the lot's own link). Closing-price jobs for them loaded nothing, and the collector halted itself.
-- 1) repair: use the address from the lot's own page when we have it, else the plain item address
update lots l
   set url = coalesce(
         (select d.data->>'url' from lot_details d
           where d.item_id = l.item_id and d.data->>'url' ~ '^https://www\.ebth\.com/items/\d+'
           order by d.id desc limit 1),
         'https://www.ebth.com/items/' || l.item_id)
 where l.url is null or l.url !~ '^https://www\.ebth\.com/items/\d+';

-- 2) guard: whatever a client sends, a lot's address is always a real item address
create or replace function lots_clean_url() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_old text;
begin
  if new.url is null or new.url !~ '^https://www\.ebth\.com/items/\d+' then
    select url into v_old from lots where item_id = new.item_id;      -- keep a good address we already have
    new.url := case when v_old ~ '^https://www\.ebth\.com/items/\d+' then v_old
                    else 'https://www.ebth.com/items/' || new.item_id end;
  end if;
  return new;
end $$;

drop trigger if exists trg_lots_clean_url on lots;
create trigger trg_lots_clean_url before insert or update of url on lots
  for each row execute function lots_clean_url();
