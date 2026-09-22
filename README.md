# Auction Arbitrage Dashboard

Watches auction lots on ebth.com and catawiki.com, records every bid change and every closing price, and shows it on a private dashboard.

| Folder | What it is |
|---|---|
| `extension/` | Chrome extension. The only part that touches ebth.com or catawiki.com. It runs in your own signed-in browser. |
| `supabase/migrations/` | The database, applied in order: `0001_init.sql` (tables, security, functions) then `0002_breadth.sql` (sale and category pages, tracked lots), through `0022`-`0024` (Catawiki's own schema, crawler and a data-corruption fix). |
| `app/`, `lib/`, `middleware.ts` | The dashboard (Next.js, deployed on Vercel). |
| `tests/` | Automated checks for the page reader and the database logic. |

## How it is wired

- The extension and the dashboard both talk to the database through functions, each with its own secret token (stored in the `settings` table). Neither holds a database master key, and the tables are not readable with the public key.
- Vercel environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DASHBOARD_TOKEN` (the `dashboard_token` row in `settings`), `DASHBOARD_PASSWORD` (protects the dashboard).
- The extension's connection code (project URL, public key, `ingest_token`) is shown on the dashboard's Setup page.
- EBTH and Catawiki share one pacing budget (the `fetches` table, tagged by `platform`) rather than two independent ones -- the real constraint is how much this one browser is doing in the background, not a per-site allowance. The extension alternates which platform it checks first each minute so neither starves the other.

## Safety behavior

The collector loads one page at a time, slowly, inside your normal browser session. It never runs on account, cart or checkout pages. On any block, challenge or sign-out it stops itself, and the dashboard shows why. It does not try to get around a block.

## Tests

Save pages from your own browser into `tests/fixtures/` (a lot page whose filename contains `Rolex`, the Followed Items page, and a sale page scrolled to the bottom whose filename starts with `SEPTEMBER_REMARKABLE`) and Catawiki pages into `tests/fixtures_catawiki/`, then from `tests/` run `npm install` and `node --test`. Fixtures contain account data, so they are git-ignored.
