-- ask_turns.channel: the Discord channel id an /ask came from (digits-only snowflake), so a later reply can go back to that channel.
-- NULL for web asks, DMs, malformed ids and every row written before this migration. Nothing reads it yet.
-- This is a column, not a sidecar table, and it is NOT in schema.sql on purpose: schema.sql is re-run before migrations on every deploy and
-- every fresh preview database, so a column there plus this ALTER would fail with "duplicate column name" (docs/runbooks/schema-source-of-truth.md,
-- rule 2: a new column goes only in a numbered migration). Safe on re-run because wrangler d1 migrations apply records each file by name in
-- d1_migrations and runs it once per database; schema.sql never alters ask_turns, so the column cannot exist before this runs.
-- The Worker writes the column only for a Discord guild-channel ask and falls back to the old insert if the column is absent (deploy order).
-- Rollback: nothing reads the column. ALTER TABLE ask_turns DROP COLUMN channel; (SQLite 3.35+, supported by D1).
ALTER TABLE ask_turns ADD COLUMN channel TEXT;
