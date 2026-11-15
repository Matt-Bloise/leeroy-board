# LISTENER: Leeroy listens in Discord

Flag `LISTENER` (`[vars]`, shipped `off`): `off` | `dry` | `live`. Code: `infrastructure/worker/listener.js`, `listener-config.js`; migration `0012_listener.sql`; tests `tests/unit/listener.test.mjs`. Owner decisions (Matt, 2026-11-15): answer when tagged or replied to; untagged chat is read in and answered only when there is a direct answer (a later PR); a short dry run, then live; a mute command is the friends' remote control; the forwarder runs on Matt's PC and starts at logon.

## How it works

A small forwarder process on the PC holds the Discord gateway connection and POSTs one signed JSON event per message to `POST /api/listen`. The Worker does the thinking; the forwarder holds no logic, no model key and no memory.

Event: `{ id, guild_id, channel_id, parent_id? (the parent channel when the message is in a thread), author_id, bot?, kind: 'mention'|'reply'|'chatter', content, ref_text? }`. Headers: `X-Listen-Timestamp` (unix seconds) and `X-Listen-Signature` = hex HMAC-SHA256 of `<timestamp>.<raw body>` with `LISTENER_SECRET`. A timestamp more than 120 seconds off, a wrong signature, a missing or short secret: 401. Body over 12 KB: 413. Bad JSON or event: 400. Flag off, `ASK_RESEARCH` off or a PR preview: 404.

The Worker then:
1. ignores the event unless `guild_id` equals the roster's `guildId` (no `guildId` set: everything is ignored) and the author's Discord id is in `discord_members`. A non-member leaves nothing behind (no row, no text). `listen_events` holds no text and no author: the question and the answer live in the member's own `ask_turns` row, so the member's export and erase already reach them.
2. claims the message in `listen_events` under a salted hash of its id (USER_SALT; a repeated delivery does nothing, and the row cannot be looked up in Discord). No retention purge yet: rows hold only a hash, a channel id, a kind and a decision.
3. `mention` or `reply`: answers through the same research path as `/ask` (paid Claude only, real names, group memory). Dry: the turn is private (`share` 0, filed `ask-private`), nothing is posted, the would-be reply is the answer of that private turn (`listen_events.ask_id` points to its `ask_turns` row). Live: posted as a reply to the message with `allowed_mentions {parse: [], replied_user: false}`; a turn shared in the reply channel only: no copy goes to the #wow-forever webhook, to `stats.recent` or to the site's live broadcast (`noFanout`), unlike a public `/ask`. When Claude cannot answer, the in-voice member line is used (decision `...:fallback`).
4. `chatter`: with `GROUP_MEMORY` on and the channel not quiet, filed as the author's `message` row (`source = 'listener'`). Not answered. A secret-shaped text is never stored.

Every mention, role mention, `@everyone` and channel link is stripped from the content on the way in. No log line carries message text.

## /quiet

Registered only while `LISTENER` is not `off`. A roster member runs `/quiet state:on` in a channel: Leeroy stops reading and commenting there (chatter is neither stored nor answered). A thread counts as quiet when its parent channel is. Tagging him or replying to him still gets an answer, because that is a direct request. Chat stored before `/quiet on` stays in memory (the reply says so). If the quiet lookup itself fails, the channel counts as quiet. `/quiet state:off` lets him back. State lives in `listen_quiet`.

## Setup

1. Apply migration 0012 (the deploy does it).
2. Set the secret: `wrangler secret put LISTENER_SECRET` (any 32+ random characters; the same value goes into the forwarder's environment on the PC).
3. Set `LISTENER = "dry"` in `wrangler.toml` and deploy. Let it run for about a day.
4. Read the dry run in the D1 console:
   ```sql
   SELECT e.at, e.kind, e.decision, substr(t.question, 1, 100) AS q, substr(t.answer, 1, 160) AS would_say FROM listen_events e LEFT JOIN ask_turns t ON t.id = e.ask_id ORDER BY e.at DESC LIMIT 30;
   SELECT decision, count(*) FROM listen_events GROUP BY decision;
   ```
5. Happy: set `LISTENER = "live"` and deploy.

Chatter only arrives once the Discord Message Content intent is on (Developer Portal, Bot, Privileged Gateway Intents) and the forwarder asks for it. Without it Discord sends empty content for untagged messages; mentions and replies to the bot still carry their text.

## Rollback

Set `LISTENER = "off"` and deploy: the route is a 404 and nothing runs. Stopping the forwarder on the PC also stops all traffic. Stored rows stay; to drop them: `DROP TABLE IF EXISTS listen_events; DROP TABLE IF EXISTS listen_quiet;` and remove the filed chatter with `DELETE FROM group_log WHERE source = 'listener'`.

## The forwarder

Not part of this repository's Worker: it lives in the `leeroy-ops` repository (its own small process, one start script, started at logon by the PC's logon start). The old PC bot is not used.

## What is not verified

No live Discord gateway event, no live Claude call and no real HMAC from the PC forwarder has run against this code; the tests use stubs and an in-memory D1.
