# EBTH Watch

Watches auction lots on ebth.com, records every bid change and every closing price, and shows it on a private dashboard.

| Folder | What it is |
|---|---|
| `extension/` | Chrome extension. The only part that touches ebth.com. It runs in your own signed-in browser. |
| `supabase/migrations/` | The database: tables, security, and the functions the extension and dashboard call. |
| `app/`, `lib/`, `middleware.ts` | The dashboard (Next.js, deployed on Vercel). |
| `tests/` | Automated checks for the page reader and the database logic. |

## How it is wired

- The extension and the dashboard both talk to the database through functions, each with its own secret token (stored in the `settings` table). Neither holds a database master key, and the tables are not readable with the public key.
- Vercel environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DASHBOARD_TOKEN` (the `dashboard_token` row in `settings`), `DASHBOARD_PASSWORD` (protects the dashboard).
- The extension's connection code (project URL, public key, `ingest_token`) is shown on the dashboard's Setup page.

## Safety behavior

The collector loads one page at a time, slowly, inside your normal browser session. It never runs on account, cart or checkout pages. On any block, challenge or sign-out it stops itself, and the dashboard shows why. It does not try to get around a block.

## Tests

Save two pages from your own browser into `tests/fixtures/` (a lot page whose filename contains `Rolex`, and the Followed Items page), then in `tests/` run `npm install` and `npm test`. Fixtures contain account data, so they are git-ignored.
