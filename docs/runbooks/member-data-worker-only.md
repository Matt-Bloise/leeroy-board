# Member data is Worker-only

The files that describe the group's members are never published as static files. `https://leeroy.party/data/party.json` (and `decide`, `tonight`, `guided-atlas`, `client`, and the sign-ups in `signups`) answer 404. The page reads those documents from the Worker (`/api/data/<name>`, `/api/bootstrap`, `/api/state`), which removes what a member hides at read time (`infrastructure/worker/public-party.js`). A static copy would hand out the whole document whatever a member hides.

## What keeps it that way

- `tools/pages-bundle.mjs` is the only thing that stages the Pages bundle. `deploy-cloudflare.yml` (production) and `pr-preview-cloudflare.yml` (preview) both run `node tools/pages-bundle.mjs .cloudflare-dist`, so they cannot drift. It copies the site as before, leaves out `PRIVATE_DATA_FILES`, ships `data/atlas/links.json` without its `start_zone` records (`STRIPPED_FILES`), and ends with an assertion that fails the deploy step (exit 1, before `wrangler pages deploy`) if a private path is in the output.
- `tools/static-server.mjs` (local browser runs) applies the same list, so a page or test that reads a private file over HTTP fails on a laptop too.
- `tests/unit/pages-bundle.test.mjs` pins the list, that both workflows use the script, a simulated bundle with no private path and no member field next to a member name, that the final assertion fires, and the static server's 404s. `tests/api/api.test.mjs` checks the real preview Pages origin answers 404 for each file.
- The files stay in the repository: the Worker seeds D1 from them in CI (`infrastructure/scripts/seed-d1.mjs`, from the checkout, not from the bundle) and bundles `data/client.json` as its default document (`infrastructure/worker/default-docs.js`). Only publishing them is removed.
- The page has no static fallback for them (`js/board.js` `apiFetch`, `scenes/decide.js`, `scenes/guided-atlas.js`): with no Worker answer it shows "This part of the board could not load. Try again in a moment."
- Browser suites get these documents from the API stub (`tests/helpers/api-stub.mjs`, from the checkout and `tests/fixtures/api-snapshot`) or the local Worker, never from a static URL. The stub and the recorded snapshot carry fictional member names (`tests/helpers/fictional-party.mjs`); re-record with `tools/local-browser.sh record-fixtures`, which applies the same swap.

## Add a new private data file

1. Add its repo path to `PRIVATE_DATA_FILES` in `tools/pages-bundle.mjs` (a file that also holds public records the page needs: add a reducer to `STRIPPED_FILES` instead, and recompute any counts it derives).
2. Serve it from the Worker only: add the name to `PUBLIC_DATA_DOCS` (`public-docs.js`) and to `MEMBER_DOCS` and `projectDataDoc` (`public-party.js`) so it passes the privacy projection; read it in the page through `dataGet` / `BoardFetch`, never `fetch("data/<name>.json")`.
3. Add the path to `EXPECTED_PRIVATE` in `tests/unit/pages-bundle.test.mjs` (the test fails until you do; it also fails when a `MEMBER_DOCS` document other than `launch` is missing from the list. `launch` is published on purpose, its repo copy has no member rows, and a test checks that. The list is not pinned equal to `MEMBER_DOCS`: it also holds `signups`), and to the 404 list in `tests/api/api.test.mjs`.

## Not covered here

- The Worker's `/api/atlas/links` still carries the `start_zone` records (no projection yet); only the static copy is reduced.
- Files stay in git history, and in the repository on GitHub, whatever the bundle holds.
- Older Pages deployments are not touched. Per-deployment URLs and `pr-N` preview aliases that were published before this change keep serving the old files until those deployments are deleted (a production action for the owner), and an open PR on an older branch republishes them on its next preview deploy: rebase it onto master.
- `/data/*` is cached for `max-age=300` (`_headers`), so a copy fetched shortly before a deploy can be served for up to five minutes after it.
