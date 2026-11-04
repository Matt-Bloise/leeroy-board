# Runbook: schema source of truth

Last checked: 2026-11-02. Citations are `file:line` or marked (unverified).

## How the two relate today

| File | Role | Evidence |
| :--- | :--- | :--- |
| `infrastructure/schema.sql` | "Unified baseline" of 17 tables and their indexes, every statement `CREATE ... IF NOT EXISTS` | `schema.sql:1-7,10,200-204` |
| `infrastructure/migrations/0001_guest_rate_limits.sql` | One numbered migration: `guest_rate_limits` table and index, both `IF NOT EXISTS` | `migrations/0001_guest_rate_limits.sql:1-5` |
| `infrastructure/migrations/README.md` | States the intent: a new database starts from `schema.sql` with zero migrations; later changes are numbered migrations | `migrations/README.md:5-6` |

The same table, `guest_rate_limits`, is defined in both (`schema.sql:199-204` and `0001_guest_rate_limits.sql:2-5`). That is the only overlap today, and it contradicts the stated intent that `schema.sql` is the baseline and migrations are the later changes: the baseline already contains the first migration.

How CI uses them, in this order, on every production deploy and every PR preview (`deploy-cloudflare.yml:195-205`, `pr-preview-cloudflare.yml:204-214`):

1. `wrangler d1 execute <db> --remote --file=./schema.sql`
2. if any `migrations/*.sql` exists, `wrangler d1 migrations apply <db> --remote`
3. seed only if `kv_state` is empty

The migrations directory is wired in `wrangler.toml:23` (`migrations_dir = "migrations"`). Local equivalents are the `d1:schema:local` and `d1:migrate:local` scripts in `infrastructure/package.json:10-14`.

Consequence: because `schema.sql` is re-run on every deploy, it only ever creates missing objects; it never alters an existing table. `CREATE TABLE IF NOT EXISTS` on an existing table with a changed definition does nothing.

## Experiment: can a fresh database be built from each alone

Run on 2026-11-02 with Node 22.23.2 `node:sqlite` (in-memory SQLite; `sqlite3` was not installed). This is plain SQLite, not D1: it does not exercise `wrangler`, the `d1_migrations` bookkeeping table, or D1-specific limits. Script was ad hoc and is not in the repository.

| Build | Result | Objects (tables and indexes) |
| :--- | :--- | ---: |
| `0001` migration alone | Succeeds, but yields only `guest_rate_limits` and its index | 2 |
| `schema.sql` alone | Succeeds | 34 (17 tables) |
| `schema.sql`, then `0001` | Succeeds, identical object list to `schema.sql` alone | 34 |
| `0001`, then `schema.sql` | Succeeds, identical object list | 34 |

Findings:
- A fresh database can be built from `schema.sql` alone. It cannot be built from migrations alone: the migrations directory holds only one change, so 16 of the 17 tables would be missing. The migrations are not a full history.
- The CI order (schema, then migrations) works today only because `0001` is idempotent and duplicates a baseline table.

Hazard test, same method: a hypothetical edit that adds a column to a table in `schema.sql` and a migration `ALTER TABLE members ADD COLUMN note TEXT;`. Applying the schema and then the migration on a fresh database fails with `duplicate column name: note`. `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite. On a fresh preview database (`pr-preview-cloudflare.yml:204-214`), which is created from scratch for every PR, that PR's preview deploy would fail. On production the order is safe only if `schema.sql` is not also changed.

Not tested: running through real `wrangler d1` (needs a Cloudflare token); whether D1 rejects anything node:sqlite accepted (unverified).

## Rule for future migrations

Until the model is changed, follow exactly one of these per schema change, and say which in the PR:

1. New table or index: add it as `CREATE ... IF NOT EXISTS` in a new migration and also in `schema.sql`. Safe, because both are idempotent. This is what `0001` did.
2. New column, dropped or renamed object, changed constraint, data fix: put it only in a new numbered migration (`0002_...sql`, created with `npm run d1:migrate:create -- <name>`, `infrastructure/README.md:121`). Do not edit `schema.sql` for that change. Never edit or renumber an applied migration; fix forward with the next number.
3. Every migration is reviewed as risk 8 to 10 (`.github/pull_request_template.md:4`), includes a test or a documented manual check (`CONTRIBUTING.md:11`), and states a rollback: Time Travel bookmark taken before merge (`rollback.md`, section 3). A revert commit does not undo applied SQL.
4. Before merging, run the new migration on a scratch local database on top of a database built from `schema.sql` (`npm run d1:schema:local && npm run d1:migrate:local`). The PR preview does the same on a fresh remote database; read that step's log.
5. Destructive statements (`DROP`, `DELETE`, `UPDATE` without a narrow `WHERE`) need a restore point noted in the PR body and the owner's manual merge.

## Recommended direction (a decision for the owner, not applied here)

Make migrations the single source of truth: freeze `schema.sql` as `0000_baseline.sql` in `migrations/`, drop the `schema.sql` execute step from both workflows, and let `wrangler d1 migrations apply` build every database from zero. Then a fresh database and an upgraded one follow the same path and the `ADD COLUMN` hazard disappears. Alternative: keep `schema.sql` as a generated artifact, produced by applying all migrations and exporting the schema (`wrangler d1 export --no-data`, flag confirmed with `--help`), and have CI check it is current. Either needs a change to workflows (risk 8 to 10), so it was left out of this documentation change.

Open question (unverified): production already holds a `d1_migrations` row for `0001` only if migrations have run there; confirm with `npx wrangler d1 execute leeroy-board-db --remote --command="SELECT name FROM d1_migrations;"` before renaming or merging anything into `migrations/`.

## Migration 0009 deploy gap (ask_turns written by the old Worker)

Between applying migration 0009 and the deploy of the Worker that writes asker rows, a few seconds of questions from the old Worker have no `ask_turn_askers` row and are not in `ask_turn_legacy`. Export and erase never find them (fail closed). After the deploy, mark them as legacy with `--before` set to the time the new Worker went live (UTC, ISO; read it from `npx wrangler deployments list` in `infrastructure/`, run `npm ci` there first):

```bash
node infrastructure/scripts/backfill-ask-legacy.mjs --remote --before 2026-11-04T12:00:00Z --dry-run
node infrastructure/scripts/backfill-ask-legacy.mjs --remote --before 2026-11-04T12:00:00Z
```

Dry-run lists the ids and writes nothing. It never touches a row created at or after `--before`, a row that has an asker row, or a web visitor row (`by_name = 'Visitor'`). Tested in `tests/unit/ask-askers.test.mjs`. An Ask from a roster member or Discord user is now refused with 503 / an ephemeral message when `USER_SALT` is missing, instead of being stored unerasable.
