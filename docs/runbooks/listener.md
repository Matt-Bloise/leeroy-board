# LISTENER: Leeroy listens in Discord

Flag `LISTENER` (`[vars]`, shipped `off`): `off` | `dry` | `live`. Code: `infrastructure/worker/listener.js`, `listener-config.js`, `listener-untagged.js` (part B); migration `0012_listener.sql`; tests `tests/unit/listener.test.mjs`, `tests/unit/listener-b.test.mjs`. Owner decisions (Matt, 2026-11-15): answer when tagged or replied to; untagged chat is read in and answered only when there is a direct answer (part B, flag `LISTENER_UNTAGGED`, below); a short dry run, then live; a mute command is the friends' remote control; the forwarder runs on Matt's PC and starts at logon.

## How it works

A small forwarder process on the PC holds the Discord gateway connection and POSTs one signed JSON event per message to `POST /api/listen`. The Worker does the thinking; the forwarder holds no logic, no model key and no memory.

Event: `{ id, guild_id, channel_id, parent_id? (the parent channel when the message is in a thread), author_id, bot?, kind: 'mention'|'reply'|'chatter', content, ref_text? }`. Headers: `X-Listen-Timestamp` and `X-Listen-Signature`, specified exactly in "The signing key" below. A timestamp more than 120 seconds off or a wrong signature: 401. Body over 12 KB: 413. Bad JSON or event: 400. Flag off, `ASK_RESEARCH` off, a PR preview, or no usable `DISCORD_BOT_TOKEN`: 404 (the route does not exist).

The Worker then:
1. ignores the event unless `guild_id` equals the roster's `guildId` (no `guildId` set: everything is ignored) and the author's Discord id is in `discord_members`. A non-member leaves nothing behind (no row, no text). `listen_events` holds no text and no author: the question and the answer live in the member's own `ask_turns` row, so the member's export and erase already reach them.
2. claims the message in `listen_events` under a salted hash of its id (USER_SALT; a repeated delivery does nothing, and the row cannot be looked up in Discord). No retention purge yet: rows hold only a hash, a channel id, a kind and a decision.
3. `mention` or `reply`: answers through the same research path as `/ask` (paid Claude only, real names, group memory). Dry: the turn is private (`share` 0, filed `ask-private`), nothing is posted, the would-be reply is the answer of that private turn (`listen_events.ask_id` points to its `ask_turns` row). Live: posted as a reply to the message with `allowed_mentions {parse: [], replied_user: false}`; a turn shared in the reply channel only: no copy goes to the #wow-forever webhook, to `stats.recent` or to the site's live broadcast (`noFanout`), unlike a public `/ask`. When Claude cannot answer, the in-voice member line is used (decision `...:fallback`).
4. `chatter`: with `GROUP_MEMORY` on and the channel not quiet, filed as the author's `message` row (`source = 'listener'`). Not answered. A secret-shaped text is never stored.

Every mention, role mention, `@everyone` and channel link is stripped from the content on the way in. No log line carries message text.

## The signing key

There is no separately provisioned secret. The shared key is derived from the bot token that the Worker (secret `DISCORD_BOT_TOKEN`) and the PC forwarder (it holds the gateway connection) already have. Exact specification, for the forwarder:

1. `key` = HMAC-SHA256 with the bot token as the HMAC key and the 18-byte ASCII message `leeroy-listener-v1` (token and message both taken as UTF-8 bytes). `key` is the **32 raw bytes** of the digest. Do not hex-encode it: the next step uses the bytes themselves.
2. `signature` = HMAC-SHA256 with those 32 raw bytes as the HMAC key and the UTF-8 bytes of `<timestamp>.<raw request body>` as the message, written as **64 lowercase hex characters** (the Worker also accepts upper case).
3. Headers: `X-Listen-Timestamp` is the send time as unix seconds, a base-10 integer string such as `1800000000`; `X-Listen-Signature` is the hex signature. The `<timestamp>` in the message is that exact header string, and `<raw request body>` is the exact bytes sent (sign the string you send; never re-serialise).
4. The Worker derives `key` from `env.DISCORD_BOT_TOKEN` on each request (cached per isolate while the token is unchanged), compares the signature in constant time, accepts a timestamp within 120 seconds either side, and refuses a body over 12 KB. Exported helper: `listenerKey(botToken)` in `listener-config.js`, returning the 32 bytes (or `null` for a missing token or one shorter than 16 characters); `signListen(key, timestamp, rawBody)` returns the hex signature.
5. Missing or short bot token: the route is a 404, as with `LISTENER` off. Rotating the bot token rotates the key: the forwarder re-derives it from the new token; until both sides hold the new token every event is a 401.

Test vector (a clearly fake token; the unit test `tests/unit/listener-b.test.mjs` recomputes every value here with an independent WebCrypto call and fails if this paragraph and the code drift):

- vector token = `listener-test-vector-token`
- vector key = `bb1e0a8601ee4998d2d25df52e49d3c899ab8f01a569b285d828659c802844e4`
- vector timestamp = `1800000000`
- vector body = `{"id":"1"}`
- vector signature = `d87fe7beb9f13e1ddd2388a14d77ec34b241c733839f714193c095172448b3bb`

Node reference for the forwarder:

```js
const key = crypto.createHmac("sha256", token).update("leeroy-listener-v1").digest(); // 32-byte Buffer
const signature = crypto.createHmac("sha256", key).update(timestamp + "." + body).digest("hex");
```

A leaked bot token also lets the holder forge events; that token is already the more dangerous secret, so no second one adds protection.

## Untagged text (part B, flag `LISTENER_UNTAGGED`)

Shipped `off` (`[vars]`, only the exact value `on` enables it, and only while `LISTENER` is `dry` or `live`). Off: a `chatter` event is handled exactly as described in step 4 above. On, for a `chatter` event from a roster member in the roster guild (anyone else was already dropped, so no text of theirs is read, classified or stored), in a channel that is not quiet:

1. **Rules, no model.** Empty text, text under 12 characters and commands (`/x`, `!x`, `.xx`) are ignored. Personal-life topics (health, family, work, where someone lives, money, schedule outside the game) are ignored: never classified, never stored by this path. Text with no question mark and no question opener is "obvious chatter": it goes straight to the wiki step without a model. Anything else with a question is a candidate. (Bot authors never get this far: the event parser refuses them.)
2. **Classifier, candidates only.** One Haiku-class call on the paid Anthropic API through the same capped path the group-wiki refresher uses (`research/claude.js claudeCappedCall`; no Workers AI, no Gemini, no other provider). It sees one fenced message and nothing else: no author, no channel, no other message. It needs `RESEARCH_NAMES` real, like the wiki refresher. It spends from its own counter `claude_tokens_listen_YYYYMM`, a tenth of the monthly cap, inside the same monthly cap. It returns `{decision: answer|wiki_only|ignore, reason, confidence}`; any error, timeout, spent cap, secret-shaped text or unreadable reply is `ignore`, and a `personal` reason is always `ignore`.
3. **Decision.** `answer` only when the classifier says a direct, checkable answer exists AND `confidence >= UNTAGGED_MIN_CONFIDENCE` (0.8) AND fewer than `UNTAGGED_DAILY_CAP` (3) unprompted answers (posted, or would-be in a dry run) happened in this channel in the last 24 hours, counted from `listen_events`. Otherwise it becomes `wiki_only`. This cap is a soft personality limit, not moderation. Constants are in `worker/listener-untagged.js`.
4. **Dry vs live.** Dry: the would-be decision is written to `listen_events.decision` only (`u:answer-dry:<reason>`): no text, no author, no turn, no post. Live: the answer goes through the same path as a mention (paid Claude, real names, group memory, a reply with every ping off), decision `u:posted`; there is no in-voice filler line for an unprompted answer, so when Claude cannot answer nothing is posted (`u:no-answer`).
5. **Wiki feed.** `wiki_only` text (and rule-level "no question" chatter) is filed through the group-memory appender as the author's `message` row (`source = 'listener'`) when `GROUP_MEMORY` is on, exactly as part A files chatter: private D1, the secret screen, the roster slug check, names handled as the group memory already does. No new table, no new retention. `ignore` text is not stored. With `GROUP_MEMORY` off nothing is stored (`u:memory-off`).

`listen_events.decision` codes with the flag on: `u:ignore:<empty|short|command|personal|social|vague|...>`, `u:wiki:<no-question|planning|lowconf|cap|...>`, `u:memory-off`, `u:not-stored`, `u:answer-dry:<reason>`, `u:posted`, `u:post-failed:<status>`, `u:no-answer`, `u:no-token`. Reading a dry run:

```sql
SELECT decision, count(*) FROM listen_events WHERE decision LIKE 'u:%' GROUP BY decision ORDER BY 2 DESC;
SELECT substr(at, 1, 10) AS day, channel, count(*) FROM listen_events WHERE decision LIKE 'u:answer-dry%' GROUP BY 1, 2;
```

Turning it on is the owner's decision and is not part of this change: it also needs the Discord Message Content intent switched on in the Developer Portal and the forwarder asking for it (untagged messages arrive empty without it, and an empty text is ignored). `docs/privacy.md` says the listening is off until announced; update that paragraph when it goes on.

## /quiet

Registered only while `LISTENER` is not `off`. A roster member runs `/quiet state:on` in a channel: Leeroy stops reading and commenting there (chatter is neither stored nor answered). A thread counts as quiet when its parent channel is. Tagging him or replying to him still gets an answer, because that is a direct request. Chat stored before `/quiet on` stays in memory (the reply says so). If the quiet lookup itself fails, the channel counts as quiet. `/quiet state:off` lets him back. State lives in `listen_quiet`.

## Setup

1. Apply migration 0012 (the deploy does it).
2. Nothing to provision: the signing key comes from `DISCORD_BOT_TOKEN` (already a Worker secret). The forwarder derives it from the same token ("The signing key" above).
3. Set `LISTENER = "dry"` in `wrangler.toml` and deploy. Let it run for about a day.
4. Read the dry run in the D1 console:
   ```sql
   SELECT e.at, e.kind, e.decision, substr(t.question, 1, 100) AS q, substr(t.answer, 1, 160) AS would_say FROM listen_events e LEFT JOIN ask_turns t ON t.id = e.ask_id ORDER BY e.at DESC LIMIT 30;
   SELECT decision, count(*) FROM listen_events GROUP BY decision;
   ```
5. Happy: set `LISTENER = "live"` and deploy.

Chatter (and the untagged classifier) only gets text once the Discord Message Content intent is on (Developer Portal, Bot, Privileged Gateway Intents) and the forwarder asks for it. Without it Discord sends empty content for untagged messages; mentions and replies to the bot still carry their text.

## Rollback

Set `LISTENER = "off"` and deploy: the route is a 404 and nothing runs. Stopping the forwarder on the PC also stops all traffic. Stored rows stay; to drop them: `DROP TABLE IF EXISTS listen_events; DROP TABLE IF EXISTS listen_quiet;` and remove the filed chatter with `DELETE FROM group_log WHERE source = 'listener'`.

## The forwarder

Not part of this repository's Worker: it lives in the `leeroy-ops` repository (its own small process, one start script, started at logon by the PC's logon start). The old PC bot is not used.

## What is not verified

No live Discord gateway event, no live Claude call (neither the classifier nor the answer) and no real HMAC from the PC forwarder has run against this code; the tests use stubs and an in-memory D1. The classifier's prompt and its JSON contract have never met the real model: read a dry run before trusting `answer`. The personal-life rule is a keyword list and will miss paraphrases (non-question chatter is never shown to a model, so only the rules protect it).
