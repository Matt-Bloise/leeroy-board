# Preview tests

Automated checks that run against a pull request's preview environment (Cloudflare Pages + Worker). They make no AI calls at all (free Workers AI has a very low rate limit) and use no AI keys.

- `api/api.test.mjs`: 8 checks with `node:test` and global `fetch` (health, bootstrap, state, CORS, auth refusal, Discord signature refusal, library index, WebSocket).
- `browser/live-smoke.mjs`: 74 browser checks in Chromium and WebKit at 390x844 (touch) and 1366x768. Firefox is not used.
- `browser/smoke-retry.mjs`: the retry decision. A check that fails once and passes on a second visit is a warning, not a failure.

## Run locally

Needs Node 22 or newer.

```
cd tests
npm install
npx playwright install chromium webkit
```

Set three environment variables. Use the preview URLs from the `cloudflare-pr-preview` comment on the pull request.

| Variable | Meaning |
| :--- | :--- |
| `PREVIEW_API` | Worker origin, for example `https://leeroy-brain-pr-13.<account>.workers.dev` |
| `PREVIEW_PAGES` | Pages origin, for example `https://pr-13.leeroy-board.pages.dev` |
| `BOARD_ADMIN_TOKEN` | The admin token the preview Worker was deployed with. Take it from your secret store. Never commit it or paste it into a file. |

Then:

```
npm run test:api
npm run test:browser -- --url "$PREVIEW_PAGES/"
```

The browser run takes about a minute. Exit code 0 means every check passed.

## CI

`.github/workflows/preview-tests.yml` runs both suites on every pull request from a branch of this repository (not forks). It waits for the preview comment, waits for the preview to answer, runs the tests with the `BOARD_ADMIN_TOKEN` repository secret, uploads logs, and posts a summary comment marked `<!-- preview-tests -->`.
