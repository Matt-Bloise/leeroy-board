# Runbook: load and soak test

Last checked: 2026-11-02. The script is `tests/load/soak.js` (k6). It is **not run in CI** and has **not been run yet**: no result below is measured. Every number is labelled **speculative** until a report exists.

## Rules
1. Preview environments only. The script refuses any API origin containing `leeroy.party`. Never point it at production.
2. One preview slot is shared by every contributor (Cloudflare allows 9 in total, `CONTRIBUTING.md`). Tell the owner before a run, and tear the preview down after.
3. Member asks call an AI model. Preview uses Workers AI, which has a very low free rate limit, and `CONTRIBUTING.md` says tests make no AI calls. So the ask scenario is **off unless you set `-e ASK=1`**, runs at 6 per minute, and may return 429 or an error by design. Treat ask results as a cost and rate-limit probe, not a pass/fail on the platform.
4. The member key is a preview key passed on the command line. Never commit one, paste it into an issue, or reuse a production key.
5. The websocket scenario opens `/live`, which has no key check in the code read (`infrastructure/README.md`). Each connection holds the Durable Object; close them (the script does after 30 to 60 s).

## What it does
| Scenario | Endpoint | Shape |
| :--- | :--- | :--- |
| bootstrap | `GET /api/bootstrap` (edge cached 60 s per `docs/openapi.yaml`) | Ramp to N virtual users over 1 min, hold 8 min, ramp down |
| ask | `POST /api/intent` with `kind: "ask"` and a member key | 6 per minute, only with `ASK=1` |
| room | WebSocket `/api/live` upgrade to `BoardRoom` | Half of N users connect, hold 30 to 60 s, reconnect |

Profiles: `small` = 5 VUs, `large` = 500 VUs (`-e PROFILE=large`). Notes: the `ask` path in the code is `POST /intent` with `kind: "ask"` (`worker/index.js` near line 1346); the prompt text is fixed and carries no real member data.

## Run
```bash
k6 run -e API=https://<preview-worker-origin>/api -e BOARD_KEY=<preview member key> tests/load/soak.js
```
Then repeat with `-e PROFILE=large`. Add `-e ASK=1` for the ask probe. Save the end-of-test summary (`--summary-export=report.json`) outside the repository.

## Targets (all speculative)
| Metric | Small (5 VUs) | Large (500 VUs) | Basis |
| :--- | :--- | :--- | :--- |
| Bootstrap p95 | under 800 ms | under 800 ms | The only figure that appears in the roadmap (Q47). The rest below are guesses. |
| Bootstrap error rate | under 1 percent | under 1 percent | Guess |
| Websocket handshake success | over 98 percent | over 95 percent | Guess; per-isolate and Durable Object limits not checked |
| Member ask p95 | under 8 s | not tested | Guess; depends on the AI provider |

Because bootstrap is edge-cached for 60 s, high hit rates will flatter the numbers. Note the cache status header in a few manual requests, and treat a cached-only result as a CDN test, not a Worker test. Add `?cb=<random>` only with the owner's agreement, since that bypasses the cache and loads D1.

## Reading the result
- Pass: all thresholds in the k6 output are green and no Worker exceptions appear in `wrangler tail` during the run.
- Record in the PR or an issue: date, preview URL, profile, k6 version, the summary, and what limit was hit. Label causes confirmed, likely or speculative.
- A failure at 500 VUs is information, not a bug by itself: no capacity target has been agreed. The owner sets the real SLO from the first report.

## Not covered
Discord interactions, write paths (sign-ups), D1 write contention, and the long-lived room under message fan-out. Add after the first run.
