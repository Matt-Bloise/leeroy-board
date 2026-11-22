# Visual baselines (gating)

`tests/browser/visual-baseline.mjs` screenshots the board and compares every shot with a PNG committed in `tests/browser/baselines/`. It is a **gate**: the job `visual` in `.github/workflows/preview-tests.yml` fails, and the result comment cannot say `passed`, when a screen changed and its new baseline is not committed in the same PR.

## What is shot

30 screens: 15 screens at each of the two sizes the board is built for, phone first.

| Size | Context |
| :--- | :--- |
| `390x844` | touch, `isMobile`, device pixel ratio 1 |
| `1366x768` | desktop, device pixel ratio 1 |

| Screen | How the suite reaches it |
| :--- | :--- |
| `first` | the first visit (`?preview=1`): the first-visit sheet with "Open the Discord card" and "Just take a look" |
| `wall` | "Just take a look", then Next steps closed: the wall of tiles |
| `tonight` | "Just take a look" opens Next steps |
| `timeline`, `five`, `roads`, `racials`, `legacy`, `buffs`, `ledger`, `signups`, `librarian`, `library`, `decide` | from the wall, the **Everything** journey is chosen with the switch in the header (two taps on the phone, where the first only opens the switch), then `window.__boardKit.goScene(<scene>)` |
| `landing` | `landing/` |

The board's default journey, Guided, shows only the core of each scene (`css/v13d.css` hides the rest), which would leave most of every panel out of the baselines: the maps, grids, tables and cards the visual work is about. So the scenes are shot in Everything. The first screen, the wall and Next steps are shot as a first visitor sees them, in Guided. The suite taps the switch like a visitor does, and a scene is only shot once its panel is open, shown, has text, and does not carry the "could not load" line.

The scene list is read from the page (`window.__boardKit.SCENES`), so a new scene is a screen without a baseline and fails until one is committed. A baseline that no screen produces (a removed scene) fails too. File names: `<screen>-<size>.png`.

## The pinned backend

Every input that is not the page's own code is fixed, so a commit is meant to render the same pixels on every run (calibration below measures how true that is):

- The site is the checkout itself, served by `tools/static-server.mjs` (the rules of `_headers`, the private member files answer 404, as on Pages). No preview, no secret.
- `/api/` is answered from `tests/fixtures/api-snapshot` (`stubbed()`, zero Worker requests). Member names in the fixtures are made up (`tests/helpers/fictional-party.mjs`).
- Chromium from `tests/package-lock.json` (Playwright 1.49.1) on `ubuntu-24.04`.
- `prefers-reduced-motion: reduce`, light scheme, time zone UTC, locale `en-US`, service workers blocked, `Math.random` seeded.
- The page clock is pinned (`tests/helpers/clock-arg.mjs`) and **paused before the page exists**. Only the suite moves it, in the same fixed steps in every run (`SCHEDULE` in the file: after the load, after "Just take a look", after closing, after opening a scene, then a 12 s flush that covers the wall's 10 s settle). The network goes quiet between steps. The launch countdown therefore shows the same seconds in every run, and every timer, idle callback and animation frame fires in the same order against the same page.
- Taps are dispatched events (`pointerdown`, `pointerup`, `click`) on the element. No pointer is moved, so nothing is left hovered and the light, which follows the pointer, stays where the page puts it.
- Then the final settle. The page's `Date` is frozen where the schedule left it, so the countdown cannot change, while timers, idle callbacks and frames keep running in 250 ms steps of page time. A shot counts once three rounds in a row, each with the network quiet and the on-screen `<img>` elements downloaded and decoded, give byte-identical screenshots with no request in between (up to 48 rounds). CSS background art (paper, wood, banners) is covered by the network going quiet: asking for it again from the page (`new Image()`) sends requests of its own, which on CI's Chromium kept every round busy (measured 2026-11-22: 20 requests for 28 background URLs). Work that needs real time as well as timers therefore finishes instead of being frozen half-done: the light's shader compiles in the GPU process and is polled every 16 ms.

**Canvases are not masked.** The full-viewport `#wisps` canvas, the WebGL wall light `#light` (on the wall screens) and the cloth ribbons `#tab-cloth` (the banners above each scene) are in the shots as drawn. The former non-gating version masked `canvas`, `.candle` and anything with `moon` in its class in magenta. `.candle` and `#wisps` cover the whole viewport, so its first-screen shot was a solid magenta rectangle: a baseline that could never fail.

## A broken page never becomes a baseline

A screen fails, in compare mode and when baselines are written, when:
- the page did not reach the state the step asked for (the first-visit sheet, Next steps, the wall, the scene open with text in it);
- it threw a page error, logged a console error, or asked the API for a path the fixtures lack (`stubbed()` fails the run);
- a file of this site answered 4xx or 5xx, or a request to the site failed (a missing stylesheet, script, texture or banner). `/favicon.ico` is left out: Chromium asks for it by itself, the landing page declares no icon, and the host answers 404 there too. Failed loads of other origins are left out too: they differ between runners and change no pixel of the page;
- a scene panel shows "This part of the board could not load";
- the screenshot is nearly blank (fewer than 16 colours in a sample);
- it shows a real member name. The names are read from `data/party.json` at run time and never printed: the check looks at the page text, `aria-label`, `title`, `alt`, `placeholder` and input values.

`tests/unit/visual-baseline-gate.test.mjs` checks the committed set in every unit run. Every PNG decodes at its size, the set is exactly the screens times the sizes (scenes read from `js/board.js`), and none is nearly blank or more than 1 percent magenta. It also checks the PNG codec, the pixel diff, the threshold boundaries, the workflow wiring and the report logic.

## The threshold

A pixel is changed when any channel differs by more than **8 of 255**. A screen fails when more than **0.2 percent** of its pixels changed: 658 pixels at 390x844, 2,098 at 1366x768. A size change always fails. The comparison runs in Node on the decoded files (`tests/helpers/png.mjs`, `tests/helpers/pixel-diff.mjs`), not in a browser canvas.

Calibration, 2026-11-22: 0.2 percent was the starting threshold from outside advice. Repeat shots on the pinned backend put the noise far below it, so it stays.

| Where | Runs | Screens | Shots each | Pixels beyond 8/255 | Largest channel step |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Local, between shots | 1 | 30 | 3 | 0 | 1 |
| CI Intel Xeon 6975P-C, between shots | 2 | 30 | 2 to 3 | 0 | 3 |
| CI Intel Xeon 6975P-C, against the committed baselines | 3 | 30 | 1 to 3 | 0 | 5 |
| CI AMD EPYC 7763, against the baselines (rendered on Intel) | 1 | 30 | 2 | 0 | 1 |

Two earlier versions of the settle failed calibration:
- With the clock left running, three desktop screens differed between shots by 19.8, 3.8 and 0.0003 percent. Pinning the clock fixed it (see Product races below).
- With the clock simply paused after the schedule, a slower CI CPU (Intel Xeon Platinum 8370C, run 44999394702) changed 73 percent of `timeline-390x844` and the light canvas of `wall-1366x768`, while 28 screens matched. That is what the final settle with a frozen `Date` fixes.

A screen that fails prints `DIAG` lines (where the pixels changed, the brightness of both sides, the best-matching shift, the page state), so a new runner quirk explains itself in the log.

What 0.2 percent catches, measured on the first screen:

| Change | Phone, 390x844 | Desktop, 1366x768 |
| :--- | ---: | ---: |
| Primary button moved 2 px (the CI mutation) | 3.4 % (11,194 px), fails | |
| Primary button moved 1 px | 2.9 %, fails | |
| Letter spacing on the button, +0.3 px | 0.34 %, fails | 0.45 %, fails |
| Heading recoloured | 0.28 %, fails | 0.32 %, fails |
| One character added to a link | 0.25 %, fails | 0.003 % (30 px), passes |
| A small link recoloured | 0.12 % (387 px), passes | 0.04 % (447 px), passes |

So a change smaller than about 650 pixels on the phone or 2,100 on the desktop passes. Once the gate has run green for a while with 0 px of noise, `maxRatio` in `THRESHOLD` can come down to 0.0002 (66 and 210 pixels), which catches the recoloured link. Do that in its own PR, with the calibration numbers from Visual Baselines runs with `commit` off.

## What the gate does not see

Known limits, stated so nobody trusts it for more than it does:
- Only the viewport is shot (390x844, 1366x768). Content below the fold of a long scene or the landing page is not compared.
- One state per screen: light scheme, reduced motion, device pixel ratio 1, no hover or focus, Chromium only (no WebKit or Firefox), the wall only in Guided.
- A change smaller than the threshold passes: about 650 pixels on the phone (a 25x26 icon vanishing or turning black is 650) and 2,100 on the desktop. A tint of up to 8/255 over the whole page passes, and a refresh keeps the old bytes of such a screen.
- Real timing cannot show: the clock is pinned and `Math.random` seeded.
- The member-name check reads page text, `document.title`, `aria-label`, `title`, `alt`, `placeholder` and input values, and needs a whole name. It does not read canvas pixels or CSS `content`; the fixtures are the real defence.

## When the gate fails

1. Open the failed `visual` job. Each failing screen prints `FAIL <screen>-<size>: <n>% of pixels changed (<px> px, limit 0.200%), inside x .. y .. w .. h ..`.
2. The `visual-baseline` artifact holds `actual/` (this run's shots), `diff/` (changed pixels in red over the dimmed shot) and `summary.md`.
3. If the change is not intended, fix the code.
4. If it is intended, commit the new baselines in the same PR:
   1. Merge master into the branch first. Preview Tests renders the PR merged with master, so baselines rendered from a stale branch can fail there.
   2. Actions > **Visual Baselines** > Run workflow > "Use workflow from" = the PR branch (`commit` on, `repeat` 3). Every screen is shot three times in fresh browser contexts, and a screen whose shots disagree is not written (the run fails and commits nothing), so a baseline is never a coin flip. The `render` job renders all 30 screens on the CI image with a read-only token. A screen with no pixel beyond 8/255 against its committed baseline keeps the committed bytes, so only screens that really changed get new files. The `commit` job takes only `<screen>-<size>.png` files from that artifact, replaces `tests/browser/baselines/`, and pushes one commit to the branch. It refuses the default branch, and refuses when the branch moved after the render.
   3. A push made with the workflow token starts no workflow. Push your next commit, or add `ci-full`, to run Preview Tests on it.
   4. Review the new PNGs in the PR's Files tab (GitHub shows image diffs) before asking for the merge.

Baselines must come from the CI image. Fonts and anti-aliasing differ on other machines, and a local Chromium is a different build. To compare two local renders, use `--write-baselines DIR` and `--baselines DIR`. Never commit a local render.

## Stale baselines on master

Preview Tests judges a pull request merged with master as master stood when its checks ran. Two pull requests that each change the pictures can therefore merge one after the other, and leave master's baselines matching neither render: the next pull request, even one that changes no picture, then fails the gate on a difference it did not make. The runner image can do the same on its own: the landing page uses `system-ui`, so a font change in the `ubuntu-24.04` image moves its pixels under the pinned browser.

Visual Drift (`.github/workflows/visual-drift.yml`) compares master with its baselines every day at 07:35 UTC, two shots per screen, and opens one issue, "Visual baselines drifted on master", when a scheduled run fails. It reports only: nothing is blocked. To fix it, branch from master, run Visual Baselines on the branch (`commit` on), read the new PNGs in the pull request (they should show exactly the drift the issue describes), and merge it. The repository setting "Require branches to be up to date before merging" would close the first gap at its source; that is a Settings decision for the owner, not something a pull request changes.

## Product races found while pinning

These were real timing differences in the page, not in the test. They are left as found, because this gate changes no product code. Listed here for whoever polishes those screens:

- `js/cloth-hook.js` measures the ribbon rail (`--rail-pad`) in an idle callback. Whether that callback runs while the first-visit sheet is up or after it decides the value. When it runs during the first-visit sheet it computes a negative value, so `padding-top` falls back to 0. On desktop, Next steps then sits 10 px higher than when the callback ran later.
- The wall stays `display: none` (`html.wall-cold`, `#main.beam-soon`) until the first pointer event plus 300 ms, or 10 s after load.
- The WebGL light aims at the last pointer position, so a pointer resting on a tile lights that tile.

## Options

```
node browser/visual-baseline.mjs --url http://127.0.0.1:8080/                 compare (exit 1 on any failure)
  --write-baselines [dir]   write the shots as baselines (default tests/browser/baselines); a screen with no pixel beyond 8/255 keeps its committed bytes; a broken screen fails and is not written
  --only first,wall         only these screens; --sizes 390x844 only that size (a partial run does not report extra baselines)
  --repeat N                shoot every screen N times in fresh contexts and report the noise between the shots
  --inject-css FILE         add this stylesheet before shooting (a mutation step of the CI job)
  --block REGEX             abort the requests whose URL matches, as if the file were missing (a mutation step of the CI job: the shot must fail)
  --throttle N              slow the page's CPU N times (imitates a slower runner)
  --slow-art MS             delay every image request by MS
  --jitter MS               delay every request by a random time up to MS
  --baselines DIR           compare with another folder of baselines
  --out DIR                 actual/, diff/, summary.json, summary.md (default tests/browser/out/visual-baseline)
```

Actions > Visual Baselines also takes `only` (screens) and `sizes` for a run with `commit` off: a calibration or a hunt for a flake, e.g. `only` = `timeline`, `sizes` = `390x844`, `repeat` = 20. A partial render is never committed.

Serve the checkout first: `node tools/static-server.mjs 8080`. On a loopback URL the suite adds `?brain=local`, so the page asks its own origin's `/api/`, which the stub answers.

## Rollback

To make it non-gating again: remove `visual` from the `report` job's `needs` and its `VISUAL_RESULT` env line, and in `tools/ci-report.mjs` drop `visual` from the `results` the CLI passes. `buildReport` ignores a visual result that is not given. The CLI on its own fails closed: a missing `VISUAL_RESULT` reads as `missing`. To remove the gate entirely, revert the PR that added it.
