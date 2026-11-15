# ASK_RESEARCH: the flip, the rollback and the first real ask

Status: DRAFT, prepared 2026-11-15. This runbook and the one-line flag change in the same PR are merged and deployed only on the owner's word. Nothing here is a go.

## The flip (one line)

`infrastructure/wrangler.toml`, `[vars]`: `ASK_RESEARCH = "on"`. It is a `[vars]` flag, so it takes effect on deploy (Josh deploys). It is never on in a PR preview.

Land first, in this order: PR 339 (nonce tolerance, Sonnet-class compose), PRs 348 and 360 (carry-list restores, privacy conditions). This change must not merge before them: with the flag on and without them the guards and the voice are the older, narrower versions.

## The rollback (one line)

Set `ASK_RESEARCH = "off"` in `infrastructure/wrangler.toml` and deploy. The off path is the old `/ask` byte for byte (pinned by tests), so rollback needs no data change. A model label that starts with `claude:` stops appearing in new `ask_turns` rows after the deploy.

## Before the flip (needs the owner's go; none of this has been run)

1. Key: `ANTHROPIC_API_KEY` is an encrypted env secret on the leeroy-brain Worker (no Secrets Store binding, no BYOK). The resolver falls through to it; `tests/unit/ai-keys-env-secret.test.mjs` pins that. Do not paste the key anywhere.
2. Model ids and prices: with that key, one live call per model id in `wrangler.toml` (`RESEARCH_CLAUDE_MODEL_FAST`, `RESEARCH_CLAUDE_MODEL_DEEP`, and the fallback ids) to confirm they exist and what they cost. The 5-5 ids are unverified.
3. Latency: `tools/measure-claude-latency.mjs` against the real endpoint (see `research-latency.md`). Pass: compose p95 under 5 s, retry p95 under 2.5 s. The live run needs the owner's go because it spends tokens.
4. Worker CPU: a throwaway preview deploy with the flag on (previews force it off), then read CPU time in Workers observability. Pass: median and p95 under 10 ms. Needs the owner's go and Josh.
5. Monthly cap: confirm `RESEARCH_CLAUDE_MONTHLY_TOKENS` is a number the owner accepts.

## The first real ask (after the deploy)

Ask one ordinary question as the owner, then check each line:

1. Label: in D1 `SELECT id, model, status, created_at, answered_at FROM ask_turns ORDER BY created_at DESC LIMIT 3;` the newest row's `model` must read `claude:...+research`. `gemini`, `workers-ai` or `library` means the Claude hop did not answer; read the label suffix for the reason (`guard:*`, `claude:no-time`, `cpu:*`, budget) before doing anything else.
2. Status: `status` is `answered`, not `thinking` or `error`.
3. Latency: `answered_at` minus `created_at` is under 24 s and, for a normal question, near the compose p95 measured above.
4. Answer: show the owner the answer as posted. The owner's reading is the voice test; the A/B judge was unreliable, so no number replaces it.
5. Privacy: the answer must contain no member name that the question did not contain; look at the row once by eye.
6. Spend: read the monthly Claude counter row and confirm it moved by roughly one compose.

If any of 1 to 3 or 5 fails, roll back (above) and report the label and reason. Do not retry in a loop.
