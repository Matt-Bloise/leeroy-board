# Runbook: feature flags (Cloudflare Flagship)

Decision (Uncle Jimmy, Nov 3): feature flags live in **Cloudflare Flagship**, not in `infrastructure/wrangler.toml` `[vars]`. A flag is **created by the production deploy with wrangler** (disabled) when it is missing, and **flipped by the owner** in the Cloudflare dashboard (Compute, Flagship) or with `wrangler flagship flags enable`. CI never enables, updates, disables or deletes a flag. A flip takes effect without a deploy.

## How it fits together

- `infrastructure/wrangler.toml` binds the Worker to the production Flagship app (the app was created by hand in the dashboard):

  ```toml
  [[flagship]]
  binding = "FLAGS"
  app_id = "1f0b836c-4929-4728-8bee-6b8bde677e79"
  ```

  The app id is an identifier, not a secret. Nothing in CI edits, enables, disables or deletes flags; the production deploy only creates the missing ones (next section).
- The Worker reads a flag with `await flagOn(env, "D1_FEED")` (`infrastructure/worker/flags.js`). With the binding it asks Flagship (default `false`). A **missing flag, a disabled flag, any error, any answer other than `true`, or no answer within 100 ms (`FLAG_TIMEOUT_MS`) means off**. The `[vars]` value is not consulted when the binding exists.
- Without the binding (local dev, unit tests, PR preview Workers) it reads the legacy `[vars]` value of the same name (`D1_FEED = "off"` / `"on"`). `wrangler.toml` keeps `D1_FEED = "off"` as that fallback.
- **PR previews never bind to the production app.** Preview Workers are deployed from the same `wrangler.toml`, so the preview deploy step runs `tools/strip-flagship-binding.mjs` on the patched copy before `wrangler deploy` (it removes `[[flagship]]`, `[flagship]` and `[[env.NAME.flagship]]` blocks, and fails the step if a flagship binding is left in a form it cannot remove, such as `flagship.binding = ...` or an inline `flagship = [...]`, or if `wrangler.json` / `wrangler.jsonc` exists next to `wrangler.toml`, because wrangler reads those first). Previews therefore keep the legacy `[vars]` and stay deterministic. `tests/unit/workflow-secrets.test.mjs` fails if any non-production job can run `wrangler deploy` without stripping first.
- Local `wrangler dev` has the binding and uses wrangler's local Flagship simulator (it does not read the production app unless `remote = true` is added), so set a local flag in the simulator, not `.dev.vars`, to turn a migrated flag on locally.

## The deploy creates missing flags (disabled)

- `infrastructure/flagship-flags.txt` is the one list of flag keys (one per line). `tests/unit/flags.test.mjs` fails when a key passed to `flagOn()` in `infrastructure/worker` is not in it, or when a key in it is not in the table below.
- The **production deploy only** (`.github/workflows/deploy-cloudflare.yml`, master, environment `production`), in the step after `wrangler deploy`, runs `tools/flagship-ensure-flags.mjs`. It reads the app id from `infrastructure/wrangler.toml`, runs `wrangler flagship flags list <APP_ID> --json --all --remote` (read only), and for each listed key that is **absent** runs `wrangler flagship flags create <APP_ID> <KEY> --disabled --remote`.
- A flag created this way is a boolean flag (on = true, off = false, default variation `off`) and is **disabled**, so it serves `off` until the owner enables it. **An existing flag and its on/off state are never touched**: the script never runs enable, update, disable, split, rules or delete.
- The step is `continue-on-error: true` with `timeout-minutes: 3`, and every wrangler call has a 60 s timeout, so a hung wrangler cannot hold up the secrets sync after it. If the list cannot be trusted as the complete list (the command fails or times out, the output is not recognised or is ambiguous, or it shows another page: a non-null `cursor` / `next`, or `has_more` true) it creates nothing; any problem is a yellow `::warning title=Flagship flags::` annotation in the run, never a failed deploy. The API token is never printed.
- PR previews never run it: `tests/unit/workflow-secrets.test.mjs` fails if any workflow other than the production deploy references the script or `wrangler flagship flags create/enable/...`.
- Check it by hand without changing anything: `node tools/flagship-ensure-flags.mjs --dry-run` (lists the real app, creates nothing; needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

## Flag keys the Worker reads through Flagship

Each is a **boolean flag** in the app `leeroy-brain` (the app `1f0b836c-4929-4728-8bee-6b8bde677e79`), with **variations `on` (true) and `off` (false)** and **default variation `off`**. The deploy creates it, disabled, when it is missing (you do not need to create it in the dashboard); it stays **disabled** (serving `off`) until you want it on. The key is spelled exactly:

| Flag key | What it does | Fallback in `wrangler.toml` |
| --- | --- | --- |
| `D1_FEED` | computes `GET /api/data/stats` from D1 (cached 5 minutes) | `D1_FEED = "off"` |
| `INTEREST_NUDGES` | adds the "Ask: what should I do at my level?" and "How many are interested?" buttons to `/tonight` and `/signup` (plus "I'm in tonight" on `/tonight` while the RSVP is empty), and lets the 6-hour cron read the Interested count of Leeroy's own scheduled events and the reaction counts of Leeroy's own sign-up cards and recent timed posts (`worker/interest.js`). GET only, counts only, stored in the private kv_state row `interest_counts`; it never writes a sign-up. Needs the bot to be able to read the channels it posts in (View Channel, Read Message History) | `INTEREST_NUDGES = "off"` |
| `ROSTER_FROM_D1` | (refused while `ROSTER_STEP2_READY` is false in `worker/roster-source.js`, so on behaves as off until the step 2 PR) reads the member roster, the default admin and the redaction names from the private kv_state row `party_roster` (admin `PUT /api/config/party_roster`; shape and rollout in `docs/adr/0002-member-roster-from-d1.md`) instead of the built-in lists. A missing or invalid row falls back to the built-ins. Off: today's behaviour, and D1 is never asked for the key | `ROSTER_FROM_D1 = "off"` |

Until `D1_FEED` exists the Worker treats it as off, which is today's behaviour; the first deploy after this change creates it, disabled.

## Not yet on Flagship (still legacy `[vars]`)

`WEB_LOGIN`, `DATA_RIGHTS`, `EVENTS_ENABLED`, `MOMENTS_ENABLED`, `MOMENTS_SHADOW`, `MOMENTS_DRY_RUN`, `CHARS_V1`, `BUILD_MODAL`, `BUILD_PROJECT`, `JOIN_PROMPT`, `ANSWER_UX`, `ASK_RESEARCH` (`/ask` research mode, `worker/research/`: Claude first (tokenised and guarded, see "ASK_RESEARCH provider order"), then Workers AI, then library facts; no other provider; a question the library cannot answer gets a model answer instead of the abstain, unsupported numbers and names are labelled not deleted; never on in a PR preview), `CARDS_ENABLED`, `CARDS_SHADOW`, `BOARD_LINES_ENABLED`, `SETUP_COMMAND`, `EVAL_ENABLED`, `REQUEST_GAUGE`, `ANTHROPIC_BYOK` (Claude key held in the AI Gateway, never in the Worker; no direct fallback; see `secrets.md`). They are still flipped by editing `wrangler.toml` and deploying.

## ASK_RESEARCH provider order, guards and the Claude token cap

With `ASK_RESEARCH = "on"` (never in a PR preview) the `/ask` model call runs this chain and nothing else. Gemini, Groq, Cerebras, GitHub Models and OpenRouter never see friend text, and the asker's chosen provider is ignored.

1. **Claude**, only when `anthropicAvailable(env)` (BYOK, Secrets Store binding or legacy secret; `worker/ai-keys.js`) and the monthly token budget allows. Models: `RESEARCH_CLAUDE_MODEL_FAST` (`claude-haiku-5-5`) and `RESEARCH_CLAUDE_MODEL_DEEP` (`claude-sonnet-5-5`). A 404 or 400 answer retries once with `RESEARCH_CLAUDE_FALLBACK_FAST` / `_DEEP` (the 4.5 ids). The 5-5 ids and all prices are **unverified**; check the provider's model list before the first real call. `max_tokens` 700, gateway cache skipped, no friend text in `cf-aig-metadata`. The legacy `CLAUDE_MODEL_*` vars are untouched and serve the flag-off path.
2. **Workers AI** (inside Cloudflare), with the same tokenised prompt.
3. **Library facts** plus the honest line, or the honest line alone.

**Tokenised by construction.** Before any model sees the prompt, the system prompt, the party and build blocks, the asker line, the question and the previous turn go through `privacy/tokenise.js`: roster names become per-request tokens (`{P3.k7f2}`); the roster is `privacy/roster-config.js` (a view of `bot-data.js` `ROSTER_DATA`; `genericAliases` lists the plain-word aliases left alone). Replies are detokenised to **display names only**. A reply naming a first name, character or guild name, or carrying a bare or foreign token, is discarded and Workers AI answers instead (then the library facts).

**Guards before every Claude call.** `guardUserText` (strict) runs over EVERY friend-writable segment, after tokenising: the question, the previous turn, every structured sheet field, every sign-up key and value, and the tonight title (each party segment on its own). `guardBody` (cheap) runs over the final request body, which also covers the persona and library text (a CI test, `tests/unit/ask-research-claude.test.mjs`, checks that no library page file holds a roster key; the default persona lives in D1 and is covered by tokenising plus `guardBody`). A hit, a roster that cannot be parsed, or a tokeniser error means no Claude call: Workers AI answers the same tokenised prompt. Never a refusal. The reason is a fixed code appended to the `ask_turns.model` label (for example `claude:claude-haiku-5-5+research` or `workers-ai:...+research [guard:name]`); codes are `guard:<kind>`, `guard:config`, `tokenise:error`, `cpu:budget`, `claude:cap`, `claude:counter-error`, `claude:paused`, `claude:reply-flagged`, `claude:http-<status>`, `claude:timeout`, `claude:error`. No name, text or id is ever in a code.

**Names the Worker knows.** The name list for tokenising and guarding is `ROSTER_DATA` plus, at request time, every sheet in the party document: its name, its slug and any character names (`character`, `main`, `alts`, `characters` on the sheet or in its fields). A sheet that matches a roster member adds its extra names to that member; any other sheet becomes a member of its own. A name that collides with another member, is one character long or is a reserved word is skipped (the owner of the colliding key already protects it). The compiled name map is cached per isolate for each roster and party; only the nonce changes per request.

**Sheet fields: structured vs free-text.** `worker/research/claude.js` (`STRUCTURED_FIELDS`, `FREE_TEXT_FIELDS`, `classifyField`). A structured field that fails the strict guard stops Claude for that ask. A free-text field that fails it is removed from the prompt (Claude and Workers AI both); one that passes is sent. A field not listed is free-text (the safe default).

| Kind | Fields |
|---|---|
| Structured (sent; a guard hit stops Claude) | `class`, `race`, `spec_path`, `spec_at_40`, `level`, `role`, `professions`, `launch_state` |
| Free-text (sent only if it passes the guard, else dropped) | `plan_zone`, `goals` |

**Monthly spend guard (degrades, never walls).** Before the call an estimate (prompt characters / 3 plus the 700-token answer allowance) is RESERVED with one atomic D1 statement on `kv_state` key `claude_tokens_YYYYMM` (UTC month; a plain integer): it succeeds only while the month is under the cap, so concurrent asks cannot all pass a check-then-act gate (at most one reservation overshoots, by its own estimate). After the call the reservation is reconciled to the real usage: all four `usage` fields (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), each clamped to 0 to 200,000; a missing block, a non-number or a negative counts as the estimate. A call known not to be billed (a guard stop, a 4xx that is not a rate limit) gives its reservation back. `RESEARCH_CLAUDE_MONTHLY_TOKENS` (default `2000000`; a bad or empty value means the default, `0` turns Claude off) is the bound. When the reserve fails Claude is skipped silently, Workers AI answers, and one owner-visible row `alert:claude-cap:YYYYMM` (`{kind, month, cap}`, no names) is written once per month; read it with `SELECT * FROM kv_state WHERE key LIKE 'alert:claude-cap:%'`. A counter that cannot be read or written skips Claude, and a failed write pauses Claude for 10 minutes in module memory (`claude:paused`), so spend cannot go unrecorded. The research call sends no `cache_control` (no cached friend text) and makes one send per attempt: no gateway-then-direct second send. The fallback model is tried once, and only when the answer says the MODEL is missing (a `not_found_error` naming the model, or an `invalid_request_error` saying it does not exist); credit, auth and rate errors never retry.

**CPU budget.** Tokenising plus the guards are timed with `performance.now()`; over 8 ms for one ask (or a prompt over 60,000 characters, a clock-free proxy, because a Worker's clock may not advance during pure computation) skips Claude for that ask (`cpu:budget`) and Workers AI answers. Measured on a development PC: about 2.5 ms median, 6.6 ms worst case for a hostile 2,000-character question; the Free plan CPU limit is 10 ms, so this is a safety net, not a guarantee.

**Cost bound, with assumptions (prices unverified; check the provider's price page).** Worst case per month is the cap times the dearest per-token price: if input costs `Pi` and output costs `Po` dollars per million tokens, then 2,000,000 tokens cost at most `2 x max(Pi, Po)` dollars. Illustration only, not a quote: at an assumed 5 dollars per million tokens (either direction) the cap bounds the month at 10 dollars, at 15 dollars per million at 30 dollars. Cache writes and reads count as full tokens (all four usage fields are summed), so the count is at least what the provider bills at the dearest rate for these four fields; a provider-side charge outside them (for example a priced tool) is not counted. Change the cap in `wrangler.toml` and deploy.

## Migrate another flag

1. Add the **same key as the var** (for example `CARDS_ENABLED`) to `infrastructure/flagship-flags.txt`; the next production deploy creates the boolean flag, disabled.
2. In the Worker replace the read of `env.NAME` by `await flagOn(env, "NAME")` and keep `NAME = "off"` in `[vars]` as the fallback.
3. Add the key to the table below (`tests/unit/flags.test.mjs` checks that every key passed to `flagOn` is in the key list and listed here, and has an off fallback).
4. Deploy (the flag is created disabled), then turn it on in the dashboard or with `wrangler flagship flags enable <APP_ID> <KEY> --remote`.

## Flip a flag

Cloudflare dashboard, Compute, Flagship, app `leeroy-brain`, the flag, toggle **enabled** (or serve `on`), or `wrangler flagship flags enable <APP_ID> <KEY> --remote`. A disabled flag serves its default variation, `off`. Only a person does this; the deploy never does.

## Roll back

**Flip the flag off in the dashboard. No deploy.** If Flagship misbehaves the Worker treats the error as off. To drop the binding entirely, redeploy a previous Worker version (docs/runbooks/rollback.md); then the Worker uses `[vars]`.

## Wrangler 4

The deploy pins wrangler 4.148.0 (exact, `infrastructure/package.json` and lockfile; Flagship binding support arrived in 4.82.x; needs Node 22 or newer, which every workflow that runs wrangler sets up). Its config schema has `[[flagship]]` with `binding`, `app_id` and `remote`.

## Open points (verify on the first real deploy)

- Nothing was run against the live Flagship API or the production app from CI or from the authoring sandbox. After the first deploy, check the deploy log lists `env.FLAGS (1f0b836c-...) Flagship` among the bindings.
- **Not verified against the real service** (B51): the actual output of `wrangler flagship flags list --json --all --remote` (the parser is tolerant of arrays, wrapped arrays and banner lines, and treats anything else as unreadable, creating nothing); what `flags create` does for a key that already exists (the script never calls it for a key the list returned); that wrangler 4.148.0 accepts `--disabled` together with `--remote` on the real app (both options are in its `--help`); and that the production API token is allowed to use Flagship. Look at the first production deploy log for the `flagship-flags:` lines and any yellow warning.
- `getBooleanValue` is called with two arguments (key, default); no evaluation context is passed.
- Older commands in the runbooks (`rollback.md`, `incident.md`) were confirmed on wrangler 3.114.17 and should be re-checked on 4.148.0 when next used.
