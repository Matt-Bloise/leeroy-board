# ADR 0001: Tenancy and identity

Status: DRAFT for review by the owner and the back-end architect. Nothing here is implemented.
Date: 2026-11-02
Scope: how people, guilds (tenants) and logins relate once the board serves more than one guild.

Unknowns are labelled **(unverified)** or listed under Open questions. Citations are `file:line` where code was read.

## Context

Today the board is one guild's board. Identity is spread over several mechanisms:

- Member keys: a `members` row holds a slug and the salted sha256 of a key (`infrastructure/schema.sql:143-147`). Member-key routes (`/me`, `/sheet`, `/signups`, `/intent` and others) authenticate with it (`infrastructure/README.md:44-50`).
- Discord login: `/auth/discord` returns an opaque session; `sessions.user_key` and `user_state.user_key` are 64-character hashes (`schema.sql:167-185`). What the hash is derived from is **(unverified)**; confirm in `worker/account.js`.
- A roster in the `kv_state` row `discord_members`: `[{ slug, name, match: [lowercase substrings], id? }]` (`worker/members.js:2`). Discord users are mapped to a slug first by id, then by a display-name substring `match` (`worker/members.js:23-33`).
- `accounts` and `account_keys` (`schema.sql:150-164`): a second, multi-token mechanism whose relation to `members` is **(unverified)**.
- Almost all data keys on a `slug` (`sheet_events`, `dispatches`, `intents`) or a free-text name (`ask_turns.by_name`, `fact_fixes.by_name`).

Problems for a multi-guild product: a slug is only unique within one guild; name-substring matching can attach the wrong person and is not safe across guilds; there is no concept of a tenant, so all rows share one namespace; a person in two guilds would be two unrelated identities.

## Decision (proposed)

1. **Discord user id is the root identity.** One `users` row per Discord user. It is the only credential that can create a user. The id is stored as text (it exceeds safe JavaScript integer range).
2. **Google and Battle.net are attach-only.** They can be linked to an existing user from a signed-in session and can then be used to sign in, but they never create a user. This keeps one root and avoids merge-two-accounts flows. Battle.net links exist to prove character ownership and for Blizzard attribution; Google is optional.
3. **One global D1 database plus one Durable Object per tenant.**
   - Global D1 holds identity and tenancy: users, identities, tenants, memberships, sessions, audit_log, and the catalogues shared by all tenants (library pages, sources).
   - Each tenant gets a Durable Object (named by tenant id) that holds that guild's live state and serialises its writes: sign-ups, tonight, party sheets, votes, board documents now in `kv_state`. The DO is the only writer of tenant board state; D1 stays the system of record for identity.
   - Characters and builds are described below as D1 tables because members and tenants both query them. Whether they live in D1 or in the tenant DO is Open question 2.
4. **Retire member keys and `discord_members.match`.** A signed-in user plus a membership row replaces both. Display-name substring matching is removed entirely; a member is attached to a tenant by Discord id (from the guild join or an admin invite), never by guessing.

## Schema sketch

A sketch to argue about, not a migration. SQLite types, ids are random text (ULID or UUID, **choice open**), times are epoch seconds (matches `sessions`, `schema.sql:170-172`).

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,              -- internal id
  discord_id    TEXT NOT NULL UNIQUE,          -- root identity, text
  display_name  TEXT NOT NULL,                 -- last seen Discord name
  avatar_hash   TEXT,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER                        -- soft delete, then purge
);

CREATE TABLE identities (                      -- attach-only providers
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('google','battlenet')),
  provider_uid  TEXT NOT NULL,
  label         TEXT,                          -- e.g. a BattleTag; sensitivity open
  created_at    INTEGER NOT NULL,
  UNIQUE (provider, provider_uid),
  UNIQUE (user_id, provider)                   -- one per provider; relax if needed
);

CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  discord_guild_id TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,          -- subdomain / URL part
  plan          TEXT NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  suspended_at  INTEGER
);

CREATE TABLE memberships (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  nickname      TEXT,                          -- per-guild display name
  legacy_slug   TEXT,                          -- migration aid only, dropped in step 3
  joined_at     INTEGER NOT NULL,
  left_at       INTEGER,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE characters (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  realm         TEXT NOT NULL,
  name          TEXT NOT NULL,
  class         TEXT,
  verified_via  TEXT,                          -- 'battlenet' or NULL
  created_at    INTEGER NOT NULL,
  UNIQUE (realm, name)
);

CREATE TABLE builds (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE SET NULL, -- NULL = private
  label         TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     TEXT REFERENCES tenants(id),   -- active tenant, may be NULL
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  tenant_id     TEXT,
  actor_user_id TEXT,                          -- NULL for the system
  action        TEXT NOT NULL,                 -- e.g. 'member.role_change'
  target        TEXT,
  detail_json   TEXT                           -- no free text from users
);
```

How current tables map: `members`, `account_keys` -> retired; `sessions.user_key`, `user_state.user_key` -> `user_id`; `sheet_events.slug`, `dispatches.slug`, `intents.slug` -> `user_id` plus `tenant_id`; `ask_turns.by_name`, `fact_fixes.by_name` -> `user_id` (stored at write time, so history survives a rename); `fact_fixes` is the nearest thing to an audit log today and folds into `audit_log`.

## Migration plan (three steps, each its own PR and each risk 8 to 10)

Follow `docs/runbooks/schema-source-of-truth.md`: new tables are idempotent; changes to existing tables are numbered migrations only. Take a D1 Time Travel bookmark before each (`docs/runbooks/rollback.md`).

1. **Add.** Create the new tables and add nullable `user_id` / `tenant_id` columns beside the old keys. Create one tenant for the current guild. Backfill `users` and `memberships` from the roster, using the stored Discord `id` where present. Roster entries with no id and only a `match` list cannot be backfilled automatically; they need a human mapping (Open question 4). Dual-write new rows to both shapes. Reads unchanged. Rollback: revert; old columns still authoritative.
2. **Switch reads.** Reads and authorisation use `users` / `memberships`. Member-key routes keep working through a shim that resolves a key to its user, with a deprecation log. Compare old and new answers on production for a soak period before moving on. Rollback: flip reads back; dual writes kept both sides current.
3. **Drop.** Stop dual-write. Remove the shim, member keys, `members`, `account_keys`, the `match` field and `legacy_slug`, and the old `slug` / `user_key` / `by_name` columns. Destructive, restore point required, owner merges. Rollback only via Time Travel.

Move per-tenant board state from `kv_state` into the tenant Durable Object as a separate, later ADR; it is independent of the identity steps.

## Consequences

- One person, many guilds, one set of characters. Per-guild nickname and role.
- No name-guessing; wrong-person attachment is removed as a class of bug.
- Everyone must have a Discord account. Accepted for a Discord-first product.
- A global D1 is a single write point for identity. Fine at expected volume **(unverified, no load numbers exist)**.
- Retiring member keys breaks any bookmarked or scripted key use. Needs a notice period.
- Personal data moves to new tables, so `docs/data-inventory.md` must be updated in step 1.

## Open questions for the back-end architect

1. Is one global D1 right, or should identity also shard? What is the write ceiling we should design for?
2. Where do characters and builds live: global D1 (cross-guild, simple queries) or the tenant DO (isolation)? A character can belong to a user in several guilds.
3. How is `user_key` derived today, and can existing sessions and `user_state` rows be remapped to `user_id` without logging everyone out?
4. How are roster entries that have only a `match` list resolved without guessing? Manual admin claim flow?
5. Relation between `accounts` / `account_keys` and `members`: is `accounts` live or dead? Delete or migrate?
6. Id format (ULID vs UUID v7 vs random) and whether `discord_id` should be stored as is or keyed by a hash.
7. Tenant DO naming and routing: by tenant id, by guild id, or by slug? How does a rename or transfer work?
8. Battle.net: do we store the BattleTag at all? Which Blizzard scopes, and how long are tokens kept (prefer none)?
9. Offboarding: user leaves guild versus user deletes account versus tenant deleted. Which rows are deleted, which anonymised (`audit_log`)? Retention values are in `docs/privacy.md`, also a draft.
10. Can the Discord bot keep verifying roles over HTTP interactions only, or does membership sync need a gateway or a periodic REST sweep?
11. Does `audit_log` live in D1 or an append-only DO, and who can read it?
12. Does any plan or tenant limit need enforcement in the DO (rate limits, seats)?

## Alternatives considered

- Separate D1 per tenant: strong isolation, but cross-guild identity and migrations across many databases are hard. Not chosen here; open to the architect.
- Keep member keys as a second root: avoids a Discord requirement but keeps the multi-guild collision problem.
- Equal root providers (Google, Battle.net can create users): needs account-merge flows and creates duplicate-person risk.
