-- 0035: support for a Catawiki category/search page as a crawl source (e.g.
-- catawiki.com/en/c/187-stamps), alongside the existing single-auction seed kind.
--
-- The single-auction seed this project started with inevitably exhausts -- once every lot in it
-- has closed, there's nothing left to discover, and the crawler just re-polls a dead page forever
-- (which is exactly what happened: it sat re-fetching the same 26-item closed auction every two
-- minutes for hours). A category page is different: it aggregates lots across many different,
-- ongoing auctions and keeps refreshing on its own as old lots close and new ones get listed.
--
-- The one real behavior change this requires: a lot discovered via a category page has no ends_at
-- at all until its own detail visit (see extension/lib/catawiki.js's parseCategoryList for why --
-- there's no single shared auction to fall back to the way an auction-list page's lots have).
-- catawiki_next_job's eligibility check required ends_at > now() for a lot to qualify for a detail
-- visit, which would have permanently excluded every category-discovered lot from ever being
-- detailed -- the same class of bug already fixed once in 0028/0029 for a different root cause
-- (an auction-list lot whose own ends_at fallback wasn't being used). Here there's no fallback to
-- use in the first place, so a lot with ends_at is null must itself be treated as eligible: that
-- detail visit is precisely how its real ends_at gets learned.
--
-- No changes were needed to catawiki_ingest_page itself: it already skips the auction upsert
-- when p->'auction' is null, and already prefers each lot's own auction_id over the top-level
-- one -- exactly the shape a category-page payload produces, since parseCategoryList sends
-- auction: null and each lot carries its own auctionId already.

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
     where (ends_at > p_now or ends_at is null) and seller_name is null order by first_seen asc, item_id asc limit 1;
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
   where (ends_at > p_now or ends_at is null) and seller_name is null order by first_seen asc, item_id asc limit 1;
  if v_item_id is not null then
    return jsonb_build_object('kind', 'detail', 'url', v_url, 'item_id', v_item_id);
  end if;

  return null;
end $$;

-- catawiki_ingest_page: adds the placeholder-auction step described above, right before the lots
-- loop that needs it. Otherwise identical to the 0028 version (which already added the ends_at
-- fallback-to-auction logic this builds on top of).
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

  -- 0035: a category-page payload has no top-level auction at all (each lot can belong to a
  -- different one), and even a list/detail payload's lot could in principle name an auction_id
  -- we've never separately crawled. catawiki_lots.auction_id is a foreign key, so any auction_id
  -- a lot references needs a row here first -- a bare placeholder (name/url are NOT NULL columns,
  -- filled with a guessable, real, valid Catawiki URL for that id) rather than skipping the FK
  -- requirement. If that auction is ever actually crawled directly, the upsert above fills in the
  -- real name/category/curator/ends_at over this placeholder, same as any other re-crawl.
  if v_verdict = 'ok' then
    insert into catawiki_auctions (auction_id, name, url)
    select distinct x->>'auction_id', 'Auction ' || (x->>'auction_id'), 'https://www.catawiki.com/en/a/' || (x->>'auction_id')
      from jsonb_array_elements(coalesce(p->'lots', '[]'::jsonb)) x
     where x->>'auction_id' is not null
    on conflict (auction_id) do nothing;
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
        -- fixed (0028): fall back to the auction's own ends_at, same as category/auction_id already do
        coalesce((v_item->>'ends_at')::timestamptz, (p->'auction'->>'ends_at')::timestamptz),
        coalesce((v_item->>'live_format')::boolean, false),
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
