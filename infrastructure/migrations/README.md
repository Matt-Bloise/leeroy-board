# Database Migrations

This directory holds incremental SQL migrations for Cloudflare D1.

- **Initial Database Creation**: The database is provisioned and initialized with the complete baseline schema in [`infrastructure/schema.sql`](../schema.sql) (with zero migrations applied).
- **Subsequent PRs & Schema Changes**: Any future table, column, or index changes should be added as numbered migration scripts in this directory (e.g. `0001_add_new_column.sql`) created via `npm run d1:migrate:create`. The CI/CD workflows (`deploy-cloudflare.yml` and `pr-preview-cloudflare.yml`) will automatically apply any pending migration scripts in subsequent PRs.
