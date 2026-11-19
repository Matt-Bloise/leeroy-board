# Shadow ask: compare the Worker's /ask answer with the local bot's, on a real question

A shadow call runs one question through the same compose path an `/ask` turn from a roster member runs, and records what the Worker would have answered. Nothing is posted anywhere. It is the proof method for the `/ask` rows of `docs/parity/worker-parity-gap-table.md`: full-size compose latency and answer quality on a real question, next to the local answer for the same question.

## Run

```
node tools/shadow-ask.mjs <path-to-file-holding-the-bot-token> --question "who tanks tonight" --as <roster-slug> [--local-answer-file <file>] [--base https://api.leeroy.party]
```

- The token file is read and never printed. The script derives the shadow signing key from it (below), signs the body with `X-Listen-Timestamp` / `X-Listen-Signature` and prints the JSON plus one timing line. Exit 0 only when the call came back `status: answered`.
- The question is `--question`, or stdin when that is absent. At most `MAX_QUESTION_CHARS` (2000) characters.
- `--as` is a roster slug (`discord_members`). The run then uses that member's real name, build and group memory exactly as that member's own `/ask` would. Without it the run has a placeholder name, no build and no member group memory, and the row's `asker_slug` is NULL. An unknown slug is refused (400).
- `--local-answer-file` stores the local bot's answer beside the Worker's. It is sent whole: the Worker scans all of it for secrets (a secret anywhere in it drops the local answer, so one that straddles the cut cannot survive as a prefix) and then keeps the first 1500 characters. A body over 4 KB is refused by the script before sending.
- The base URL must be https (http only for localhost or 127.0.0.1), no credentials in it; anything else exits 2 without sending. Redirects are refused (`redirect: "error"`): the signed body is never replayed to another host, and a 3xx answer is a failed request (exit 1). Output carries `http_status` (the HTTP code) next to the Worker's own `status`.

## The signing key

The shadow route has its own key, separate from the listener key the PC forwarder holds: `key = HMAC-SHA256(key = the bot token as UTF-8 bytes, message = "leeroy-shadow-v1")`, 32 raw bytes (`shadowKey` in `listener-config.js`). The signature and headers are the listener's (`HMAC-SHA256(key, "<timestamp>.<raw body>")` in lower-case hex, `X-Listen-Timestamp`, `X-Listen-Signature`). A signature made with the listener key never verifies on this route, and a shadow-key signature is refused by `/api/listen` and the self-test (tests cover both directions).

The shadow key can read answers as any roster member (build and group memory included). Derive it only on the owner's machine: `tools/shadow-ask.mjs` is the only place it is derived outside the Worker. Do not copy it to the PC forwarder or put the token file anywhere the forwarder can read it.

## The route

`POST /api/shadow/ask`, flag `SHADOW_ASK` (a `[vars]` flag, shipped `off`).

Gate, in order:

1. Flag not exactly `on` (any case, trimmed), a PR preview, or no usable bot token: 404, nothing read or written.
2. Signature (the listener's HMAC, 120 s window): missing or wrong 401. Body over 4 KB: 413.
3. `ASK_RESEARCH` off: 409 (the research path is what is compared).
4. The body must be exactly the known keys with `"purpose":"shadow-ask"`: `question` (required), `as`, `channel` (a Discord channel id, so group memory reads that channel as an ask there would), `private` (true runs the member's private path), `local_answer`. Anything else, including a validly signed `/api/listen` event or self-test body, is 400 before any spend. A question that holds a secret-shaped value is refused (400) and never stored.
5. A signature already accepted: 409. The SHA-256 of the lower-cased signature (never the signature) is kept in the limiter row from acceptance until its verifier expiry (its timestamp plus 120 s), pruned by expiry only. Only accepted calls are recorded: rejected (400) and rate-limited (429) requests never enter or evict the cache, however many arrive. At most `SHADOW_ASK_DAILY` (20 by default) accepted calls a day exist, so the list stays small.
6. Rate limit: 6 an hour and 20 a day by default (`SHADOW_ASK_LIMITS`, see "Limits" below): 429 with `Retry-After`. The limiter row is `kv_state` key `shadow_ask_rate`; if it cannot be written: 503 and nothing runs. Refused calls (401, 400, 409) do not use up the allowance.

Then `answerWithAi` runs with a record-only sink (the `sink` parameter; every other caller passes none and is unchanged, which `tests/unit/shadow-ask.test.mjs` proves with a differential trace recorded on master before the sink existed). With the sink: no Discord message, no interaction followup, no webhook, no socket message, no card, no stats entry, no group-memory write, no `answer_details`, no `ask_turns` row. The only writes are the row in `shadow_answers` (migration `0014_shadow_answers.sql`, also in `schema.sql`), the limiter row and the Claude spend counters. The table is private: no route reads it back; the signed caller gets the answer in the response of the call itself, and the admin export (`GET /api/admin/export`) can read it.

## What the response says

```
{ "http_status": 200, "id": "...", "ok": true, "status": "answered", "model": "claude:claude-sonnet-5-5+research", "latency_ms": 9400, "reason": "ok", "answer": "..." }
```

- `model` is the label an `ask_turns` row would carry: `provider:model`, `+research`, a `[reason]` when Claude did not answer, `+degraded` when the in-voice fallback line or library facts were used instead.
- `latency_ms` is the compose time inside the Worker, from the start of the answer path (same clock as the ask's own `latency_ms`). The ask's deadline is 26 s and its hard end 22 s (`hardEndMs`): the script's timing line says whether the run finished under 22 s.
- The answer text is only in the response because the caller holds the key. It passed the ask path's outbound protections (secrets, hex tokens, long ids are masked or the reply is dropped) and then the shadow's own last scan, which withholds a secret-shaped answer whole. What the table stores is what the caller is shown.

| status | meaning |
|---|---|
| `answered` | Claude answered; `ok` is true. |
| `degraded` | Claude did not answer; the row holds the in-voice line or library facts a friend would have got. `reason` says why. |
| `error` | The answer path failed (`ask:error`) or the last scan withheld the text (`guard:outbound`). |
| `refused` | A budget verdict refused the ask (not reachable for a roster member while `ASK_RESEARCH` is on). |
| `store-failed` (HTTP 500) | The compose ran, the row could not be written; the answer is in the response, there is no row. |

Reason codes (a fixed vocabulary; anything else is `other`):

| reason | meaning |
|---|---|
| `ok` (NULL in the table) | answered |
| `claude:subcap` | the shadow's own share (2% of the monthly cap, counter `claude_tokens_shadow_YYYYMM`) is spent for the month. No send. |
| `claude:cap` | the monthly cap is spent (also raises the usual one-per-month alert row). No send. |
| `claude:no-key` / `claude:paused` / `claude:counter-error` | no key, or a counter write failed recently and Claude is paused for 10 minutes. |
| `claude:http-NNN` | the provider answered with that status (401/403 key, 400/404 model id, 429 rate limit, 5xx overload). |
| `claude:timeout@compose-Ns` | the compose send hit its deadline after N seconds; the Haiku-class retry follows when time allows. |
| `claude:no-time` | under 2.5 s of the ask deadline was left for the Claude hop. |
| `claude:reply-flagged@<kind>` (kind: `empty`, `env-secret`, `hex-token`, a named secret pattern, or `name`; the bare `claude:reply-flagged` is the older form) | the reply held a secret or a name the guard refuses and was dropped. |
| `guard:secret` / `guard:host` / `guard:config` / `cpu:budget` | an outbound guard or the prompt-size guard stopped the send. |
| `guard:outbound` | the answer was withheld whole by the shadow's last outbound scan. |
| `ask:error` | the answer path threw. |

## Spend

Same guard as an ask: the monthly counter `claude_tokens_YYYYMM` against `RESEARCH_CLAUDE_MONTHLY_TOKENS`, plus the shadow's own sub-counter capped at `SHADOW_ASK_SUBCAP_PERCENT` (default 2) percent of that cap (100,000 tokens at the default 5,000,000: roughly 25 full-size composes a month, so at the defaults the 20-a-day ceiling is a bound, not a target). A reservation the monthly cap refuses is given back to the sub-counter; the counters settle on real usage.

## Limits (Worker vars)

The limits are ONE Worker var, `SHADOW_ASK_LIMITS = "hourly/daily/percent"`, in `infrastructure/wrangler.toml` (absent = the defaults 6/20/2). One variable because the Workers Free plan allows 64 variables in all; see `tests/unit/var-budget.test.mjs`. Each part is parsed and clamped on its own.

| Part of `SHADOW_ASK_LIMITS` | Default | Range | Effect |
|---|---|---|---|
| part 1 (hourly) | `6` | integer 1 to 120 | accepted calls in any rolling hour; the next is 429 |
| part 2 (daily) | `20` | integer 1 to 600 | accepted calls in any rolling day; raised to the hourly value if set below it |
| part 3 (percent) | `2` | number 0.1 to 60 | the shadow counter's share of `RESEARCH_CLAUDE_MONTHLY_TOKENS`, in percent |

Unset, empty, non-numeric, `NaN`, `Infinity`, zero, negative or exponent-form values use the default, never unlimited. A positive value outside the range is clamped to the nearest edge. Raising them in production is a separate `wrangler.toml` change and deploy; the monthly cap still binds, and a shadow reservation past the sub-cap ends as `claude:subcap`.

Worked cost line (Sonnet 5.5, estimate, not measured here): a full compose is about 3 to 4k tokens in plus out, so 200 composes is about 0.8M tokens. At the default 2% sub-cap (100,000 tokens) that is about 25 composes a month, so a 60 to 200 compose baseline needs the percent raised: 0.8M of a 5,000,000 cap is 16%, so `SHADOW_ASK_SUBCAP_PERCENT = "16"` or more (20 is the maximum), and `SHADOW_ASK_DAILY` and `SHADOW_ASK_HOURLY` raised to match the pace wanted. The shadow tokens also count against the monthly cap, so the real asks have the remaining 4.2M.

## What it proves

- Full-size compose latency of the real path (research prompt with real names, build, group memory, the Sonnet-class compose model, the same deadline) on a real question, not a stub prompt.
- The answer the Worker would have given, side by side with the local one (`local_answer` in the row) for a parity read of quality.
- Which reason code a failure would carry, from the same code that writes real rows.

## What it does not prove

- Delivery: the Discord side (deferred reply, followup, posting, buttons, reactions) is not exercised.
- Concurrency and load: calls are limited to 6 an hour by default.
- Group memory writes, the stats feed, answer reuse and the budget wall are skipped on purpose (they are writes); only the group-memory read is exercised.
- Anything about a friend who is not on the roster (a guest never reaches Claude).
- A run without `--as` has no build and no member group memory: use `--as` for a parity read.

## Turning it on

This change ships the flag `off`. Turning it on is a one-line change, `SHADOW_ASK = "on"` in `infrastructure/wrangler.toml` `[vars]`, through a PR by the owner or an admin (merging deploys it). It needs `ASK_RESEARCH` on and `DISCORD_BOT_TOKEN` set, and is never active in a PR preview. Turning it off again is the same change back; the table can stay. Rollback of the schema: `DROP TABLE IF EXISTS shadow_answers;` (nothing else reads it).

## Privacy

`shadow_answers` holds a mirrored question and answers, so it is as private as `ask_turns` and `group_log`: private D1 only, never exported to a page, never on the socket. `asker_slug` is its only link to a person; a member's erase deletes their rows by it (`DATA_MAP`, `data-rights.js`); the erase checks that the table exists first, so a deploy that runs before migration 0014 does not break erase. The rows are the owner's own test data and are not in the member export.
