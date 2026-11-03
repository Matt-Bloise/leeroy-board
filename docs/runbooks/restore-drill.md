# Runbook: restore drill (offline, with checksums)

Last checked: 2026-11-03. Local only: nothing leaves the machine, no Cloudflare account, no secrets, no AI call, no Worker request on leeroy.party.

## Purpose

Prove that the backup you own (`GET /api/admin/export`, `docs/runbooks/backup-restore.md`) restores, with numbers: after a wipe, every table has the same row count **and** the same content. A row count alone misses a changed value, so each table also gets a sha256 checksum.

## The command

```bash
cd infrastructure && npm install        # once; installs wrangler
cd .. && node tools/restore-drill.mjs   # about 100 seconds on a small cloud container
```

Exit code 0 means every table matched. It prints the report below. Options (`node tools/restore-drill.mjs --help`):

| Option | Meaning |
| :--- | :--- |
| `--backend wrangler` (default) | A real local D1: `wrangler d1 execute --local` for the database and `wrangler dev --local` to serve the export route. |
| `--backend sqlite` | The same steps on in-process SQLite through the real Worker route. No wrangler, no install, under a second (0.2 s measured). `tests/unit/restore-drill.test.mjs` runs this one in CI. |
| `--port <n>` | Port of the local `wrangler dev` (default 8799). |
| `--expect <file>` | Fail unless the report equals this file (line 1, the backend name, is ignored). |
| `--keep` | Keep the temporary folder (wrangler backend). |

There is no `--remote`: the tool refuses it.

## What it does

1. Builds a source database from `infrastructure/schema.sql` and seeds it with made-up fixtures (`fixtureSql()` in the tool): secret-looking values, quotes and accents, 450 rows in one table so the export takes several pages.
2. Exports it through `GET /api/admin/export` with a made-up admin token (first checking that the route answers 401 without it) and checks that no secret fixture value reached the file.
3. Checksums every exported table **in the source database**, read independently of the export. A checksum is sha256 over every value of the exported columns in rowid order, each value read as SQL `quote(value)` so `NULL`, `'null'`, `1` and `'1'` differ.
4. **Wipes:** deletes the database.
5. Restores the export into a fresh database (`tools/restore-local.mjs` logic: schema first, parents before children).
6. Checksums the restored tables and diffs rows and checksum, table by table. Tables that are never exported must come back empty.

## Expected output (exact)

Line 1 names the backend (`wrangler --local (real local D1)` or `sqlite (in-process, no wrangler)`); everything after it is identical on both and is the file `tests/fixtures/restore-drill.expected.txt`:

```
RESTORE DRILL (backend: wrangler --local (real local D1))
1. source database: 40 tables from schema.sql, seeded with 465 fixture statements
2. export: 35 tables exported, 5 never exported (account_keys, sessions, guest_rate_limits, sessions_v2, provider_tokens), 579 lines
   no secret value in the export file (6 checked)
3. checksums of the source: 35 tables, 464 rows
4. wipe: the database is deleted
5. restore: a fresh database is built from schema.sql and loaded from the export
6. diff, table by table (rows and sha256 of the exported columns; source vs restored)
   ok   kv_state               rows    2 ->    2   sha256 481aebfea0dfc7ca == 481aebfea0dfc7ca
   ok   ask_turns              rows    1 ->    1   sha256 ddc4ebb0cdc3cc9b == ddc4ebb0cdc3cc9b
   ok   members                rows    2 ->    2   sha256 c8248b41cf9c2127 == c8248b41cf9c2127
   ok   user_state             rows    1 ->    1   sha256 2ee85f098ea75d95 == 2ee85f098ea75d95
   ok   intents                rows  450 ->  450   sha256 216455a2a88eebbc == 216455a2a88eebbc
   ok   users                  rows    1 ->    1   sha256 42d7983ca5ec9ae4 == 42d7983ca5ec9ae4
   ok   tenants                rows    1 ->    1   sha256 bd2169bf336f8601 == bd2169bf336f8601
   ok   characters             rows    1 ->    1   sha256 5bb903ef0d674443 == 5bb903ef0d674443
   ok   builds                 rows    1 ->    1   sha256 609e35b4a5dedaba == 609e35b4a5dedaba
   ok   character_profiles     rows    1 ->    1   sha256 d2605a4ada78aaff == d2605a4ada78aaff
   ok   noise_ledger           rows    1 ->    1   sha256 c723059cfe4e6bc7 == c723059cfe4e6bc7
   ok   request_gauge          rows    2 ->    2   sha256 fa6be4c23ff9abc3 == fa6be4c23ff9abc3
   ok   23 tables are empty in the fixtures (0 -> 0, nothing to compare, not tested): lib_pages, lib_blobs, lib_sources, lib_source_snapshots, wiki_proposals, fact_fixes, sheet_events, dispatches, accounts, identities, humans, human_members, tenant_config, memberships, thread_cursors, audit_log, groups, group_slots, signups_v2, entitlements, discord_events, answer_details, answer_feedback
   ok   account_keys           rows    0 ->    0   never exported: comes back empty (by design)
   ok   sessions               rows    1 ->    0   never exported: comes back empty (by design)
   ok   guest_rate_limits      rows    1 ->    0   never exported: comes back empty (by design)
   ok   sessions_v2            rows    1 ->    0   never exported: comes back empty (by design)
   ok   provider_tokens        rows    1 ->    0   never exported: comes back empty (by design)

RESTORE DRILL PASSED: 35 tables, 464 rows, every count and checksum matches
```

Measured on 3 November 2026: both backends produced this text byte for byte (`diff` of the two outputs was empty). The wrangler run took 100 seconds, the sqlite run under a second (0.2 s measured).

## Reading it

- `ok` lines: rows and checksum equal. `FAIL` lines: the failing table is named, and the run exits 1 (`RESTORE DRILL FAILED`).
- `sessions`, `sessions_v2`, `provider_tokens`, `account_keys` and `guest_rate_limits` are never exported (`worker/export.js`), so they come back empty. That is the design, not a loss; people sign in again.
- `members.key_hash` is not exported and not in the checksum: restored members get a placeholder hash and need new keys (`infrastructure/scripts/hash-key.mjs`).
- `kv_state` rows whose key starts with `secret` or `feed_cache:` are not exported; the checksum covers the same filtered set on both sides (4 fixture rows, 2 exported).

## When it fails

| Message | Likely cause |
| :--- | :--- |
| `table X is neither exported nor excluded` | A new table that the export does not list. Fix `worker/export.js`. |
| `X: checksum differs`, rows equal | A value changed on the way (encoding, type, a default). Compare the table in the source and restored folders with `--keep`. |
| `X: rows A -> B` | Rows lost or added. Check for a `ROW_FILTERS` change or a constraint that rejected an insert. |
| `export file: ... incomplete` | The export stopped before the last page. Nothing is wiped when the file cannot be restored. |
| `wrangler is not installed` | Run `cd infrastructure && npm install`, or use `--backend sqlite`. |

## When to run it

After any schema change (a new table must show up in the report), before relying on the export for a real incident, and quarterly. It is also run on every pull request that touches the export or the schema, by `tests/unit/restore-drill.test.mjs` (the sqlite backend).

## What it does NOT prove

- **Production data.** It drills made-up fixtures. To prove a real backup, pull one with `tools/pull-export.mjs` and run `tools/restore-local.mjs` on it (`backup-restore.md`); that checks counts, not checksums, because there is no live source to compare to.
- **D1 limits and speed.** A real restore of a large export into D1 can hit statement-size or time limits that local D1 does not. Unverified.
- **Empty tables.** About two thirds of the tables hold no fixture row, so they are listed as "not tested". Their restore path is the same code as the tested tables, but a table-specific problem would not show.
- **Restoring into production.** Not covered, on purpose. Production restore is Time Travel (`backup-restore.md`).
