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
| `timeline`, `five`, `roads`, `racials`, `legacy`, `buffs`, `ledger`, `signups`, `librarian`, `library`, `decide` | from the wall, `window.__boardKit.goScene(<scene>)` |
| `landing` | `landing/` |

The scene list is read from the page (`window.__boardKit.SCENES`), so a new scene is a screen without a baseline and fails until one is committed. A baseline that no screen produces (a removed scene) fails too. File names: `<screen>-<size>.png`.

## The pinned backend

Every input that is not the page's own code is fixed, so the same commit renders the same pixels on every run:

- The site is the checkout itself, served by `tools/static-server.mjs` (the rules of `_headers`, the private member files answer 404, as on Pages). No preview, no secret.
- `/api/` is answered from `tests/fixtures/api-snapshot` (`stubbed()`, zero Worker requests). Member names in the fixtures are made up (`tests/helpers/fictional-party.mjs`).
- Chromium from `tests/package-lock.json` (Playwright 1.49.1) on `ubuntu-24.04`.
- `prefers-reduced-motion: reduce`, light scheme, time zone UTC, locale `en-US`, service workers blocked, `Math.random` seeded.
- The page clock is pinned (`tests/helpers/clock-arg.mjs`) and **paused before the page exists**. Only the suite moves it, in the same fixed steps in every run (`SCHEDULE` in the file: after the load, after "Just take a look", after closing, after opening a scene, then a 12 s flush that covers the wall's 10 s settle). The network goes quiet between steps. The launch countdown therefore shows the same seconds in every run, and every timer, idle callback and animation frame fires in the same order against the same page.
- Taps are dispatched events (`pointerdown`, `pointerup`, `click`) on the element. No pointer is moved, so nothing is left hovered and the light, which follows the pointer, stays where the page puts it.
- Then the final settle. The page's `Date` is frozen where the schedule left it, so the countdown cannot change, while timers, idle callbacks and frames keep running in 250 ms steps of page time. A shot counts once three rounds in a row, each with the network quiet and the on-screen art downloaded and decoded (every `<img>` and CSS background in the viewport), give byte-identical screenshots with no request in between (up to 48 rounds). Work that needs real time as well as timers therefore finishes instead of being frozen half-done: the light's shader compiles in the GPU process and is polled every 16 ms.

**Canvases are not masked.** The full-viewport `#wisps` canvas, the WebGL wall light `#light`, the Buffs canvas and the cloth are in the shots as drawn. The former non-gating version masked `canvas`, `.candle` and anything with `moon` in its class in magenta. `.candle` and `#wisps` cover the whole viewport, so its first-screen shot was a solid magenta rectangle: a baseline that could never fail.

## A broken page never becomes a baseline

A screen fails, in compare mode and when baselines are written, when:
- the page did not reach the state the step asked for (the first-visit sheet, Next steps, the wall, the scene open with text in it);
- it threw a page error, or asked the API for a path the fixtures lack (`stubbed()` fails the run);
- the screenshot is nearly blank (fewer than 16 colours in a sample);
- it shows a real member name. The names are read from `data/party.json` at run time and never printed: the check looks at the page text, `aria-label`, `title`, `alt`, `placeholder` and input values.

`tests/unit/visual-baseline-gate.test.mjs` checks the committed set in every unit run. Every PNG decodes at its size, the set is exactly the screens times the sizes (scenes read from `js/board.js`), and none is nearly blank or more than 1 percent magenta. It also checks the PNG codec, the pixel diff, the threshold boundaries, the workflow wiring and the report logic.

## The threshold

A pixel is changed when any channel differs by more than **8 of 255**. A screen fails when more than **0.2 percent** of its pixels changed: 658 pixels at 390x844, 2,098 at 1366x768. A size change always fails. The comparison runs in Node on the decoded files (`tests/helpers/png.mjs`, `tests/helpers/pixel-diff.mjs`), not in a browser canvas.

Calibration, 2026-11-22. This was the starting threshold from outside advice. It was kept after repeat shots on the pinned backend showed noise far below it:

- Local, before the clock was pinned and the taps fixed: 27 of 30 screens were already identical across fresh contexts. Three were not. `tonight-1366x768` had 19.8 percent of pixels changed: the cloth rail race below moved the panel 10 px. `wall-1366x768` had 3.8 to 4.2 percent: the light followed the mouse left on a tile. `library-1366x768` had 1 pixel.
- After the fixes, the numbers in "Calibration runs" below.

What the threshold catches: the CI mutation step shifts the first-visit button 2 px on the phone screen and requires the suite to fail on it. A change smaller than 0.2 percent of the screen passes: for example one word of a sentence, or a small icon recoloured. Lower `maxRatio` in `THRESHOLD` only with new calibration numbers from CI.

## Calibration runs

See the PR that introduced the gate for the per-run table (CPU model, repeat-shot noise, largest difference against the committed baselines). To repeat it: Actions > Visual Baselines > Run workflow with `commit` off and `repeat` 3. It compares three fresh shots of each screen with each other and with the committed baselines, prints a `REPEAT` line per screen, and commits nothing.

## When the gate fails

1. Open the failed `visual` job. Each failing screen prints `FAIL <screen>-<size>: <n>% of pixels changed (<px> px, limit 0.200%), inside x .. y .. w .. h ..`.
2. The `visual-baseline` artifact holds `actual/` (this run's shots), `diff/` (changed pixels in red over the dimmed shot) and `summary.md`.
3. If the change is not intended, fix the code.
4. If it is intended, commit the new baselines in the same PR:
   1. Merge master into the branch first. Preview Tests renders the PR merged with master, so baselines rendered from a stale branch can fail there.
   2. Actions > **Visual Baselines** > Run workflow > "Use workflow from" = the PR branch (`commit` on, `repeat` 1). The `render` job renders all 30 screens on the CI image with a read-only token. A screen with no pixel beyond 8/255 against its committed baseline keeps the committed bytes, so only screens that really changed get new files. The `commit` job takes only `<screen>-<size>.png` files from that artifact, replaces `tests/browser/baselines/`, and pushes one commit to the branch. It refuses the default branch, and refuses when the branch moved after the render.
   3. A push made with the workflow token starts no workflow. Push your next commit, or add `ci-full`, to run Preview Tests on it.
   4. Review the new PNGs in the PR's Files tab (GitHub shows image diffs) before asking for the merge.

Baselines must come from the CI image. Fonts and anti-aliasing differ on other machines, and a local Chromium is a different build. To compare two local renders, use `--write-baselines DIR` and `--baselines DIR`. Never commit a local render.

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
  --inject-css FILE         add this stylesheet before shooting (the mutation step)
  --baselines DIR           compare with another folder of baselines
  --out DIR                 actual/, diff/, summary.json, summary.md (default tests/browser/out/visual-baseline)
```

Serve the checkout first: `node tools/static-server.mjs 8080`. On a loopback URL the suite adds `?brain=local`, so the page asks its own origin's `/api/`, which the stub answers.

## Rollback

To make it non-gating again: remove `visual` from the `report` job's `needs` and its `VISUAL_RESULT` env line, and in `tools/ci-report.mjs` drop `visual` from the `results` the CLI passes. `buildReport` ignores a visual result that is not given. The CLI on its own fails closed: a missing `VISUAL_RESULT` reads as `missing`. To remove the gate entirely, revert the PR that added it.
