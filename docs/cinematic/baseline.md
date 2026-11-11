# Cinematic program baseline (slice 0)

This page records what the board measures today, before any cinematic change, so every later slice can show a before and after number on a stated device. All figures were measured on 2026-11-06 (UTC times from `date -u`) on one Windows desktop running Chromium 1148 (Playwright 1.49.1), emulating a 390x844 CSS-pixel phone at device pixel ratio 3 with touch. No throttling was applied, so these are lower bounds for a real phone.

## Device gap

The named test phone is not chosen yet. Nothing here is a phone measurement: INP, p95 frame time and a real-device LCP are open until Matt names the phone. The Chromium context is the stand-in the program asks for.

## Numbers

Instrument: the repo's own visual audit (`tests/visual/audit.mjs`, see `docs/visual-quality.md`), one context per run, API stubbed from `tests/fixtures/api-snapshot` (0 requests to the Worker). "Live" is https://leeroy.party, "local" is this commit served by `tools/static-server.mjs`.

| Measure | Live (light) | Local (light) | Flag threshold | Program target |
|---|---|---|---|---|
| LCP, first visit | 677 ms (paper-baked.jpg) | 494 ms | 2,500 ms | 2,500 ms or less |
| CLS, first visit | 0.24 | 0.24 | 0.1 | 0.05 or less |
| CLS, worst scene | 0.24 first visit, 0.20 atlas | 0.27 five, 0.24 first visit | 0.1 | 0.05 or less |
| First-visit transfer, audit window | 12.13 MB | 12.97 MB | 3 MB | 1.5 MB or less |
| First-visit transfer, 4 s after load (CDP, encoded) | 1.34 MB over 91 requests | not measured | 3 MB | 1.5 MB or less |
| Largest scene transfer | 2.87 MB (atlas) | 3.30 MB (atlas) | 1.5 MB | 1 MB or less |
| Long animation frames, first visit | 6 frames, 470 ms, longest 111 ms | 8 frames, 813 ms, longest 165 ms | 3 or 200 ms | 0 over 50 ms |
| Text under 12 px | 0 elements with a nonzero size; 7 distinct elements at a computed 0 px (see note) | same 7 | any | 0 |
| Tap targets under 44 px | 0 of 6 on first visit, 0 on every scene | 0 | any | 0 |
| Loops that survive reduced motion | 0 (first visit and all 14 scenes) | 0 | any | 0 |
| Overflow, console errors, failed requests | 0, 0, 0 | 0, 0, 0 | any | 0 |

Reduced-motion context (dark, `prefers-reduced-motion: reduce`, run at 2026-11-06T03:58:37Z live and 03:59:42Z local): 0 running animations on first visit, 0 infinite animations on every scene. In the normal-motion context, 1 (live) or 2 (local) animations are running at the end of the first visit and none are infinite at the sampling moment.

Notes that change how the numbers read:

- **The two transfer figures disagree by about nine times.** The audit sums body and header bytes for every response in its first-visit window; the CDP count stops 4 s after the load event and sums encoded bytes. The likely cause is that the audit window is longer and lets lazy wall art load; this is not confirmed. Until one figure is chosen, the program target of 1.5 MB is met by the 4 s figure and missed by 8x by the audit figure. Resolving this is the first task of slice 1's performance pass.
- **Text under 12 px.** The 7 flagged elements (for example `button#scene-peek`, `button.atlas-x`, `button#tilt`) have a computed font size of 0 px. Whether their text is visible or is a visually-hidden label was not checked.
- **CLS 0.24** is the one budget the board misses on a plain first visit, live and local, in both colour schemes.
- **Sizes of the pieces (CDP, live, 4 s):** scripts 294 KB, images 675 KB, fonts 158 KB, stylesheets 104 KB, one bootstrap fetch 91 KB. The largest single files are `paper-baked.jpg` 209 KB, `oak-tile.jpg` 190 KB, `medal/tonight.webp` 134 KB, `board.js` 101 KB. That CDP run loaded the live page unstubbed, so it sent one `api.leeroy.party/api/bootstrap` request to the Worker.
- **Audit totals, live, one context:** 176 findings: image_over 61, format 57, image_under 30, small_text 12, long_frames 6, bytes 6, cls 3, contrast 1.

## Commands

All run from the repo root; the first three need `tests/node_modules` (`cd tests && npm ci && npx playwright install chromium`).

```bash
# live, light, 390x844 DPR 3 (2026-11-06T03:56:22Z)
cd tests && node visual/audit.mjs https://leeroy.party/ --only cr-390x844@3-light --out ../_audit/live
# local build (2026-11-06T03:57:44Z)
cd .. && tools/local-browser.sh visual --only cr-390x844@3-light --out _audit/local
# reduced motion (2026-11-06T03:58:37Z live, 03:59:42Z local)
cd tests && node visual/audit.mjs https://leeroy.party/ --only 390x844@3-dark-reduced --out ../_audit/live-reduced
# 4-second transfer count: Chromium DevTools Protocol Network.loadingFinished, summed encodedDataLength (2026-11-06T04:05:25Z)
```

## Lighthouse

Not run in this slice. `lighthouse` and `lhci` are not installed on the machine that did this work and installing them needs approval. The repo's `lighthouserc.json` keeps its current warn levels (home page: LCP 25,000 ms, 8.2 MB total, 355 KB scripts, 7.4 MB images; landing page tighter). Those levels are not tightened here because tightening them to the audit's numbers would compare two different instruments. The first slice that has a Lighthouse run to read tightens them. Lighthouse runs nightly and does not gate a pull request.

## Not measured, and why

- INP, p95 frame time, long frames on a phone: needs the named phone.
- WebKit and Firefox: the audit supports them; this slice ran Chromium only, as the program names.
- Anything signed in: the audit uses stubbed data and no account.
