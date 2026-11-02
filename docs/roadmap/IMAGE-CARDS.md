# Image cards on Cloudflare: research and verdict

Parity row 7 (`docs/roadmap/PARITY.md`): the old bot sent 32 picture answers in 15 days (about 2 a day) and had `/page`, `/tooltip` and `/map` cards, drawn by a headless Edge on the owner's PC. Today the Worker answers those commands with text (`infrastructure/worker/discord.js`). Question: can the Worker draw pictures on the Workers Free plan?

Research only. No renderer, no wasm and no new dependency ships in this change. The one code change is a pure rule, `infrastructure/worker/image-rule.js`, that decides when a picture would be worth sending. It is not wired into `discord.js`.

## Verdict

**No-go for rendering inside the Worker on the Free plan. Keep the text cards.** Revisit if either trigger below happens.

- Satori plus resvg-wasm fits the *size* limit (the 3 MB figure is outdated, see below) but not the *CPU* limit: about 70 to 130 ms of CPU for one warm card in Node, against 10 ms per request on Free. A request over the limit is killed with error 1102, which a `try/catch` cannot turn into a text fallback.
- Browser Run on Free is allowed in volume for our traffic (10 minutes a day against about 2 pictures a day) but needs a Cloudflare API token as a Worker secret, and I could not measure seconds per screenshot. It is the only option that might work with no spend; it is a separate, later spike.
- Cheapest honest alternatives, in order: (1) keep the text reply (today); (2) pre-draw the finite cards in CI and serve them as static files from Pages; (3) Workers Paid ($5 a month at time of writing, check current pricing) lifts CPU to 30 s default and makes in-Worker rendering safe.

Triggers to revisit: the owner moves the Worker to Paid, or the 32 picture answers turn out to matter more than a text answer with a link to the board.

## Numbers and sources

Cloudflare's docs host (`developers.cloudflare.com`) and Discord's (`docs.discord.com`) were not reachable from the research environment. The figures below come from the same pages' source files in each vendor's public docs repository on GitHub (`raw.githubusercontent.com`), read on 2026-11-02 at the repo's default branch.

### Workers Free limits
Source: `cloudflare/cloudflare-docs`, `src/content/docs/workers/platform/limits.mdx` (published as Workers, Platform, Limits).

| Limit | Free | Paid |
|---|---|---|
| CPU time per HTTP request | 10 ms | 5 min (default 30 s) |
| Worker size | 64 MiB uncompressed | 64 MiB |
| Startup time | 1 s | 1 s |
| Requests per day | 100,000 | no limit |
| Subrequests per invocation | 50 | 10,000 |

- "There is no compressed size limit. Only the uncompressed bundle size counts." The 3 MB script limit in the brief is out of date: that was the older compressed cap. It is no longer the constraint.
- "CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count." Fetching fonts or crests from Pages is therefore free in CPU terms; parsing them and drawing is not.
- Over the limit: Cloudflare returns error 1102, "Worker exceeded resource limits". The invocation is terminated, so a deferred Discord reply would be left on "thinking".
- The docs' own figure for a typical Worker is about 2.2 ms per request, and 10 to 20 ms for server-side rendering and heavy parsing.

### (a) Satori plus resvg-wasm, measured
Measured here, 2026-11-02, with `satori@0.63.2` and `@resvg/resvg-wasm@2.6.2` (npm).

| Item | Size |
|---|---|
| `satori/layout.wasm` | 520,763 B (211,096 B gzip) |
| `satori/dist/standalone.js` | 937,346 B (350,081 B gzip) |
| `@resvg/resvg-wasm/index_bg.wasm` | 2,478,606 B (950,547 B gzip) |
| Test Worker bundle from `wrangler deploy --dry-run` (wrangler 3.114.0), both libraries and both wasm files, nothing else | **4,433.84 KiB upload, 1,589.81 KiB gzip** |

The existing Worker would add its own size on top. 4.3 MiB is far under 64 MiB, and over the old 3 MB figure, which no longer applies.

CPU per card, Node 22, one 1000 by 700 px card with a title and 8 fact rows, one 43 KB font (the board's `fonts/alegreya-latin.woff2`, which Satori read as woff2 without conversion). `process.cpuUsage()` user plus system:

| Step | Cold (1st run) | Warm (runs 2 to 4) |
|---|---|---|
| Load both wasm modules | 64 ms | n/a |
| Satori layout to SVG | 151 ms | 27 to 60 ms |
| resvg SVG to PNG | 241 ms | 42 to 119 ms |
| Total per card | about 450 ms with init | about 70 to 180 ms |

The PNG was 31,776 bytes. This is Node on a shared machine, not `workerd`, so the absolute numbers are indicative; the gap to 10 ms is 7 to 40 times, which no tuning I would trust closes. What I could not measure: real CPU in `workerd` or in production (it needs a deployed test Worker).

Satori's own notes (README, `vercel/satori`): it supports TTF, OTF, WOFF and WOFF2 fonts passed as data; it loads its layout wasm itself, and on Workers you fetch or import `layout.wasm` and call `init()` (the standalone build). Fonts come from the Pages site by `fetch()`, which costs wall time, not CPU.

### (b) Browser Run (Browser Rendering) on Free
Source: `cloudflare/cloudflare-docs`, `src/content/docs/browser-run/limits.mdx`.

| Limit (Workers Free) | Value |
|---|---|
| Browser hours | 10 minutes per day |
| Concurrent browsers (Browser Sessions) | 3 per account |
| New browser instances (Browser Sessions) | 1 every 20 seconds |
| Total requests (Quick Actions, the REST screenshot call) | 1 every 10 seconds |
| Browser timeout | 60 seconds |

Our load, about 2 pictures a day (32 in 15 days), fits: even at 5 s per screenshot that is about 10 s of the 600 s allowance. A burst does not fit: more than one picture per 10 s gets a 429. Unverified: seconds per screenshot, whether the binding or the REST call is available to this account, and the secret handling. The old design (a real browser) also renders the board's real CSS, so it would match the site best.

### (c) SVG only
Discord's message docs list the image types usable in an embed: "Only `.jpg`, `.jpeg`, `.png`, `.webp`, and `.gif` may be used at this time. Other file types are not supported." (`discord/discord-api-docs`, `developers/reference.mdx`, section Uploading Files, and `developers/resources/message.mdx`). An `.svg` attached to a message shows as a file download, not a picture, and cannot be an embed image. SVG costs almost no CPU (string building), but it does not meet the need. Rejected.

### (d) Cloudflare Images transforms
Source: `src/content/docs/images/pricing.mdx`. Free: "up to 5,000 unique transformations each month"; past that, "New transformations will return a `9422` error"; no charge on Free. It resizes, crops and overlays an existing image (including through a Worker binding); it does not lay out text or draw a card. It could finish a pre-drawn image (for example a resized crest), but it cannot replace a renderer. Rejected as the main option.

### Discord delivery shape (for whoever builds it later)
Source: `discord/discord-api-docs`, `developers/interactions/receiving-and-responding.mdx` and `developers/reference.mdx`.

- "You must send an initial response within 3 seconds"; interaction tokens "are valid for 15 minutes". `/page` and `/tooltip` answer inline with type 4 today, so a picture needs a type 5 deferred reply first, then `PATCH /webhooks/{application.id}/{interaction.token}/messages/@original` ("Edit Original Interaction Response", same as Edit Webhook Message).
- Files go in a `multipart/form-data` body: parts `files[0]`, `files[1]` and so on, each with a filename, plus a `payload_json` part for the rest. `attachments` entries carry the matching `id`. Request limit: 25 MiB. An embed can show the upload with `attachment://filename.png`.
- Not checked against live Discord (no access from here).

## Cheapest honest path if pictures are wanted

1. **Now:** nothing. The text replies stay. The rule in `image-rule.js` is ready for when a picture path exists. It follows the old bot: a picture only if the question names a spell or item present in `data/library/tooltips.json`, or the best answer carries a number or a date; the caption stays the text answer.
2. **Cheapest build, no per-request CPU:** a CI step draws one PNG per tooltip (834 tooltips in the current file) and per library page (67) with Satori and resvg in Node, which has no CPU cap, and publishes them to Pages as `img/cards/...`. The Worker then only sets an embed `image.url`, which is plain JSON. Pages static files are fine at that count; the cost is a larger deploy and a rebuild whenever data changes. `/ask` pictures with free text are not covered by this.
3. **If dynamic pictures matter:** Workers Paid with the renderer, or a Browser Run spike on Free sized to one picture per 10 s.

Constraints that apply to any build: `data/client.json` flag `tooltips.text` stays off, so a card shows name, rank, level, numbers and the composed short line only, never game prose; no Blizzard marks or hosts in names.

## What this change does not verify

- Real CPU time in `workerd` or production for the renderer (Node numbers only).
- Seconds per Browser Run screenshot, and whether the account has access.
- How a picture looks in Discord, and the deferred-reply flow end to end (no live Discord).
- Cloudflare's current paid price (not fetched).
