# Data inventory

DRAFT for the owner and the back-end architect. Not legal advice; needs counsel review before it is relied on.

Derived on 2026-11-02 from `infrastructure/schema.sql` (204 lines, 17 tables) and `infrastructure/README.md`. This lists every table and column that names a person, identifies one, or can hold text a person typed. "Names" means a person is directly identified; "Links" means it identifies a person only by joining to another table or by a stable per-person key; "Free text" means a person may type personal data into it. What a column actually contains in production was not inspected: entries marked (unverified) come from names and comments only. When the tenancy ADR (`docs/adr/0001-tenancy-and-identity.md`) is implemented this file must be redone.

## Tables and columns

| Table | Column | Class | What it holds | Note |
| :--- | :--- | :--- | :--- | :--- |
| `members` | `slug` | Names | Short handle for a member (lowercase, up to 32 characters) | Primary key; may be a real name or nickname (unverified) |
| `members` | `key_hash` | Links | Salted sha256 of the member's key | No plain key stored (`schema.sql:142`) |
| `members` | `created_at` | Links | When the member was added | |
| `accounts` | `name` | Names | Account display name | Use of this table in production is unverified |
| `accounts` | `slug` | Names | Account handle | |
| `accounts` | `id`, `created_at` | Links | Account id and time | |
| `account_keys` | `key_hash` | Links | Hash of an account token | |
| `account_keys` | `account_id` | Links | Owning account | |
| `account_keys` | `label` | Free text | Optional label for a token | |
| `sessions` | `token_hash` | Links | Hash of the login session token | |
| `sessions` | `user_key` | Links | 64-character per-user key from Discord login | Derivation unverified; assume stable per person |
| `sessions` | `created_at`, `expires_at`, `last_seen` | Links | Login times; `last_seen` shows activity | |
| `user_state` | `user_key` | Links | Per-user key | |
| `user_state` | `doc` | Links | One of journey, prefs, walked, seen, signups-choice | |
| `user_state` | `json` | Free text | The person's saved settings, up to 16384 bytes | Contents per doc type not inspected |
| `user_state` | `etag`, `updated_at` | Links | Version and time | |
| `ask_turns` | `by_name` | Names | Who asked | |
| `ask_turns` | `question` | Free text | The question typed to the AI | May hold anything the person writes |
| `ask_turns` | `answer`, `cites_json` | Free text | AI reply and citations | May echo the question |
| `ask_turns` | `share` | Links | Whether the turn is shared with the group | Default 1 (shared) |
| `ask_turns` | `model`, `latency_ms`, `status`, `created_at`, `answered_at` | Links | Which AI vendor model answered, timing | `model` shows which vendor received the question |
| `ask_turns` | `status`, `latency_ms`, `created_at`, `answered_at` | Links | Read as counts and timings only by the D1_FEED stats computation (default off): totals, median, p95, max, last 7 timings. `question`, `answer` and `by_name` are not read | Output is aggregates; the cache row holds no per-person data |
| `lib_pages` | row count | Links | Read as a count (`wiki_pages`) by the D1_FEED stats computation | |
| `kv_state` | `json` where `key` is `feed_cache:stats` | Links | D1_FEED cache of the computed stats document, rewritten at most every 5 minutes | Private (`feed_` prefix, not served by `/api/data`). Aggregates only. Not covered by erase because it holds no personal data |
| `answer_details` | `more`, `sources` | Free text | Extra answer text behind the "More" and "Sources" buttons (ANSWER_UX) | Model output; may echo the question. Deleted after 30 days by the cron |
| `answer_details` | `asker_hash` | Links | Salted hash (USER_SALT) of the asker, set only for private answers so only they can open the detail | Not a Discord id |
| `answer_details` | `intent_id`, `message_id`, `created_at` | Links | Answer id (joins to `ask_turns`), Discord message id the buttons are bound to, time | |
| `answer_feedback` | `user_hash` | Links | Salted hash (USER_SALT) of the person who clicked Helpful or Off; one row per person per answer | Not a Discord id; never returned by any route. Deleted after 90 days by the cron |
| `answer_feedback` | `intent_id`, `vote`, `created_at` | Links | Which answer, +1 or -1, time | Joins to `ask_turns` for the admin report |
| `fact_fixes` | `by_name` | Names | Who made a library edit | |
| `fact_fixes` | `note` | Free text | Optional edit note | |
| `fact_fixes` | `old_value`, `new_value`, `page_id`, `fact_key`, `created_at` | Links | The edit itself | |
| `sheet_events` | `slug` | Names | Member the character sheet belongs to | |
| `sheet_events` | `name` | Names | Name on the event (character or member; unverified which) | |
| `sheet_events` | `field`, `value_json` | Free text | Sheet field and value (build, gear, notes) | |
| `sheet_events` | `visible`, `source`, `created_at` | Links | Visibility, origin, time | |
| `dispatches` | `slug` | Names | Sender | |
| `dispatches` | `name` | Names | Sender display name | |
| `dispatches` | `ask_ids_json` | Links | Which Ask turns were shared | Joins to `ask_turns` |
| `intents` | `slug` | Names | Member who made the change | |
| `intents` | `kind` | Links | Action type (signup, journey, launch, fix, ask) | |
| `intents` | `body` | Free text | Request payload | Contents vary by kind (unverified) |
| `intents` | `at`, `ver` | Links | Time, version | |
| `guest_rate_limits` | `ip_hash` | Links | Hash of a guest's IP address | Hash of an IP is still personal data; hash method and salt unverified |
| `guest_rate_limits` | `created_at` | Links | Time of the guest question | |
| `kv_state` | `json` where `key` is `signups` | Names | Sign-ups: who is coming | Per README, a board document (unverified shape) |
| `kv_state` | `json` where `key` is `party`, `party_sheets`, `tonight`, `marks`, `decide`, `links`, `launch`, `stats`, `timeline` | Names or Free text | Board documents; party and sheets name members and builds | Shapes not inspected |
| `kv_state` | `json` where `key` is `discord_members` | Names | Roster: slug, display name, lowercase match terms, optional Discord numeric id | Private; admin-only write; no read route (`README.md:75`) |
| `kv_state` | `json` where `key` is `discord_roster` | Links | Guild and thread references | Private |
| `kv_state` | `json` where `key` is `name_map` | Names | Name replacements for AI answers | Private |
| `kv_state` | `json` where keys are `votes:*`, `vote:*`, `feed_posts` | Names or Free text | Votes and posts (unverified) | Private or board; not inspected |

## Tenancy tables (migrations 0002 and 0003), added for Q59

Added 2026-11-02. These tables were missing from the list above because it was derived from `schema.sql` before the tenancy migrations. All are keyed by the Discord user id (`users.discord_user_id`) and removed by `DELETE FROM users` through foreign-key cascade, except where noted. Export and erase: `GET /api/me/export`, `POST /api/me/erase` (`DATA_RIGHTS` flag, `worker/data-rights.js`).

| Table | Column | Class | What it holds | Erase |
| :--- | :--- | :--- | :--- | :--- |
| `users` | `discord_user_id`, `display_name`, `created_at` | Names | Root identity | Deleted explicitly |
| `identities` | `provider`, `provider_user_id`, `attached_at` | Names | Linked Battle.net, Twitch, Google, GitHub ids | Cascade |
| `humans`, `human_members` | `id`, `human_id`, `added_at` | Links | Groups several Discord users as one person | Cascade; the `humans` row is deleted when this user was its only member |
| `sessions_v2` | `token_hash` (never exported), `created_at`, `expires_at`, `last_seen_at` | Links | Web login sessions | Cascade |
| `provider_tokens` | `access_token_enc`, `refresh_token_enc` (never exported), `scope`, `expires_at`, `updated_at` | Links | Encrypted OAuth tokens | Cascade |
| `memberships` | `tenant_id`, `role`, `status`, `joined_at` | Links | Which guild the person belongs to | Cascade |
| `characters` | `name`, `realm`, `region`, `class`, `spec` | Names / Free text | Characters typed by the member. `name` is the game handle from the /build and /join form (it held the Discord id for rows written before the handle field existed; a resubmit corrects it) | Cascade |
| `builds` | `title`, `data_json` | Free text | Builds for a character | Cascade through `characters` |
| `character_profiles` | `race`, `faction`, `ruleset`, `region_label`, `selected` | Free text | What the member typed for a character they added on the web (migration 0005, `CHARS_V1`). Written only by `POST /api/me/characters`. Included in `GET /api/me/export` | Cascade through `characters` |
| `group_slots` | `character_id` | Links | Seat a character fills | `SET NULL`; trigger re-opens the seat |
| `signups_v2` | `group_id`, `user_id`, `character_id`, `rsvp` | Links | RSVP to a planned group | Cascade |
| `audit_log` | `actor_discord_user_id`, `target`, `detail_json` | Links / Free text | Who did what | Actor `SET NULL`; rows remain. The erase row itself holds no personal data (actor NULL, salted hash of the id) |
| `groups`, `tenants`, `tenant_config`, `thread_cursors`, `discord_events`, `entitlements` | tenant-level | None per person | Guild-level data (`discord_events` holds Discord snowflakes, not people) (judged from column names) | Not touched by a member erase |

### Added with the /join and /build handle batch (flags BUILD_MODAL, BUILD_PROJECT, JOIN_PROMPT, all off)

| Where | New read or write | Class | Note |
| :--- | :--- | :--- | :--- |
| `characters.name` | Written with the handle the person typed (before: their Discord id) | Names | Refused if it holds `@`, a link, a slash or a publisher mark (same rule as the admin script). Game handles only, never a real name |
| `tenants` | One row, written once, for the guild named in `discord_roster.guildId` (written by the Worker on the first confirmed submit; `/setup` also writes it) | None per person | Guild id only. Never created for any other guild |
| `kv_state` `discord_members` | Read and written by the Worker on a confirmed submit (before: admin routes only). Adds the person's Discord id, slug and handle | Names, Links | Still private, still no read route. Written in the same batch as the party document |
| `kv_state` `party` | Read and written by the Worker on a confirmed submit: the person's card (handle, class, race, role) is added or refreshed | Names | Public document (`GET /api/data/party`). Same fields the admin script wrote |
| `kv_state` `party`, `discord_members` | Read (no write) by `/build` and the sheet code to learn who is in the party, with the built-in five as fallback | Names | A read only; nothing new is stored |
| In memory only | `/ask` or `/sheet` by someone not on the roster (flag JOIN_PROMPT): the Discord id is remembered in the Worker's memory to show the hint once | Links | Never stored; lost when the Worker restarts |

An erase (`POST /api/me/erase`) still removes the `users` cascade rows. It does not edit the `party` or `discord_members` documents (already listed below as not covered); an admin removes the card and roster entry by hand (see the runbook's Rollback).

Not covered by export or erase: `kv_state` board documents (signups, party, party_sheets, votes and similar) that may name a member, Cloudflare logs, and Discord-side data. A web session is never used to match `by_name` or `slug` rows, because a Discord display name is chosen by its owner and could equal another member's name.

## Backup export (`GET /api/admin/export`, admin token)

Added 2026-11-02. Streams NDJSON of the whole database, one table page at a time, so the owner holds a copy outside Cloudflare (`tools/pull-export.mjs`, restore with `tools/restore-local.mjs`). The file therefore holds everything in the tables above that is personal data: names, Discord ids, ask questions and answers, saved preferences, and the pseudonymous hashes that act as keys (`user_state.user_key`, `answer_feedback.user_hash`, `answer_details.asker_hash`). Keep it private, outside the repository, and delete it after a drill.

Never exported (list in `infrastructure/worker/export.js`, checked against `schema.sql` by `tests/unit/export.test.mjs`):

| What | Why |
| :--- | :--- |
| Table `sessions`, table `sessions_v2` | Session token hashes |
| Table `provider_tokens` | Encrypted OAuth access and refresh tokens |
| Table `account_keys` | Account key hashes |
| Table `guest_rate_limits` | Hashed visitor addresses, short-lived counters |
| Column `members.key_hash` | Salted hash of the member key; a restore brings members back without a working key and keys are re-issued |
| `kv_state` rows whose key starts with `secret` or `feed_cache:` | Never served by the Worker; a derived cache |

The route reads the database and writes nothing, answers no-store, and logs no row data. Admin token only.

## Salted hashes (what a salt rotation touches)

Added 2026-11-02, for `docs/runbooks/rotate-salts.md` and `tools/rotate-salts.mjs`. `USER_SALT`: `user_state.user_key`, `sessions.user_key`, `answer_details.asker_hash`, `answer_feedback.user_hash`, ballot keys inside `kv_state` `vote:<id>`, `guest_rate_limits.ip_hash`, `audit_log.target` for erase events, and the signature in Discord answer buttons. `KEY_SALT`: `members.key_hash`, the short channel and content hashes in the `moments_ledger` row (diagnostic), and, by schema only, `account_keys.key_hash`. The tool keeps this list and a test fails if a new salted column or file is not on it.

## Tables with no personal data

`lib_pages`, `lib_blobs`, `lib_sources`, `lib_source_snapshots` and `wiki_proposals` hold game library content and source-monitoring data. `kv_state` rows `persona`, `vocab` and `ai_budget:*` are configuration and counters. `wiki_proposals` has no author column. (Judged from column names; contents not scanned.)

## Where personal data lives outside the tables

- Discord: the account itself, avatar and guild roles stay at Discord. We receive an id, display name and avatar through login or interactions (`POST /discord`). Which fields exactly are read is unverified; confirm in `worker/discord.js` and `worker/account.js`.
- Cloudflare request logs and Worker logs: IP address and request metadata. Retention is a Cloudflare setting (unverified).
- AI vendors: question text is sent to the provider selected in `worker/ai-models.js`.
- Browser storage on the person's device (preferences, device logs): unverified, not read from this schema.

## Known gaps

1. No table records consent or an export request. `DELETE /me` erases account data (`README.md:46`); what it removes was not verified against this list. Erase requests are recorded only as an `audit_log` row with no personal data (Q59, behind `DATA_RIGHTS`).
2. `by_name` and `slug` are free-form and not tied to one identity key, so erase and export need name matching today.
3. `ask_turns.question` is unbounded personal text kept by default; retention is set in `docs/privacy.md` (draft).
