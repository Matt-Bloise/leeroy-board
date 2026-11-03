-- Migration 0008.
-- Replay protection records every Discord interaction id in discord_events, which needs a tenant (NOT NULL, foreign key).
-- A guild that never ran /setup, and direct messages, use this reserved row. It is 'suspended' so nothing that looks for
-- an active tenant sees it, and its guild id is 17 zeros, which no real Discord guild has. Idempotent.
INSERT OR IGNORE INTO tenants (id, discord_guild_id, name, status, created_at)
VALUES ('legacy', '00000000000000000', 'legacy (no tenant)', 'suspended', '2026-11-03T00:00:00.000Z');
