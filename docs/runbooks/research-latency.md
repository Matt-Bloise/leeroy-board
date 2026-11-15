# Research latency and CPU gate (ASK_RESEARCH, PR 329 conditions)

Two of the pre-flag-on conditions for `ASK_RESEARCH` need a live key and a deployed Worker: real Worker CPU of the research path, and real latency of the Claude calls. This runbook is the exact procedure. Nothing here changes Worker code or a flag.

Tools (both in `tools/`, both print numbers only: no key, header, prompt, reply, question or name):

| Tool | Measures | Needs |
|---|---|---|
| `tools/measure-research-cpu.mjs` | Node CPU of prompt build, tokenise, strict and cheap guards, reply clean, label/lint over a fictional corpus (100 iterations) | nothing |
| `tools/measure-claude-latency.mjs` | Latency, time to first byte, token counts and share over the timeout for a Sonnet-class compose and a Haiku-class retry | a key in the environment, or `--dry-run` |

## Pass / fail thresholds

| Check | Pass | Authority |
|---|---|---|
| Worker CPU per research ask, median | under 10 ms | Workers observability, preview deploy (Workers Free limit is 10 ms CPU per request) |
| Worker CPU per research ask, p95 | under 10 ms | same |
| Sonnet-class compose, non-streaming, `max_tokens` 700, prompt of a few thousand tokens, p95 | under 5 s | `measure-claude-latency.mjs` live run, against the 6 s timeout |
| Haiku-class retry, same body, p95 | under 2.5 s | same, against the 3 s timeout |
| Failures | any non-200 or hard-cap call counts as over the limit; a phase with no successful call fails | same |

The Node CPU number is a **proxy only**. It runs on a different engine build and clock than workerd, and workerd freezes timers during pure compute. The authoritative CPU number is the Workers observability CPU time of a deployed Worker. A pass from the Node tool never satisfies the condition; a fail is a real warning.

The numbers 6 s and 3 s are the intended timeouts. Check the current constants before reading a result: at the time of writing `research/claude.js` has one 9 s budget (`CLAUDE_TIMEOUT_MS`), a 2.5 s minimum for the retry (`RETRY_MIN_MS`) and an 8 ms privacy budget (`privacyBudget.ms`). The gates above are set under the 6 s and 3 s targets, so they hold for either.

## Who runs it

- The latency run: whoever holds the Anthropic credential (Matt), from his own machine, with the credential in the environment of that one shell. Do not paste it into a file, a chat, a commit or a CI log. It costs about 40 calls of roughly 4k input and up to 700 output tokens at the defaults.
- The CPU observation: whoever can deploy a preview and open Workers observability for it (Matt, or a session he has authorised). `ASK_RESEARCH` is forced off in a PR preview, so the research path does not run there as committed. Turning it on for a measurement is a flag decision: ask Matt first, use a throwaway branch deploy that is never merged, and do not touch production flags.

## Steps

1. Offline CPU baseline (no key, safe anywhere):
   `node tools/measure-research-cpu.mjs` (add `--iterations 100 --budget-ms 10 --json` as needed; `RESEARCH_CPU_BUDGET_MS` sets the default budget).
   Read: total median and p95 against the budget, the per-stage rows, the loop-mean CPU, and the cold first call (an isolate cold start looks like it). On Windows per-call `process.cpuUsage` is quantised to about 15 ms ticks; the tool says so and judges by wall time per ask. Exit 1 means over budget.
2. Latency dry run (proves the tool and the fake endpoint, says nothing about Anthropic):
   `node tools/measure-claude-latency.mjs --dry-run --n 5`
3. Live latency run. Set the credential in the shell, run, then clear it:
   - Direct: `ANTHROPIC_API_KEY` set; endpoint is `https://api.anthropic.com/v1/messages`.
   - Gateway (BYOK, the key lives in the gateway): `LATENCY_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` and `CF_AIG_TOKEN`. This is the path production will use when `ANTHROPIC_BYOK = "on"`, so measure it, not only the direct path.
   - Worker preview route: `LATENCY_ENDPOINT=<full URL>` for a route that forwards the same body.
   Then: `node tools/measure-claude-latency.mjs --n 30 --pause-ms 1000`. Run it at two or three different times of day; the p95 of one quiet minute is not the p95 of a Friday night. Models default to `claude-sonnet-5-5` and `claude-haiku-5-5` (`LATENCY_MODEL_DEEP`, `LATENCY_MODEL_FAST`); those ids are unverified until this run returns 200, so a `http-404` is the answer to that open question, not a tool failure.
   Read: per phase p95 against 5 s and 2.5 s, the share over 6 s and 3 s, time to first byte, and average input/output tokens (confirm the prompt is a few thousand tokens and the compose output is near, not at, 700).
4. Worker CPU: deploy the preview as described under "Who runs it", send at least 50 research asks of normal size, open Workers observability for that Worker and read CPU time per request for the `/ask` route: median and p95. Record both with the deploy sha.
5. Record the four results (CPU median, CPU p95, compose p95, retry p95, plus the share over each timeout) in the PR 329 thread against conditions 1 and the latency condition. Keep the raw tool output; it holds no friend text.

## If it fails

| Failure | Do, in this order |
|---|---|
| Compose p95 over 5 s | 1. Shorten the prompt (library block and retrieved text are most of the tokens; compare average input tokens in the output). 2. Lower `max_tokens` (700 is headroom over a 1500-character body of about 400 tokens). 3. Move compose to streaming and cut at the first complete answer; the tool measures non-streaming, so re-measure after the change. |
| Retry p95 over 2.5 s | Keep Haiku for the retry, shorten the retry prompt, lower its `max_tokens`. If Haiku itself is over, the retry is not worth its slot: fall straight to Workers AI. |
| Many calls over 6 s or 3 s but p95 passes | The tail is the problem: keep the timeouts, do not raise them, and check the fallback chain still answers inside the 24 s ask deadline. |
| `http-404` or `http-400` | The model id is wrong. Fix `RESEARCH_CLAUDE_MODEL_*`, re-run. |
| `http-429` or `http-529` | Not a latency result. Slow `--pause-ms`, retry later, do not count it as a pass. |
| CPU median or p95 over 10 ms in observability | 1. Replace the clock-based `privacyBudget` with a size check before tokenising (workerd timers freeze in compute). 2. Cut prompt size going through tokenise. 3. Strict-guard fewer segments or tokenise once per isolate. 4. If still over, the Workers Free plan cannot carry the path: the flag stays off until the plan limit changes (Matt's decision). |
| Node proxy over budget but observability under | Observability wins; note both. |
| Node proxy under budget but observability over | Observability wins; the flag stays off. |

The flag stays off until every row of the threshold table passes on measured numbers.
