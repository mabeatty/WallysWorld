-- Fixes a data-corruption bug in catawiki_ingest_page (0023): in the lots on-conflict clause,
-- high_bid and is_starting_bid were the only two columns not wrapped in
-- coalesce(excluded.x, catawiki_lots.x). Because the crawler alternates list and detail jobs
-- against the same lots -- list jobs discover/refresh identity, detail jobs capture bid state --
-- every list-job re-crawl of an auction was silently resetting high_bid to null and
-- is_starting_bid to false on every lot a prior detail job had already enriched. Everything below
-- is byte-for-byte the original 0023 function apart from those two lines.
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
        -- fixed (0024): a list-job payload has no bid data at all -- Catawiki's own
        -- __NEXT_DATA__ on an auction-listing page simply doesn't include it -- so a bare
        -- `excluded.x` here silently wiped out whatever a prior detail-job crawl had already
        -- captured for this lot, every time the auction was re-crawled as a list page.
        high_bid = coalesce(excluded.high_bid, catawiki_lots.high_bid),
        is_starting_bid = coalesce((v_item->>'is_starting_bid')::boolean, catawiki_lots.is_starting_bid),
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

