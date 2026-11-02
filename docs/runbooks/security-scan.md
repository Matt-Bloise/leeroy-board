# Runbook: security scan

Workflow: `.github/workflows/security.yml`. It is report only: no step can fail a pull request and it must not be added as a required check until the noise is under control.

## What runs

| Scan | When | What | Output |
| :--- | :--- | :--- | :--- |
| Semgrep 1.183.0, rules `p/javascript` and `p/owasp-top-ten`, no login, metrics off | every non-fork PR, and weekly (Monday 05:17 UTC) on `master` | static analysis of the whole repo | artifact `security-semgrep` (SARIF), code scanning alerts under category `semgrep` |
| OWASP ZAP baseline 2.16.0 (passive, no attack traffic) | every non-draft, non-fork PR | the Pages preview URL, found from the `<!-- cloudflare-pr-preview -->` comment that names the head sha, the same way `preview-tests.yml` does | artifact `security-zap` (`zap.html`, `zap.json`) |

One comment, marked `<!-- security-scan -->`, is created on the first run and edited on every later push. Permissions are `contents: read`, `pull-requests: write`, `security-events: write`; no secrets are used. Fork PRs and draft PRs skip the scans that need a write token or a preview.

SARIF upload needs code scanning to be available for the repo. If it is not, that step fails quietly (`continue-on-error`) and the artifact still has the SARIF file.

## Triage

1. Open the summary comment, then the run and the artifact for detail. A ZAP finding names the URL and the alert; a Semgrep finding names the rule and `file:line`.
2. Decide per finding, within the PR that introduced it where possible:
   - Real: fix in the PR, or open a follow-up item and link it in the PR. Rate the PR's risk accordingly (auth, secrets, input handling raise it).
   - False positive: note why in the PR. For Semgrep add `// nosemgrep: <rule-id>` with a one-line reason on the line; for a rule that is wrong everywhere, add it to a `.semgrepignore` or exclude it in the workflow in a dedicated PR.
   - Accepted risk: record it in the PR and, if lasting, in `docs/adr/`.
3. ZAP baseline is passive, so missing security headers, cookie flags and information leaks are the usual alerts. Header fixes belong in the Pages `_headers` file or the Worker responses. Alerts about `*.pages.dev` or `*.workers.dev` platform behaviour are not ours to fix.
4. The weekly run reports through code scanning alerts only (no PR to comment on). Review them weekly; dismiss false positives in the GitHub UI with a reason.
5. A finding that is an exploitable secret exposure or auth bypass is an incident: follow `incident.md` and `secrets.md`, do not discuss details in a public PR.

## Changing the scan

- Pin everything: actions by commit sha with the version in a comment, semgrep by `==version`, the ZAP image by version tag. Bump them deliberately in their own PR.
- Making it gating is a separate decision: remove `continue-on-error` on the scan steps and mark the job required only after a few weeks of clean-enough baselines.
- Rollback: revert the commit that added or changed the workflow; nothing else depends on it.
