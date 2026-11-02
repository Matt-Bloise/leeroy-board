# Visual baselines

`tests/browser/visual-baseline.mjs` compares screenshots of three screens with committed PNGs: the first screen (`?preview=1`), the sample guild sheet (The five, no identity) and the landing page, each at 390x844 (touch) and 1366x768. It is **non-gating**: it always exits 0, prints `WARN` lines and writes `tests/browser/out/visual-baseline/summary.json` and `summary.md` (max diff ratio per screen). The browser runner picks it up automatically.

## How it compares

- Screenshots are taken with CSS animations frozen, reduced motion on, light scheme, service workers blocked.
- Masked (painted magenta): `.candle`, every `canvas`, `#clock`, `#mini-clock`, `.clock-digits`, and any element whose class or id contains `moon` or `countdown`. Add a selector to `MASK` in the script if a new animated region shows up as noise.
- A pixel counts as different when any RGB channel differs by more than 32 of 255. The ratio is different pixels divided by all pixels. Above 1% prints `WARN`.
- A missing baseline prints `SKIP` and compares nothing. A size change prints `WARN` with ratio 1.
- Output names: `<screen>-<size>.png`, with screen one of `first`, `sample`, `landing` and size `390x844` or `1366x768`.

## Generate or refresh the baselines

Baselines must be rendered on the Linux CI image. Fonts and anti-aliasing differ on Windows and macOS, so local PNGs would warn on every run.

1. GitHub, Actions, **Visual Baselines**, Run workflow. Set `pages_url` to the origin to capture (default `https://leeroy.party`; a PR preview origin works too).
2. When the run ends, download the `visual-baselines` artifact (six PNGs). The workflow does not commit anything.
3. Put the PNGs in `tests/browser/baselines/`, commit them in a PR, and open it as usual.
4. Re-run the browser suite on that PR and read the `visual-baseline` lines in the browser log. Max diff ratio should be 0 to a fraction of a percent run after run.

Refresh the baselines after an intended visual change. The sample guild and first-screen content are static, but the landing page and board data can change copy: capture from the same commit you are testing when you need an exact match.

## Promoting to a gate

Not yet. Collect at least ten runs across PRs with no `WARN` on unchanged screens first. Then decide a threshold and make the suite exit 1 above it; that is a separate PR.

## Rollback

Delete `tests/browser/visual-baseline.mjs` (and the baselines folder). Nothing else depends on it.
