# Runbook: feature flags (Cloudflare Flagship)

Decision (Uncle Jimmy, Nov 3): feature flags live in **Cloudflare Flagship**, not in `infrastructure/wrangler.toml` `[vars]`. A flag is flipped in the Cloudflare dashboard and takes effect without a deploy.

## How it fits together

- `infrastructure/flags.json` lists the flags (app `leeroy-brain`; one entry per flag: `key`, `description`, `legacy_var`, `default: "off"`).
- On every production deploy (master, environment `production`) the step `Ensure Flagship app and flags` runs `tools/flagship-ensure.mjs`. It finds the app by name or creates it, and creates each manifest flag **only if it is missing**, disabled. It never modifies an existing flag, so a switch flipped in the dashboard survives every deploy. It prints the `app_id`; the deploy appends `[[flagship]] binding = "FLAGS" app_id = "<id>"` to the CI checkout's `wrangler.toml` (never committed).
- The Worker reads a flag with `await flagOn(env, "d1-feed")` (`infrastructure/worker/flags.js`). With the binding it asks Flagship (default `false`; any throw means off). Without the binding (local dev, unit tests, PR preview Workers, or a deploy where the ensure step failed) it reads the legacy `[vars]` value (`D1_FEED = "off"` / `"on"`).
- Key to legacy var: upper case, dashes to underscores (`d1-feed` is `D1_FEED`).
- The ensure step is `continue-on-error`. If it fails, the deploy still ships the code, a warning annotation says so, and the Worker runs on the `[vars]` fallback.
- PR workflows never run the ensure script (`tests/unit/workflow-secrets.test.mjs` fails if they mention it).

## Add a flag

1. Add an entry to `infrastructure/flags.json` (`key` in kebab-case, `description`, `legacy_var`, `default: "off"`).
2. Keep a matching `NAME = "off"` in `wrangler.toml` `[vars]` as the fallback (`tests/unit/flags.test.mjs` checks every manifest flag has one).
3. In the Worker use `await flagOn(env, "your-key")` instead of reading `env.NAME`.
4. Deploy. The flag appears in the dashboard, off. Turn it on there.

## Flip a flag

Cloudflare dashboard, Flagship, app `leeroy-brain`, the flag, toggle **enabled**. A disabled flag serves its default variation (off).

## Roll back

**Flip the flag off in the dashboard. No deploy.** If Flagship itself misbehaves, the Worker treats an error as off. To drop the binding entirely, redeploy a previous Worker version (docs/runbooks/rollback.md); the Worker then uses `[vars]`.

## Token permissions

`CLOUDFLARE_API_TOKEN` (used by the deploy for the ensure step) needs **Flagship Write** (Flagship App Write) to create the app and flags and **Flagship Read** to list them. **Flagship Evaluate** is for evaluation over the API; a Worker uses the binding and needs no token. A 401/403 makes the ensure step fail with the missing permission named.

## Not yet on Flagship

Every flag except `d1-feed` still reads `[vars]` directly. They are already in the manifest (created disabled), so migrating one is steps 2 and 3 above.

## Open points (verify on the first real deploy)

- The request bodies of the flag create call are isolated in `appBody` / `flagBody` in `tools/flagship-ensure.mjs` and were not checked against the live API.
- The pinned wrangler (`infrastructure/package.json`, 3.114.17) has no `flagship` binding in its config schema. Until wrangler is upgraded to a version that supports `[[flagship]]`, the appended block is ignored by wrangler and the Worker keeps using `[vars]`. Check the deploy log for a wrangler warning about an unexpected field and for `env.FLAGS` in the bindings list.
