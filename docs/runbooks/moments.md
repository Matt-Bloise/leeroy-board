# Runbook: timed Discord posts ("moments")

The Worker posts the launch-week Discord messages on a schedule, so nothing has to run on a personal computer. Code: `infrastructure/worker/moments.js`. It replaces the old PC bot's moment list. **Off by default**: with all flags off the every-minute cron returns before it reads anything.

> **Launch night (Nov 3 to 4, 2026): the PC bot stays authoritative.** The Worker runs in **shadow mode only** until after launch. Do not set `MOMENTS_ENABLED` before then.

## What the PC bot did
It held a list of timed moments and posted each one once, in order: `names-1h`, `names-0`, `launch-24h`, `launch-1h` (a countdown card edited in place every minute until T-0, then left as the final message), `launch-0` (the only moment that may ping people), `launch-10m`, `raids-1d`. A moment more than its late cutoff (default 30 minutes) overdue was skipped and logged, never posted late.

## How it works
- Cron `* * * * *` (second of the five trigger slots Workers Free allows; the first is the 6-hourly sweep). `scheduled` routes by `controller.cron`: this trigger runs only moments, every other trigger runs the source sweep. PR previews strip all crons, so previews never post.
- Schedule: D1 `kv_state` key `moments` (an array). State: key `moments_state`, written only by the Worker. Both are private keys: never served by `GET /api/data/*`, never in the repo.
- A post is **claimed** in `moments_state` (compare-and-swap on the row) before the Discord call and reconciled after, so two runs in the same minute cannot both post. The create call also carries a nonce with `enforce_nonce`, so Discord drops a repeat of an interrupted call.
- Every message sets `allowed_mentions` to `{ "parse": [] }`. Only a moment with `allowPing: true` **and** the id `launch-0` may list users, and the config route refuses `allowPing` on any other id. Edits never ping.
- One retry on a Discord 429, waiting `retry_after` (a wait over 8 s is not slept on; the next minute retries). A failed post stays retryable up to 5 attempts and until its cutoff.
- Countdown: `at` is when the card is posted, `endsAt` is T-0 (default `at` + 60 minutes). **One edit per minute per message** ("Starts in 42m"), and at `endsAt` a final "Now." edit. If a tick is missed the next run makes a single catch-up edit showing the current time left, never two in a row. If the card is deleted in Discord the edit gets a 404; the moment is marked `deleted` in state and never edited again.

## Seed the schedule
Fields per moment: `id`, `at` (ISO UTC, ends in `Z`), `channelId`, `kind` (`text`, `card` or `countdown`), `content` (Discord timestamp markup such as `<t:1793833200:F>` is fine), optional `imageUrl` (https, on `leeroy.party`), `boardToken` (becomes a board link, same helper as `{board:...}`), `ping` + `allowPing` (`launch-0` only), `lateCutoffMinutes`, `endsAt` (countdown only). Fictional example (ids are made up; the times follow the real launch, 2026-11-04T23:00:00Z, so `launch-1h` is 22:00Z):

```json
[
  { "id": "names-1h", "at": "2026-11-03T14:00:00Z", "channelId": "100000000000000001", "kind": "text",
    "content": "Name reservations open <t:1793887200:R> (<t:1793887200:F>)." },
  { "id": "launch-24h", "at": "2026-11-03T23:00:00Z", "channelId": "100000000000000001", "kind": "card",
    "content": "One day to go.", "imageUrl": "https://leeroy.party/img/example.png", "boardToken": "tonight" },
  { "id": "launch-1h", "at": "2026-11-04T22:00:00Z", "channelId": "100000000000000001", "kind": "countdown",
    "content": "Launch night.", "endsAt": "2026-11-04T23:00:00Z" },
  { "id": "launch-0", "at": "2026-11-04T23:00:00Z", "channelId": "100000000000000001", "kind": "text",
    "content": "We are live. <@200000000000000002>", "allowPing": true, "ping": ["200000000000000002"], "lateCutoffMinutes": 10 }
]
```

Write it with the admin token (the real file stays on your machine, not in the repo). The route validates it and answers 400 with the reason if a moment is wrong:

```bash
curl -sS -X PUT https://api.leeroy.party/api/config/moments -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "Content-Type: application/json" --data @moments.local.json
```

Changes reach the cron within about a minute (the config cache is 60 s). The row is capped at 20,000 bytes.

## Check before turning on
```bash
curl -sS https://api.leeroy.party/api/admin/moments -H "Authorization: Bearer $BOARD_ADMIN_TOKEN"
```
Returns `enabled`, `shadow`, `dryRun`, the next due moment, the done, skipped and deleted lists, each moment's status and the last 50 ledger rows. No channel ids, user ids, message ids or content.

Rehearse with `MOMENTS_DRY_RUN` or, better, `MOMENTS_SHADOW` (see Flags).

## Flags
All default off in `infrastructure/wrangler.toml`.

| Flag | Effect |
| :--- | :--- |
| `MOMENTS_SHADOW = "on"` | Shadow: plans and "posts" against its own state (`moments_shadow_state`), writes `would_post`, `would_edit` and `would_skip` rows to the ledger, **never calls Discord**, needs no bot token. |
| `MOMENTS_ENABLED = "on"` | Live: posts to Discord. |
| `MOMENTS_DRY_RUN = "on"` | Logs the plan only (`wrangler tail`): no ledger, no state, no Discord. |

Shadow and live are mutually exclusive: with both on, nothing runs and a `flags_conflict` line is logged.

## The ledger
D1 `kv_state` key `moments_ledger` (private, newest 500 rows, newest last). It is also in `GET /api/admin/moments` (last 50 rows).
- Shadow rows: `op` (`would_post`, `would_edit`, `would_skip`), moment `id`, `plannedAt`, `channelHash`, `contentHash`, `chars`, `final`. Hashes are the first 16 hex of a salted SHA-256, so no channel id or text is stored. To diff against the PC bot, hash what it posted the same way, or compare `chars` and the post times.
- Live rows: one per Discord HTTP response: `op`, `id`, `status`, `remaining` (X-RateLimit-Remaining), `resetAfter` (X-RateLimit-Reset-After) and, for a 429, `retryAfter`. A 429 is retried once after `retry_after`; both responses are recorded.
A ledger write failure never blocks or changes a post.

## Launch night plan (Nov 3 to 4)
1. Seed the schedule (above) and check `GET /api/admin/moments`.
2. Set `MOMENTS_SHADOW = "on"`, `MOMENTS_ENABLED` stays off. Merge and deploy. The PC bot keeps posting everything.
3. After launch, diff the ledger against what the PC bot posted (ids, times, text length).
4. Only after launch, and only if the diff is clean: stop the PC bot's moments, set `MOMENTS_SHADOW = "off"` and `MOMENTS_ENABLED = "on"`. Mark any moment the PC bot already posted as done or remove it from the schedule first.

## Roll back
Set the flag(s) to `"off"` and deploy (or `wrangler rollback`). Posts stop at the next minute. Nothing already posted is deleted. To re-run a moment that was skipped or recorded wrongly, delete its entry from `moments_state` with `wrangler d1 execute` (read the row, edit the JSON, write it back) and keep it inside its cutoff.

## Things to know
- A claimed post with no message id for more than 3 minutes is skipped as `claim_stale` rather than retried: look at the channel, then reset the entry if it never arrived.
- Discord interactions and REST cannot be tested in a preview. The unit tests use a fake `fetch`; the first real post is the check. Use a private test channel first.
- The Worker's clock is the clock. Moments are minute-resolution; a moment is posted by the first run at or after `at`.
