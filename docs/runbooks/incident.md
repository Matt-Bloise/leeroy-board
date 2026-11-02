# Runbook: incident response

Last checked: 2026-11-02. Citations are `file:line` in this repository, Cloudflare/GitHub docs URLs, or marked (unverified).

## Severity levels

| Level | Definition | Target response | Example |
| :--- | :--- | :--- | :--- |
| SEV1 | Site or API down for everyone, data loss or corruption, or a leaked secret | Start now; mitigate within 1 hour | `GET /api/health` fails, D1 rows wrong, token exposed |
| SEV2 | Major feature broken or degraded for many users, with a workaround | Same day | Ask Leeroy fails, WebSocket `/live` down, sign-ups not saving |
| SEV3 | Minor defect, cosmetic, one scene or one user | Next working day, normal PR | Layout bug on one device |

These targets are proposed defaults, not commitments found in the repo. The owner may change them.

## First 10 minutes

1. Confirm it is real. Open https://api.leeroy.party/api/health (public health route, `infrastructure/README.md:29`) and https://leeroy.party/. Note HTTP codes and the time (UTC).
2. Classify the severity. If a secret may be exposed, treat as SEV1 and go to `secrets.md` rotation steps now.
3. Find the last change. `gh run list --repo <owner>/leeroy-board --workflow "Deploy Site & Serverless Backend to Cloudflare (Production)" --limit 5` and `git log -5 master`. Production deploys on every push to `master` (`.github/workflows/deploy-cloudflare.yml:3-6`).
4. Stop further change. If a bad commit is on `master`, pause deploys (below) before anything else merges.
5. Tell people (below). Post one line: severity, symptom, start time, who is driving.
6. Mitigate with the smallest reversible step from `rollback.md` (decision table). Do not debug live in production.
7. Write notes as you go: timestamp, action, result. They become the postmortem timeline.

## Who to tell

- The owner: always, for SEV1 and SEV2. The owner is the only person who merges changes rated 6 or higher (`CONTRIBUTING.md:7`). Who holds the Cloudflare account and repository settings is unverified; assume the owner.
- The partner (outside collaborator who contributes through PRs): tell if the incident involves an open PR, a recent merge of theirs, or an area they work in.
- Members of the group: a short plain-language note in the group channel for SEV1 and SEV2 when the board is unusable. No technical detail, no secrets.

Contact details are deliberately not in this repository. Keep them in the owner's private notes.

## Where to look

| Source | What it shows | How |
| :--- | :--- | :--- |
| Cloudflare dashboard, Workers & Pages, `leeroy-brain`, Metrics / Deployments | Request and error rates, which version is live, deploy times | Dashboard |
| Cloudflare dashboard, Workers & Pages, `leeroy-board`, Deployments | Pages production deployment history | Dashboard |
| Cloudflare dashboard, D1, `leeroy-board-db` | Tables, console, Time Travel bookmarks | Dashboard |
| Live log tail | Real-time Worker invocations and exceptions | `cd infrastructure && npx wrangler tail leeroy-brain --status error --format pretty` (flags confirmed with `--help`, wrangler 3.114.17) |
| GitHub Actions | Deploy and preview-test runs, failing step, timestamps | https://github.com/<owner>/leeroy-board/actions (the repository Actions tab) |
| Preview Tests comment on the PR | Unit, stamps, API and browser results for a head sha (`<!-- preview-tests -->`, `.github/workflows/preview-tests.yml:187-195`) | PR page |
| AI Gateway `leeroy-ai-gateway` | Provider errors and cache for AI calls (`infrastructure/wrangler.toml:43`) | Dashboard, AI Gateway |
| Mission control page | Not present in this repository (searched the tree for "mission control" on 2026-11-02, no match). If the owner runs one elsewhere, link it here. | |

`wrangler.toml` has no `[observability]` block (`infrastructure/wrangler.toml:1-61`), so persisted Workers Logs are not enabled by configuration. Whether they are on in the dashboard is unverified. `wrangler tail` is live only and keeps nothing; capture what you need while it runs.

Admin-only health detail (provider and AI budget) needs the admin token (`infrastructure/README.md:29`); do not paste it into chat or tickets.

## Pause merges

Production deploys are triggered only by a push to `master` (`deploy-cloudflare.yml:3-6`); there is no `workflow_dispatch` trigger. Pause options, least to most drastic:

1. Disable the production deploy workflow (verified to exist and be active on 2026-11-02 via the GitHub API, workflow id 403954602). Requires repository admin rights:
   ```
   gh workflow disable 403954602 --repo <owner>/leeroy-board
   gh workflow enable  403954602 --repo <owner>/leeroy-board     # to resume
   ```
   Merges still land on `master` but nothing deploys. Resume deliberately: the next push deploys everything merged in the meantime. Because the workflow has no `workflow_dispatch`, redeploying after enabling needs a new push or a re-run of the last run in the Actions UI.
2. Tell the partner and any contributor to stop merging and to hold their open PR. Under `CONTRIBUTING.md:6-7` anything rated 6 or higher is merged only by the owner anyway.
3. Branch protection or rulesets would give a hard stop, but none exist: the API returns "Branch not protected" for `master` (checked 2026-11-02). Adding protection is a recommended follow-up (`secrets.md`, weakness table).

Closing PRs is also needed to free preview slots; teardown runs on close (`.github/workflows/pr-preview-cloudflare.yml:333-335`), and the account holds 9 previews in total (`CONTRIBUTING.md:6`).

## Resolve

- Mitigated: the symptom is gone, verified by repeating step 1 and a normal user action (open the board, load `/api/bootstrap`).
- Resolved: root cause known, permanent fix merged through a PR with a test (`CONTRIBUTING.md:11`), deploy workflow re-enabled.
- Label causes confirmed, likely or speculative; do not declare a root cause without direct evidence.

## Postmortem template

Write within 3 working days for SEV1 and SEV2. Blameless: describe systems and decisions, not people. Do not include secret values, personal contact details, or member names.

```
# Postmortem: <short title>   (date, severity)

Summary: one paragraph. What broke, for whom, how long.
Impact: users affected, data affected, duration (UTC start, detect, mitigate, resolve).
Detection: how we found out; time from start to detection.

Timeline (UTC): hh:mm event / action / result, one per line.

Root cause: confirmed | likely | speculative, with evidence (log line, run URL, commit sha).
Contributing factors: process or tooling gaps (for example no branch protection, no staging data).
What went well / what went badly / where we got lucky.

Rollback used: Pages | Worker | D1 | revert PR | none. Did it work, how long did it take.
Data impact: rows lost or changed, restore point used (bookmark), verification done.

Action items (each with owner and PR or issue link):
- [ ] prevent: ...
- [ ] detect: ...
- [ ] mitigate faster: ...
Runbooks updated: which files.
```
