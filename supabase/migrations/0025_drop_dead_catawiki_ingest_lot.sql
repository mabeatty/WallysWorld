-- catawiki_ingest_lot (0022) was superseded by catawiki_ingest_page's array/batch form (0023)
-- before any app code was ever written to call it -- nothing in the extension, dashboard, or
-- Node test suite references it. It carried the same unfixed high_bid/is_starting_bid coalesce
-- bug as catawiki_ingest_page did before 0024. Since it's genuinely dead and unused, dropping it
-- rather than patching a function nothing calls.
drop function if exists catawiki_ingest_lot(text, jsonb);
