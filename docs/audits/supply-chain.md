# Supply-chain audit (read-only, master @ branch point)

Scope: npm dependencies (`infrastructure/`, `tests/`), vendored files, `.github/workflows/*`, Cloudflare token handling, Dependabot, and secret-shaped content in git history (190 commits, all refs). No secret values are reproduced here.

## Findings

| # | Severity | Where | Finding | Fix |
|---|----------|-------|---------|-----|
| 1 | **High** | `.github/workflows/pr-preview-cloudflare.yml:104,130,482`, `preview-tests.yml:133`, `deploy-cloudflare.yml:31` | The same `CLOUDFLARE_API_TOKEN` is used for previews and production by owner decision (`tools/check-secret-scope.sh:11`). Preview jobs run on `pull_request` from the PR head, so anyone who can push a branch and add `ci-full` runs their own workflow/`npm ci`/`npx wrangler` code with that token in the environment. Fork PRs are correctly excluded (`pr-preview-cloudflare.yml:34`, forks get no secrets). Risk is limited to people with write access, but the token's scope is unknown (see "Could not verify"). | Use a separate preview token limited to Workers/D1/Pages on preview-named resources, or move previews behind a protected `preview` environment with required reviewers. Keep the production token only in the `production` environment (master-only). |
| 2 | **High (dev tooling)** | `infrastructure/package.json` (wrangler 4.148.0) | `npm audit`: 4 high advisories via transitive `undici` 7.0–7.30 (cache poisoning, TLS option drop, DoS) and `sharp`/`miniflare`. The deploy job runs this wrangler with the production token. Fix is `wrangler@4.162.0` per npm. | Bump the exact pin and lockfile in a separate PR (needs an install and a dry-run deploy to validate, so not done here). |
| 3 | **High (dev tooling)** | `tests/package.json:10` (playwright 1.49.1) | GHSA-7mvr-c777-76hp: browser downloads not TLS-verified, fixed in 1.55.1. Affects `npx playwright install` in CI (e.g. `deploy-cloudflare.yml:467`). | Bump to >=1.55.1 and refresh baselines (visual baselines may change, so not done here). |
| 4 | Medium | `tests/package.json:11` (yaml 2.6.1) | Stack overflow on deeply nested YAML (moderate). Used by tests only. | `npm audit fix` (non-breaking). |
| 5 | Medium | repo root | No `.github/dependabot.yml`. Nothing proposes updates for the SHA-pinned actions, the two lockfiles, or the ZAP image. Findings 2-4 are the result. | Add Dependabot for `github-actions`, `/infrastructure` npm and `/tests` npm (weekly, grouped). Not added here: it opens PRs on a repo with parallel sessions; owner call. |
| 6 | Medium | `.github/workflows/nightly-production.yml:78`, `security.yml:187` | ZAP image `ghcr.io/zaproxy/zaproxy:2.16.0` pinned by tag, not digest. | Pin `@sha256:`; digest not verifiable offline here. |
| 7 | Medium | `nightly-production.yml:149` | `npx --yes @lhci/cli@0.14.0` installs the unlocked transitive tree at run time. | Vendor a lockfile or install from a locked `tests/` dependency. |
| 8 | Medium | `security.yml:50` | `pip install semgrep==1.183.0` pinned but without hashes. | `--require-hashes` with a requirements file. |
| 9 | Medium | all `npm ci` steps (e.g. `deploy-cloudflare.yml:79`) | Install scripts run (esbuild, workerd, fsevents) in the job that holds the production token. All are well-known binary-fetch scripts; lockfiles have integrity hashes and only registry.npmjs.org URLs. | `npm ci --ignore-scripts` is possible for tests/, but wrangler's workerd/esbuild need their postinstall, so leave as is. Low practical risk. |
| 10 | Low | `pr-preview-cloudflare.yml:46` | `${{ github.event.pull_request.head.repo.full_name }}` is interpolated into a `run:` script. GitHub restricts that charset, so not exploitable today. | Pass via `env:`. |
| 11 | Low | `preview-tests.yml`, `pr-preview-cloudflare.yml`, `security.yml` top-level `permissions:` | `pull-requests: write` / `issues: write` are granted at workflow level to jobs that only read (e.g. unit, stamps). Every workflow does have a `permissions:` block, so the default is not write-all. | Move write scopes to the jobs that comment. Not done: each job's API use needs checking per job. |
| 12 | Low | `vendor/three.module.min.js`, `vendor/embedded-app-sdk.mjs` | Vendored third-party code with licence files present, but no recorded source version or checksum. | Add a `vendor/README` with version and sha256 and compare to the npm tarball. |
| 13 | Info | licences | infrastructure lockfile (91 pkgs): MIT 51, Apache-2.0 20, LGPL-3.0-or-later 10 (sharp's prebuilt libvips, `@img/sharp-libvips-*`, optional, dev-only, not shipped), others permissive. tests (6 pkgs): MPL-2.0 (playwright-core family), Apache-2.0, MIT, ISC. Nothing is shipped to users from npm. |  |

## Fixed in this branch (`cloud/supply-chain`)

- Added `persist-credentials: false` to the 19 `actions/checkout` steps that did not set it (the other 2, in `flake-rerun.yml` and `security.yml`, already did). Reasoning: checkout otherwise leaves the job's `GITHUB_TOKEN` in `.git/config` for every later step, including steps that run PR-controlled code (`npm ci`, tests) and the deploy job. No workflow step runs `git fetch/push/pull/commit` (grepped; the `gh` calls authenticate with `GH_TOKEN`/`GITHUB_TOKEN` env, not git config), so behaviour is unchanged. YAML parses; `tests/unit/workflow-secrets.test.mjs` passes 36/36.

## Checked and fine

- **Action pinning:** all 3rd-party actions are pinned by full SHA with a version comment: `actions/checkout` 11bd719…(v4.2.2), `setup-node` 39370e3…(v4.1.0), `upload-artifact` b4b15b8…(v4.4.3), `download-artifact` fa0a91b…(v4.1.8), `github-script` 60a0d83…(v7.0.1), `codeql-action/upload-sarif` f09c1c0…(v3.27.5). The first-party SHAs are consistent across all workflows and match the pins documented in `preview-tests.yml:26-30`. Only `actions/*` and `github/*` are used; no other publishers.
- **`pull_request_target`:** not used. `workflow_run` is used once (`flake-rerun.yml`); it checks out the default branch with `persist-credentials: false`, is limited to same-repo `pull_request` failures, and does not run PR code.
- **Fork PRs:** preview and spin-up jobs require `head.repo.full_name == github.repository`; forks only run the policy step and get no secrets under `pull_request`.
- **Production deploy:** triggered by push to master/`workflow_dispatch`, guarded by `if: github.ref == 'refs/heads/master'`, `environment: production`, `contents: read`. The Cloudflare token is not written to Worker secrets (comment at `deploy-cloudflare.yml:351`; enforced by `tests/unit/workflow-secrets.test.mjs`), and Worker secrets come only from the deploy job. The token is exported via `GITHUB_ENV` (lines 157, 223), which is masked in logs.
- **Artifacts:** logs and reports only, 14-day retention; no credentials uploaded (paths are log/report files). `download-artifact` reads `preview-test-logs-*` in the same run only.
- **Lockfiles:** `npm ci` everywhere; both lockfiles have integrity hashes and no non-registry sources. `wrangler` is exactly pinned.
- **Secret history scan:** regex scan of `git log --all -p` added lines for AWS, GitHub, Anthropic/OpenAI/Groq/Google keys, Slack, Discord webhook/bot token, JWT, private-key blocks and `key/secret/token/salt = "<24+ chars>"` assignments. No real-looking AWS/GitHub/Google/Slack/Discord/JWT/private-key hits. Hits were only `sk-ant-` strings and quoted salt/key/admin literals in test files (`tests/unit/ai-keys-evasion.test.mjs`@1526e86, `voice-eval-runner.test.mjs`@2564d01, `party-cache-purge.test.mjs`@14c1bbf, `sheet-level.test.mjs`@74fa554, a dozen test files and `tools/restore-drill.mjs`@05f8475). They sit in unit tests that describe their values as made-up/FAKE; I treated them as fixtures but did not verify against any provider. No `.env`, `.pem`, `.dev.vars` or key files are tracked.

## Could not verify

- Scope/permissions of `CLOUDFLARE_API_TOKEN` and which secrets exist at repo vs `production` environment level (needs repo admin; `tools/check-secret-scope.sh` does this).
- Branch protection, required reviewers on the `production` environment, "Require approval for outside collaborators" setting, and GitHub secret-scanning/push-protection status.
- Whether the `sk-ant-` and quoted salt/key literals in tests are inert (judged from test context only).
- Provenance/version of `vendor/*` files; ZAP image digest; hash verification for pip/lhci.
- `npm audit` ran against the registry via the proxy; advisories are as of the run date and the "fix versions" were not installed or tested.
