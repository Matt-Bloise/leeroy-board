# Runbook: backup and restore

Last checked: 2026-11-02. Citations are `file:line`, Cloudflare docs URLs, or marked (unverified). No secret values appear here.

## What data lives where

| Data | Location | Source |
| :--- | :--- | :--- |
| Board documents (party, timeline, stats, signups, tonight, launch, decide, guided-atlas, marks, links) | D1 `kv_state`, seeded from `data/*.json` once, then edited live | `infrastructure/scripts/seed-d1.mjs:49-60`; `deploy-cloudflare.yml:219-224` |
| Library pages and pre-built blobs | D1 `lib_pages`, `lib_blobs`, `lib_sources`, `lib_source_snapshots`, `wiki_proposals`, `fact_fixes` | `infrastructure/schema.sql:17-117`; seeded by `seed-d1.mjs:76-129` |
| Ask history, sheet events, dispatches, intents mailbox | D1 `ask_turns`, `sheet_events`, `dispatches`, `intents` | `schema.sql:88-140,188-197` |
| Member key hashes, accounts, sessions, per-user settings | D1 `members`, `accounts`, `account_keys`, `sessions`, `user_state` | `schema.sql:143-185` |
| Guest rate limit counters | D1 `guest_rate_limits` | `schema.sql:200-204` |
| WebSocket room state | Durable Object `BoardRoom`, no storage of its own | `infrastructure/README.md:14` |
| Static site | Git (`master`) and Cloudflare Pages deployments | `deploy-cloudflare.yml:270-290` |
| Worker code and config | Git (`infrastructure/`), Cloudflare Worker versions | `infrastructure/wrangler.toml` |
| Secrets | GitHub Actions secrets and Worker secrets; names in `secrets.md` | `deploy-cloudflare.yml:248-268` |

### `kv_state` rows: public documents versus private config

`kv_state(key, json, updated_at)` mixes both (`schema.sql:10-14`). The Worker refuses to serve private keys from the public `GET /data/:name` and `/atlas/:name` routes (`infrastructure/worker/index.js:1150`, lists at `infrastructure/worker/config.js:98-99`).

- Private, exact keys: `persona`, `name_map`, `discord_members`, `discord_roster`, `vocab`, `votes:index`, `feed_posts` (`config.js:98`).
- Private, prefixes: `ai_budget:`, `vote:`, `votes:`, `feed_`, `private:`, `config:`, `secret` (`config.js:99`).
- Public documents: every other key, for example `party`, `signups`, `launch`, plus `party_sheets` written by the Worker (`index.js:254,289`).

The private rows exist only in D1 and are not in git (`infrastructure/README.md:69`). They are the least recoverable data in the system: Time Travel and your own exports are the only copy.

Stale text found: `infrastructure/README.md:62` says `GET /data/:name` has no allow-list; `index.js:1150` now has one. `PUT /data/:name` is admin-token gated (`index.js:1175-1177`), not member-key as the README route table says (`infrastructure/README.md:50`). Reported here, not changed.

## What is backed up, and what is not

| Item | Backed up? | How |
| :--- | :--- | :--- |
| D1 contents and schema | Yes, point in time | Time Travel, always on, no extra cost (docs: https://developers.cloudflare.com/d1/reference/time-travel/). Window is 30 days on Workers Paid and 7 days on Workers Free (same page). This account's plan is unverified, so assume 7 days. |
| Public board documents as of seed time | Yes | `data/*.json` in git. Stale: live edits are not committed back unless someone runs `node scripts/export-d1.mjs --remote` (`export-d1.mjs:144-163`) and commits. That script rewrites only keys that already have a data file or are in a fixed list of 7; it does not export private rows. |
| Full SQL copy | Only if you make one | `npx wrangler d1 export leeroy-board-db --remote --output=<file>.sql` (flags confirmed with `--help`). No scheduled export exists in `.github/workflows/`. |
| Code, workflows, config | Yes | Git |
| Pages builds | Yes, as deployments | Cloudflare Pages deployment list |
| Worker versions | Last 100 | Cloudflare docs, `rollback.md` |
| Secret values | No | The repo does not and must not store them. Keep the originals in the owner's password manager. Whether Cloudflare can show a Worker secret back is unverified; assume not. |
| Anything older than the Time Travel window with no export | No | Not recoverable |

Recommended gap fill (not implemented here): a scheduled `d1 export` to private storage outside the repository, at least weekly, stored encrypted because exports contain `members`, `sessions` and `user_state`.

## Restore drill (scratch database)

Purpose: prove an export restores, without touching production. Run quarterly and after any schema change. Never run `restore` against `leeroy-board-db` for a drill.

```
cd infrastructure && npm install
# 1. export production (read-only); write outside the repository
npx wrangler d1 export leeroy-board-db --remote --output=../../drill-export.sql
# 2. create a scratch database (name must not collide with leeroy-board-db or leeroy-board-db-pr-*)
npx wrangler d1 create leeroy-board-db-drill
# 3. import the export into the scratch database
npx wrangler d1 execute leeroy-board-db-drill --remote --file=../../drill-export.sql
# 4. verify
npx wrangler d1 execute leeroy-board-db-drill --remote --command="SELECT COUNT(*) AS n FROM kv_state;"
npx wrangler d1 execute leeroy-board-db-drill --remote --command="SELECT key, updated_at FROM kv_state ORDER BY key;"
npx wrangler d1 execute leeroy-board-db-drill --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
# 5. clean up the scratch database, then delete the export file by hand
npx wrangler d1 delete leeroy-board-db-drill --skip-confirmation
```

Pass criteria: the table list matches `schema.sql` (17 tables, see `schema-source-of-truth.md`); the `kv_state` row count equals production; every private key listed above is present. Record the date and result in a PR or issue. Delete the export afterward (it holds key hashes and sessions). Keep it out of the repository: `infrastructure/.gitignore:4` ignores only `.seed-bundle*.sql`, not `*.sql` in general.

Status: the drill was not executed while writing this document (it needs a Cloudflare token). The option names were checked with `--help`; that a D1 export re-imports cleanly through `d1 execute --file` is unverified. Run the drill once and amend this file with the result.

Safer read-only check: `npx wrangler d1 time-travel info leeroy-board-db --timestamp=<recent>` only reads a bookmark. Restore cannot target a scratch database; cloning is not supported (docs, same page).

## After a bad migration

Migrations run on every production deploy, after `schema.sql` (`deploy-cloudflare.yml:195-205`).

1. Stop: pause the deploy workflow (`incident.md`, "Pause merges") so the failing step is not re-run by the next push.
2. Read the failed step in the Actions run: which statement failed, whether it partially applied.
3. Note the current bookmark: `npx wrangler d1 time-travel info leeroy-board-db`.
4. Decide. Data intact and schema merely incomplete: fix forward with a new migration (never edit an applied file). Data damaged: restore to just before the deploy with `npx wrangler d1 time-travel restore leeroy-board-db --timestamp=<time before deploy>`. Restore is reversible (docs).
5. Roll the Worker back if the new code expects the new schema (`rollback.md`, section 2).
6. Verify: `GET /api/health`, `GET /api/bootstrap`, the table list, row counts for `kv_state`, `members`, `ask_turns`.
7. Re-enable the workflow only once the fix PR is ready. Write the postmortem (`incident.md`).

A restore rewinds the whole database, including migration bookkeeping, so the failed migration will run again on the next deploy unless the PR is reverted or fixed (inference from Time Travel restoring the whole database; unverified).
