# Gateway spike: one hour on a throwaway worker

This page is the admin's checklist for the one-hour spike that decides whether a Durable Object can hold the Discord gateway connection (`docs/parity/worker-parity-gap-table.md`, sections 2a, 2f row 2, and 3). The kit lives in `tools/gateway-spike/` and is a separate worker, `leeroy-gateway-spike`. It has no D1, no AI binding, no routes, no cron, no vars, and none of the production secrets. It is not part of the production deploy (`deploy-cloudflare.yml` deploys from `infrastructure/`; `tools/pages-bundle.mjs` publishes a fixed list of top-level folders that does not include `tools/`; `tests/unit/gateway-spike.test.mjs` pins both).

Who: the account admin (Josh). The spike needs a Cloudflare login that can deploy a Worker, and a Discord login that can create an application. Matt's role is read-only on Cloudflare, so Matt cannot run it.

Not verified by the author: nothing in this kit was run against Discord or Cloudflare. Only the pure state machine was tested with a fake socket. Every statement below marked [not stated] is something the opened pages do not say; the spike exists to measure those.

## Steps

1. **Create a throwaway Discord application.** Developer Portal, New Application, Bot tab, reset token, copy it once. Leave all three Privileged Gateway Intents OFF. The spike identifies with intents 513 (GUILDS plus GUILD_MESSAGES), which need no privileged intent [Discord gateway docs: "`513` combines GUILDS (`1 << 0`) and GUILD_MESSAGES (`1 << 9`)"; privileged ones are GUILD_MEMBERS, GUILD_PRESENCES, MESSAGE_CONTENT].
2. **Invite it to a throwaway test server** you own (OAuth2 URL generator, scope `bot`, no permissions). The spike only needs to see events such as GUILD_CREATE and MESSAGE_CREATE. Without the Message Content intent, `content` is empty except for the bot's own messages, DMs, mentions of the bot, and context-menu targets, which is fine for counting events.
3. **Never use the real bot's token.** Identify is limited to 1000 per 24 hours globally, and exceeding it ends all sessions and resets the token [Discord gateway docs]. A throwaway app keeps the real bot's budget untouched.
4. **Set the secret on the throwaway worker only.**
   ```
   cd tools/gateway-spike
   npx wrangler secret put DISCORD_BOT_TOKEN --name leeroy-gateway-spike
   ```
   Do not run this in `infrastructure/`. Confirm the target name is `leeroy-gateway-spike` before pasting the token.
5. **Deploy.** `npx wrangler deploy` from `tools/gateway-spike/`. Note the `https://leeroy-gateway-spike.<subdomain>.workers.dev` URL. If wrangler rejects the `new_sqlite_classes` migration in `wrangler.toml`, see the note under "Cloudflare facts" and use the form your wrangler version accepts. The class must be SQLite-backed (Workers Free supports only that backend).
6. **Start it.** `curl -X POST https://<url>/spike/start`. Record the time. This arms the 30 s alarm and opens the socket.
7. **Check READY.** `curl https://<url>/spike/status` after about 10 s. Expect `phase: "ready"`, `counters.identifies: 1`, `timeToReadyMs`, and `counters.eventTypes` listing GUILD_CREATE. If `lastError` shows an HTTP status or "no webSocket on upgrade response", copy the exact string into the results table: that is the answer to "outbound WebSocket accepted on the current plan".
8. **Run for one hour.** Do not call anything for the first 50 minutes except a status read every 10 minutes (each call is a billable request and wakes the object). Post a few messages in the test server and mention the bot once to see MESSAGE_CREATE counters move.
9. **Alarm-less eviction test (10 minutes, optional but wanted).** `curl -X POST "https://<url>/spike/alarms?on=0"` removes the alarm and stops re-arming. Wait 20 minutes without calling anything, then `GET /spike/status`. `bootHistory` shows whether a new instance booted (`coldStarts` increased) and `previousInstanceRanS` and `gapBeforeBootS` show when the old one went away. `curl -X POST "https://<url>/spike/alarms?on=1"` restores it. Your own status call is a request that can wake an evicted object, so a cold start seen here means it was evicted before that call.
10. **Force-close test (RESUME).** `curl -X POST https://<url>/spike/force-close`. Wait 10 s, then `GET /spike/status`. Pass means: `counters.resumes` +1, `counters.resumed` +1, `counters.identifies` unchanged, `closeCodes["4000"]` +1, `reconnects` +1. Close code 4000 is "may reconnect" in the Discord table; resume goes to the stored `resume_gateway_url` with op 6 [Discord gateway docs; opcodes and status codes page]. Repeat three times.
11. **Duration.** `GET /spike/duration` returns `awakeSeconds` and `gbSeconds` (seconds x 0.125 GB). Read the Cloudflare dashboard Durable Objects metrics for the same window (duration in GB-s, requests, rows written) and fill the table. Predicted for one always-awake hour: 450 GB-s.
12. **Delete the worker afterwards.** `npx wrangler delete --name leeroy-gateway-spike` (this also removes the Durable Object data). Then delete the throwaway Discord application, which revokes the token. Do not leave a spike worker running: it holds an always-awake object.

## Results table (fill in)

| Question | Result |
|---|---|
| Plan at test time (Workers Free or Paid) | |
| Outbound WebSocket accepted (yes/no); if no, the exact error from `lastError` | |
| Time to READY (`timeToReadyMs`) | |
| Heartbeat ACK ratio (`ackRatio`, hour total) | |
| Zombie closes in the hour (`counters.zombies`) | |
| Resume works (yes/no), 3 force-closes; `identifies` after the test | |
| Identifies used in the whole hour | |
| GB-s for the hour, measured (dashboard) | |
| GB-s for the hour, from `/spike/duration` | |
| GB-s predicted (450) and the difference | |
| Stayed alive with the alarm on (yes/no; `coldStarts` and `bootHistory`) | |
| Stayed alive with the alarm off, or evicted and when (`bootHistory`) | |
| Requests billed in the hour (dashboard) | |
| Rows written in the hour (dashboard) vs `counters.storageWrites` | |
| Did incoming gateway messages bill at 20:1 on the client socket (requests vs `counters.events` plus ACKs) | |
| Close codes seen (`closeCodes`) | |

## What the kit does

- `src/state.js`: the state machine (no Cloudflare APIs). `src/gateway-do.js`: the Durable Object that opens the socket, stores `session_id`, `resume_gateway_url` and `seq`, counts everything, and answers `/spike/*`. `src/index.js`: routes to one named object.
- `GET /gateway/bot` for the URL and `session_start_limit`; connect to `?v=10&encoding=json`; HELLO, first heartbeat after `heartbeat_interval x jitter`, then every interval; a missed ACK closes with 4000 and resumes; IDENTIFY only when no stored session exists. Spike-only rules (ours, not Discord's): refuse IDENTIFY below 5 `session_start_limit.remaining` or after 3 in an hour.
- Storage writes are throttled: `seq` is persisted on READY, on each heartbeat and on close, not on every event, to keep rows written low. After an eviction the object resumes from an older `seq`, so replayed events are expected.
- The DO alarm fires every 30 s as keepalive and watchdog and always re-arms in a `finally`. The alarm page recommends catching errors and scheduling a new alarm. The 30 s period is our choice, not a documented value.
- `/spike/status` never returns the token or the session id; it returns booleans and counts.

## Cloudflare facts used (pages opened 2026-11-19 with WebFetch)

| Rule | Page and what it says |
|---|---|
| Free: 100,000 requests/day, 13,000 GB-s/day, 100,000 rows written/day, 5M read/day; limits reset 00:00 UTC; over limit, operations fail. Paid: 1M requests/month and 400,000 GB-s/month included, overage $0.15 per million requests and $12.50 per million GB-s | https://developers.cloudflare.com/durable-objects/platform/pricing/ (limits table) |
| Duration is wall-clock while running or idle-but-unable-to-hibernate; 128 MB billed regardless of use | same page, duration billing |
| WebSocket creation is one request; the 20:1 ratio is for incoming messages only; outgoing messages are free | same page, WebSocket billing. Whether the ratio applies to a client (outbound) socket is [not stated] |
| Each alarm invocation is a request; each `setAlarm()` is one row written | same page, alarms |
| CPU 30 s default per invocation (request, WebSocket message, alarm) for SQLite-backed classes; alarm handlers 15 minutes wall; 100 DO classes Free, 500 Paid; about 1,000 requests/s soft limit per object | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Outbound WebSocket limits for DOs | same page: [not stated]. Free-plan CPU value for a DO: [not stated] |
| Eviction: idle but unable to hibernate is evicted after 70-140 s without requests or events; hibernation needs no outbound connection and no standard-API WebSocket; pending outbound WebSockets block eviction until done or 15 minutes | https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ("70-140 seconds") |
| Outgoing WebSockets do not hibernate; an open outbound socket prevents eviction for up to 15 minutes and later I/O can extend it | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ("Outgoing WebSockets do not hibernate"). How to open one: [not stated] there |
| Client socket: `fetch()` with `Upgrade: websocket` on an `https://` URL, then `resp.webSocket` and `accept()`; connections can drop on runtime updates or crashes, so reconnect and restore state | https://developers.cloudflare.com/workers/runtime-apis/websockets/. `wss://` is [not stated], so the kit rewrites `wss:` to `https:` |
| One alarm per object; `setAlarm`, `getAlarm`, `deleteAlarm`; at-least-once; uncaught error retries 6 times with backoff from 2 s | https://developers.cloudflare.com/durable-objects/api/alarms/ ("at-least-once"). Minimum interval and handler duration: [not stated] there |
| Workers Free: 100,000 requests/day, 10 ms CPU per request, 50 subrequests; Paid: 30 s default CPU, 10,000 subrequests; outbound WebSockets count toward the 6 simultaneous connections on both plans; DO Free/Paid split: none given | https://developers.cloudflare.com/workers/platform/limits/ |
| Paid minimum $5 per month; DOs on both plans, Free only SQLite-backed | https://developers.cloudflare.com/workers/platform/pricing/ ("$5 USD per month") |
| Binding and class declaration | https://developers.cloudflare.com/durable-objects/get-started/ : bindings take `name` and `class_name`; that page declares the class in an `exports` block with `"storage": "sqlite"` and does not mention `new_sqlite_classes` [not stated]. The production `infrastructure/wrangler.toml` uses `[[migrations]] new_sqlite_classes`, which the kit copies; `stub.fetch` is [not stated] on that page |
| Whether outbound WebSocket fetch is allowed on Workers Free | [not stated] on every page above. This is the question the spike answers |

## Discord facts used (pages opened 2026-11-19 with WebFetch)

| Rule | Page and what it says |
|---|---|
| Connect with `v` and `encoding` query params; `GET /gateway/bot` returns `url`, `shards`, `session_start_limit` (`total`, `remaining`, `reset_after`, `max_concurrency`); do not cache it long | https://docs.discord.com/developers/events/gateway and /topics/gateway (Get Gateway Bot) |
| HELLO gives `heartbeat_interval`; first heartbeat after interval x a random 0..1 jitter, then every interval | https://docs.discord.com/developers/events/gateway (Hello) |
| No ACK between heartbeats means a zombied connection: close with a code other than 1000 or 1001, reconnect, resume | same page (Heartbeat ACK) |
| Identify: `token`, `intents`, `properties`; 1000 per 24 h across shards; resume does not count; exceeding it terminates sessions and resets the token; concurrent identifies limited per 5 s (`max_concurrency`) | same page (Identify, rate limits) |
| 120 gateway events per connection per 60 s, over it disconnects | same page |
| Resume: op 6 with `token`, `session_id`, `seq`, sent after connecting to `resume_gateway_url` from READY | same page (Resume) |
| Op 7: attempt resume. Op 9: `d` true may resume, `d` false disconnect, wait, new identify | same page |
| Closing with 1000 or 1001 invalidates the session; other codes or a dropped TCP connection keep it "a few minutes" (exact lifetime [not stated]) | same page (closing) |
| Close codes: 4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009 may reconnect; 4004, 4010, 4011, 4012, 4013, 4014 may not. 4007 and 4009 say start a new session, 4003 says session invalidated: the kit identifies on those three and resumes on 4000, 4001, 4002, 4005, 4008. 4006 is not in the table [not stated] | https://docs.discord.com/developers/topics/opcodes-and-status-codes |
| GUILDS (`1 << 0`) and GUILD_MESSAGES (`1 << 9`) are not privileged; privileged: GUILD_MEMBERS, GUILD_PRESENCES, MESSAGE_CONTENT, each enabled in the Developer Portal | https://docs.discord.com/developers/events/gateway (Intents) |
| Without Message Content, `content` and similar fields are empty except own messages, DMs, mentions of the app, context-menu target | same page (Message Content Intent) |
| Verification is required at 100 or more guilds, with privileged intents approved after review | https://docs.discord.com/developers/topics/gateway |

Note on the 4000 test: the table says 4000 is an unknown error where reconnecting may help. Using it as our own client close code is a spike choice; the docs do not call it a recommended client code [not stated]. The only rule they state is "any code other than 1000 or 1001".

## After the spike

Paste the filled table into `docs/parity/worker-parity-gap-table.md` section 5 (replace the unverified items it answers) and tell the owner whether option A (DO gateway) holds and on which plan. If outbound WebSocket is refused on Free, that is the evidence for the plan-change item in section 3.
