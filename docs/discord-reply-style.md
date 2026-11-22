# Leeroy's reply style in Discord

One look for what Leeroy posts in Discord: the sign-up card, the party board, `/ask` answers, `/page`, `/tooltip` and `/map`. The rules are below; the code is `infrastructure/worker/reply-style.js` and its tests are `tests/unit/reply-style.test.mjs`.

It ships behind the flag `REPLY_STYLE`, **off by default** (the variable is absent). Off, every reply is byte for byte what it was. How to turn it on and how to preview a reply: [The flag](#the-flag) and [Preview](#preview).

## The rules

1. **Cards for records, messages for talk.** A lookup or a record that stays in the channel (the sign-up card, the party board, `/page`, `/tooltip`, `/map`) is an embed card. An answer or a confirmation (`/ask`, a button's reply, an error) is a plain message. An `/ask` answer keeps the text shape the answer formatter already gives it: the first sentence in bold, facts as bullets, a small `-# Sources:` line.
2. **The colour says what kind of card it is.** Three colours, each taken from the board:

   | Colour | Hex | Used by | From the board |
   | :--- | :--- | :--- | :--- |
   | Gold | `#FFD100` | `/page`, `/tooltip` (and `/countdown`, `/dates`, `/library`, which already use it) | WoW UI gold, Leeroy's own colour |
   | Green | `#8FC97A` | the sign-up card, the party board | the Sign-ups tile (`--ok`) |
   | Atlas red | `#B5471F` | `/map` | the Atlas route-plan colour (`--atlas-plan`) |

   No other colour, and colour never carries state: a full or empty party is said in words.
3. **Author line, then title.** The small line at the top names the board shelf the card comes from ("Sign-ups", "The party", "Library · Dungeons", "Library · Tooltip", "Atlas") with that shelf's icon from the board. The title is the subject itself in plain words, at most 80 characters so it fits one phone line, with no prefix, emoji or markdown. When the board has a page for it, the title links there.
4. **Fields are facts.** A field name is a short label and its value is the fact. A list says its count in the name ("In (3)"). Short values (24 characters or less) sit side by side; lists and long values take the full width. An empty list prints `—`; an empty field is never sent.
5. **The footer says where it comes from, then when.** "Verified library", "The Living Board", "The Living Board atlas". When the card knows when it last changed, Discord's own timestamp shows it after the footer, in each reader's local time. A stamp with no time zone, one more than 10 minutes in the future, a date with no time, an epoch number or junk shows no time at all: it is never guessed.
6. **Buttons: one row per question, colour by meaning.** Each row answers one question (on the sign-up card: RSVP, then meeting point, then arrival time, then pre-order pack). Green is yes or "I'm in", red is no or "Out", grey is every other choice, and blurple is the one next step on a reply (at most one per message). A button that leaves Discord is a link button, always last in its row, labelled "Open on the board" ("Open in the Atlas" for `/map`). A card whose buttons are all choices links its title to the board instead. At most 5 rows of 5 buttons.
7. **One picture per card.** The board's seal, as the thumbnail, marks a card that stays pinned (the sign-up card and the party board). A reply to a command has no thumbnail. A picture card's large image (the embed's `image`, added by the picture-cards change behind its own flag) is never set, changed or removed by the style; when a card carries one, the thumbnail is left off. Every image the style adds is an https file on the board's own site.
8. **Nothing new is said, and nothing pings.** The style changes presentation only. Every fact, link and number of the reply it restyles survives, names and free text are cleaned exactly as before, and every styled body carries `allowed_mentions: { parse: [] }`.

## Surface by surface

| | Colour | Author line (icon) | Title (link) | Description | Fields | Footer | Buttons | Picture |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Sign-up card | green | Sign-ups (`img/icons/tab-signups.png`) | Who is coming (`#signups`) | as today | as today | The Living Board, plus the time of the last change | RSVP row (I'm in green, Out red, Tentative and Running late grey), meeting point row, arrival row, pack row; the same custom ids as today | seal thumbnail |
| Party board | green | The party (`img/icons/tab-five.png`) | Party board (`#signups`) | the counts, as today | as today | The Living Board, "+N more on the board" when people did not fit, plus the time | Open on the board | seal thumbnail |
| `/ask` answer | a message | none | none | the answer, formatted as today | none | none | More if you want it (blurple), Sources, Helpful, Off (grey); only while `ANSWER_UX` is on | none |
| `/page` | gold | Library · *category* (`img/icons/tab-library.png`) | the page title (the page) | the page's blurb | up to 5 facts, short ones side by side | Verified library | Open on the board | none, or the picture card's image |
| `/tooltip` | gold | Library · Tooltip | the name asked for (the page) | "Verified in **Page** (*Category*)." or "Mentioned on ..." | none | Verified library | Open on the board | none, or the picture card's image |
| `/map` | atlas red | Atlas (`img/map/town.png`) | the place, "Route plan: *place*", or Azeroth Atlas (the Atlas) | Charted for you on the Living Board. | none | The Living Board atlas | Open in the Atlas | none |

Discord's limits are enforced on every styled body by `finishEmbed` and `finishComponents`: title 256, description 4096, 25 fields, field name 256, field value 1024, footer 2048, author 256, and 6000 characters across title, description, author, field names and values and footer (trimmed from the last field back, with `…`); 5 rows of at most 5 buttons, label 80, custom id 100, unique custom ids, a link button is style 5 with an https URL. A cut never splits a character (an emoji cut in half upstream becomes U+FFFD, so the JSON stays valid).

## The flag

`REPLY_STYLE` is an optional `[vars]` flag, like the other off-by-default flags that are not declared in `infrastructure/wrangler.toml` (the Workers Free plan allows 64 variables, `tests/unit/var-budget.test.mjs`). Only the word `on` turns it on, in any case and with spaces trimmed (`legacyOn`); absent, `off`, empty or anything else is off. `replyStyleOn(env)` is called in three places: the two card executors in `cards.js` (`redrawCards`, `postCard`), which pass it to the renderers as an option (never from the sign-up document, which friends write), and `buildAnswerComponents` in `answer-ux.js`.

- **Turn it on:** add the line `REPLY_STYLE = "on"` to `[vars]` in `infrastructure/wrangler.toml` and deploy (merge to master). No other edit is needed, and it is 47 of the 52 variables `var-budget.test.mjs` allows, so nothing has to be folded.
- **What changes, today:** the sign-up card and the party board on their next redraw (only while `CARDS_ENABLED` is on; that is the only time the Worker draws them), and the `/ask` answer buttons (only while `ANSWER_UX` is on). `/page`, `/tooltip` and `/map` change once they are wired (next section).
- **Roll back:** remove the line, or set it to `"off"`, and deploy. Nothing is stored by the style, so there is nothing to clean up; the next redraw of a card brings back today's look.
- Not on Flagship: a Flagship key needs its row in `docs/runbooks/flags.md` and a `[vars]` fallback, and both files are being changed by another open pull request. Moving it there later is the documented migration (`flags.md`, "Migrate another flag").

## Preview

Discord cannot be tested in a PR preview (no Discord secrets there). Three ways to see a reply before turning the flag on:

```bash
node tests/local/reply-style-preview.mjs
```

prints, for fictional data, today's body and the styled body of every surface (today's `/page`, `/tooltip` and `/map` come from driving the real `discord.js` handler with a signed fake request, as the unit tests do).

```bash
node tests/local/reply-style-preview.mjs --html reply-style-preview.html
```

writes a page that draws each surface roughly the way Discord's dark theme does (colour bar, author line, title, fields, footer and time, thumbnail, button colours), today beside styled. It is an approximation; spacing in Discord differs a little.

`--json` prints the bodies as JSON. The script sends nothing anywhere and makes no AI call.

After turning the flag on in production: click any sign-up button (or `POST /api/admin/cards/post` with `"replace": true`) and look at the pinned card; ask something with `ANSWER_UX` on and look at the buttons.

## Applied now, and what waits

- **Applied, behind the flag:** the sign-up card and the party board (`cards.js` hands its own body to `styleSignupCard` / `styleBoardCard`), and the `/ask` answer buttons (`styleAnswerButtons`).
- **Built and tested, not wired:** `/page`, `/tooltip` and `/map` (`pageCard`, `tooltipCard`, `mapCard`). These replies are built inline in `infrastructure/worker/discord.js`, which another open change is editing, so this change leaves that file alone. Wiring is one branch per command, with today's code as the off branch, for example in the `/page` handler:

  ```js
  if (replyStyleOn(env)) {
    return new Response(JSON.stringify({ type: 4, data: { ...pageCard({ row, facts, boardUrl }), flags: 64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  ```

  `/tooltip` passes `{ name, row, verified: tooltipNamedBy(row, name), boardUrl }` and keeps `flags: 64`; `/map` passes `{ place, plan: planMeet, boardUrl }`. The same follow-up adds the flag's row to `docs/runbooks/flags.md` ("Optional flags").
- **Left as they are (also inline in `discord.js`):** the `/signup` status panel shown while `CARDS_ENABLED` is off, the "Q:" quote above an `/ask` answer, and the `/countdown`, `/dates` and `/library` embeds (already gold).

## Picture cards

The picture-cards change adds an image URL to the same embeds behind its own flag. The two compose in either order: the stylers keep every embed key they do not set (`image` included), an image does not count toward the 6000 characters, and a card that carries an image loses only its thumbnail, so it shows one picture. `tests/unit/reply-style.test.mjs` checks each styled surface with an image present.
