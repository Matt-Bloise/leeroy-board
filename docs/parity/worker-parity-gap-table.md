# Worker parity gap table: what the PC bot and local session do that the Worker does not yet

Status: proposal, docs only. Written 2026-11-18. Nothing here changes a Worker var, secret, Discord setting or production workflow.

Goal (Matt): Cloudflare alone runs Leeroy, so the PC session and `bot.js` can be switched off and friends notice no difference.

Evidence classes used in every claim:

- `[code a/b]` = read in this session: `bot.js:N` etc. are the local bot (`leeroy-ops/bot-legacy/bot/`, read-only, outside this repo); `worker/x.js:N` is `infrastructure/worker/` in this repo at origin/master.
- `[docs URL]` = read from the live Cloudflare or Discord documentation in this session (URL in section 2).
- `[unv]` = not verified. Reasoned, remembered, or inferred; needs a test or an owner answer.

No member names, ids, friend text or config values appear here. `config.json` was only checked for the boolean state of named flags.

## 0. Findings that change the shape of the plan

1. The Worker already owns more than the task text suggests [code]: sign-up cards and board lines (`worker/cards.js:468,505,541`, `worker/board-lines.js:108`), the noise budget (`worker/noise.js:115,131,140`), timed moments with a shadow mode (`worker/moments.js:421`, cron in `worker/index.js:2076-2081`), scheduled events (`worker/scheduled-events.js:278`), the 6-hour source sweep (`worker/index.js:2087`), group memory (`worker/research/group-wiki.js`), the listener (`worker/listener.js:95,119,229`), sheet events (`schema.sql` `sheet_events`), answer buttons and feedback (`worker/answer-ux.js:213,234`). Most "gaps" are therefore flags that are still off plus proofs not yet run, not missing code.
2. The one hard structural gap is the **gateway**: nothing in the Worker holds a Discord WebSocket. `POST /api/listen` is fed by a PC forwarder (`docs/runbooks/listener.md:7`). Switching the PC off needs a Durable Object (or another host) to hold the connection.
3. The second structural gap is **long answers**. The local path writes inbox files, a local Claude session takes minutes, the answer is edited in (`bot.js:445-503`, `bot.js:1360-1424`). The Worker answers inside `waitUntil` with a 26 s deadline (`worker/discord.js:644`), under the 30 s cap [docs workers limits].
4. Several local behaviours are already off or retired by config (booleans only): `registerCommands` false (Worker owns slash commands, `bot.js:255`), `brain.enabled` false, `dailyDigest` false, `signupReminder/Nudge/Collapse` false, `boardPublishHourly` false, `boardPublishOnActivity` false, `refresh` false, `sheetCommand` false, `launchCommand` false. Currently true: `mentionsEnabled`, `moments`, `boardDecisionLines`, `ackReplies`. Parity work targets the true ones first. [code config.json booleans; the state is a snapshot of 2026-11-18, re-check before any cutover]
5. Conflict to resolve: `bot.js` header says mentions were retired Nov 3 (`bot.js:450`), but the config flag `mentionsEnabled` is true, so mentions are still filed to the inbox. `docs/runbooks/listener.md:89` says "the old PC bot is not used". Both cannot be right; confirm what actually answers a mention today before measuring parity. [unv]
6. Untagged-message reading is **not** a parity item. `bot.js` returns early unless the message mentions the bot (`bot.js:515`). The Worker's untagged path (`worker/listener-untagged.js`) is a new feature; keep it out of the cutover.

## 1. Gap table

Legend. Has it: yes / partial / no. Who: C = code only; J = Josh (owns the Cloudflare account); M = Matt, read-only role (can read, cannot change the Cloudflare account); P = Developer Portal (app owner). Proof: always "shadow": the Worker computes and records the answer or action without posting, then it is compared with what the local side did (method per slice in section 4).

### 1a. Gateway events

| Local behaviour (file:function) | Worker has it? | What is needed | Who | Flag (default off) | Proof |
|---|---|---|---|---|---|
| Mention in an allowed channel or thread: `bot.js:499` messageCreate, `fileMention` `bot.js:445` | partial: handler exists, `worker/listener.js:95,119`; kind list `worker/listener-config.js:20`; fed only by the PC forwarder (`docs/runbooks/listener.md:7`) | A gateway client inside the Worker that builds the same signed event and calls `processListenEvent` directly (no HTTP hop). Allowed-channel check as `bot.js:514`. | C, then J (DO binding) | `GATEWAY` = off / shadow / live | Shadow: Worker records decision plus would-be text in `listen_events` / private `ask_turns` (existing dry mode, `listener.js:155-158`); compare to the local reply for the same message id |
| Reply to a Leeroy message: `bot.js:476-481`, threaded follow-up `bot.js:1382-1395` | partial: kind `reply` exists (`listener-config.js:20`, `listener.js:121`); posts a plain reply, not a thread on the earlier answer (`listener.js:155-158`) | Thread-on-answer behaviour (create thread off the earlier message, post there, stub on the placeholder) | C | `GATEWAY_FOLLOWUP_THREAD` | Shadow compare of target (thread vs reply) per reply event |
| Untagged channel text | no, and not needed: local bot ignores it (`bot.js:515`) | Nothing for parity. `listener-untagged.js` stays flagged off | n/a | `LISTENER_UNTAGGED` (exists, off) | n/a |
| Direct message from a partner account: `bot.js:~506-512` appends to a local inbox file, reacts, nothing else | no | Decide: retire, or store in D1 (a new table or `kv_state` key) with a reaction. Needs `DirectMessages` intent in the identify (DM content arrives without the privileged intent [docs gateway]) | C; P only if the intent is not already set | `GATEWAY_DM` | Shadow: count and hash-only record vs the local inbox line count |
| Thread created in the build forum: `bot.js:319` threadCreate, `refreshForumThreads` `bot.js:274`, used by build lookups (`bot.js:299`, `cmd.resolveBuild`) | partial: builds and `/build` exist (`schema.sql` `builds`, `worker/build-modal.js`, flag `BUILD_MODAL`). A forum scan was not found by search in `worker/` [unv: grep only] | THREAD_CREATE gateway event plus REST listing of active threads in cron, writing to the builds table | C | `FORUM_SYNC` | Shadow: Worker's thread list vs `forumThreads` after 15 min |
| Reaction thumbs up/down on a Leeroy message logged to a local file: `bot.js:326` | partial: votes exist as buttons into `answer_feedback` (`worker/answer-ux.js:234`). `worker/discord.js:1541` says the Worker has no reaction handling | REACTION_ADD gateway event (needs `GuildMessageReactions`), message id to intent id map (is the message id stored with the turn? [unv]) | C | `GATEWAY_REACTIONS` | Shadow: rows written to a shadow table; compare to `feedback.jsonl` line count and message ids |
| Trash-emoji delete of a Leeroy answer by its asker: `bot.js:1524`, `ob.isTrashEmoji`, `answered` map `bot.js:1402` | no | REACTION_ADD plus "who asked" lookup (`ask_turn_askers`, `worker/answer-ux.js:57,72`), then DELETE message via REST. The `answered` map is in memory and lost on restart, so D1 is better | C | `GATEWAY_REACTIONS` | Shadow: would-delete rows vs local log lines |
| Poll-closed system message triggers a board publish: `bot.js:500` | no, but the local flag `boardPublishOnActivity` is false, so it is dormant | None unless re-enabled | n/a | n/a | n/a |
| Launch-stub cleanup: bot deletes its own type-23 "Game Invitation" messages after 4 s: `bot.js:501-505` | no | Gateway MESSAGE_CREATE filter (own app id, type 23) plus delayed DELETE. A delay of 4 s needs an alarm or an inline `setTimeout` inside the DO | C | `GATEWAY_LAUNCH_STUB` | Shadow: would-delete rows vs local log |
| Guild join registers commands: `bot.js:312` | yes: Worker owns commands, `registerCommands` is false locally (`bot.js:255`); command manifest in `worker/discord.js` | None. Confirm the Interactions Endpoint URL is set, otherwise Discord still routes interactions to the gateway. [unv] | M (read), P | none | Compare the portal field value with the Worker URL |
| Gateway health: shardDisconnect, resume replays, `invalidated` (`bot.js:246-251`) | no | Own heartbeat, resume and reconnect logic (section 2a) | C | `GATEWAY` | Soak: forced disconnects in shadow, assert no missed id vs REST catch-up |

### 1b. Timers

| Local behaviour (file:function) | Worker has it? | What is needed | Who | Flag | Proof |
|---|---|---|---|---|---|
| Outbox drain every 5 s: `bot.js:231` `drainOutbox`, `drainOutboxOnce` `bot.js:1313` | no (different design) | Not a port. Replace the file queue with direct posts from the answer path, plus a D1 `outbox` table only for items a human-driven session must still hand over (announcements). `/say` and `POST /api/announce` already cover admin posts (`docs/runbooks/discord-say.md`) | C | `OUTBOX_D1` | Shadow: row written, not sent; compare job types seen locally in a week (reply, post, followup, edit, delete, react, card, `bot.js:1319-1327`) |
| Forum refresh every 15 min: `bot.js:237` | no | Cron or alarm job (see `FORUM_SYNC` above) | C | `FORUM_SYNC` | as above |
| Mention catch-up every 10 min, on startup and on resume: `bot.js:238`, `catchUpMentions` `bot.js:528` | no | REST scan of allowed channels and active threads, 50 messages each, 48 h window, idempotent on message id (`listen_events` already dedupes, `listener.js:71`). Needed even with a gateway DO: it is the safety net for gaps | C | `CATCHUP_REST` | Shadow: ids it would file vs ids the local catch-up filed; expect zero misses |
| Board publish hourly and on activity: `bot.js:671` | not applicable here: it spawns local node scripts that publish the Pages board. The Worker side of the board data is `GET /api/state` and `D1_FEED` (`wrangler.toml`) | Out of this scope; local flags are false [code config booleans]. Moving the publish pipeline into CI is a separate slice | C / J (Pages) | n/a | n/a |
| Daily digest after 6 PM ET: `bot.js:703` | no | Cron step plus noise budget; local flag is false so this is optional | C | `DIGEST` | Shadow lines vs `digest.js` output on the same day |
| Sign-up jobs every minute (reminder T-15 min, nudge T-24 h, collapse): `bot.js:1720-1752` | no | Port `signup-jobs.js` plan to a cron step reading `signups_v2` / signups doc; ledger in D1. Local flags are false | C | `SIGNUP_JOBS` | Shadow `would_post` rows vs the local ledger |
| Moments tick every 20 s: `bot.js:1680-1718`, schedule from `notes/EVENTS.md` | partial: engine and shadow mode exist (`worker/moments.js:421`, vars `MOMENTS_*`); cron is every minute (`wrangler.toml` crons, `worker/index.js:2076`); schedule comes from D1 key `moments` (`index.js:2080`), not the markdown file | Schedule transfer (EVENTS.md to D1 config key) plus a check that a 1-minute tick is acceptable against the local 20 s tick. Runbook says shadow only until launch passed (`docs/runbooks/moments.md:5`); that date has passed, owner decides | C, J (flag flip) | `MOMENTS_SHADOW` then `MOMENTS_ENABLED` (exist) | Shadow ledger rows vs `data/moments.jsonl` entries (same moment id, within 60 s) |
| Typing indicator every 8 s while a question is in flight, 2 min cap: `bot.js:342-352` | no [code grep of worker/ for typing: none] | POST typing every 8 s inside the answer path (fits the 26 s deadline), or from the DO for long answers | C | `ACK_TYPING` | Shadow: count of would-be typing calls; cannot be compared visually, so rely on call count per answer |
| Ack "On it" line plus hourglass reaction on filing: `bot.js:396-402`, `bot.js:496` | partial: slash path acks with a deferred reply (`worker/discord.js:875,2088`) and a persona line. No ack for a gateway message | Post ack reply, react, later edit that same message into the answer (as `bot.js:1417`). Rolling ack lines come from `data/ack-lines.json` (3.5 KB); the Worker has persona lines (`ackLines`, `discord.js:2088`) | C | `GATEWAY_ACK` | Shadow: planned ack text vs local ack for same message |
| "Still on it" edit at 12 minutes: `bot.js:403-420` | no | DO alarm set at filing time, edit the placeholder if the answer has not landed (alarm runs up to 15 min wall clock [docs workers limits]) | C | `GATEWAY_STILL_ON_IT` | Shadow: would-edit rows |
| Pointer when mentions are off: `bot.js:424-444` (once per person per 10 min) | no | Only if `mentionsEnabled` goes false first; otherwise skip | C | n/a | n/a |
| Pid single-instance guard: `bot.js:192-211` | n/a | Replaced by DO single-instance (one named object) | C | n/a | n/a |

### 1c. Interaction replies, cards, sheets, lookups, memory

| Local behaviour (file:function) | Worker has it? | What is needed | Who | Flag | Proof |
|---|---|---|---|---|---|
| Slash and component interactions (`bot.js:1091`; `/ask`, `/tonight`, `/signup`, `/sheet`, `/build`, `/map`, `/board`, `/page`, `/tooltip` via `commands.js`) | partial: Worker answers slash traffic. The full local command list vs the Worker manifest was not diffed [unv] | Diff `cmd.commandDefinitions` against the Worker manifest; list any missing command | C | n/a | Command-list diff in CI |
| Deferred reply then edit within the 15 min token: `bot.js:353-372` private asks held in memory; `fillDeferred` `bot.js:998` | yes for short answers: type 5 then PATCH `@original` (`worker/discord.js:614,875,2127`), 26 s deadline (`discord.js:644`) | Long answers (past 26 s) need a durable continuation: DO alarm holding the interaction token (valid 15 min, [unv: Discord doc not opened]) | C | `ASK_LONG` | Shadow: duration distribution of local answers vs 26 s |
| Sign-ups card refresh after every sign-up (coalesced 3 s): `bot.js:607-623` | yes behind a flag: `worker/cards.js:468,505` (redraw, request edit), `cards-handler.js:67`; `CARDS_ENABLED`, `CARDS_SHADOW` (`wrangler.toml`) | Flip order and message-id handover: the card must be the same message the PC bot edits, so state (`state.signupsCardId`) moves into `kv_state` | C, J (flag) | `CARDS_SHADOW` then `CARDS_ENABLED` (exist) | `noise_ledger` `shadow:edit:<channel>` counts vs local edit log lines (`cards.md:9`) |
| Party card first post plus in-place edit batched 5 min: `bot.js:790-826` | partial: Worker holds the sheet event log (`schema.sql sheet_events`, `index.js:286-382`); a Party card renderer in the Worker was not found (`cards.js:305` is the board card) [unv] | Port `party-card.js` builder; read from `sheet_events` directly instead of `brain.fetchParty` | C | `PARTY_CARD` | Compare component tree JSON (hash) with the local card for the same sheet seq |
| Board decision lines, 5 min batch: `bot.js:~680`, `board-lines.js` | yes behind a flag: `worker/board-lines.js:91,108`, `BOARD_LINES_ENABLED` | None beyond the flag order | C, J | `BOARD_LINES_ENABLED` (exists) | Shadow counts vs local posts |
| Noise budget, 3 per day per channel, quiet hours 1-9 AM ET: `noise.js`, ledger `data/noise.jsonl` | yes: `worker/noise.js:115,131,140`, D1 `noise_ledger` | Seed the Worker ledger with the local day's count at cutover so a day does not double-spend | C | none | Local count vs ledger rows for the same ET day |
| Sheet writes from Discord (`applySheet` `bot.js:847`, `sheetWriteFromBot` `bot.js:828`, POST to the Worker) | yes: the Worker is already the source of truth (`index.js:5`, `sheet_events`) | Local `/sheet` command flag is false, so only the Worker path matters; verify the Worker's own `/sheet` interaction handler exists [unv] | C | n/a | Sheet event count parity per day |
| Share buttons, detail buttons ("More", "Sources"): `bot.js:564-597`, `details/<messageId>.md` files | partial: `worker/answer-ux.js:149,213` with D1 `answer_details`; `ANSWER_UX` flag off | Turn on, keep id compatibility with existing buttons (custom ids differ [unv]) | C, J | `ANSWER_UX` (exists) | Button render parity on a fixture set |
| Library lookup, sources, facts (`atlas.js`, `data/facts.json`, `data/library.json`, `board/data/**`) | partial: `lib_pages`, `lib_sources`, `lib_source_snapshots` D1 tables and the 6 h sweep (`worker/scraper.js`, `index.js:2087`); retrieval and abstain rules `worker/self-rag.js:1-20` | Atlas data (`board/data/atlas/*.json`, static) must ship to the Worker (D1 blob or bundled module). `build-data.mjs` outputs need a CI step | C | `ATLAS_WORKER` | Same questions answered by both; fact ids cited compared |
| Local Claude session as the answerer (reads inbox, writes outbox) | partial: `/ask` research mode answers with Claude via API (`ASK_RESEARCH` on in `wrangler.toml`, `worker/research/claude.js`). The local session can browse and read files; the Worker cannot | Define the answer quality bar: which questions the local session answers better than `/ask` today. Probably needs the Worker's source lookup (section 2c) | C, M (decides bar) | none | Sample of N real questions, both answers scored blind |
| Memory: `state.json` (recent acks, egg), `seen.json`, `journeys.json`, `feedback.jsonl`, `noise.jsonl`, `moments.jsonl`, `signups.json`, `brain-state.json` | partial: see section 2d | Mapping table in 2d | C | `STATE_D1` | Row-count parity per file |
| Read-back check (verify what was posted/edited actually landed) | no generic one in the bot [code grep: no match in `bot.js` or modules]. The Worker does it only in the roster-upsert workflow (`docs/runbooks/roster-upsert.md:32`) | Section 2e | C | `READBACK` | Shadow mismatch counter |

## 2. Design decisions

### 2a. How the Worker hears mentions and plain messages

Facts that drive it:

- Hibernation only helps a DO acting as a WebSocket server. Quote: "Hibernation is only supported when a Durable Object acts as a WebSocket server. Outgoing WebSockets do not hibernate." An open outbound socket prevents eviction (up to 15 minutes, and later I/O can extend it). [docs https://developers.cloudflare.com/durable-objects/best-practices/websockets/]
- Duration (GB-s) is billed in wall-clock time while an object runs or sits idle but cannot hibernate, always at the full 128 MB. [docs https://developers.cloudflare.com/durable-objects/platform/pricing/]
- Free plan: only SQLite-backed DOs, 100,000 requests/day, 13,000 GB-s/day, 100,000 SQLite rows written/day, 5M read/day. Alarm invocations count as requests; each `setAlarm()` is one row written. Incoming WebSocket messages bill at 20:1 (100 messages = 5 requests); creating the socket is one request. [docs pricing URL above; whether the 20:1 rule applies to an outbound client socket is not stated: unv]
- Derived: 128 MB = 0.125 GB x 86,400 s = 10,800 GB-s per day for one always-awake object, about 83% of the free 13,000. The existing `BoardRoom` DO (`wrangler.toml`, `worker/room.js:59`) shares the same allowance, as does any alarm run. [derived from docs]
- Cost at our volume [derived from docs pricing and limits pages, opened 2026-11-18]: one always-awake object = 10,800 GB-s/day = about 324,000 GB-s per 30 days. Free allows 13,000 GB-s/day (83% used; any second always-on object or long restart overlap can exhaust it, and exceeding a free limit makes the operation fail until 00:00 UTC). Paid includes 400,000 GB-s/month, so the gateway object fits with no duration overage (overage would be $12.50 per million GB-s); the Paid cost is the plan's own minimum charge (the pricing page's examples add a $5/mo minimum) plus request overage, which is negligible here (incoming gateway messages bill 20:1 if the rule applies to an outbound socket [unv]; outgoing messages and pings are free). Whether the account is already on Paid: unv (the cron CPU note in 2b suggests it may be). A second guard on Paid: usage past the allowances bills, so set an alert.
- Hibernation: the pricing page says duration is billed while an object is active or idle but unable to hibernate; it does not say an outbound client WebSocket blocks hibernation, but the API docs only support hibernation for accepted (inbound) sockets, so plan for an always-awake object [docs, inference].
- Council (2026-11-18): Gemini agreed the DO gateway is sound on Paid and asked for persisted RESUME state (session_id, resume URL, seq), a heartbeat-ACK watchdog with a DO alarm, event dedupe in D1, an IDENTIFY circuit breaker, and a shadow proof that survives a forced redeploy. Gemini's claim that Workers Free blocks outbound WebSocket fetch is unverified (it rated itself 0.75; the DO limits page is silent). The Codex seat is being re-run with names stripped; dispositions are recorded in section 2f when it answers. Nothing is built on this design before then.
- DO CPU is 30 s per request, WebSocket message or alarm by default; free-plan-specific values are not listed on the page. 100 DO classes on Free. [docs https://developers.cloudflare.com/durable-objects/platform/limits/]
- Discord: heartbeat every `heartbeat_interval` (first one after a jittered wait); no ACK between heartbeats means a zombied connection, close with a code other than 1000/1001 and resume. Resume = connect to `resume_gateway_url`, send op 6 with `session_id` and `seq`. Closing with 1000 or 1001 invalidates the session. IDENTIFY is limited to 1000 per 24 h across shards (resume does not count); exceeding it ends all sessions and resets the bot token. 120 gateway commands per 60 s per connection. [docs https://docs.discord.com/developers/events/gateway]
- Message Content intent: without it `content` is empty except for the app's own messages, DMs, messages that mention the app, and the target of a message context-menu command. So a mention carries text without the privileged intent; an untagged message does not. A reply that does not mention the bot (reply ping off) is not stated by that page: unv. [docs gateway URL above]
- Privileged intents need verification only at 100+ guilds; this is a one-server bot [docs gateway URL; guild count for this app: unv].

| Option | Pros | Cons | Cost (docs) |
|---|---|---|---|
| A. One named DO holds an outbound gateway WebSocket; alarm every ~30-60 s as watchdog and keepalive; hands events to `processListenEvent` | Cloudflare-only; no PC; reuses existing listener code | No hibernation, so it is "always awake" and billed as such; heartbeat and resume code is new; a DO eviction or deploy drops the socket, so resume logic and a REST catch-up are mandatory; free-plan headroom is about 17% [derived] | Free plan fits on paper (10,800 of 13,000 GB-s). Workers Paid: 400,000 GB-s/month included (about 13,300 GB-s/day) so the same load fits inside the included amount, with the $5/month minimum noted in the pricing examples |
| B. Interactions only (slash, buttons, message context menu); no gateway | Zero always-on cost; already live | Cannot see plain @mentions or replies; no reactions, no thread events, no catch-up of chat; breaks "friends notice no difference" if friends still tag Leeroy | none |
| C. Tiny always-on forwarder elsewhere (small VM, other free host) POSTing to `/api/listen` | Smallest code change (already designed, `docs/runbooks/listener.md`); no DO billing risk | Not Cloudflare-only; one more thing to run and secure; free-host terms and uptime were not researched [unv] | not researched [unv] |

Recommendation: A, behind `GATEWAY` = off / shadow / live, with `CATCHUP_REST` always on. Keep C (the existing PC forwarder) as the rollback path until A has run clean for a defined soak. B is the fallback only if the owners decide mentions are retired for good (see section 0 item 5). Intents for A: `Guilds`, `GuildMessages`, `GuildMessageReactions`, `DirectMessages` (and `MessageContent` only if mentions-with-reply-ping-off must be read; mentions and DMs do not need it).

Heartbeat design: DO class `GatewayLink` (new `new_sqlite_classes` migration), `fetch()` starts the socket; a `setInterval` heartbeat is risky because DO timers die on eviction [unv], so each tick also arms an alarm; the alarm handler checks last ACK, reconnects or resumes, and re-arms before returning (the alarm docs recommend catching errors and re-arming; retries are 6 with exponential backoff from 2 s [docs https://developers.cloudflare.com/durable-objects/api/alarms/]). Persist `session_id`, `seq`, `resume_gateway_url` in DO storage so a restart resumes instead of identifying; count IDENTIFYs in `kv_state` and refuse a 4th in an hour.

### 2b. Timers: Cron Triggers vs DO alarms

- Cron: `* * * * *` (every minute) is supported; UTC; changes may take up to 15 min to propagate and runs can be missed meanwhile. [docs https://developers.cloudflare.com/workers/configuration/cron-triggers/]
- Cron triggers per account: 5 Free, 250 Paid. CPU per cron invocation: 10 ms Free, 30 s Paid (schedule under 1 hour). Wall clock for cron or alarm: 15 min. `waitUntil` extension: 30 s. Free daily requests: 100,000. [docs https://developers.cloudflare.com/workers/platform/limits/]
- DO alarm: one alarm per object, at-least-once, minimum interval not stated, handler duration not stated on the alarm page (15 min per the limits page). [docs alarms URL above]
- Current use: two cron triggers already (`0 */6 * * *`, `* * * * *`, `wrangler.toml`), "second of five" per its comment. Whether other Workers on the account use triggers: unv (Josh).
- The 10 ms CPU line is a real risk for the minute cron on Free. The existing cron already does D1 work and sweeps, so either the account is on Paid or the work is mostly I/O wait: unv (Josh can read the plan).

Recommendation: keep one minute cron as the single dispatcher (moments, sign-up jobs, catch-up every 10th minute, forum refresh every 15th, digest check, card flush `index.js:2083,2094`) so no new trigger slot is used. Use DO alarms only for per-item delays that need sub-minute or per-event timing: still-on-it (12 min), launch-stub delete (4 s), gateway watchdog. The local moments tick is 20 s; the Worker's is 60 s: acceptable only if the moments schedule has no sub-minute precision requirement [unv].

### 2c. Forever and source lookups from the Worker

What local does: `atlas.js` reads static JSON under `board/data/atlas/` (`atlas.js:1-40`); library facts are built by `build-data.mjs` into `data/*.json`; the local Claude session can browse and read arbitrary files when answering. `brain.js` is a bridge to the Worker (mailbox pull every 10 s, keys, mirror push; `brain.js:1-30`), currently off by config.

What the Worker does: retrieval over `lib_pages` / `lib_sources` / snapshots, abstain rules (`worker/self-rag.js:1-20`), a 6-hour sweep that fetches monitored sources on one host each, 10 s timeout, 256 KB cap, same-host https redirects only (`worker/scraper.js:20-25`), Claude as the only model hop for members (`worker/research/claude.js:7`) with an Anthropic-only host allow-list.

Limits [docs workers limits]: 50 external subrequests per invocation on Free (10,000 Paid); 6 simultaneous outgoing connections; redirects count as subrequests; D1 queries per invocation 50 Free / 1,000 Paid, a `batch()` counts as one [docs https://developers.cloudflare.com/d1/platform/limits/].

Options: (1) answer only from the D1 library plus the 6 h sweep (today's behaviour; abstains when the Library does not cover it, `self-rag.js`); (2) add an on-demand fetch tool for a small allow-list of hosts inside an answer, at most N subrequests; (3) keep a "deep question" hand-off to a local session (defeats the goal).

Recommendation: 1 first (parity of what `/ask` already does) and measure the abstain rate on real questions; then 2 with a hard cap well under 50 fetches and the existing same-host rules. Atlas JSON ships as a build artefact into D1 or a bundled module. Which questions the local session answers that the Library cannot is not measured: unv, and it is the main product risk of the cutover.

### 2d. Memory move to D1

| Local file (`bot/data/`) | Holds | Existing D1 home | Gap |
|---|---|---|---|
| `state.json` | recent ack lines, card message ids (`signupsCardId`, `partyCardId`), digest day, egg flag | `kv_state` (`schema.sql:10`) | Keys to define; card ids are the critical handover |
| `seen.json` | handled mention ids | `listen_events` (`migrations/0012_listener.sql`, keyed by message id) | none: dedupe already by primary key |
| `feedback.jsonl` | reaction votes | `answer_feedback` (`migrations/0004`, `answer-ux.js:234`) | needs message id to intent id link |
| `noise.jsonl` | unprompted post counts | `noise_ledger` (`migrations/0006`) | seed at cutover |
| `moments.jsonl` | moment ledger | `kv_state` keys `moments_state`, `moments_ledger` (`moments.js:19-21`) | none |
| `signups.json`, `journeys.json` | RSVP and depth per user | `signups_v2` (`schema.sql:378`), `user_state`; journeys not located [unv] | confirm journeys home |
| `keys.json`, `brain-state.json` | personal board key hashes, pull cursor | `account_keys` (`schema.sql:157`); cursor obsolete once the bridge is gone | confirm |
| `party-projection.json` | cached party view | derived from `sheet_events` | none, drop |
| `facts.json`, `library.json`, `quiz.json`, `dates.json`, `events.json`, `ack-lines.json` | built content | `lib_pages` / `lib_blobs`, `scheduled-events` (`discord_events`), persona lines | build step to publish into D1 |
| Group memory (asks, answers, chatter) | what friends said | `group_log`, `group_wiki`, `ask_turns` (`migrations/0011`, `schema.sql:88`) | already live behind `GROUP_MEMORY`; local session memory (outside `bot/data`, e.g. harness memory) is not mapped [unv] |

Recommendation: no bulk migration. Write forward into D1 under flags, and import only card ids, the noise count and the moments ledger at cutover. D1 limits: 500 MB DB on Free (10 GB Paid), 2 MB per row. [docs D1 limits URL above]

### 2e. Read-back check in the Worker

The local bot has no generic read-back (no match in `bot.js` or its modules). The nearest practice is the roster-upsert proof (`docs/runbooks/roster-upsert.md:32`). Proposed design:

- After every Discord write that matters (post, edit, delete, card redraw) the Worker does a GET of the same message and compares: id exists, author is the bot, content/components hash equals what was sent (Discord normalises some text, so compare the fields it echoes, not raw bytes [unv]). One extra subrequest per write; budget it against the 50 subrequest Free cap.
- Result goes to a D1 row (`readback` kind in `noise_ledger` or a small table): ok / mismatch / missing. A non-ok row is surfaced on an admin read endpoint and triggers one retry, never a loop.
- Shadow mode: the same check runs over messages the local bot posted, giving a baseline mismatch rate before the Worker posts anything.
- D1 read-back: after a batch write, SELECT the keys and compare counts, as the roster workflow does.

Flag `READBACK` = off / log / enforce.

### 2f. Council dispositions (Gemini and Codex, 2026-11-18; raw answers in the council run folders, not the repo)

Brief was public-safe with roles only. Each point has a disposition; nothing gateway-dependent is built until the owner accepts this table.

| # | Point (seat) | Disposition |
|---|---|---|
| 1 | DO-held gateway needs Workers Paid (Gemini); Codex says Free fits on paper (10,800 of 13,000 GB-s/day) | Both agree on the arithmetic. Adopt: plan on Paid for headroom, treat Free as possible but fragile (83% used, a second always-on object or restart overlap breaks it). Plan change is on the owner/admin list as a money item. |
| 2 | Gemini: Workers Free blocks outbound WebSocket fetch (self-rated 0.75) | Not accepted as fact: the DO limits page is silent on it. Add a 1-hour spike on the real account before any build (admin to run, or a throwaway worker). |
| 3 | Codex ranks a proven always-on discord.js forwarder first for reliability, DO gateway second pending soak | Accepted as the rollback: keep the PC forwarder until the DO has a clean 7-day soak. The DO is the target because it removes the PC; the forwarder is not removed early. |
| 4 | Persist session_id, resume URL, seq; advance the checkpoint only after durable intake; resume on reconnect, honor opcode 7 and 9 and close codes | Required for slice 1. Add to the slice acceptance tests. |
| 5 | Heartbeat watchdog: jittered first heartbeat, answer server heartbeat requests, close with a non-1000 code on missing ACK, DO alarm as dead-man switch, cron as backstop | Required for slice 1. |
| 6 | IDENTIFY budget (1,000 per 24 h): check Get Gateway Bot remaining before identifying, jittered backoff, shared between PC and Worker | Required for slice 1; one connection generation, stale callbacks ignored. |
| 7 | Dedupe by stable event key across resume replay and REST catch-up (D1 insert-or-ignore) | Required; the existing listener already dedupes by message id [verify at build]. |
| 8 | REST catch-up paginates from per-channel/thread watermarks, honors 429, alerts on unrecoverable gaps | Required (flag CATCHUP_REST); thread watermarks added to the design. |
| 9 | Ping-off replies and Message Content: test whether reply text is available with the intent off | Open test, before the Developer Portal item is requested. Default assumption: intent needed. |
| 10 | Shadow then canary: compare ids, routing, targets, ack/edit timing and blinded answer quality; force restarts and failed resumes; 7 days with zero unexplained misses/duplicates; then actual writes in one channel; fence PC and Worker sends; rehearse rollback | Adopted as the proof plan; the 'who answers a mention today' question is a first step (unverified in section 5). |
| 11 | Both PC and Worker may hold gateway connections at once (Gemini) | Shadow can run alongside; the Worker never posts in shadow. Presence updates are not sent by the Worker. |
| 12 | Interactions-only ranks lowest-risk but misses passive mentions and replies (both) | Kept as a fallback only; cannot meet 'friends notice no difference' if friends tag the bot. |

## 3. Josh / Matt only list

Matt has a read-only role on Cloudflare, so everything that changes the account needs Josh. Developer Portal items need whoever owns the Discord application.

| Item | Needed for | Who |
|---|---|---|
| New Durable Object class binding `GatewayLink` and a migration tag `v2` with `new_sqlite_classes` in `wrangler.toml`; the file is code, but the deploy and any DO enablement on the account is Josh's | Gateway DO | code PR (C), deploy by J |
| Workers plan change to Paid if the account is on Free (money item: the gateway Durable Object needs it; see 2a cost). Not to be changed without the owner's decision | Gateway DO duration headroom | J changes, M/owner decides |
| Confirm Workers plan (Free or Paid) and current cron trigger usage on the account | Cron CPU limit (10 ms Free), trigger slots, DO duration headroom | J reads, M can ask |
| Flag flips in `[vars]` (`GATEWAY`, `MOMENTS_ENABLED`, `CARDS_ENABLED`, `ANSWER_UX`, ...) or Flagship flags | every slice | J (deploy) or the owner per `docs/runbooks/flags.md` |
| Secrets: `DISCORD_BOT_TOKEN` already present (used for listener key derivation, `docs/runbooks/listener.md:21`); no new secret planned. Do not add a second bot token | gateway | J (unchanged) |
| Interactions Endpoint URL set to the Worker route, confirm only | slash parity | P |
| Privileged intents: Message Content only if reply-without-ping mentions must be read; Server Members not needed. Guild Message Reactions and Direct Messages are not privileged | gateway | P |
| Cron trigger additions (none planned; the single minute cron is reused) | timers | J |
| Anything in the Cloudflare dashboard: AI Gateway key, Secrets Store, D1 database id, Pages | unchanged | J |
| Stopping the PC bot, the forwarder and the local session at cutover | cutover | M (host), after a written go/no-go |

## 4. Proposed slice order (most local dependence removed first)

Every slice: flag default off, tests in `tests/unit/` (the repo's flag test `tests/unit/wrangler-flags.test.mjs` must list new vars), shadow proof where the Worker records the answer or action without posting.

| # | Slice | Scope | Flag | Tests | Shadow proof | Removes |
|---|---|---|---|---|---|---|
| 1 | Gateway DO, shadow | `GatewayLink` class: identify, heartbeat, ACK watchdog, resume, reconnect; forwards mention/reply events to `processListenEvent` in dry mode | `GATEWAY=shadow` | unit tests with a fake socket: heartbeat jitter, missed ACK, op 7, op 9 true/false, resume payload, identify counter cap | Run alongside the local bot. For each mention the Worker records decision and would-be answer (existing dry path); compare event ids with local `inbox/` records over 7 days: zero missed, zero extra | the forwarder and the gateway part of `bot.js` |
| 2 | REST catch-up | cron step: scan allowed channels and active threads, idempotent on `listen_events` | `CATCHUP_REST=shadow` | unit tests on selection (port `catchup.js` tests: `test-catchup.mjs`) | ids it would file vs local catch-up log | the 10 min timer |
| 3 | Ack, typing, still-on-it, long answers | ack post plus hourglass, typing loop, alarm for 12 min edit, continuation past 26 s | `GATEWAY_ACK`, `ASK_LONG` | unit tests for edit-into-placeholder; alarm re-arm | would-post/would-edit rows vs local ack and edit times | the outbox reply path and local session latency |
| 4 | Live mentions | `GATEWAY=live` for one test channel, then allowed channels; the PC bot's `mentionsEnabled` set false in the same change window | `GATEWAY=live` | existing listener tests plus reply-thread behaviour | A/B on a test channel only; blind scoring of Worker vs local answers on a fixed question set | the local inbox/outbox and local answerer |
| 5 | Cards and board lines | `CARDS_SHADOW`, then `CARDS_ENABLED`, `BOARD_LINES_ENABLED`; import card message ids and noise count | existing flags | existing card tests; add a state-import test | `noise_ledger` shadow counts vs local edits (`docs/runbooks/cards.md`) | card refresh and board lines in `bot.js` |
| 6 | Moments | schedule import from `EVENTS.md` to D1 key, then `MOMENTS_SHADOW`, then `MOMENTS_ENABLED` | existing flags | schedule validation tests | ledger rows vs `moments.jsonl`, within 60 s | `startMoments` |
| 7 | Reactions, trash, launch stub, forum sync, DM | remaining gateway events | `GATEWAY_REACTIONS`, `GATEWAY_LAUNCH_STUB`, `FORUM_SYNC`, `GATEWAY_DM` | per-event unit tests | would-act rows vs local logs | remaining `discord.on` handlers |
| 8 | Read-back and sign-up jobs, digest, Party card | `READBACK`, `SIGNUP_JOBS`, `DIGEST`, `PARTY_CARD` as needed | as named | unit tests per module | mismatch counter at zero over a week | optional features, local flags currently false |
| 9 | Library parity and cutover | Atlas data into the Worker, source lookups capped (2c), score blind on real questions, then a written go/no-go, then stop the PC bot and the local session | `ATLAS_WORKER` | answer-quality eval set | blind side-by-side, abstain rate vs local | everything else |

Cutover rule: no PC component is switched off until its slice has a clean shadow report and a one-line rollback (flag off, PC side back on). The PC forwarder stays the fallback until slice 4 has run live without a miss.

## 5. What is NOT verified

- Whether the Worker account is on Free or Paid, and whether other Workers use cron slots.
- That an outbound gateway socket in a DO survives for days in practice; the docs describe eviction and billing, not Discord gateways. Timer behaviour of `setInterval` in a DO after eviction is untested.
- Whether the 20:1 WebSocket message billing applies to an outbound client socket.
- Discord interaction token lifetime (15 min) and the behaviour of a reply with ping off against the Message Content rule: not opened or tested this session.
- Whether the Interactions Endpoint URL is set today, and which Developer Portal intents are on now.
- Which process actually answers a mention today (config says mentions on, comments say retired, listener runbook says the old bot is unused).
- Command-list parity between local `commands.js` and the Worker manifest; the Worker's `/sheet` interaction handler; whether the Worker stores the message id with a turn (needed for reaction feedback); where journeys live in D1; whether a Party card renderer or forum scan exists in `worker/` (searched by grep only).
- The quality gap between the local Claude session and `/ask` research mode on real questions.
- Free-host forwarder option (C): not researched.
- No code was run and no Cloudflare or Discord call was made; local config was read only for boolean flag states, which are a snapshot of 2026-11-18.

## 6. Sources opened this session

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://docs.discord.com/developers/events/gateway (redirect target of discord.com/developers/docs/events/gateway)
