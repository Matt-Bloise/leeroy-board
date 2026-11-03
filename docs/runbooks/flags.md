# Runbook: feature flags (Cloudflare Flagship)

Decision (Uncle Jimmy, Nov 3): feature flags live in **Cloudflare Flagship**, not in `infrastructure/wrangler.toml` `[vars]`. Flags are **created and flipped in the Cloudflare dashboard (Compute, Flagship), never by CI**. A flip takes effect without a deploy.

## How it fits together

- `infrastructure/wrangler.toml` binds the Worker to the production Flagship app (the app was created by hand in the dashboard):

  ```toml
  [[flagship]]
  binding = "FLAGS"
  app_id = "1f0b836c-4929-4728-8bee-6b8bde677e79"
  ```

  The app id is an identifier, not a secret. Nothing in CI creates, edits or deletes flags.
- The Worker reads a flag with `await flagOn(env, "D1_FEED")` (`infrastructure/worker/flags.js`). With the binding it asks Flagship (default `false`). A **missing flag, a disabled flag, any error, any answer other than `true`, or no answer within 100 ms (`FLAG_TIMEOUT_MS`) means off**. The `[vars]` value is not consulted when the binding exists.
- Without the binding (local dev, unit tests, PR preview Workers) it reads the legacy `[vars]` value of the same name (`D1_FEED = "off"` / `"on"`). `wrangler.toml` keeps `D1_FEED = "off"` as that fallback.
- **PR previews never bind to the production app.** Preview Workers are deployed from the same `wrangler.toml`, so the preview deploy step runs `tools/strip-flagship-binding.mjs` on the patched copy before `wrangler deploy` (it removes `[[flagship]]`, `[flagship]` and `[[env.NAME.flagship]]` blocks, and fails the step if a flagship binding is left in a form it cannot remove, such as `flagship.binding = ...` or an inline `flagship = [...]`, or if `wrangler.json` / `wrangler.jsonc` exists next to `wrangler.toml`, because wrangler reads those first). Previews therefore keep the legacy `[vars]` and stay deterministic. `tests/unit/workflow-secrets.test.mjs` fails if any non-production job can run `wrangler deploy` without stripping first.
- Local `wrangler dev` has the binding and uses wrangler's local Flagship simulator (it does not read the production app unless `remote = true` is added), so set a local flag in the simulator, not `.dev.vars`, to turn a migrated flag on locally.

## Flag keys the Worker reads through Flagship

Create each as a **boolean flag** in the app `leeroy-brain` (the app `1f0b836c-4929-4728-8bee-6b8bde677e79`), with **variations `on` (true) and `off` (false)** and **default variation `off`**. Keep the flag **disabled** (or serving `off`) until you want it on. The key is spelled exactly:

| Flag key | What it does | Fallback in `wrangler.toml` |
| --- | --- | --- |
| `D1_FEED` | computes `GET /api/data/stats` from D1 (cached 5 minutes) | `D1_FEED = "off"` |

Until `D1_FEED` exists in the dashboard the Worker treats it as off, which is today's behaviour.

## Not yet on Flagship (still legacy `[vars]`)

`WEB_LOGIN`, `DATA_RIGHTS`, `EVENTS_ENABLED`, `MOMENTS_ENABLED`, `MOMENTS_SHADOW`, `MOMENTS_DRY_RUN`, `CHARS_V1`, `BUILD_MODAL`, `BUILD_PROJECT`, `JOIN_PROMPT`, `ANSWER_UX`, `CARDS_ENABLED`, `CARDS_SHADOW`, `BOARD_LINES_ENABLED`, `SETUP_COMMAND`, `EVAL_ENABLED`, `REQUEST_GAUGE`. They are still flipped by editing `wrangler.toml` and deploying.

## Migrate another flag

1. In the dashboard, create a boolean flag with the **same key as the var** (for example `CARDS_ENABLED`), variations `on`/`off`, default `off`.
2. In the Worker replace the read of `env.NAME` by `await flagOn(env, "NAME")` and keep `NAME = "off"` in `[vars]` as the fallback.
3. Add the key to the table above (`tests/unit/flags.test.mjs` checks that every key passed to `flagOn` is listed here and has an off fallback).
4. Deploy, then turn it on in the dashboard.

## Flip a flag

Cloudflare dashboard, Compute, Flagship, app `leeroy-brain`, the flag, toggle **enabled** (or serve `on`). A disabled flag serves its default variation, `off`.

## Roll back

**Flip the flag off in the dashboard. No deploy.** If Flagship misbehaves the Worker treats the error as off. To drop the binding entirely, redeploy a previous Worker version (docs/runbooks/rollback.md); then the Worker uses `[vars]`.

## Wrangler 4

The deploy pins wrangler 4.148.0 (exact, `infrastructure/package.json` and lockfile; Flagship binding support arrived in 4.82.x; needs Node 22 or newer, which every workflow that runs wrangler sets up). Its config schema has `[[flagship]]` with `binding`, `app_id` and `remote`.

## Open points (verify on the first real deploy)

- Nothing was run against the live Flagship API or the production app from CI or from the authoring sandbox. After the first deploy, check the deploy log lists `env.FLAGS (1f0b836c-...) Flagship` among the bindings.
- `getBooleanValue` is called with two arguments (key, default); no evaluation context is passed.
- Older commands in the runbooks (`rollback.md`, `incident.md`) were confirmed on wrangler 3.114.17 and should be re-checked on 4.148.0 when next used.
