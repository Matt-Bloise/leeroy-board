# Receiving Discord @mentions and replies on Cloudflare, with no PC

Status: spike with a flag-off prototype (`infrastructure/worker/gateway.js`, class `GatewayDO`). Nothing here has talked to the real Discord Gateway.

## Verdict

**Conditional go on the free plan.** A Durable Object can hold the Gateway socket 24/7. It cannot hibernate while it does, so it is billed wall-clock duration all day. The arithmetic fits the free allowance, with about 17% to spare and a hard failure (not a bill) if it is exceeded:

| | Per day | Free allowance | Share |
|---|---|---|---|
| Duration, one DO awake 24 h at the fixed 128 MB | 0.125 GB x 86,400 s = **10,800 GB-s** | 13,000 GB-s | **83%** |
| Requests: one alarm a minute | 1,440 | 100,000 (shared with the whole Worker) | 1.4% |
| Requests: Gateway events | unknown, see below | | |

If the allowance runs out, Cloudflare fails further operations of that type until the daily reset (per the free-plan wording in the search summary of the pricing page). The Worker, `BoardRoom` and the slash commands could then fail too, so this is not harmless. Ship it off, trial it for one day with the dashboard open, and keep the fallback ready.

**Fallback if the numbers are worse than 83%:** keep Interactions-only (the `/ask` slash command and the context-menu "Ask Leeroy", both live). Plain @mentions then stay unavailable once the PC bot is retired. Paid-plan estimate: the $5 Workers Paid base. Duration per month would be about 324,000 GB-s against 400,000 included, and requests are far below the 1,000,000 included, so overage should be $0 (figures from the pricing page as summarized by search; see "Sources and how far to trust them").

## Sources and how far to trust them

**Read this first.** In the session that wrote this, `developers.cloudflare.com` and `discord.com` did not resolve (the sandbox network allow-list blocked them), so I could not fetch either primary source. Everything below is from (a) web-search summaries of the Cloudflare pages, marked **[search]**, or (b) my recollection of the Discord docs, marked **[recall]**. Someone must open each link and confirm before the flag is turned on. Nothing here is verified by running it.

Cloudflare:
- Pricing and duration billing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Lifecycle and hibernation conditions: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- WebSockets / Hibernation API: https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets-api/
- Alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- workerd issue on outgoing sockets and hibernation: https://github.com/cloudflare/workerd/issues/4864

Discord:
- Gateway (opcodes, heartbeat, identify, resume, close codes, rate limits): https://discord.com/developers/docs/events/gateway
- Gateway events and intents: https://discord.com/developers/docs/events/gateway#gateway-intents
- Message content intent: https://discord.com/developers/docs/events/gateway#message-content-intent
- Create Message (REST): https://discord.com/developers/docs/resources/message#create-message

## Answers, with numbers

1. **Does an outbound WebSocket client in a DO prevent hibernation? Yes.** [search] Hibernation only works for sockets the DO accepts with `ctx.acceptWebSocket()`; a socket the DO opens itself to an external service (`fetch` with `Upgrade: websocket`, then `ws.accept()`) is not hibernatable, and the lifecycle page says active outbound connections keep the object in memory and incur duration charges. A pending `setTimeout`/`setInterval` also blocks hibernation, and the heartbeat is a timer. The same search summary quoted "up to 15 minutes per connection" for idle outbound connections; I could not read the context, and it does not matter here because the heartbeat keeps the object busy anyway.
2. **What does the 24/7 DO cost on the FREE plan?** Billing is wall clock while active and not hibernatable, charged for the fixed 128 MB regardless of use [search]. So 0.125 GB x 86,400 s = **10,800 GB-s/day against 13,000 free**, 83% of the allowance, leaving 2,200 GB-s. `BoardRoom` is hibernatable and bills only while handling events, so it should fit in the remainder, but a busy night of live-board viewers eats the margin. Free plan Durable Objects must be SQLite-backed [search]; `GatewayDO` is declared that way (`new_sqlite_classes`).
3. **Requests.** Free: 100,000 a day [search]. The prototype adds 1,440 alarm invocations a day. Heartbeat ACKs arrive every ~41 s (~2,100 a day). Whether inbound messages on an outbound socket count as requests, and at what ratio, I could not confirm (the hibernatable-socket 20:1 rule is the only ratio I know of, and it may not apply here). Worst case at 1:1 that is about 3,600 a day for protocol traffic. The unbounded part is `MESSAGE_CREATE`: with the GUILD_MESSAGES intent Discord sends every message in every channel the bot can see, not just the allow-listed ones (there is no server-side filter). A small private guild is likely hundreds a day; a busy one could be tens of thousands. **Check the guild's real volume before enabling.**
4. **CPU.** Free Workers get 10 ms CPU per request [search]; network waiting does not count. Parsing a frame is microseconds. `answerWithAi` ranks library pages in process (the same code the Interactions path runs in `waitUntil`), so any CPU problem already exists there. Whether a DO socket event resets the CPU budget per message on the free plan: **unverified**.
5. **Deploys and evictions.** A deploy or eviction replaces the instance: memory and the open socket are lost, and the constructor runs again. [search] says objects are restarted on occasional shutdowns; it did not confirm deploy behavior, but that is how DOs work. What survives: DO storage (`session_id`, `resume_gateway_url`, sequence) and the alarm. The alarm fires every minute, finds no socket, and reconnects with `RESUME` (op 6: token, session_id, seq) to `resume_gateway_url`. Discord replays missed events [recall], so the outage is bounded by the alarm (at most ~60 s plus backoff) as long as Discord still holds the session (a few minutes [recall]); after that `INVALID_SESSION` (not resumable) leads to a fresh `IDENTIFY`. The sequence is persisted about once per heartbeat (~41 s), so a resume can replay up to that many events; handled message ids are stored right when handled and replays are skipped, and the 20 s cooldown is stored at once.
6. **Can the Workers free plan host this at all?** Yes, by the numbers above: Durable Objects are available on free (SQLite only), outbound WebSockets from a DO are allowed, and the 83% figure fits. It leaves little headroom.

## Gateway facts the code relies on [recall; confirm]

- URL `wss://gateway.discord.gg/?v=10&encoding=json`. After `READY`, reconnect to `resume_gateway_url`.
- `HELLO` (op 10) gives `heartbeat_interval`. First heartbeat after `interval x random(0..1)`, then every interval. Missing ACK (op 11) before the next beat means a zombied connection: close with a non-1000/1001 code and resume.
- Server may send op 1 (heartbeat now), op 7 (reconnect, resume), op 9 (invalid session; `d` true means resumable; wait 1 to 5 s then IDENTIFY if not).
- Close codes: 4004 auth failed, 4010 to 4014 are fatal (4013 invalid intents, 4014 disallowed intents). 4007 invalid seq and 4009 session timed out need a fresh IDENTIFY. 1000/1001 invalidate the session.
- Intents: GUILDS 1<<0, GUILD_MESSAGES 1<<9, MESSAGE_CONTENT 1<<15 (privileged). Value used: 33281.
- MESSAGE_CONTENT: without it message content is empty except in messages that mention the bot, DMs, and the bot's own messages. A plain reply without a ping would arrive empty, so turn the intent on.
- Limits: 120 gateway events per 60 s per connection (we send ~1 beat per 41 s), 1,000 IDENTIFYs per 24 h (the prototype refuses beyond 900 a day and backs off 1 s doubling to 60 s with jitter).
- REST reply: `POST /channels/{id}/messages` with `message_reference` and `allowed_mentions: { parse: [], replied_user: false }`.

## What the prototype does

- `GatewayDO` in `infrastructure/worker/gateway.js`; binding `GATEWAY` and migration tag `v2` in `wrangler.toml` (the existing `BoardRoom` and tag `v1` are untouched). `GATEWAY_ENABLED = "off"` by default.
- The Worker cron (every 6 h) and `POST /api/admin/gateway/start` start it; after that the DO's own one-minute alarm keeps it alive.
- Only `MESSAGE_CREATE` from a human, in the configured guild (`discord_roster.guildId`), in a channel in D1 `kv_state` key `gateway_channels`, that mentions the bot or replies to one of its messages. Bots, webhooks, DMs, other guilds and other channels are ignored; an empty allow-list ignores everything.
- `handleGatewayAsk({ env, message })` inserts `ask_turns` with the same SQL as the Interactions path, runs `answerWithAi` unchanged, and replies over REST. It does not call `insertIntent` (that lives in `index.js`; importing it from here would be circular).
- `GET /api/admin/gateway` (admin token): state, last heartbeat ack, reconnect count, last 20 event types and times. No message content, no token.
- The token is `env.DISCORD_BOT_TOKEN`, the secret `POST /api/announce` already uses. It is never logged, stored or returned.

## Failure modes

| Failure | Behavior |
|---|---|
| Deploy or eviction | Reconnect within ~1 min via alarm; RESUME if the session is alive, else IDENTIFY. |
| Zombie socket | No ACK by the next beat: close 4000, resume. |
| Bad token / intent not enabled in the portal (4004, 4013, 4014) | Marked `fatal`, no retry, alarm stops. Fix, then `POST /api/admin/gateway/start?clear=1`. |
| Reconnect storm | Backoff to 60 s; IDENTIFY capped at 900 a day. |
| Daily free allowance exhausted | Cloudflare fails operations until reset; the Worker could be affected. Turn the flag off. |
| Duplicate reply after a replay | Handled ids and a per-user cooldown (20 s, DO storage) make it unlikely, not impossible. |
| AI slow or erroring | Same path as `/ask`: persona error line. The socket loop is not blocked by the AI call. |
| Flag turned off | The next alarm closes the socket and stops re-arming. |

## What the owner or Josh must do to turn it on

1. Open the confirm list above and verify the Cloudflare and Discord facts against the live docs.
2. Discord Developer Portal, the bot's page, Bot tab: enable **Message Content Intent** (privileged; for a bot in under 100 servers it is a toggle, no review).
3. Allow-list channels (admin token), for example:
   `curl -X PUT https://api.leeroy.party/api/config/gateway_channels -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "Content-Type: application/json" -d '["<channel id>"]'`
4. Set `GATEWAY_ENABLED = "on"` (in `wrangler.toml` or the dashboard), deploy, then `POST /api/admin/gateway/start`.
5. Watch `GET /api/admin/gateway` for `state: "ready"`, and the Cloudflare dashboard Durable Objects duration for a full day. Target: well under 13,000 GB-s.
6. Only then stop the PC bot.

Rollback: set the flag to `off` (the DO closes within a minute), or revert the PR. The `v2` migration only adds an empty class.
