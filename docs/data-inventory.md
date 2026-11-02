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

## Tables with no personal data

`lib_pages`, `lib_blobs`, `lib_sources`, `lib_source_snapshots` and `wiki_proposals` hold game library content and source-monitoring data. `kv_state` rows `persona`, `vocab` and `ai_budget:*` are configuration and counters. `wiki_proposals` has no author column. (Judged from column names; contents not scanned.)

## Where personal data lives outside the tables

- Discord: the account itself, avatar and guild roles stay at Discord. We receive an id, display name and avatar through login or interactions (`POST /discord`). Which fields exactly are read is unverified; confirm in `worker/discord.js` and `worker/account.js`.
- Cloudflare request logs and Worker logs: IP address and request metadata. Retention is a Cloudflare setting (unverified).
- AI vendors: question text is sent to the provider selected in `worker/ai-models.js`.
- Browser storage on the person's device (preferences, device logs): unverified, not read from this schema.

## Known gaps

1. No table records consent, a deletion request or an export request. `DELETE /me` erases account data (`README.md:46`); what it removes was not verified against this list.
2. `by_name` and `slug` are free-form and not tied to one identity key, so erase and export need name matching today.
3. `ask_turns.question` is unbounded personal text kept by default; retention is set in `docs/privacy.md` (draft).
