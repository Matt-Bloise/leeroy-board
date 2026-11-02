# Visual quality audit

`tests/visual/audit.mjs` measures how the board looks and performs across screen sizes, pixel densities, colour schemes and motion settings. It is a measurement, not a gate: findings never fail CI. Preview Tests run it after the browser smoke step and attach the result as the `visual-audit` artifact; the result comment gets one line with the counts by category.

Run it by hand:

```bash
cd tests && npm ci && npx playwright install chromium webkit
node visual/audit.mjs https://pr-NN.leeroy-board.pages.dev/      # or PREVIEW_PAGES=...
```

Options: `--out DIR` (default `visual-audit/`), `--budget-min N` (default 10; contexts that do not fit are skipped and listed), `--only TEXT` (run contexts whose id contains TEXT). The script exits 0 whatever it finds and exits 1 only when it crashes (no browser starts, or no page loads). It makes no AI calls and sends nothing to the Worker.

## What it runs

15 contexts, in priority order so the time budget cuts from the tail:

| Viewport | DPR | Engine | Variants |
| :--- | ---: | :--- | :--- |
| 390x844 | 3 | chromium, webkit | light; chromium dark with reduced motion |
| 430x932 | 3 | chromium | dark |
| 768x1024 | 2 | chromium, webkit | light; webkit reduced motion |
| 1024x1366 | 2 | chromium | dark |
| 1366x768 | 1, 2 | chromium, webkit | light; dark; dark with reduced motion; forced-colors active (once) |
| 1080x1920 | 1 | chromium | reduced motion |
| 2560x1080 (ultrawide) | 1 | chromium, webkit | light; dark |
| 3840x2160 | 1 | chromium | dark |

Phones and tablets are touch contexts with `isMobile`. For every context the audit loads the first visit, takes a screenshot of the first screen (`screenshots/<context>.jpg`), then visits each scene by setting the hash: `#tonight #timeline #five #roads #racials #legacy #buffs #ledger #signups #librarian #library #decide #atlas #data`. Scenes are reached inside the loaded page, so LCP and the load transfer belong to the first visit; CLS, long frames and bytes on a scene cover that scene's first moments.

## What is measured, why, and the thresholds

| Category | Measure | Threshold that flags it | Why |
| :--- | :--- | :--- | :--- |
| overflow | `scrollWidth > clientWidth`, with the widest elements named | any | Sideways scroll on a phone is the most visible layout failure. |
| console_errors | `console.error` and uncaught page errors | any | A script that threw is a feature that did not run. |
| failed_requests | responses with status 400 or above, failed requests, images that did not decode | any | Missing art and Worker errors. |
| tap_targets | touch contexts only: links, buttons, inputs under 44 px in either side; inline links in running text are exempt | under 44 px | Fingers are about 44 px (WCAG 2.5.5, platform guidelines). |
| small_text | visible text with a computed font size under 12 px | under 12 px | Unreadable on a phone at arm's length. |
| contrast | WCAG contrast ratio of the text that carries the most characters against its effective background; any text on a solid background below the ratio | under 4.5:1 (3:1 for large text) | Readability in dim rooms and for low vision. Text over an image background cannot be decided from computed style and is counted as unknown, not passed. |
| cls | cumulative layout shift (no recent input) | over 0.1 | Content jumping while a friend reads or taps. Chromium only. |
| lcp | largest contentful paint, first visit | over 2500 ms | When the first screen is really there. Chromium only. |
| long_frames | long animation frames (`long-animation-frame`) | 3 or more, or 200 ms or more in total, in a page | Dropped frames in animation and scrolling. Chromium only. |
| bytes | transfer size (body plus headers) | over 3 MB on the first visit, over 1.5 MB on a scene | Data cost and slow first paint on a phone. |
| motion | animations that never end and are still running under `prefers-reduced-motion: reduce` | any | Reduced motion must stop looping animation. |
| image_under | image pixels needed on screen (CSS size times DPR) more than the image has; for `<img>` and CSS backgrounds in the viewport, using object-fit and background-size | natural pixels under 1x of required | A soft or blurry picture on dense screens. At DPR 2 and 3 this is the usual finding; it is also measured at DPR 1 because an upscaled image is soft there too. |
| image_over | natural pixels more than 3x the required pixels | over 3x | Bytes spent on pixels nobody can see. |
| format | PNG or JPEG over 150 KB | over 150 KB | WebP or AVIF is usually much smaller for painted art. |

Worst offenders first: every finding gets a score (overflow and failed requests high, cosmetic ones low) and the report adds the scores per subject (an image path, a selector) across contexts and pages, so something wrong everywhere ranks above something wrong once.

Limits: image sizes use what is in the viewport at scroll top; `border-image` fills and canvas or WebGL art are not measured; text over images is excluded from contrast; tap target sizes use the element box, not any padding hit area added by script.

## HDR and wide gamut on this stack

Playwright cannot switch a display into HDR or P3. The audit records what each engine reports (`(dynamic-range: high)`, `(color-gamut: p3)`, `rec2020`, `srgb`, colour depth) and greps `css/`, `scenes/` and `js/` for `@media (dynamic-range: high)`, `color(display-p3`, `color-gamut`, `dynamic-range-limit`, `image-set(`, canvas `colorSpace` and `plus-lighter`. A CI runner reports an SDR sRGB display, so the P3 and HDR branches of the CSS are listed as present but not exercised. Look at them on a real P3 or HDR display.

Today:

- Painted raster art (the 400-plus WebP files, the PNG icons and seals, the JPEG tavern, board and parchment plates) is SDR sRGB at 8 bits. None of it carries a wide-gamut or HDR profile.
- Wide-gamut colour is done in CSS: `color(display-p3 ...)` inside `@supports` and `@media (color-gamut: p3)` for brass, gold and flame accents.
- HDR is faked with light: `@media (dynamic-range: high)` adds `plus-lighter` blending and brighter glows, and the three 16-bit PNGs in `img/hdr/` (candle, ember, glint) are layered with `dynamic-range-limit: no-limit` so only those small highlights can exceed SDR white while the rest of the page is held to standard.

What a real HDR upgrade of the art would involve:

1. Re-master from the painted sources in a wide gamut (Display P3, or BT.2020 for true HDR) at 10 or more bits, not from the shipped 8-bit sRGB files, which cannot be recovered.
2. Encode as AVIF (10-bit, with an ICC profile or CICP tags: P3 primaries; BT.2020 primaries with PQ or HLG transfer for HDR) or JPEG XL (Safari and recent Chromium; check support before depending on it). WebP has no HDR path.
3. Serve by capability: `<picture>` with `<source type="image/avif" media="(dynamic-range: high)">`, or CSS `image-set()` with `type()` and a `@media (dynamic-range: high)` block, keeping the sRGB WebP as the default fallback. Use `@media (color-gamut: p3)` for P3-only variants that are not HDR.
4. Canvas and WebGL: request `getContext("2d", { colorSpace: "display-p3" })` (and the matching WebGL `drawingBufferColorSpace`) so painted layers are not clamped to sRGB; float or HDR canvas is still experimental.
5. Control the headroom with `dynamic-range-limit` so UI text and plates stay at SDR white and only highlights bloom.

Risks: file size (10-bit AVIF art can be larger than the WebP it replaces, and the bytes metric above will show it); decode cost on low-end phones (watch long animation frames); inconsistent engine support and tone mapping, so the same image can look different in Chrome, Safari and Firefox; HDR highlights can look glaring next to SDR UI and on OLED at night; text contrast over an HDR image is not defined by the WCAG formula; and anything shipped must degrade to the sRGB WebP without a layout change.

## Reading a report

`visual-audit.md` leads with counts by category, then the worst offenders, a table per context with the screenshot link, findings by page, and the engine HDR report. `visual-audit.json` holds every phase (overflow figures, tap target and text samples, image rows with natural and rendered sizes, format and bytes, CLS, LCP, long frames, errors, failed requests) for the brain to read or diff between runs.
