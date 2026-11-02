# Monetizing without Blizzard data, and the open-source pivot

Status: draft for the owner and the back-end architect, 2026-11-02. Claims are labelled confirmed, likely or speculative. Not legal advice.

## 1. The constraint (confirmed)

The Blizzard Developer API Terms of Use, section 2(b), bar charging premiums to use the APIs. Three community threads on the Blizzard forums (Aug to Sep 2026) ask whether a paid tier that adds no API features is allowed. None has an official reply (confirmed by reading the threads on 2026-11-02). No verified developer-relations or licensing email exists; the only addresses people found are for copyright and privacy. A written inquiry is drafted and waiting in the owner's mail drafts.

## 2. The rule that removes the dependency (likely)

The Terms govern use of the Blizzard APIs. A product that never calls them has no 2(b) exposure. So the independent design is:

- No Battle.net login, no character import, no armory calls, no API-derived data stored or shown.
- All data is typed by members or comes from Discord (forms, threads, roles), plus a library written by us or taken from CC BY-SA sources with attribution.
- Battle.net sign-in stays optional and attach-only, and is off by default until Blizzard answers in writing. If added later it stays free for everyone.

What does not go away (likely): trademark and naming (no "WoW", "Warcraft", "Blizzard" in names; "Forever" treated as covered), game art and logos (we use none of theirs), and the library's source licences (CC BY-SA text needs attribution and share-alike; no stored Wowhead or Icy Veins text).

## 3. What can be sold with no Blizzard data (confirmed as feasible, price points are speculative)

- More than one raid group or party, recurring events, history beyond a season, roster export, custom branding, and the assistant answering from the guild's own rules.
- Priced per guild, never per seat, never a paywall before first value: roughly 4, 12 and 24 USD per month by capacity.
- Free forever: one guild, one party, the whole first-run and sign-up flow.

## 3b. Game-agnostic pivot (likely best long-term)

The engine (Discord-derived forms and threads, sign-ups, next-step engine, tenants) knows nothing about any game. A game is a pack: a folder of JSON (classes, roles, raid sizes, vocabulary) plus optional art. WoW Forever is the first pack and ships under the neutral product name. Any other group game (FFXIV, Guild Wars 2, tabletop) is another pack. That also makes the product immune to any single publisher's terms.

## 4. How the money would flow (what the owner needs to do; nothing here has been done)

1. Entity: form an LLC (or equivalent) before the first paid sale so liability and the Discord team owner are not a person (likely). Needs a lawyer or a formation service and a state filing fee (varies by state, often 50 to 500 USD). Decision: owner.
2. Discord Premium Apps: the application must be owned by a Developer Team, verified, the owner 18+, a US, EU or UK team, with terms and privacy links live. Discord takes 15 percent of the first 1M USD (confirmed in the research notes of 2026-11-02; re-verify before launch). Needs: owner enables payouts with a bank account and tax form.
3. Web checkout: use a merchant of record so VAT and tax are handled (Paddle charges about 5 percent plus 0.50 USD per sale, which hurts at 4 USD; alternatives to price out: Lemon Squeezy, Polar, Stripe). Stripe's managed payments ask the seller to hold all necessary rights, which touches the Blizzard question. Needs: an account in the entity's name, bank account, tax details.
4. Cloudflare: the Free plan terms forbid collecting card data on a Free property, so checkout is always hosted by the processor. Workers Paid is 5 USD per month. The account stays Josh's for now by the owner's decision (2026-11-02); an entity-owned account is a later move.
5. Entitlements live in our database, driven by processor webhooks. The free tier is enforced in code.

Costs to expect (speculative until quoted): entity filing, 5 USD per month Workers Paid, processor fees of 5 to 15 percent, trademark searches (free: USPTO TSDR, EUIPO, WIPO), optional counsel review of terms and privacy (hours of a lawyer).

## 5. Why the open-source angle is fun and credible (speculative on adoption)

- A one-click, self-hostable Cloudflare template for a guild companion: Pages plus a Worker plus D1, free to run for a small guild. Nothing like it exists as open source for game groups that live in Discord.
- Open core: the engine and the sample WoW pack are open source (MIT or Apache-2.0 for the engine; CC BY-SA for community packs). The hosted multi-guild service, support and convenience features are the paid part. Self-hosters are never blocked.
- Community packs make it novel: any player can contribute a pack for their game by pull request, tested by the same CI.
- Transparent privacy: because the code is open, the privacy claims are checkable.

## 6. Decisions and unknowns

- Open: licence choice, product name and domain (the current domain was given by the partner, and `leeroy.party` stays the friends' private tenant).
- Open: whether Blizzard replies. Until then the plan above works without them.
- Verify before launch: Discord Premium Apps fee and eligibility, merchant-of-record pricing, EU VAT treatment.
