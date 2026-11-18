# Claude self-test

Proves in production that the Worker can reach Anthropic with the key it holds, on the compose model and on the fast model, without a friend asking.

## Run

```
node tools/claude-selftest.mjs <path-to-file-holding-the-bot-token> [https://api.leeroy.party]
```

The token file is read and never printed. The script derives the listener signing key from it (same derivation as `docs/runbooks/listener.md`), signs the body with `X-Listen-Timestamp` / `X-Listen-Signature` and prints the answer. Exit code 0 only when `ok` is true.

## What the route does

`POST /api/selftest/claude` (signed like `/api/listen`, 120 s window, body any JSON up to 1 KB).

- No usable bot token in the Worker (or a PR preview): 404, the route does not exist. Bad or missing signature: 401. Over 1 KB: 413. Not JSON: 400.
- A second call inside 60 s: 429 with `retryAfter` (seconds). The limiter row is `kv_state` key `selftest_claude_last`. If it cannot be written: 503 and nothing is sent.
- Otherwise two sends in sequence, each capped at 8 output tokens with the prompt "Reply with the single word ok.": `compose` (the deep primary model, 16 s deadline) then `fast` (the Haiku-class model, 8 s deadline). A failed compose still runs `fast`. No model-not-found fallback send: the primary id itself is what is tested.
- Spend guard: the same reserve and settle as the asks under `claude_tokens_YYYYMM`, plus its own sub-counter `claude_tokens_selftest_YYYYMM` capped at 0.2% of the monthly cap (10,000 tokens at the default), so the self-test cannot eat the ask budget.
- Writes only the limiter row and the counter rows. No `ask_turns` row, no friend data.

## Reading the answer

```
{ "status": 200, "ok": true, "steps": [ { "stage": "compose", "ok": true, "ms": 900, "modelClass": "sonnet", "reason": "ok" }, { "stage": "fast", ... } ] }
```

`modelClass` is `sonnet`, `haiku` or `other` (a configured id that is neither). The model id, model text, key and provider error bodies never appear.

| reason | meaning |
|---|---|
| `ok` | The send succeeded and returned text. |
| `claude:no-key` | No Anthropic credential reachable by the Worker. |
| `claude:http-401` / `claude:http-403` | Key rejected or rotated. Check the secret. |
| `claude:http-400` / `claude:http-404` | The configured model id is not accepted (look at `RESEARCH_CLAUDE_MODEL_DEEP` / `_FAST`). |
| `claude:http-429` | Provider rate limit. |
| `claude:http-5xx` | Provider overload or outage. |
| `claude:timeout@compose-16s` | The compose send hit its 16 s deadline. A `fast` timeout is plain `claude:timeout`. |
| `claude:header` | A header value the runtime refuses (gateway token or key with a bad character). |
| `claude:subrequests` | Workers subrequest limit. |
| `claude:error-<Name>` | Anything else, by error name only. |
| `claude:empty` | The call returned no text. |
| `claude:subcap` | The self-test's own monthly share is spent. |
| `claude:cap` | The monthly token cap is spent (also raises the usual one-per-month alert row). |
| `claude:paused` / `claude:counter-error` | A counter write failed recently; Claude is paused for 10 minutes. |
| `guard:*` | An outbound guard stopped the body (should not happen with the fixed prompt). |

## Cost

A few hundred tokens at most per run (two sends, under 100 input tokens and 8 output tokens each). The reservation is an estimate of about 20 tokens per send, settled to the real usage.

## What it does not prove

- The Discord path: the forwarder, the listener route, posting a reply.
- Member-only context: real names, sheets, group memory, the research prompt size. A 16 s compose deadline on an 8-token reply says little about a 700-token research answer.
- That a key works for large prompts or for the gateway cache path; the asks use the same call code but a different prompt.

The signature is the only gate (there is no flag): anyone holding the bot token can already act as the bot, and a valid call is bounded to two tiny sends per 60 s and a 10,000-token monthly sub-cap. A replay of a captured request after 60 s and inside the 120 s window would run one more self-test and nothing else.
