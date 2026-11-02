# Contributing

This repo is the home of the Leeroy board: the site (Cloudflare Pages), the Worker and Durable Object (`infrastructure/`), the D1 schema and the tests (`tests/`). Production is https://leeroy.party and https://api.leeroy.party. Every merge to master deploys.

## How a change goes in
1. One branch per change, one pull request per branch. One open PR per contributor at a time (Cloudflare has 9 preview environments in total).
2. The PR states a risk rating from 0 to 10 (see the PR template). The rating sets the testing effort and who merges: 0 to 5 merges after the preview tests are green; 6 or higher waits for a manual merge by the owner. A rating is computed from the changed paths first and only ever raised.
3. Every PR gets its own preview environment and the `Preview Tests` workflow: a back-end suite (API input and output) and a front-end suite (layout, rendering, animation, display). New behaviour comes with tests in `tests/`.
4. Tests make no AI calls (free Workers AI has a very low rate limit). Discord interactions cannot be tested in a preview and are checked on production after merge.
5. Every PR states how to roll back: Pages previous deployment, `wrangler rollback`, D1 Time Travel, or a revert.

We accept a before and after number on a stated device (frame time, long animation frames, bytes, render counts) for performance changes. No secrets in the repo, and no first names or Discord ids in code or copy.

## Contributions

The code and art are copyright Matt Bloise, all rights reserved (see LICENSE.md). By opening a pull request you confirm that you wrote the change, or have the right to submit it, and you grant Matt Bloise a perpetual, worldwide, royalty-free licence to use, modify and relicense it. You are credited in the commit.
