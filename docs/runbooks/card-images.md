# Runbook: picture cards in Leeroy's Discord replies (CARD_IMAGES)

Last checked: 2026-11-22. Code: `tools/cards/` (templates and renderer), `cards/` (the PNGs), `infrastructure/worker/card-models.js`, `card-images.js`, `card-manifest.json`, `.github/workflows/cards.yml`. Not tested against live Discord (previews cannot reach it).

## What it is

Leeroy's `/page`, `/tooltip` and `/map` replies, and the pinned sign-up card, can carry a picture card. The pictures used to come from a headless browser on the owner's PC; these come from CI and Pages, so nothing depends on the PC:

1. **Templates.** One HTML page (`tools/cards/card.html`, `card.css`, `card.js`) draws four kinds of card at 400 CSS px wide (maps 800), in the board's colours and its own WOFF2 fonts (`fonts/`, OFL). No raster images.
2. **A finite set.** `tools/cards/sources.mjs` lists every card from the repository's data: 71 library pages, 128 named spells and items, 17 map views (the `/map` place list, every route-plan meeting point, the whole atlas) and 1 sign-up card. 217 cards, about 12 MiB.
3. **One pinned browser.** `tools/cards/render.mjs` draws each card at device scale 2 (800 or 1600 px wide) with Chrome for Testing headless shell **153.0.8010.12**, pinned by version, size and SHA-256 in `tools/cards/chromium.json` (installed by `tools/cards/install-chromium.mjs` from Google's Chrome for Testing bucket) and driven by `playwright-core` **1.63.0** (exact, `tools/cards/package.json`). The render fails if the browser reports any other version.
4. **Immutable files.** Each PNG is committed as `cards/<kind>/<name>-<12 hex>.png`; the 12 hex characters start the SHA-256 of the card's decoded pixels. A picture that changes gets a new URL; a URL never changes what it shows. Pages serves `/cards/*` with `Cache-Control: public, max-age=31536000, immutable` (`_headers`).
5. **The Worker only points at them**, behind the Flagship flag **`CARD_IMAGES`** (default off). It never draws a card: rendering in the Worker stays deferred until its CPU cost is measured (`docs/roadmap/IMAGE-CARDS.md`).

## What each reply gets with the flag on

| Where | Picture | Sent only when |
| --- | --- | --- |
| `/page` | the library page: category, title, the start of the blurb, two facts (the first ones that cite no source needing attribution) | the `lib_pages` row the reply shows has the same model as the drawn card: if the title, category, the start of the blurb or those facts changed in D1 since, no picture |
| `/tooltip` | the spell or item tooltip: name, rank, cost, cast, range, requirements and the composed short line | the name asked for is one of the library's named tooltips (case and spacing ignored) |
| `/map` | line art of the place from the board's atlas data; the whole atlas when no place is given | the place (or its alias, such as `crossroads` or `vos`), or the route plan's meeting point, is in the drawn set |
| the pinned sign-up card (`CARDS_ENABLED`) | what that card's own buttons say: the four answers, its meeting points, its arrival times | the card's choices are the drawn set (today: the defaults). Never a name |

`/signup` itself (the ephemeral panel) gets no picture: its buttons are different ones. Personalised pictures (a roster with names) stay on the PC renderer during the migration; uncached dynamic answers (`/ask`) stay text.

Every picture is also sent only when its file answers `200 image/png` at `BOARD_PUBLIC_URL` (one HEAD per file per Worker isolate, at most 600 ms, remembered ten minutes when found and one minute when not). The Worker deploys before Pages and Pages can be rolled back alone, so this keeps a reply from naming a file that is not on the site (after a Pages-only rollback, within ten minutes). The HEAD carries a one-off query (`?probe=<uuid>`) that Pages ignores and every cache keys on, so a 404 seen before Pages has the file is never cached under the card's own URL. Anything else, any error included: the reply is exactly the reply without a picture. With the flag off the replies are byte-identical to before (`tests/unit/card-images.test.mjs` compares them per command; a differential against master gave 45 of 45 identical).

## What a card never shows

- **Names.** No member, character or Discord name, handle, id or message: the sign-up card is the buttons' words, and a unit test scans every card's text for the roster's names and aliases and the names in `data/signups.json` and `data/party.json`.
- **What says which classes the party has.** Map cards draw places and zone outlines only: no routes, and no start area as a town dot (`routes.json` `day_one.starts` names the party's classes by elimination). A start area appears only as its own card, because `/map` offers it as a place.
- **Text that needs attribution.** A fact citing a host whose text may be stored only with credit and links (`data/library-sources.json` `storedText: "attribution-required"`, today `warcraft.wiki.gg`, CC BY-SA) is never drawn; the reply's text and the board keep it with its sources.
- **Game prose or marks.** Tooltip cards follow `tooltips.text` off (numbers and the composed short line; item effect lines are left out). No card or file name for the `blizzard` key, which the board skips too.

## Check a card, then turn it on

Nothing is visible to the friends until the flag is on. In this order:

1. **Look at the files.** After the merge deploy, open a few in a browser:
   - `https://leeroy.party/cards/page/classes-druid-d09a1676f23a.png`
   - `https://leeroy.party/cards/tooltip/fireball-faf210c29e84.png`
   - `https://leeroy.party/cards/map/the-crossroads-abda90d4ce97.png` and `https://leeroy.party/cards/map/atlas-59585b53913b.png`
   - `https://leeroy.party/cards/signup/signups-217ceaab-dd9795a8dda7.png`
   Every name is in `infrastructure/worker/card-manifest.json` (`cards.<key>.file`).
2. **See one in Discord without the flag.** Paste one of those URLs into a private channel or a DM to yourself. Discord shows the image; check that the type is readable at Discord's size and when opened full size.
3. **Turn the flag on**: Cloudflare dashboard, Compute, Flagship, app `leeroy-brain`, flag `CARD_IMAGES`, enable (it serves `on`). Or `npx wrangler flagship flags enable 1f0b836c-4929-4728-8bee-6b8bde677e79 CARD_IMAGES --remote` from `infrastructure/`. No deploy. The production deploy creates the flag, disabled, the first time it runs after this change (`docs/runbooks/flags.md`).
4. **Try it where only you see it.** `/page title:classes/druid` and `/tooltip name:Fireball` answer ephemerally, so only you see the picture. `/map place:crossroads` answers in the channel: try it in a private test channel. The sign-up picture appears only on the pinned card, so only once `CARDS_ENABLED` is on as well.
5. **Off again** at any time: disable the flag in the same place. No deploy. A reply sent while it was on keeps its picture.

If no picture ever appears with the flag on, check from a browser that the file URL answers 200, and that `BOARD_PUBLIC_URL` is `https://leeroy.party` in `infrastructure/wrangler.toml`. The Worker logs nothing per reply about cards.

## Keep the cards fresh

- **Repository data or drawing code changed** (`data/library`, `data/atlas`, `fonts/`, the templates, `tools/cards/*.mjs`, `chromium.json`, `card-models.js`): the unit test `card-images.test.mjs` fails ("the data changed since it was drawn", or the inputs hash). Re-render everything and commit:
  ```bash
  cd tools/cards && npm ci && node install-chromium.mjs && cd ../..
  node tools/cards/render.mjs --write
  ```
  It writes only the PNGs whose decoded pixels changed, deletes the ones no card uses, and rewrites the manifest. `--write --only <key prefix>` is for trying a change and refuses to run when the template, the drawing code, a font or the browser changed (it would stamp cards it did not redraw). Linux x64 only (the pinned browser is the Linux build). Without one, push the data change anyway: the `Card pixels` workflow fails and uploads its renders as the artifact `card-renders-first`; render with the pinned browser before merging.
- **D1 changed after a deploy** (the 6-hour cron, a wiki approval): `/page` replies for those pages have no picture until the repository's copy of the page and the cards are updated. A stale picture is never sent.
- **New sign-up choices** (an admin edits `signups.options`): no sign-up picture until the set is added to `SIGNUP_VARIANTS` in `tools/cards/sources.mjs` and re-rendered.
- **A re-render deletes old files.** A Discord message that already shows a picture keeps it while Discord's own media cache holds it; after that, a message whose card was redrawn since shows no picture. The text is unaffected.

## The pixel check (CI)

`.github/workflows/cards.yml` runs on a pull request that touches anything that draws a card (paths in the file) and on demand. Two clean `ubuntu-24.04` runners each install the pinned driver and browser and run `node tools/cards/render.mjs --check`, which fails unless every card decodes to exactly the pixels of its committed PNG, every committed PNG is a strict PNG in the manifest, and the manifest matches the repository's data and drawing code. A pull request that changes cards merges only with `Card pixels` green (it is not part of the `Preview tests` comment). About a minute of rendering per runner, only when card inputs change.

What makes the pixels repeatable: the pinned browser; Skia's baseline CPU code (`--disable-skia-runtime-opts`, no AVX2 or AVX-512 paths picked at run time); sRGB, no LCD text, no hinting, no GPU; UTC, en-US and a fixed clock; every request answered from the repository and anything else refused (a refused request fails the run); every font face loaded and checked before the first card, images decoded; every character of every card checked in Node against the character map (`cmap`) of all five fonts (`tools/cards/fonts.mjs`), so no glyph can come from a fallback font or be an empty box; DevTools (`CSS.getPlatformFontsForNode`) must also report that every glyph came from one of the board's fonts; and pixels compared after decoding, never as PNG bytes. Committed PNGs hold IHDR, IDAT and IEND only (`decodePng(..., { strict: true })`): an animation, transparency or colour-profile chunk could make a viewer show other pixels than the ones hashed.

Measured on 2026-11-22: the authoring sandbox (an Intel Xeon with AVX-512) drew all cards identically in two fresh browsers (`--check --twice`); Chrome for Testing 157.0.8103.78 drew all of them identically to the pinned 153.0.8010.12; and two GitHub runners (both Intel Xeon 6975P-C) reproduced every committed card exactly. Not yet seen: an AMD runner.

## Roll back

Disable `CARD_IMAGES` in Flagship (no deploy). The files under `/cards/` can stay; nothing links to them with the flag off. To remove everything: revert the change (Pages then stops serving `/cards/`, and the Worker no longer reads the manifest).

## Not verified

- How Discord shows the pictures in a real reply, and its media proxy's caching of `leeroy.party/cards/` (no live Discord from CI or the authoring sandbox). The steps above check it first.
- A HEAD from the production Worker to `https://leeroy.party/cards/...` (same zone; a refusal there would mean no pictures, never a broken one).
- Determinism on an AMD runner (both CI runs so far were on the same Intel model).
