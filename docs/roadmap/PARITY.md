# Parity: the old PC bot versus Cloudflare (2026-11-02)

This page ranks what the old PC-hosted bot did against what the Worker does today, so the Cloudflare-only goal loses nothing that people used. The ranking comes from the old bot's own event log (Oct 19 to Nov 2: 261 questions filed, 69 "More" button uses, 85 card operations, 94 sign-up events, 32 image answers, 18 reactions, 4 board lines), not from the code. The evidence for "better" is listed at the end. Inventories: the old bot from its code and notes, the new setup from the repo at master plus open PRs.

## What the Worker can do today
22 slash commands and two message context menus; a type-4 acknowledgement then an edit of the original reply; buttons for sign-ups and votes; a persona pack and journeys in D1; library retrieval; a 6-hour scrape cron that posts nothing. It cannot read Discord (Interactions only) and posts nothing on its own.

## Matrix, ranked by real use

| # | Capability (old) | Use | Worker today | Cloudflare mechanism | Status |
|---|---|---|---|---|---|
| 1 | Answer quality and voice (Skippy-style swagger, answer-first format, sources, deep link) | every question | degraded: raw ids, bare URL, wrong addressing, weak models | format post-processor (PR 113), deterministic voice guards, model bake-off, persona pack | in progress |
| 2 | Reliable reply (placeholder replaced by the answer, never stuck) | every question | could stay on the placeholder | 24 s guaranteed final reply (PR 113), then a Queue consumer | in progress |
| 3 | @mentions and replies to the bot | 261 filed | none (needs the Gateway) | Durable Object Gateway client (spike), or context menu and slash only | spike running |
| 4 | "More" and "Sources" buttons (private depth) | 69 | none | store the extra text in D1, button handler returns an ephemeral message | to build |
| 5 | Sign-up card, states, write-in modal, tallies | 94 | RSVP buttons exist; card edit-in-place and states unverified | message edit over REST, D1 state | to verify, then build |
| 6 | Pinned cards edited in place (Party Board, Sign-ups, Party card) | 85 ops | none | REST message edit from the Worker on data change, message ids in D1 | to build |
| 7 | Image answers and `/page` `/tooltip` `/map` cards | 32 plus commands | text only | pure-Worker card renderer (SVG to PNG in WASM) or Browser Run | to spike |
| 8 | Launch-night moments (7, countdown card edited each minute) | scheduled | none | `scheduled` cron, D1 ledger (PR in flight, flag off) | in progress |
| 9 | Feedback reactions and file | 18 | none | thumbs-up and thumbs-down as buttons, D1 table; also the evaluation signal | to build |
| 10 | Thread replies and private follow-up threads | used | none | REST thread creation with the bot token | to build |
| 11 | Board decision lines (silent, batched, display names) | 4 | none | post from the Worker when a sign-up changes, 5-minute window in D1 | to build |
| 12 | Noise budget and quiet hours | every post | none | D1 ledger checked before any unprompted post | to build with 8 and 11 |
| 13 | Deterministic voice guards (never "Skippy", "Matt" to "Bloise", display names only, stock openers stripped, the 1-in-12 chicken egg) | every answer | not enforced in code | extend `answer-format.js` | to build |
| 14 | News watch and library refresh; daily digest | off live | scrape cron, no digest | cron, report to the board, digest post behind a flag | later |
| 15 | Discord Scheduled Events; quiz and didyouknow; dates, countdown, help | light | quiz, dates, countdown, help exist | REST for events | later |
| 16 | Precheck and eval loop, scorecard | each answer | none | evaluation harness in CI plus an admin evaluation route | to build |
| 17 | Roster, channel ids and launch time hard-coded | n/a | roster bundled in code | D1 config per tenant (the add-member process exists) | in progress |

## Retired on purpose
Partner DM intake, typing indicators, the wastebasket reaction, 5-second outbox polling, the Claude-session brain, the Windows scheduled tasks, board publishing to a mirror.

## How we will know it is better
Each row gets an outside check: Cloudflare's own delivery and latency numbers, a script that lints every bot message in the live channel history against the format rules, the friends' thumbs and a blind side-by-side of old and new answers, Josh's review, and Discord's rendering of the final message. The old bot's 118 answers are the private baseline and never enter this repository.
