# Runbook: model bake-off

Purpose: choose the best free model and prompt for the Leeroy voice from outside evidence: blind human ratings plus a deterministic lint. An AI's opinion of its own or another model's answer is not evidence here.

Parts:

| Part | Where | What it does |
|---|---|---|
| `POST /api/admin/eval` | `infrastructure/worker/eval.js` | Runs questions x candidates through the production retrieval and prompt path, returns each answer with a lint result. Stores nothing, posts nothing to Discord. |
| `answer-lint.js` | `infrastructure/worker/` | Deterministic format checks (see "What the lint checks"). |
| `/rate/` | `rate/` | Static page. Shows two anonymous answers per question, records your choice, exports `ratings.json`, computes a Bradley-Terry strength score. No network calls. |
| Sample questions | `tests/fixtures/bake-off-sample.json` | Eight fictional questions, only to try the tooling. |

Real questions stay on the owner's computer. Never commit them, never paste them into a PR, an issue or a chat with a tool that stores them. The repo carries only the fictional sample, and a unit test fails if the rating page, the sample or this runbook contains a Discord-id-shaped number, an email address or a mention.

## 1. Switch the route on (Josh's deploy)

The route is off by default. It answers 404 unless the Worker has `EVAL_ENABLED=true`, and it always needs `BOARD_ADMIN_TOKEN`.

1. Ask Josh to set `EVAL_ENABLED = "true"` in the Worker vars for the bake-off window and deploy.
2. When the run is done, have him remove it (or set it to `false`) and deploy again. Confirm with the check below that the route is back to 404.

Check (does not print the token):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://api.leeroy.party/api/admin/eval \
  -H @<(printf 'Authorization: Bearer %s\n' "$BOARD_ADMIN_TOKEN") -H 'Content-Type: application/json' -d '{}'
# 400 = on, 404 = off, 401 = wrong token
```

`BOARD_ADMIN_TOKEN` must already be in your shell environment (loaded from your private secrets file). Never type it on a command line, never `echo` it, never put it in a file in the repo. The `-H @<(printf ...)` form keeps it out of the process list.

## 2. Assemble the question set (local only)

Build two files in a private folder outside any repo, for example `~/bake-off/`.

`request.json` (the questions are yours, the candidates are what you want to compare):

```json
{
  "questions": [
    { "id": "q01", "text": "your real question here" },
    { "id": "q02", "text": "another one", "journey": "guided" },
    { "id": "q03", "text": "a question asked by a visitor", "asker": "visitor" }
  ],
  "candidates": [
    { "label": "llama-prod",   "provider": "workers-ai" },
    { "label": "llama-plain",  "provider": "workers-ai", "promptVariant": "plain" },
    { "label": "gemini-lite",  "provider": "gemini", "model": "gemini-3.5-flash-lite" },
    { "label": "gemini-lite-fmt", "provider": "gemini", "model": "gemini-3.5-flash-lite", "promptVariant": "format-reminder" }
  ]
}
```

Rules the route enforces:

- 1 to 40 questions, 1 to 6 candidates, at most 120 cells (questions x candidates) per job. Bigger jobs: split them.
- Question `id`: letters, digits, `.` `_` `-`. `text`: up to 1000 characters. `journey` (optional) is the persona depth. `asker` (optional) is `member` (default) or `visitor`; use `visitor` for questions a non-member would ask, so the lint can catch members being addressed by name.
- Candidate `label` is what you will see in the summary. It is hidden while rating.
- `provider` is one of `workers-ai`, `gemini`, `groq`, `cerebras`, `github`, `openrouter`. Claude is not allowed.
- `model` (optional) must be on the allow-list in `EVAL_MODEL_ALLOWLIST` in `infrastructure/worker/ai-models.js`. Anything else is a 400. Without `model` the provider's production default is used. The Workers AI entries beyond the production model are listed from Cloudflare's catalogue and have not been exercised live; a model that is retired or answers in another shape shows up as an `ok: false` cell, not a crash.
- `promptVariant` (optional): `production` (what `/ask` sends today), `plain` (ignores the persona pack, uses the built-in prompt), `examples-6` (persona with 6 examples instead of 3), `format-reminder` (production plus an explicit format contract).

A provider that has no key configured, or any provider other than Workers AI in a PR preview, gives an `ok: false` cell with an error and no call.

## 3. Run it

One request runs at most 6 model calls and stops before 25 seconds. A job is a loop on `nextCursor`. Cells run question by question, so neighbouring cells hit different providers.

Pacing is built in: at least 1 second between any two model calls, and per-provider minimums (`PROVIDER_MIN_GAP_MS` in `eval.js`; Gemini free tier is about 15 requests per minute, so 4.2 seconds). A provider that answers 429 is not retried; its cell comes back `rateLimited: true` and the provider is left alone for 60 seconds.

Budget: Workers AI calls share the daily neuron counter with real `/ask` answers. The run refuses to call Workers AI when less than 40 percent of the daily allowance remains and returns `stoppedForBudget: true`. Do not loop on that; wait for 00:00 UTC.

Loop (bash, needs `curl` 7.55 or newer and `jq`; writes one file per request into `parts/`):

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${BOARD_ADMIN_TOKEN:?load the admin token into the environment first}"
API="https://api.leeroy.party"
JOB="bake-$(date +%Y%m%d)"
cd ~/bake-off && mkdir -p parts && rm -f parts/*.json
cursor=0; n=0; stalls=0
while :; do
  body=$(jq -c --argjson cur "$cursor" --arg job "$JOB" '. + {cursor: $cur, jobId: $job}' request.json)
  resp=$(curl -sS --max-time 40 -X POST "$API/api/admin/eval" \
    -H @<(printf 'Authorization: Bearer %s\n' "$BOARD_ADMIN_TOKEN") -H 'Content-Type: application/json' -d "$body")
  printf '%s\n' "$resp" | jq -e '.results' >/dev/null || { echo "request failed: $(printf '%s' "$resp" | head -c 200)"; exit 1; }
  n=$((n+1)); printf '%s\n' "$resp" > "$(printf 'parts/%03d.json' "$n")"
  echo "cells from $cursor: $(printf '%s' "$resp" | jq -c '{callsMade, nextCursor, stoppedForBudget, stoppedForTime}')"
  [ "$(printf '%s' "$resp" | jq '.stoppedForBudget')" = "true" ] && { echo "budget stop; run again after 00:00 UTC"; break; }
  next=$(printf '%s' "$resp" | jq '.nextCursor')
  [ "$next" = "null" ] && break
  if [ "$next" = "$cursor" ]; then stalls=$((stalls+1)); [ "$stalls" -ge 3 ] && { echo "no progress"; exit 1; }; sleep 10; else stalls=0; fi
  cursor=$next
  sleep 2
done
jq -s '.' parts/*.json > results.json
echo "wrote results.json"
```

Afterwards:

```bash
# Cells that failed or were rate limited (rerun them later with "cursor": <index> and "maxCalls": 1)
jq '[.[].results[] | select(.ok|not) | {index, candidate, error, rateLimited}]' results.json
# Lint pass rate per candidate
jq '[.[].results[] | select(.ok)] | group_by(.candidate) | map({candidate: .[0].candidate, n: length, pass: (map(select(.lint.pass))|length), median_ms: (map(.ms)|sort|.[length/2|floor])})' results.json
# Which checks fail, per candidate
jq '[.[].results[] | select(.ok) | {candidate, f: .lint.failures[]}] | group_by([.candidate,.f]) | map({candidate: .[0].candidate, check: .[0].f, count: length})' results.json
```

`results.json` contains your real questions and the answers. Keep it on your computer only.

## What the lint checks

`lintAnswer` in `answer-lint.js` is pure and deterministic. It runs on the formatted answer, the text a person would see. A check in "failures" makes `lint.pass` false:

| Check | Fails when |
|---|---|
| `bracket_ids` | a raw `[id/page]` citation is left in the text |
| `bare_urls` | a web address is not inside a masked link |
| `sources_unmasked` | a `-# Sources:` line exists but is not all masked links (no sources line is only a warning) |
| `first_sentence_not_bold` | the first line is not one bold whole sentence |
| `length` | longer than the persona `format.chatMaxChars` (default 1200), shorter than `chatMinChars` if set, or empty |
| `forbidden_words` | `Skippy` or whole-word `Matt` appears |
| `mentions` | `@everyone`, `@here`, a user or role mention, or an `@handle` |
| `stock_opener` | the answer opens with "Great question", "Certainly", "Sure", "Here is" and similar |
| `non_member_addressed` | a visitor question gets an answer that addresses a party member by name |
| `emoji` | any emoji (default allowance 0) |

The lint says nothing about voice, accuracy or charm. That is what the ratings are for.

## 4. Rate

1. Open `https://leeroy.party/rate/` (it is not indexed). It loads nothing from the site except its own page files.
2. Choose `results.json` (or the files in `parts/`; several files merge). The file never leaves the browser.
3. For each pair read A and B, then press `A`, `B`, `T` (tie) or `X` (both bad). `U` goes back. Typing in the note box turns the keys off. Progress is kept in this browser, so you can stop and continue with the same file, seed and pairs-per-question.
4. The shuffle seed decides which answer is A and the order of the pairs. Keep the default unless you want a second, independent pass.
5. Press "Finish and show summary" to reveal the candidates. "Export ratings.json" saves your choices with the labels.

Aim for at least 30 decided pairs. Pairs are balanced so each candidate is shown about equally often. With 40 questions and one pair per question that is 40 ratings; use 2 pairs per question for a sharper result.

## 5. Read the table

Columns: wins, losses, ties, both bad and strength.

- Strength is a Bradley-Terry score: the chance-weighted strength that best explains your wins and losses, computed with the standard iterative update. Ties count as half a win each. "Both bad" is counted separately and left out of the score. A small prior keeps an unbeaten or winless candidate from running off to 0 or 100 percent. Strengths add up to 100 percent. If A has 40 percent and B 20 percent, A is expected to beat B about two times in three (40 / (40 + 20)).
- With fewer than about 30 decided pairs, treat differences under 10 points as noise. The summary prints the number of decided comparisons.
- Check both bad. A candidate that wins often but is called "both bad" often is the best of a weak field.

## 6. What the outcome means

| Outcome | Meaning | Next step |
|---|---|---|
| One candidate leads clearly and its lint pass rate is at least as good as the others | Chosen model and prompt | Step 7 |
| Same model, different `promptVariant`, one clearly ahead | The prompt matters more than the model | Put that variant's change in the persona pack (step 7) |
| `plain` beats `production` | The persona pack is hurting | Revisit the pack; do not change the model yet |
| Lint failures cluster on one check for every candidate | A format problem the formatter or the prompt should fix | Fix the formatter or prompt, rerun the lint on the same questions |
| A candidate has strong ratings but many `rateLimited` or `ok: false` cells | It may not hold up under real traffic | Do not choose it on ratings alone; check latency and errors |
| Everything is close, many ties | The candidates are equivalent for this voice | Choose the cheapest or fastest one, or the one with the best lint pass rate |
| Most pairs are "both bad" | No candidate reproduces the voice | Work on the prompt and persona pack before comparing models again |

Latency: the lint summary command above prints median milliseconds per candidate. Discord needs an answer within 24 seconds (`ASK_DEADLINE_MS`), and the chosen provider gets 12 seconds (`ASK_CHOSEN_TIMEOUT_MS`).

## 7. Set the chosen model (through Josh's deploy)

The bake-off changes nothing by itself. To adopt a result, send Josh the winning candidate and he deploys it:

| Winner | Change |
|---|---|
| A Workers AI model | `WORKERS_AI_MODEL` var set to the model id (and `AI_PROVIDER = "workers-ai"` if it is not already the default provider) |
| A Gemini model | `GEMINI_MODEL_FAST` (and `AI_PROVIDER = "gemini"`) |
| Groq, Cerebras, GitHub Models, OpenRouter | `GROQ_MODEL_FAST`, `CEREBRAS_MODEL`, `GITHUB_MODEL_FAST`, `OPENROUTER_MODEL` respectively, plus `AI_PROVIDER` |
| A prompt variant | The persona pack: `plain` means clearing or simplifying the pack, `examples-6` means adding examples to the pack (the pack is written with `PUT /api/persona`), `format-reminder` means adding the format contract text to the pack's rules |

Model ids must be on the allow-list for the eval; the production variables accept any id, so keep them on the tested ones. After the deploy, ask one real question on production and read the answer once. Then remove `EVAL_ENABLED` (step 1). Rollback: set the variable back to its previous value (the Worker previous version is also available through `wrangler rollback`).

Do not paste results, ratings or questions into a PR. A PR may carry the decision (model id, variant, the number of ratings) and nothing else.
