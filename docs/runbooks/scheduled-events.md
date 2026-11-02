# Runbook: Discord scheduled events

Ships flag-off. Nothing here runs until the owner sets `EVENTS_ENABLED = "on"` and grants the bot the permission below. No ids, dates or tokens are written in the repository.

## What it does

Keeps Discord "Events" for the server (launch night, raid nights) in step with a schedule held in D1. Code: `infrastructure/worker/scheduled-events.js`; route `POST /api/admin/events/sync` in `index.js`.

- **create and update only.** It never deletes an event. To remove one, delete it in Discord by hand.
- It only PATCHes events recorded in its own map (`kv_state` key `scheduled_events`, our event key to the Discord event id, with the fields last sent). An event someone made by hand is never read or changed.
- An event whose start time is not in the future is skipped (Discord rejects a past `scheduled_start_time` with 400).
- Events are external (`entity_type` 3, place in `entity_metadata.location`) with `privacy_level` 2, the only value Discord accepts for guild events. External events need an end time, so the schedule requires one.
- The plan is computed from the map, not from Discord, so a dry run makes no Discord call, and a second apply with no schedule change does nothing. Consequence: an edit made by hand in Discord to an event we own is not noticed or reverted; change it in the schedule instead.

## Permission the owner must grant

The bot needs **Manage Events** (permission bit 33, `1 << 33`) or **Create Events** (bit 44, `1 << 44`). Create Events is enough here because the bot only edits events it created. The server owner (or an admin) grants it in Server Settings, Roles, the bot's role. The Worker cannot grant it. Without it Discord answers 403 and the sync returns 403 with the message "Discord refused: the bot needs the Manage Events (bit 33) or Create Events (bit 44) permission in this server."

## Setup (owner)

1. Grant the permission above.
2. Make sure `discord_roster` already has `guildId` (`PUT /api/config/discord_roster`). The bot token is the existing `DISCORD_BOT_TOKEN` secret, the same one `POST /api/announce` uses. It is never printed or returned.
3. Write the schedule (never commit it). Admin token in `BOARD_ADMIN_TOKEN`; the body is a JSON array:

```bash
curl -sS -X PUT https://api.leeroy.party/api/config/events_schedule \
  -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "Content-Type: application/json" \
  --data @events.json
```

Each entry: `key` (lowercase letters, digits, `-`, `_`; our stable name for the event), `name` (1 to 100), `location` (1 to 100), `start` and `end` (ISO 8601; `end` after `start`), optional `description` (up to 1000). At most 50 entries. Fictional example:

```json
[{ "key": "example-night", "name": "Example Night", "location": "Fictional Hall", "start": "2030-02-01T20:00:00Z", "end": "2030-02-01T22:00:00Z" }]
```

Changing `key` creates a new event and leaves the old one in Discord. Keep keys stable.

4. Set `EVENTS_ENABLED = "on"` in `infrastructure/wrangler.toml` `[vars]` and deploy (or in the Cloudflare dashboard).

## Use

Dry run (default, no Discord call, writes nothing):

```bash
curl -sS -X POST https://api.leeroy.party/api/admin/events/sync -H "Authorization: Bearer $BOARD_ADMIN_TOKEN"
```

Read `actions` (what would be created or updated) and `skipped` (`past`, `unchanged`, `invalid: ...`). Apply only after reading it:

```bash
curl -sS -X POST "https://api.leeroy.party/api/admin/events/sync?dry=0" -H "Authorization: Bearer $BOARD_ADMIN_TOKEN"
```

Run one sync at a time: two at once could both create the same event.

## Answers

| Status | Meaning | Do |
| :--- | :--- | :--- |
| 200 | Plan, or applied; check `results` | Nothing |
| 401 / 503 | Admin token missing or wrong / not configured | Check the token |
| 404 | `EVENTS_ENABLED` is off | Enable it |
| 403 | Bot lacks Manage Events or Create Events | Owner grants it; run again |
| 429 | Discord rate limit longer than 10 s; `retry_after_ms` says when | Run again later. Short limits are waited out automatically |
| 502 | Discord refused an event or the bot token; see `results` | Fix the entry; the others are already saved |
| 503 on apply | No bot token or no `guildId` in `discord_roster` | Configure it |

At most 20 actions run per call; `deferred` counts the rest. Run again. An update whose event was deleted in Discord answers 404 for that key; the map forgets it and the next sync creates it again.

## Rollback

Set `EVENTS_ENABLED = "off"` (the default) and deploy. The route answers 404 and nothing calls Discord. Events already created stay in Discord until someone deletes them by hand; the `scheduled_events` and `events_schedule` rows can stay or be cleared with `INSERT OR REPLACE` from `wrangler d1 execute`.

## Not verified

Written without access to live Discord. First real run: do a dry run, then apply a single far-future test event and check it in Discord before relying on it.
