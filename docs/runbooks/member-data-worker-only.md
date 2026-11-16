# Member data is Worker-only

The files that describe the group's members are never published as static files. `https://leeroy.party/data/party.json` (and `decide`, `tonight`, `guided-atlas`, `client`, and the sign-ups in `signups`) answer 404. The page reads those documents from the Worker (`/api/data/<name>`, `/api/bootstrap`, `/api/state`), which removes what a member hides at read time (`infrastructure/worker/public-party.js`). A static copy would hand out the whole document whatever a member hides.

## What keeps it that way

- `tools/pages-bundle.mjs` is the only thing that stages the Pages bundle. `deploy-cloudflare.yml` (production) and `pr-preview-cloudflare.yml` (preview) both run `node tools/pages-bundle.mjs .cloudflare-dist`, so they cannot drift. It copies the site as before, leaves out `PRIVATE_DATA_FILES`, ships `data/atlas/links.json` without its `start_zone` records (`STRIPPED_FILES`), and ends with an assertion that fails the deploy step (exit 1, before `wrangler pages deploy`) if a private path is in the output.
- `tools/static-server.mjs` (local browser runs) applies the same list, so a page or test that reads a private file over HTTP fails on a laptop too.
- `tests/unit/pages-bundle.test.mjs` pins the list, that both workflows use the script, a simulated bundle with no private path and no member field next to a member name, that the final assertion fires, and the static server's 404s. `tests/api/api.test.mjs` checks the real preview Pages origin answers 404 for each file.
- A Pages Function answers 404 for those paths itself (`pages-worker/`, staged as `_worker.js/`, with a `_routes.json` that routes only the six paths, each with and without `.json`). It sends `Cache-Control: no-store` and never asks the asset layer, on every hostname of the deployment. See "The stale copy" below for why "not published" was not enough. `assertBundleClean` fails the deploy step if the Function folder or the routes are missing or altered; `tests/unit/pages-worker.test.mjs` pins the 404, the pass-through and the path rules.
- The production probe (`tests/browser/prod-probe.mjs`, after every deploy and daily) asks `https://leeroy.party` and `https://leeroy-board.pages.dev` for each private path, bare and cache-busted, and FAILS on any 2xx (status lines only, never a body). The API host is not checked: `api.leeroy.party/api/data/party` is the Worker route and answers 200 on purpose.
- The files stay in the repository: the Worker seeds D1 from them in CI (`infrastructure/scripts/seed-d1.mjs`, from the checkout, not from the bundle) and bundles `data/client.json` as its default document (`infrastructure/worker/default-docs.js`). Only publishing them is removed.
- The page has no static fallback for them (`js/board.js` `apiFetch`, `scenes/decide.js`, `scenes/guided-atlas.js`): with no Worker answer it shows "This part of the board could not load. Try again in a moment."
- Browser suites get these documents from the API stub (`tests/helpers/api-stub.mjs`, from the checkout and `tests/fixtures/api-snapshot`) or the local Worker, never from a static URL. The stub and the recorded snapshot carry fictional member names (`tests/helpers/fictional-party.mjs`); re-record with `tools/local-browser.sh record-fixtures`, which applies the same swap.

## The stale copy (found 2026-11-15)

After the files left the bundle (PR 374) and every old deployment was deleted (PR 383, 291 of 291), `https://leeroy.party/data/{party,decide,tonight,guided-atlas,client,signups}.json` still answered 200 with the old bytes. Evidence class in brackets.

What was measured (confirmed, `curl -D -`, 2026-11-15 and 16):
- `200`, `content-type: application/json`, `cf-cache-status: DYNAMIC`, an `Age` of 28,000 to 146,000 seconds that differs by edge node and keeps rising (31170, 31245, 31251 over ten seconds: never refreshed), `Cache-Control: public, max-age=300, stale-while-revalidate=3600` (the `/data/*` rule in `_headers`), and one fixed `ETag` per file (`If-None-Match` answers 304). `GET` and `HEAD` of one URL seconds apart answered with different `Age`: several copies in different places.
- The stale answers carry `x-robots-tag: noindex`; the current deployment's public files (`/data/timeline.json`) do not. [likely: the object came from a non-production deployment's response, not from the production deployment.]
- Only the exact path hits it: `?x=1`, a bare `?`, `/data/Party.json`, `/data/party.json/`, `//data/party.json`, `/data%2Fparty.json`, `/data/%70arty.json`, `/data/party` and `www.leeroy.party` all answered the current deployment's 404 (`Cache-Control: no-store`, `text/html`). Forms the server normalises before lookup (`/data/./party.json`, `/data/../data/party.json`) hit the stale object. `leeroy-board.pages.dev` showed both 404 and `CF-Cache-Status: HIT` with the same `ETag`, depending on the edge node.
- A dashboard "Purge Everything" on the leeroy.party zone changed nothing (reported by the owner). Together with `cf-cache-status: DYNAMIC` this says the zone cache is not what answers.

Which layer (likely, not proven): Pages' own built-in asset cache, which is separate from the zone cache. Cloudflare's Pages docs ("Serving Pages") say assets are inserted per data center, stay cached "until your next deployment", have a TTL of one week and "can also disappear at any time", and that a zone cache rule "is separate from Pages' built-in caching". Deleting deployments did not evict the entries. If that is the layer, each copy ends by itself at the latest one week after it was inserted; the oldest `Age` seen was about 40 hours. [speculative: the one-week figure; nothing was measured to confirm an entry ever expires early.]

Why a Function should help (docs: confirmed; custom domain: not yet measured):
- Docs: a Function route is run first and "if no Function is matched, it will fall back to a static asset"; a Function "is required to make or forward requests to your project's static assets" (advanced mode) through `env.ASSETS.fetch()`, so a Function that answers itself never reaches the asset layer. `_routes.json` include rules run it only for the listed routes; asset requests that do not invoke it stay free. Requests to a Function are billed as Workers requests.
- Measured locally (wrangler 4.148.0 `pages dev`, workerd, the staged bundle): the six paths, with and without `.json`, a trailing slash or a query, answer the Function's 404 (`text/plain`, `no-store`); public data files pass through. Routes there are exact and case-sensitive: `/data/Party.json`, `//data/party.json` and `/data/%70arty.json` do not reach the Function and get the asset 404. That is harmless only because no asset exists at those paths and the measurements above show only the exact path was ever cached.
- NOT measured: that the production routing layer sends `leeroy.party/data/party.json` to the Function before the cached asset. It should (the zone cache is not involved, see above), but only a request after the deploy can show it. The check is below.
- Docs: `_headers` does not apply to a Function's own responses, so the Function sets `Cache-Control: no-store` itself.

Check after a deploy (expected: `404`, `text/plain`, `no-store`, no `Age` line, for all 12 lines; a `200` with `application/json` and an `Age` is the stale copy and means the Function did not take over on that hostname):

```
for n in party decide tonight guided-atlas client signups; do for h in https://leeroy.party https://leeroy-board.pages.dev; do
  echo "$h $n: $(curl -s -o /dev/null -D - "$h/data/$n.json" | tr -d '
' | grep -i -E '^(HTTP|age|content-type|cache-control)' | tr '
' ' ')"
done; done
curl -s -o /dev/null -w "public data still served: %{http_code}
" https://leeroy.party/data/timeline.json   # 200
```

What a Function cannot fix: on the Workers Free plan, when the daily allowance (100,000 requests, shared with the API Worker) is exhausted, Pages Functions by default "fail open": static assets are served "even if Pages Functions would ordinarily have run first". The stale copy would then answer again until the reset at 00:00 UTC. Action for the owner: Cloudflare dashboard, Workers & Pages, `leeroy-board`, Settings, Runtime, set Fail open / closed to **Fail closed**. With the narrow routes only the six private paths would then answer an error page; every other asset is unaffected.

What only the dashboard or a token can do (nothing here changes a token or a setting):
1. The deploy token needs **Zone > Cache Purge > Purge** and **Zone > Zone > Read**, scoped to leeroy.party, for the purge step of `pages-prune.yml` (docs/runbooks/pages-prune.md). Without them that step prints `cache purge skipped` and does nothing. Note that a zone purge is not expected to remove a copy held by Pages' own cache (see above); it clears the zone cache, which the measurements say is not holding these.
2. Fail closed (above).
3. If the Function does not remove the stale answer on the real domain: Cloudflare support (the object is in a layer the zone and the account cannot purge), or detach and re-attach the `leeroy.party` custom domain in the Pages project, or wait for the entries to expire (at most about a week from insertion, likely). Do not delete the Pages project: the production deployment and the domains go with it.

## Add a new private data file

1. Add its repo path to `PRIVATE_DATA_FILES` in `pages-worker/private-paths.mjs` (the one list: the bundler, the local static server, the prune tool, the Pages Function, its routes and the probe all read it; a file that also holds public records the page needs: add a reducer to `STRIPPED_FILES` instead, and recompute any counts it derives).
2. Serve it from the Worker only: add the name to `PUBLIC_DATA_DOCS` (`public-docs.js`) and to `MEMBER_DOCS` and `projectDataDoc` (`public-party.js`) so it passes the privacy projection; read it in the page through `dataGet` / `BoardFetch`, never `fetch("data/<name>.json")`.
3. Add the path to `EXPECTED_PRIVATE` in `tests/unit/pages-bundle.test.mjs` (the test fails until you do; it also fails when a `MEMBER_DOCS` document other than `launch` is missing from the list. `launch` is published on purpose, its repo copy has no member rows, and a test checks that. The list is not pinned equal to `MEMBER_DOCS`: it also holds `signups`), and to the 404 list in `tests/api/api.test.mjs`.

## Not covered here

- The Worker's `/api/atlas/links` still carries the `start_zone` records (no projection yet); only the static copy is reduced.
- Files stay in git history, and in the repository on GitHub, whatever the bundle holds.
- Older Pages deployments were deleted on 2026-11-15 (`pages-prune.yml`). An open PR on an older branch republishes the files to its preview on the next preview deploy: rebase it onto master. Its preview now also carries the Function.
- `/data/*` is cached for `max-age=300` (`_headers`), so a copy fetched shortly before a deploy can be served for up to five minutes after it. The private paths are answered by the Function with `no-store` and are not cached.
- Pages Function requests count as Workers requests on the free plan (docs/runbooks/cloudflare-requests.md). Only the private paths are routed to it, and the site never requests them (it reads the Worker), so ordinary traffic costs nothing; the probe adds 24 per run (72 at the most with retries).
