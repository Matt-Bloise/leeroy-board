# Dead-man check

Detects that the PC side (the bot, the local session) has gone silent, from OUTSIDE the PC. Origin: the PC bot and session stopped on 2026-11-18 and nothing noticed for 17.5 hours. Code: `infrastructure/worker/deadman.js`, key helper `heartbeatKeyFor` in `listener-config.js`, migration `0015_incidents.sql`, tools `tools/heartbeat-send.mjs` and `tools/deadman-status.mjs`, tests `tests/unit/deadman.test.mjs`.

Flag `DEADMAN` (`[vars]`, shipped `off`). Alerting is NOT built: a stale source opens a row in D1 and nothing else happens. Who is told, and how, is the owner's decision; it will be a separate flag, `DEADMAN_ALERT`, off by default. `notifyIncident()` in `deadman.js` is the marked stub where it would go: it does nothing and sends nothing.

## What it does

1. `POST /api/heartbeat`: the PC side sends a signed heartbeat about once a minute. The Worker keeps one row, `kv_state` key `heartbeat`: `{ "pc-bot": { lastAt, ts, seq, count }, "pc-session": { ... } }` (`lastAt` is epoch milliseconds: the time the PC signed, never later than the Worker's clock; `ts` is the last accepted signed timestamp in seconds, the replay guard).
2. The existing one-minute cron (`scheduled` in `index.js`, the `* * * * *` trigger) runs one more step, `runDeadmanCheck`: one `kv_state` read, and when a source is stale at most one D1 batch. For each expected source silent longer than `DEADMAN_STALE_SECONDS` and with no open incident, it inserts one row in `incidents`. The insert is one statement that re-checks, at insert time, that no incident is open for the source and that the heartbeat row's CURRENT `lastAt` for it is still older than the cutoff (`json_extract` on the `kv_state` row), so a heartbeat that landed between the cron's read and its insert wins, and an overlapping cron run holding an old snapshot cannot reopen an incident a heartbeat just closed.
3. The next heartbeat from that source sets `closed_at` on its open incident.

Off, or in a PR preview: both routes answer 404, the cron step returns at once, nothing is read or written. It is wrapped in its own try/catch and `.catch`, so a failure there cannot stop the other cron work.

## Expected sources

Fixed list: `pc-bot`, `pc-session`. A source is expected only after it has sent a first heartbeat, so turning the flag on opens no incident by itself. `DEADMAN_EXPECT` (comma list, default empty) names sources expected from the start: if one never sends, an incident of kind `never_seen` opens after the next cron tick. Names outside the fixed list are ignored.

## The stale threshold

`DEADMAN_STALE_SECONDS` (an optional override, deliberately NOT declared in wrangler.toml: the Workers Free plan allows 64 variables in all; add it only if the budget in `tests/unit/var-budget.test.mjs` has room), default `300`, clamped to 120..3600; unset or not a number reads as 300. With a heartbeat every minute, 300 s is five missed beats. Do not go below 120: the Worker records at most one heartbeat per source per 20 s and the cron runs once a minute.

## The request

Keys (all derived from the bot token, nothing separately provisioned): one independent key per source, `HMAC-SHA256(key = the bot token as UTF-8 bytes, message = "leeroy-heartbeat-v1:<source>")` with `<source>` = `pc-bot` or `pc-session`, and a separate read-only key for the status route, `message = "leeroy-heartbeat-status-v1"`. Each is 32 raw bytes. Signature: lowercase hex of `HMAC-SHA256(key = those 32 bytes, message = "<timestamp>.<raw body>")`. Headers `X-Listen-Timestamp` (unix seconds) and `X-Listen-Signature`, 120 s window, the same scheme as `listener.md` but different keys. A `pc-bot` signature is refused for `pc-session` and for status (401), and the reverse; so are listener, self-test and shadow signatures. The Worker picks the key from the (unverified) `source` in the body, then verifies; a body without a listed source cannot be signed by anyone and is 401.

Body, exactly: `{"purpose":"heartbeat","source":"pc-bot"}` or `"pc-session"`, optionally `"seq": <non-negative integer>`. Any other key or value in a validly signed body: 400. Over 1 KB: 413. No friend data goes in it.

Answers: 404 flag off, preview, or no usable bot token; 401 bad or stale signature; 409 the signed timestamp is not newer than the last accepted one for that source (replay or out-of-order, see below); 503 the row could not be written, or the open incident could not be closed (the sender retries); 200 `{"ok":true,"recorded":true}`. A call less than 20 s after the previous recorded one for the same source answers 200 `{"ok":true,"recorded":false}` and writes no heartbeat row. Any accepted call (recorded or not) also closes the source's open incident, so a retry after a failed close does close it.

Replay: the signed timestamp must be strictly greater than the last accepted one for the source (kept in the row), so a captured request, throttled or not, is refused once a later heartbeat was accepted. Liveness is never moved past the time the PC signed: `lastAt = max(previous, min(now, signed time))`, so a late replay of a request nobody accepted before can only record the moment it was really sent. The sender must therefore sign a fresh timestamp for each attempt (the tool does) and keep its clock close to true time.

How the PC side calls it: run `node tools/heartbeat-send.mjs <token-file> --source pc-bot --loop 60` from the bot's launcher (and the same with `--source pc-session` from the session's). It reads the token from the file, never prints it, sends https only (http for localhost), follows no redirects, and prints one status line per send. Without `--loop` it sends once. The loop dying with its process is the point: a heartbeat should come from the thing being watched, not from a separate scheduled task.

## Reading it

```
node tools/deadman-status.mjs <token-file> [https://api.leeroy.party]
```

Uses `POST /api/heartbeat/status` (the status key, body `{"purpose":"heartbeat-status"}`). If the incident or heartbeat read fails it answers 503, never an empty list. It prints only the sources with their age in seconds, `seq` and `count`, the stale threshold, and the open incidents (id, source, kind, timestamps). Read only; it has no replay guard because it writes nothing.

From the D1 console:

```
SELECT id, source, kind, opened_at, last_seen_at, closed_at, detail FROM incidents ORDER BY opened_at DESC LIMIT 20;
SELECT json FROM kv_state WHERE key = 'heartbeat';
```

`kind` is `stale` (a first heartbeat had arrived, then silence) or `never_seen` (listed in `DEADMAN_EXPECT`, none ever came). `last_seen_at` is the last heartbeat before the silence (empty for `never_seen`), then the heartbeat that closed it. There is at most one open incident per source (a unique partial index), so repeated cron runs add nothing.

## Costs and limits

Per accepted heartbeat: at most one `kv_state` compare-and-set write and one no-match `UPDATE` on `incidents` (writes no row while nothing is open). At most one per source per 20 s. Per cron tick: one `kv_state` read, plus one batch only while a source is stale and has no open incident. Under the Workers Free 10 ms CPU limit this is a small JSON parse and two statements. This has not been measured on the real platform: after DEADMAN is turned on, read the cron's CPU time in the Cloudflare dashboard for a day, and turn the flag back off if the cron's CPU p99 approaches 10 ms. Migration 0015 must be applied for incidents to be written; without it the heartbeat route still records (a missing `incidents` table is not treated as a failed close), the status route answers 503, and the cron step logs `deadman_check_failed` and does nothing else.

## Rollback

Set `DEADMAN` to `off` and deploy: both routes 404 and the cron step does nothing. The `incidents` table and the `heartbeat` row are left as they are and are never read while off. `DROP TABLE IF EXISTS incidents;` removes the table.

## What it does not prove

- It detects a silent PC, not a wrong answer. A bot that heartbeats while answering badly, or a heartbeat sent by a loop that outlives the thing it watches, looks healthy.
- It cannot tell a dead PC from a dead network path between the PC and Cloudflare. Both look like silence.
- The keys are derived from the bot token: anyone holding the token can derive any of them and send heartbeats, or read status. Separate keys limit what a leaked per-source or status key can do (it cannot send for another source or read status, and the status key cannot send), not what the token holder can do. That is the same trust boundary as the listener.
- The cron is the only thing that opens incidents. If the Worker or its cron trigger stops, nothing opens; that is outside what this check covers.
- Nothing is sent when an incident opens (alerting is not built), so until `DEADMAN_ALERT` exists someone has to read the table or run the status tool.
