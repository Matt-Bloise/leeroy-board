## What changed and why

## Risk rating (0-10)
<!-- 0 typo or docs, 3 CSS or copy, 5 front-end logic in one scene, 7 cross-scene or API behaviour that keeps its contract, 8-10 auth, D1 schema or migrations, secrets, Durable Object, workflows, wrangler.toml, Discord handler, rate limits. Computed from the changed paths first; raise it, never lower it. -->
Risk rating: N of 10

## Evidence
<!-- preview-tests result (front end and API), what you exercised in the PR preview. No AI calls in tests. Discord cannot be tested in a preview: say so if relevant. -->

## Rollback
<!-- Pages: promote the previous deployment. Worker: wrangler rollback. D1: Time Travel restore. Or: revert this commit. -->

## Merge rule
Rated 0-5: merge after preview-tests are green. Rated 6 or higher: wait for a manual merge by the owner after review.
One of our PRs open at a time; Cloudflare supports 9 preview environments in total.
