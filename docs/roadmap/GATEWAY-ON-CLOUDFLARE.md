# Receiving Discord @mentions and replies on Cloudflare, with no PC

Status: **research only. This document is the whole deliverable; no code is added.** An earlier draft of this PR carried a prototype (`GatewayDO`, a `GATEWAY` binding and a `v2` migration, tests). It was removed on review: the duration billing, eviction and MESSAGE_CONTENT questions below must be settled on paper and by a soak test first. The prototype is not part of this change; it survives only in this PR's history at commit `5b2ab2f` and is **not for merge**.

## Verdict: alternative now, conditional go later

1. **Now: Interactions-only.** Keep `/ask` and the context-menu command "Ask Leeroy" (both already live on the Worker) as the way to ask. They need no Gateway, no always-on object and no privileged intent. Plain @mentions and replies are given up once the PC bot is retired.
2. **Later, only if wanted: a Gateway Durable Object**, gated on the 24-hour soak test below passing. The arithmetic says it fits the free plan, but with thin margin and unverified assumptions, and a miss fails other Worker operations. That is not a risk to take on a guess.

## How far to trust the numbers (read first)

`developers.cloudflare.com` and `discord.com` did not resolve from the sandbox that produced this. I could not fetch either primary source. On **2026-11-02** I used web-search summaries of the Cloudflare pages (marked **[search]**) and my recollection of the Discord docs (marked **[recall]**). Every claim below needs checking against the live page, and the access date should be re-stamped by whoever does that.

Cloudflare (access date 2026-11-02, via search summary, page not fetched):
- Pricing and duration: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Lifecycle and hibernation: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- WebSockets / Hibernation API: https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets-api/
- Alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- workerd issue (hibernation only for incoming sockets): https://github.com/cloudflare/workerd/issues/4864

Discord (recall, not fetched):
- Gateway: https://discord.com/developers/docs/events/gateway
- Intents and the message content intent: https://discord.com/developers/docs/events/gateway#message-content-intent
- Privileged intent verification: https://support-dev.discord.com/hc/en-us/articles/6207308062871 (confirm the current URL)

## Free-plan duration math

| Item | Number | Source |
|---|---|---|
| Free Durable Objects duration allowance | 13,000 GB-s per day | [search] pricing page |
| Free requests | 100,000 per day, shared with the whole Worker | [search] |
| Billed memory | fixed 128 MB (0.125 GB), regardless of use | [search] |
| A DO kept awake 24 h | 0.125 x 86,400 = **10,800 GB-s/day = 83%** of the allowance | arithmetic |
| Headroom | 2,200 GB-s/day, for everything else including `BoardRoom` | arithmetic |
| Free-plan DOs | SQLite-backed only | [search] |
| Over the free limit | further operations of that type fail until reset | [search] |
| Paid fallback | $5 Workers Paid; ~324,000 GB-s/month used against 400,000 included, so about $5 total | [search] |

**Does an outbound WebSocket prevent hibernation? Yes.** [search] Only sockets the DO accepts (`ctx.acceptWebSocket`) hibernate; one it opens itself to Discord does not, and the lifecycle page says outbound connections keep the object in memory and incur duration charges. A pending timer (the heartbeat) blocks hibernation too. So the object is billed continuously and the 83% figure is the real cost, not a worst case.

**Requests.** An alarm each minute is 1,440 a day and heartbeat ACKs about 2,100 a day. Whether inbound messages on an outbound socket count as requests, and at what ratio, is **unverified**. The big unknown is message volume: with the GUILD_MESSAGES intent Discord sends every message in every visible channel, with no server-side filter.

**CPU.** Free Workers get 10 ms CPU per request [search]. Whether each socket event on a free-plan DO gets a fresh budget is **unverified**. The ask path (library ranking) already runs under that limit on the Interactions side.

## Deploys and eviction

A deploy or eviction replaces the instance: memory and the open Discord socket are lost and the constructor runs again. Storage and any scheduled alarm survive. The design to settle on paper:
- Store `session_id`, `resume_gateway_url` and the last sequence in DO storage (persist about once per heartbeat, ~41 s).
- A one-minute alarm notices there is no socket and reconnects with RESUME (op 6: token, session_id, seq) to `resume_gateway_url`. Discord replays missed events [recall], so the gap is bounded by the alarm interval plus backoff, provided Discord still holds the session (a few minutes [recall]).
- If the session is gone, INVALID_SESSION (not resumable) leads to a fresh IDENTIFY after 1 to 5 s. Cap IDENTIFY below Discord's 1,000 per 24 h (use 900) with exponential backoff, so a crash loop cannot burn the day's budget.
- A resume can replay up to one heartbeat interval of events, so message ids already handled must be stored and skipped, and a per-user cooldown (default 20 s) stored at once, or a user gets two answers.
- Fatal close codes (4004 auth failed, 4013 invalid intents, 4014 disallowed intents) must stop the retry loop, not spin.
- Gateway facts used: heartbeat first at `interval x random(0..1)` then every interval, missed ACK means a zombied socket (close with a non-1000/1001 code and resume), 120 events per 60 s per connection. All [recall].

## The MESSAGE_CONTENT privileged-intent gate

[recall; confirm against the portal and the verification article above]
- `MESSAGE_CONTENT` (1<<15) is privileged. Without it, message content arrives empty except when the message mentions the bot, is a DM, or is the bot's own. A plain reply to the bot's message, with no ping, would arrive empty.
- **Under 100 servers:** the owner turns it on with a toggle in the Developer Portal (Bot tab). No review. The Leeroy bot lives in one guild, so this is the case that applies.
- **100 or more servers:** the bot must be verified, and Discord must approve MESSAGE_CONTENT through the verification and privileged-intent application, with a stated use case. Without approval the Gateway closes with 4014 "disallowed intents". For a private party bot this is out of scope, but it is the gate if the bot is ever made public or run by tenants, and it is not something a feature flag can fix. Nothing in the product should depend on it silently.
- Mentions-only would work without the intent. Replies without a ping would not, so "reply to the bot" support depends on the intent.

## The alternative: Interactions-only UX

Already live: `/ask` and the "Ask Leeroy" message context-menu command, answered by the Worker over HTTP Interactions. Properties: no Gateway, no always-on object, no privileged intent, no duration cost, deploys and evictions are irrelevant, signed requests, works on the free plan today. Costs: the user must use a slash command or right-click a message instead of just @mentioning; no thread-style "reply to continue" flow. Cheapest mitigations: put a pinned message and the `/ask` hint in the channel, and keep the context-menu command prominent. This is the recommendation until a soak test says otherwise.

## 24-hour soak test plan (to run later, not now)

Goal: measure, on the real free plan, whether holding the Gateway is affordable and survivable.
1. **Prereqs:** verify every claim above against the live docs and re-stamp the access dates; confirm the guild is under 100 servers; turn on MESSAGE_CONTENT in the portal; use a throwaway test guild and a separate bot application first, never the production token. Decide an allow-list of one test channel.
2. **Instrument:** a status endpoint (admin token only) reporting connection state, last heartbeat ack, reconnect count, identifies today, and the last 20 event types (never content or the token).
3. **Run 24 h** with the flag on in a preview or staging Worker, not production. During the run: trigger two deploys and, if possible, one forced restart; send mentions and replies on a schedule from a test account; leave the channel idle for several hours.
4. **Read the Cloudflare dashboard** for Durable Objects duration and requests each hour.
5. **Pass criteria:** duration at or below 11,000 GB-s for the day (about 85%); total requests under 50% of the free limit; every deploy recovers within 90 s with RESUME (not IDENTIFY) when the session was alive; no duplicate answers across a resume; zero fatal-loop or IDENTIFY storms (under 20 IDENTIFYs); the rest of the Worker (health, `/ask`, live board) unaffected throughout.
6. **Fail criteria:** any day over 13,000 GB-s or any free-plan operation failing; recovery over 5 min; duplicates; or message volume making requests the binding constraint. On fail, stay on Interactions-only, or price the $5 Workers Paid plan.
7. **Record** the measured numbers back in this document with dates, then decide go or no-go.

## Failure modes to design against

| Failure | Needed behavior |
|---|---|
| Deploy or eviction | Alarm reconnect within ~1 min; RESUME if alive, else IDENTIFY. |
| Zombie socket | No ACK by next beat: close and resume. |
| Token wrong or intent not enabled (4004, 4013, 4014) | Stop, report, do not loop. |
| Crash loop | Backoff; IDENTIFY cap. |
| Free allowance exhausted | Cloudflare fails operations until reset, possibly the whole Worker; a kill switch (flag off) must be tested. |
| Replay after resume | Handled-id list and cooldown. |
| Bot token exposure | Read only from the existing secret binding; never logged, stored or returned. |

## What the owner or Josh would do if the soak test passes

1. Verify the sources and run the soak test above; record results here.
2. Enable the MESSAGE_CONTENT intent in the Discord Developer Portal (Bot tab).
3. Create the channel allow-list in D1 (`kv_state`, key `gateway_channels`, an array of channel ids; no ids in the repo) and confirm the roster guild id is set.
4. Implement behind a default-off flag in a separate, reviewed PR, from commit `5b2ab2f` as a starting point if useful.
5. Turn the flag on, watch a full day, then retire the PC bot.

Rollback for the eventual feature: set the flag off; the object closes within a minute.
