# Runbook: pinned cards, board lines and the noise budget

Last checked: 2026-11-02. Code: `infrastructure/worker/cards.js`, `cards-handler.js`, `board-lines.js`, `noise.js`. Not tested against live Discord.

## Flags (Worker vars or secrets; all default off)
| Flag | Effect |
| :--- | :--- |
| `CARDS_ENABLED` | Sign-up buttons, modals, card edits, `POST /api/admin/cards/post`. Off: the Worker behaves as before. |
| `CARDS_SHADOW=1` | With `CARDS_ENABLED`: no call to Discord for cards or lines. "Would edit" and "would post" are counted in `noise_ledger` under `shadow:edit:<channel>` and `shadow:post:<channel>`. |
| `BOARD_LINES_ENABLED` | Needed, besides `CARDS_ENABLED`, for the first real board line. |

The PC bot stays authoritative for the sign-up cards until after launch (Nov 4, 6 PM ET). Run shadow mode first; do not post a Worker card into the channel where the PC bot's card lives until the owner switches over.

## D1 rows (admin token, never in the repo)
- `PUT /api/config/cards`: `{"signups":{"channel":"<id>","message":"<id>"},"board":{...},"party":{...},"allowedChannels":["<id>"]}`. Only `signups` and `board` are drawn today; `party` is stored for a later renderer.
- `PUT /api/config/noise`: `{"perDay":3,"overrides":{"2026-11-04":6},"quiet":{"start":1,"end":9,"tz":"America/New_York"}}`. Omitted fields keep their defaults.
- Or post a card: `POST /api/admin/cards/post` with `{"card":"signups","channel_key":"<name in discord_roster.channels>"}`. It posts, pins (best effort) and records the id.

## When a person deletes a card
The next edit gets a 404, the Worker sets `deleted: true` on that card in `cards` and stops editing it (no retry loop). Call `POST /api/admin/cards/post` for the card; it posts a new message and records the new id.

## When Discord refuses an edit
- 404: deleted, as above. 401 or 403: the bot may not edit there; the card is marked `errored: true`, edits stop and nothing is retried. Fix the permission, then `POST /api/admin/cards/post` (it replaces an errored card).
- 429: the Worker waits for Retry-After (header, else body, capped at one hour) before the next Discord call; the change stays owed and goes out on a later interaction or tick. A board line that fails to post is held back the same way (1 minute, Retry-After, or 1 hour for 401/403).

## Timing
`wrangler.toml` has two crons: `0 */6 * * *` and the every-minute `* * * * *` (timed posts). With `CARDS_ENABLED` on, both ticks flush a due board line and retry an unfinished card edit, and so does every interaction. A line therefore goes out about a minute after its 5-minute quiet window (subject to the noise budget and quiet hours). With the flag off, neither tick reads any card row.

## Roll back
Set `CARDS_ENABLED` off (or remove it). Nothing else reads the new rows. The table can stay; if it must go: `DROP TABLE IF EXISTS noise_ledger;`.
