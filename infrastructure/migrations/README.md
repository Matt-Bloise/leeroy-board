# Database Migrations

This directory holds incremental SQL migrations for Cloudflare D1.

- **Initial Database Creation**: The database is provisioned and initialized with the complete baseline schema in [`infrastructure/schema.sql`](../schema.sql) (with zero migrations applied).
- **Subsequent PRs & Schema Changes**: Any future table, column, or index changes should be added as numbered migration scripts in this directory (e.g. `0001_add_new_column.sql`) created via `npm run d1:migrate:create`. The CI/CD workflows (`deploy-cloudflare.yml` and `pr-preview-cloudflare.yml`) will automatically apply any pending migration scripts in subsequent PRs.

## Numbering: two files share 0008, and there is no 0007

Current files: `0001` to `0006`, two files numbered `0008`, then `0009` and `0010`.

- **Apply order.** CI runs `npx wrangler d1 migrations apply`, which applies pending files in filename order and records each by its full filename. For the two `0008` files the order is therefore alphabetical: `0008_discord_events_legacy_tenant.sql` first, then `0008_request_gauge.sql`. Both are applied; neither blocks the other.
- **Why both exist.** They were written in parallel in two separate PRs and merged about six minutes apart on 2026-11-03: `0008_request_gauge.sql` in #148 (commit 1028095b), `0008_discord_events_legacy_tenant.sql` in #150 (commit 0d38241b). Each author picked the next free number without seeing the other. The two are independent: one inserts a `tenants` row, the other creates the `request_gauge` table.
- **Why there is no 0007.** Git history shows no file numbered `0007` was ever committed in this folder, so it was never applied from here. History does not explain it.
- **Do not rename.** Renaming an applied file makes the migration tracker see a new, unapplied migration and run it again. Leave both `0008` files as they are.

### Rule for the next number

1. Take the highest number in this folder (currently `0010`) and add one (`0011`).
2. Before opening a PR, fetch `master` and check the folder again. If another open or merged PR already took that number, move to the next free one.
3. Never reuse a number, fill the `0007` gap, or rename an applied file.
4. Write migrations so they can run twice without harm (`IF NOT EXISTS`, `INSERT OR IGNORE`), as the existing files do.
