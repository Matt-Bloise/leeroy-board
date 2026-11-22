# The door: the reimagined first screen (preview)

The door is a new first screen and landing for the Living Board, built on a preview route that nothing links to: **`/door/`** (on production, https://leeroy.party/door/; on a pull request preview, `https://pr-<N>.leeroy-board.pages.dev/door/`). The board at `/` is unchanged, so the friends keep the current board until the owner turns the door on. The page is `noindex`, and `robots.txt` already disallows the whole site.

It follows the cinematic program (`docs/cinematic/intent.json`, `baseline.md`, `stranger-script.md`) and the outside advice of the council run of 2026-11-22: responsive HTML and CSS for layout, SVG for crests and icons, Canvas 2D for the Atlas, the WebGL tavern loaded on entry; AVIF or WebP with a fallback and width-based `srcset`; CLS at most 0.1, at most 3 MB over a fixed audit session, at most 30 fps for decorative 3D, zero idle loops, instant transitions under reduced motion; keyboard and touch access with semantic equivalents for what a canvas shows; seeded captures at five sizes with canvases visible.

## What a visitor sees

Phone first (390x844), top to bottom:

1. **The establishing shot.** The tavern painting before any word is read. Phones and portrait screens get a 5:4 crop that keeps all five at the bar; landscape screens get the whole painting behind the words, which sit on its dark left wall.
2. **The invitation.** "Who's coming, and what's next." and one line saying what the board is (the guild's companion for the WoW Forever group). The next dated thing in plain words ("Raids open · Wed, Dec 9 · in 17 days", or the board's own "Open now, until the end of Nov 3, Pacific time" for an open window). One action: **Answer the sign-up card** (the Discord card from the data; it opens Discord), and a quiet **Look around first**. For a member who has already answered, the action becomes **See who is coming**.
3. **The table.** Sign-ups (who said they are coming, who has not answered, your own answer), the party (an SVG crest per member, the build and role, the role line), the roads (a Canvas 2D map and the same roads written out), the tavern (step inside: the WebGL room), the library, and the other scenes. Every card links into the board's own scene (`/#signups`, `/#five`, `/#roads`, ...), so nothing the board does is duplicated.

Five-second test copy (`stranger-script.md`): Q1 purpose is answered by the heading and the line under it ("who is coming and what is next", "the guild's companion for our World of Warcraft: Forever group"); Q2 next action by the one button ("Answer the sign-up card") and "Look around first". The test has not been run with strangers yet (see "Open").

## Intent, tiers and motion

Light means relevance. Tier 1 is the one thing to do and gets the brightest surface, tier 2 is context, tier 3 periphery. Text keeps full contrast in every tier: the tiers are carried by surfaces, borders and glow, never by dimming words.

| Region | Selector | Tier | Intent | Motion (and under reduced motion) |
| :--- | :--- | :--- | :--- | :--- |
| Establishing shot | `.shot` | periphery | Say "a tavern at night, these five" before any word is read. | none |
| Invitation | `.title-card` (h1, `.lede`, `#go`) | hero on a first visit, context for a member | What this is, and the one action. | button press 100 ms (1 ms) |
| Next date | `#next` | context | The next dated thing, in the viewer's time zone, coarse relative words. | none; recomputed when the tab is shown again (no timer) |
| Sign-ups | `#c-signups` | context on a first visit, **hero for a member** | Who said they are coming, who has not, your own answer. | none |
| The party | `#c-party` | context | Who plays what; the board's role line. | none |
| The roads | `#c-roads` | periphery | Where each of us wakes up and the way to the meeting city. | the roads draw once, about 1.1 s, when the card first comes into view (drawn at once) |
| The tavern | `#c-room`, `#room` | periphery | The room the board hangs in, for those who want it. | dialog fade 360 ms in, 300 ms out (1 ms); the WebGL room itself (painting instead) |
| Library, other scenes | `#c-library`, `.card-places` | context, periphery | Find an answer; reach everything else. | hover 120 ms (1 ms) |

One ease for everything: `cubic-bezier(.22, 1, .36, 1)` (the program's `--cin-ease`). No infinite animation anywhere on the page.

## How it is built

- `door/index.html`: static HTML for everything that needs no data (the first screen paints without waiting for the API), an inline SVG sprite (the board's own tile emblems, the seats, a brass medallion and an original glyph per class), `<picture>` art direction with `width`/`height` reserved. No inline script (the CSP in `_headers` stays as it is).
- `door/door.css`: phone first, three breakpoints (700 px, landscape, 1100 px), the tiers, the motion tokens with every duration at 1 ms under `prefers-reduced-motion`, forced-colors.
- `door/door.js`: reads `/api/bootstrap` through `js/brain.js` (`BoardBrain.bootstrap()`: the same API origin rules as the board, a PR preview's own Worker included; no key, no cookie) and renders. It writes nothing itself: no storage, no API write (`js/brain.js`, shared with the board, keeps a board key from a `#k=` link in the address, as it does everywhere). It reads the board's own `board-me` / `board-as` keys to know a returning member.
- `door/model.js`: the pure rules, each copied from the board and named where it is copied: the board's name matching, the next date (`tonightNext`), the sign-up count (`wk()`: the server's tallies before launch, `js/signups-week.js` after; that script loads only after launch), the role line and role words (`roles()`, the Five tile, `roleWords`).
- `door/map.js`: the roads in Canvas 2D from the board's vector data: `data/atlas/world.json` (land and zone outlines) and `data/atlas/routes.json` through the board's own planner (`atlas/routes.js` `makePlan`) and coast smoothing (`atlas/shape.js`). No map tiles: about 120 KB of JSON before compression instead of the 6 MB of tiles the full Atlas pans over. A start across the sea (before the zeppelin) is drawn in a framed inset joined by the crossing, so every road is legible at phone size. The canvas is `role="img"` with a one-line label, and every road is written out in the list under it, with who starts where and the minutes on foot. It loads when its card is within 320 px of the viewport, draws once, and redraws once on a resize.
- `door/room.js`: the tavern on entry only. Nothing of it loads before **Step inside**: then `room/room.js` (the board's own scene, three.js) is imported and started at its **medium** tier: at most 30 draws a second, device pixel ratio 1, no shadows. It pauses when the tab is hidden, rests after 30 s without input (the last frame stays, nothing is drawn), and is stopped with its WebGL context released when the dialog closes; focus returns to the button. Reduced motion, data saver, no WebGL2 or a software GPU show the painting instead and start no WebGL (`?room=gl` lets a test start it on a software GPU). The canvas is decorative (`aria-hidden`); the dialog has a heading and a status line that says what is shown.
- Art: `img/door/` holds the 5:4 crop (AVIF and WebP at 320, 480, 768 and 1200 px, a 768 px JPEG fallback), the 16:9 painting at 768 px (the existing 1200, 1672 and 2816 px files serve wider screens) and the tavern card crop (320, 480, 768 px, loaded lazily). Made from `img/tavern-hero-2816.webp` with the encoders and settings of `tools/images.mjs` (WebP q78, AVIF CRF 34 with libaom).
- Plumbing: `door` is in the Pages bundle (`tools/pages-bundle.mjs`), the stamp scanner (`tools/stamps.mjs`) and the full-run scope (`tools/ci-scope.mjs`). Its five js and css files are immutable in `_headers`, each reference stamped; the HTML keeps the Pages default (`max-age=0, must-revalidate`).

## Measurements against the budgets

Measured on 2026-11-22 in this repository's Linux container: Chromium 157 (Playwright 1.63), unthrottled, the local static server (`tools/static-server.mjs`, which does not compress) and the API answered from `tests/fixtures/api-snapshot` (fictional names, zero Worker requests), page clock pinned to 2026-11-03T22:10Z. "br" estimates the bytes Cloudflare sends: text bodies brotli-compressed at quality 5, images and fonts as served. Session: load, settle 3 s, an idle window of 2 s, scroll to the end in steps, settle 2 s.

| Budget | Door, 390x844 at DPR 3 | Door, 1366x768 | Current board at `/` (same session, 390x844 at DPR 3) |
| :--- | :--- | :--- | :--- |
| CLS at most 0.1 (program 0.05) | 0 | 0 | 0 on the first visit; 0.002 to 0.066 at 1280x720 (varies run to run) |
| Transfer at most 3 MB over the session | 0.60 MB raw, about 0.30 MB br, 16 requests | 0.61 MB raw, 17 requests | first visit 2.62 MB raw (1.31 br), 92 requests; returning member, sheet closed: 8.16 MB raw (6.8 br), 174 requests |
| The same session with the tavern entered for 4 s | | 2.06 MB raw, 25 requests (three.js 691 KB raw, about 170 KB compressed; textures 787 KB) | |
| Decorative 3D at most 30 fps | | medium tier: draws capped at 30 per second (2 to 3 per second on this software GPU) | phones get no room (touch: the tier ladder says low); on a desktop the room starts by itself 1.5 s after load, at the high tier with no frame cap |
| Zero idle loops | 0 animation frames, 0 timers, 0 infinite animations in the idle window; 0 after the tavern closes | same | returning member: about 174 animation-frame callbacks per second idle and 5 infinite CSS animations |
| Reduced motion | every transition and animation 1 ms or less; the tavern opens at once as the painting | same | |
| LCP | about 100 ms (the hero AVIF) | about 130 ms | 572 ms |
| Long animation frames | none in 5 of 6 runs; one of 52 ms at start-up in 1 (parsing the shared bootstrap) | none | first visit 3 (222 ms); returning member 24 (3,989 ms, longest 1,332 ms) |

Not measured here: a real phone (the program's named phone is not chosen; see `baseline.md`), WebKit and Firefox (only Chromium is installed in the container), Lighthouse, and the wire bytes on Cloudflare (the PR preview gives that number; the suite logs it there).

## Tests

- `tests/browser/door.mjs` (runs in the PR browser job; Chromium; fixtures, zero Worker requests): the fixed session at five sizes (360x780, 390x844, 430x932, 768x1024 touch; 1366x768), and on the laptop the tavern too. FAIL lines for: CLS over 0.1 (WARN over 0.05), more than 3 MB over the session (with and without the tavern), any animation frame, timer or infinite animation in a 2 s idle window and after the tavern closes, more than 30 draws a second in the tavern, sideways scroll, visible text under 12 px, touch targets under 44 px, a blank map canvas or roads not written out, three.js fetched before Step inside, a transition over 1 ms under reduced motion, WebGL started under reduced motion, keyboard order (skip link, then the action), focus not returned when the tavern closes, axe-core serious or critical violations, page errors. Run it locally: `cd tests && node browser/door.mjs --url "http://127.0.0.1:8080/?brain=http://127.0.0.1:8787"` with `tools/static-server.mjs` running.
- Visual baselines with canvases visible: `tests/browser/door-baselines/` holds the first screen and the map at the five sizes, seeded (fixtures, pinned clock, reduced motion so the map is in its final frame, fonts and the hero decoded). Non-gating like `visual-baseline.mjs`: a WARN above 2% of pixels (a pixel differs when a channel differs by more than 32 of 255). They were rendered in this Linux container with Chromium 157; the CI image runs Chromium 131, so a small difference is expected there. Refresh after an intended change: `node browser/door.mjs --url <origin> --write-baselines`.
- `tests/unit/door-model.test.mjs`: the pure rules against the board's (fictional names), including the after-launch weekly rule through the real `js/signups-week.js`, the roads from the real `routes.json`, the Discord-link check, and static checks that the door's sources start no interval, no infinite animation and write nothing.

## Turning it on

Not done here; the owner decides. Before switching the default:

1. Run the five-second test (`stranger-script.md`) on `/door/` beside `/`, five strangers each, and record it in `stranger-results.md`.
2. Check layout, transfer and motion on a real phone (the named phone), on the production preview of `/door/`.
3. Then a small follow-up change: on a first visit to `/` with no scene in the hash, send the visitor to `/door/` behind a flag that defaults to off (for example a `door` flag in the client document, the way `party.n` works), so the owner can turn it on and off without a deploy. Deep links (`/#five`), board links with a key and the Discord Activity keep opening the board.

## Rollback

Nothing links to the door, so leaving it in place changes nothing for the friends. To remove it, revert the pull request (or delete `door/`, `img/door/`, `tests/browser/door*`, `tests/unit/door-model.test.mjs` and the door lines in `_headers`, `robots.txt`, `tools/pages-bundle.mjs`, `tools/stamps.mjs` and `tools/ci-scope.mjs`).

## Open

- The five-second test with strangers, and the real-phone check (above).
- WebKit: the door uses `<dialog>`, `color-mix()` (with a fallback), `aspect-ratio` and `text-wrap`; all are in current Safari, but the suite runs Chromium only.
- A door view in `docs/cinematic/intent.json` (its test pins the board's two views today) when the door becomes the first screen.
- HDR and wide gamut: the door uses none of the board's HDR layers.

## Review round (2026-11-22): what an independent adversarial review found and what changed

Found by reproduction and fixed here, each with a check in `tests/browser/door.mjs` (the late-data check was run against the old CSS and fails there: 0.558 at 390x844, 0.242 at 768x1024, 0.105 at 1280x720):

- **CLS when data arrives after the card is on screen.** The lists now reserve their room (the party 352 px for five on a phone, the roads 380 px, the sign-up line 5.2 em; smaller on wide screens). A sixth member still grows the party card once: the number of members is not known before the data.
- **The resting tavern woke on a resize** (the resize message overwrote its `hidden` state) and drew 30 times a second with nobody there. A resting room now stays at rest.
- **Closing the tavern while it loads lost focus** (Step inside was disabled). It is no longer disabled; a second press while loading is ignored.
- **A rotated phone** had the one action below the fold. Short landscape screens put the painting left and the words beside it.
- **Hidden class by elimination.** The roads named or coloured a class that no visible member plays; they now say "Nobody on the board starts here" and show a neutral dot. The alt text no longer lists the table's races.
- **A stalled or failed API.** The page gives up after 10 s and says so; the map is static data and is drawn anyway, with no names.
- **`showModal()` failing** no longer leaves Step inside dead; long unbroken names wrap; two small targets reach 44 px; a device with under 4 GB of memory, or a room that cannot keep its frame budget, shows the painting.

Known and left as it is:

- **Draw rate versus frame callbacks.** At the board's medium tier the room draws at most 30 times a second, but its animation-frame callback still fires at the display rate (60 or 120 a second) and skips the draw. Capping that needs a change in `room/room.js`, which the board shares; this PR does not touch it. The cap itself is pinned by a unit test, because a software GPU draws below 30 and cannot show it.
- **Phones.** The room is allowed on phones when a person presses Step inside (the board itself gives touch devices no room). It is untested on a real phone and on WebKit (the `imageOrientation: "flipY"` option of `createImageBitmap` that `room/tavern.js` uses is the one thing to look at).
