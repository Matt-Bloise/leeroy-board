# R4: Market, onboarding UX and newcomer journey for the WoW Forever guild companion

Researcher: R4 (product, UX, market). Access date for every source: 2026-11-02. Read-only research; no repo changed, nothing posted, no credentials used.
Labels: **confirmed** = I read the primary or vendor page this session; **likely** = secondary source or vendor-authored with a plausible mechanism; **speculative** = my inference.
Images reviewed: phone-390x844-first.png and desktop-1366x768-first.png (confirmed: they show a "Next steps" parchment card, "Pick your name", five hard-coded names plus "Just looking", a launch line, a Guided/Curious/Everything switch, 12 ribbon tabs on desktop, a 5-item bottom bar on phone). I did not open the portrait 1080x1920 shot; the brief's description of it is taken as given.

---

## 0. Bottom line (read this first)

1. The product has no answer to "what is this and what do I get". Every competitor I read states the job in one line on its front page (OXM.GG: guild manager for Classic raiding; That's My BIS: loot tracker; Raid-Helper: raid sign-ups). The first screen here states none. (confirmed for competitors, confirmed from screenshots for us)
2. The first-run gate asks the visitor to identify themselves from a hard-coded list of the original five. That is a data-model problem, not a copy problem: a newcomer has no valid answer. Fix by sourcing identity from the Discord login (every serious competitor that integrates with Discord does this: OXM.GG, That's My BIS, Raid-Helper). (confirmed)
3. Direct, funded, Forever-specific competitors already exist and launch this week: OXM.GG (forever.oxm.gg), Guild Order (Forever plugins such as "Launch Board", "World Buff Board", "Raid Signup", "Loot Ledger"), That's My BIS (lists Forever as supported). Our edge is not generic guild management; it is the guided, friendly, group-knowledge layer plus Leeroy inside the Discord the group already uses. (confirmed that they exist; edge is speculative)
4. Monetization: the market norm is a free core with the paid line drawn at recurring events, history/archives, automation, branding and API; priced per server, not per seat. Discord's own Premium Apps support guild subscriptions that unlock every member. (confirmed)
5. Nielsen Norman Group's evidence says most apps should drop users straight into the interface and not use tutorials; use contextual, optional help. Our problem is not a missing tutorial; it is too many equal-weight options and no stated purpose. (confirmed)

---

## 1. Competitive and adjacent landscape

### 1.1 Discord raid and event bots

| Product | Model and price (verified where stated) | Onboarding / first 10 seconds | Weaknesses relevant to us |
|---|---|---|---|
| **Raid-Helper** | Free tier plus Premium sold as one-time time-boxed packages on raid-helper.dev (example: 3 months for one server at 10 EUR, 1 year at 25 EUR); activation by code. Premium items: custom avatar, Discord Events sync, temporary role, custom templates, recurring events, mirrored events, event logging, archiving. Source: https://raid-helper.dev/premium/ via search snippet (my direct fetch returned only a shell page). A separate site raidhelper.pl lists different prices (7.99 to 49.99 EUR) and appears to be a different product. Third-party comparisons quote about $3.50 per month, which is probably stale. **Label: likely** (snippets, not a full read) | Invite bot, configure by slash commands or DM; one old guide describes a timezone setup step first. Source: https://techcult.com/how-to-use-raid-helper-bot-in-discord/ **likely** | Entire UX is Discord chat commands and embeds; no explanation layer, no guidance, no game knowledge. It is a sign-up sheet, not a companion. Premium needed for recurring weekly raids (the most common officer need). |
| **Apollo** | Free tier (up to five active recurring series per one comparison). Premium rose to $7.99 per month or $69.99 per year for new subscribers from 2026-04-21; existing subscribers move at the first renewal after 2026-06-23. Source: https://apollo.fyi/news/pricing-april-2026 **confirmed**. A comparison (Apollo-authored) also lists Premium Pro at $25 per month: https://apollo.fyi/blog/apollo-vs-sesh **likely** (vendor) | Slash command, event card with RSVP buttons. | General events, not raid-aware (no roles/compositions for 40-player raids). Price went up 60 percent from the ~$5 era, which shows the willingness to pay ceiling for a pure event bot is about $8 per server per month. |
| **Sesh** | Premium $6.99 per month (billed annually) for 1 server, Bundle $12.99 for 3 servers, Pro $24.99 for 1 server (API, branding, webhooks, support). Free limits: 3 favorites, 24-hour logs; premium-only: recurring events, custom RSVP options, role automation, role-restricted RSVP. Source: https://sesh.fyi/premium/ **confirmed** | Slash command, calendar sync. | Same: calendar logic, not game logic. Recurring behind paywall. |
| **Charlemagne (Destiny 2)** | Free with community donations/premium (not verified). LFG, scheduling and clan stats in one bot; rated 4.8 on top.gg. Source: https://top.gg/bot/677145368894373965 **likely** | `!lfg` command. | Illustrates that a single-game bot that bundles LFG, scheduling and game stats is the model players already accept. |
| **Raid Bot (Destiny 2)**, **Raid Organizer**, **LFG Hub** | Free; slash-command LFG posts, a bench list for late joiners, templates, auto-created weekly events, temp voice channels. Sources: https://top.gg/bot/528360720212033546 , https://discord.bots.gg/bots/658698521570181140 , https://top.gg/tag/lfg **likely** (listings can be stale) | Slash command. | Commodity. The "bench" idea (late joiners and standbys) is worth borrowing for 40-player raids. |
| **Guilded** | Shut down 2025-12-19 as Roblox refocused on Roblox Communities. Source: https://alternativeto.net/news/2025/11/guilded-to-shut-down-on-december-19-2025-as-focus-shifts-to-roblox-communities/ and https://en.wikipedia.org/wiki/Guilded **confirmed** | n/a | The "Discord alternative with calendars and rosters" category is dead. Gaming groups are consolidated on Discord, which is where we live. Do not plan around Guilded. |

### 1.2 WoW-specific tools (direct and adjacent)

| Product | What it is / price | Onboarding | Notes for us |
|---|---|---|---|
| **OXM.GG** | Classic guild manager: raid rosters and splits, boss assignment sheets with maps, soft reserve and loot council, an auto-split solver, scheduling, absence calendar, PUG listings, guild bank requests, gear planner and BiS manager, applications pipeline, Warcraft Logs data. Supports TBC and **WoW Forever at forever.oxm.gg**. Run by a guild (Progress). No pricing shown on the home page. Source: https://oxm.gg/ **confirmed** | Sign in with Discord, connect your server, see your own roster; a live demo of several pages; the Discord bot acts as a full client (create characters, sign up, confirm invites, roster pings without visiting the site). **confirmed** | The closest direct competitor for the officer persona. Its onboarding principle (Discord login, connect server, demo) is exactly what we lack. Its "bot is a full client" idea matches our Leeroy. |
| **Guild Order** | "All-in-one platform for gaming guilds": forums, chat, events, tournaments, wiki, custom domains. Forever plugins listed: Trade Board, Contribution Ledger, Profile, Plan Vault, Roster Scorecard, Profession Registry, Applicant Vet, Raid Signup, Attendance, Loot Ledger, World Buff Board, Classic Attunement Board, **Launch Board**; also a Forever database, calculator and timers. Source: https://guildorder.com/games/wow_forever/wiki/what-wow-forever-is **confirmed** | Free 14-day trial on entry plan, no card; guild frozen if trial ends without a plan. Source: https://guildorder.com/pricing **confirmed** | **Pricing (confirmed):** guild plans Scout $3.99 per month or $39.99 per year (30 members), Champion $11.99 / $119.99 (200 members), Legendary $23.99 / $239.99 (500 members). Community plans $14.99 to $99.99 per month. One subscription per guild; members free; every plugin on every plan; plans differ only by capacity. Their "World Buff Board" and "Launch Board" overlap our "Who buffs whom" and launch countdown. |
| **That's My BIS (TMB)** | Loot tracker: wishlists, priorities, loot and reserve history, raid attendance, raid groups for several teams, imports from Warcraft Logs, Raid-Helper, Softres.it, Gargul, RCLootCouncil. Lists **Forever** among supported games. Free with Patreon (ads off) and donations. Source: https://thatsmybis.com/ **confirmed** | Sign in with Discord; access mapped to the guild's Discord roles (Raider, Officer, Guild Master, PUG); wiki for setup. **confirmed** | The model for role-based access via Discord roles. Free plus donations shows how the incumbent is funded; a paid tool competes against "free". |
| **Guild Manager (guildmanager.app)** | Web workspace for roster, main/alt characters, applications, participation tracking, Retail, Classic and Hardcore. Pricing not verified. Source: https://guildmanager.app/games/wow **confirmed for features, pricing unknown** | Not described. | Alt handling (main and alts per member) is a stated feature; matches persona (d). |
| **Guilds of WoW** | Sync app and Discord bot for attendance, loot council integration. Source: https://guildsofwow.com/install-applications (search listing) **likely** | Desktop sync app. | Heavier install; a barrier we do not have. |
| **Softres.it** | Free soft-reserve site: officer creates a raid link, raiders open it and choose reserves, officer locks the sheet, addons import. Source: https://www.method.gg/wow-classic/how-to-use-softres-it-for-your-raids-in-wow-classic-soft-reserve-hard-reserve-explained **confirmed** (guide dated Aug 2026) | One link, one job, no account friction for raiders. | The best onboarding example in the niche: one link to share, one task for the raider. |
| **RCLootCouncil / Gargul** | In-game loot addons; RCLootCouncil for council-style guilds, no native Discord integration per one blog. Source: https://medium.com/@rengo_wow_world_of_warcraft/rclootcouncil-vs-gargul-which-wow-loot-addon-should-you-use-f99ac760e944 **likely** | In-game. | Not a competitor: an integration target. |
| **Warcraft Logs** | Free with a patron-style subscription: Classic Fresh page lists Silver $2, Gold $5, Platinum $10 per month and a higher tier; ad-free, banners, API limits, and says it wants Classic Fresh to stay free. Source: https://fresh.warcraftlogs.com/subscribe (via search; the main page returned HTTP 403 to my fetch) **likely** | Upload logs, view. | Performance analytics, a different job. Shows the "free core, cosmetic and convenience subscriptions" pattern in WoW. |
| **Wowhead Premium** | Ad-free tiers; Rare $2 per month, 6 months $5 or $6 (sources disagree), 12 months $9; Epic around $5 per month; gifting at $1 per month. Source: https://www.wowhead.com/premium and https://help.zam.com/support/solutions/articles/27000007566-how-much-does-a-subscription-cost- **likely** (undated, conflicting) | n/a | Players accept $2 to $9 per month for convenience on top of free content; the ceiling for a "knowledge" product is low. |
| **Raider.IO, Archon, Method, Icy Veins, WoWAnalyzer** | I could not verify current pricing or onboarding for Raider.IO or Archon (search returned nothing). WoWAnalyzer, Icy Veins and Method are free content/analysis. **Unverified; do not state prices.** | | Knowledge content is free and ad funded; payment attaches to convenience, history and removal of ads, not to facts. |

### 1.3 Other games' tools (what they teach us)

- **FFXIV**: RaidPlan.io (free visual boss planner with shareable links, layers, vanity URLs; Patreon funded) and XIVPlan (open source, plans stored locally). Source: https://raidplan.io/ffxiv , https://github.com/joelspadin/xivplan **confirmed**. Lesson: a tool that produces one shareable artifact (a plan link) spreads by itself; no account needed.
- **Destiny 2**: Charlemagne, Raid Bot, Indeedstor, all Discord-native LFG with a bench. Sources above. Lesson: the audience is already in Discord; a bot meets them there.
- **Lost Ark**: LF.Group (web LFG with a synced Discord bot, 2022 guide) and an open-source Ark Guild Helper. Source: https://maxroll.gg/lost-ark/news/lf-group-recruitment-tools-for-lost-ark **likely** (dated).
- **Guild Wars 2** tools (GW2 Efficiency, Snowcrows): my searches did not return usable evidence. **Unverified.**

### 1.4 Discord Activities: what the successful ones do

- Discord's own design guidance: design for small groups of about 3 to 8, "solo-plus" (works alone, better with friends); if solo is not supported, expect many solo peeks and offer a preview; expect late joiners and give them something to do at once (spectate); be ready for 25 or more people in the call; first-time users must be able to start without voice chat explaining it; use dynamic first-time experiences, short how-to, toasts and call-to-action buttons without clutter; "if a tutorial is required to understand the basics, players may hesitate to join mid-game"; prioritize time-to-first-interaction; support mobile with safe areas and clear of swipe gestures; Tab navigation must not be trapped; ESC closes modals; high-contrast, colour-blind-safe palettes. Source: https://docs.discord.com/developers/activities/design-patterns **confirmed**
- Playroom (Death by AI): reported peaks of 700K daily users, over 70 percent of sessions with more than three friends within a week, over 30 percent day-7 engagement for many weeks; benefit came from the SDK removing invite friction (session id mapped to room id). The case study says nothing about a tutorial. Source: https://discord.com/build-case-studies/playroom **confirmed** (vendor case study)
- Mojiworks (Chef Showdown): collaborative modes gave +50 percent new-user retention and +30 percent play time versus PvP for new users; the advice is to ask why a player would come to Discord for this. Source: https://discord.com/build-case-studies/mojiworks **confirmed** (vendor case study)
- Pattern in the first 10 seconds (**likely**, synthesized): successful Activities land the user inside a shared, already-live thing (a room, a game, a video) with one obvious action; they do not ask who the user is, because Discord already knows. I found no source documenting any Activity with a "pick your name" gate; the evidence points the opposite way.
- Gap: I found no official Discord first-run guidance beyond the design-patterns page, and no per-Activity usage ranking.

### 1.5 What would make a product like ours worth paying for (analysis)

Observed facts: free competitors cover loot (TMB, Softres.it), sign-ups (Raid-Helper free tier, Sesh free tier), planning (RaidPlan.io), and knowledge (Wowhead, Icy Veins, Method). Paid products charge for recurring events, archives and history, automation, branding, API, capacity (Raid-Helper, Apollo, Sesh, Guild Order). **confirmed** across the pages above.

Therefore (**speculative**, my inference): a guild will pay for outcomes it cannot get free: (a) a guild's whole Forever onboarding in one place with Discord login and role-based views, (b) a guide that is already tailored to the guild's chosen classes, professions and launch dates and updates when Blizzard patches (knowledge freshness with a human-in-the-loop), (c) an assistant (Leeroy) that answers questions in the guild's Discord with the guild's own rules, (d) multi-party raid composition for 40-player content with a bench and alt handling (OXM.GG's auto-split solver proves demand), (e) history and archive that outlasts a launch week. Weak places to charge: raw facts, countdowns, generic timers, simple sign-ups (all free elsewhere).

### 1.6 Likely monetization models and evidence

| Model | Evidence | Fit |
|---|---|---|
| Free tier plus per-server subscription (Raid-Helper, Apollo, Sesh) | $6.99 to $7.99 per month per server for event bots; bundles of 3 servers at $12.99 (Sesh). **confirmed** | Best-supported default. |
| One subscription per guild, members free, capacity-tiered (Guild Order) | $3.99 to $23.99 per month; 14-day free trial, no card. **confirmed** | A guild-size ladder (30 / 200 / 500) maps to a 40-player raid guild. |
| Time-boxed one-off packs (Raid-Helper 3 months or 1 year codes) | Official premium page snippet. **likely** | Fits a launch-season product where the guild may churn after the first raid tier. |
| Patron/donation with ads off (TMB, Warcraft Logs, Wowhead) | **confirmed** for TMB (Patreon, PayPal), **likely** for others | Sets the expectation that the free core is the norm; paid must add convenience. |
| Discord Premium Apps (guild or user subscriptions, one-time purchases) | Docs: SKUs are subscriptions (user or guild, where a guild subscription entitles every member) and one-time purchases; applies to bots and Activities. Source: https://docs.discord.com/developers/monetization/overview **confirmed**. Fees: developer keeps 85 percent after processing fees on the first $1M cumulative gross, then standard 30 percent platform fee; payouts within 45 days after the month ends through Stripe; payout review after first $100 net. Source: https://support-dev.discord.com/hc/en-us/articles/17299902720919-Premium-Apps-Payout (via search summary) **likely** (rates from a search summary of the support article; verify the Monetization Terms before relying) | Lowest billing friction for guild officers who already live in Discord; costs a platform cut and ties you to Discord policies. |
| Per seat | I found no WoW or Discord tool that bills per raider; the pricing norm is per server or per guild. **confirmed by absence in the pages read** | Poor fit. |

Eligibility, region and approval requirements for Premium Apps were not on the page I read. **Open.**

---

## 2. First-run and onboarding research

### 2.1 Evidence (with sources)

- **Most apps need little or no onboarding; put users in the interface.** NN/g: onboarding has interaction cost and strains memory; deck-of-cards tutorials did not improve task performance; test the product without onboarding first, fix the design, and add onboarding only if it measurably helps; reserve it for apps that need user data to function, depend on user context, or have a truly novel feature. Source: https://www.nngroup.com/articles/mobile-app-onboarding/ **confirmed**. The mobile tutorial study (70 users, 4 iPhone apps) found tutorial readers rated tasks harder (4.92 versus 5.49) with no success gain (91 versus 94 percent). Source: https://www.nngroup.com/articles/mobile-tutorials/ (figures from a search summary) **likely**
- **Customization at first run:** content choices such as language or skill level fit; keep it brief, explain why you ask, allow skipping. Same NN/g article. **confirmed** This supports one short "what do you want to do" choice, not a three-way "Guided/Curious/Everything" depth switch with no stated meaning.
- **Contextual help beats up-front tours:** show tips at the moment of first encounter, brief, optional, with a visible entry point. Source: https://www.nngroup.com/articles/onboarding-tutorials/ **likely** (search summary)
- **Progressive disclosure:** show a few core options first; two levels is the practical maximum; wrong splits and multiple paths to the same option hurt; pair analytics with observation because traffic can come from mistakes. Source: https://www.nngroup.com/articles/progressive-disclosure/ **confirmed**. Applied: 12 equal-weight ribbon tabs are a first level with twelve items; the three "journeys" add a second axis.
- **Empty states must teach and offer a path:** show system status, explain what the area is for, give a direct action (and, in Loggly's example, a "load demo data" route). Source: https://www.nngroup.com/articles/empty-state-interface-design/ **confirmed**. Applied: a newcomer's "my sheet" is an empty state; a sample sheet is an NN/g-endorsed pattern.
- **Apple HIG:** onboarding should be short and pleasant, require little memorization, and focus on what the app provides, not on the operating system; request private data in onboarding only if the app depends on it; explain why an account is needed before showing sign-in. Source: https://developer.apple.com/design/human-interface-guidelines/onboarding (my fetch returned only the title; content from a search summary of the Apple pages) **likely**
- **Google Material (older m1/m2 pages):** three models: self-select, quickstart (go straight in), top user benefits; do not ask for choices that will become evident through use; show onboarding to new users only; land the user on a screen where they can act on what they learned; offer help to users who seem lost about 90 percent through the average first session. Source: https://m2.material.io/design/communication/onboarding.html **likely** (search summary; mirror pages are older)
- **Tour length (vendor data, 2025):** Chameleon reports 4-step tours at 74 percent completion and 7 or more steps at 16 percent; click-triggered tours 67 percent versus 31 percent for delay-triggered; Userpilot reports average checklist completion 19.2 percent (median 10.1) and a 2025 median activation rate of 37.5 percent. Sources: https://www.chameleon.io/benchmark-report , https://www.chameleon.io/blog/mastering-product-tours **likely** (vendors sell onboarding tools; SaaS, not games; completion is not the same as retention)
- **Value clarity above the fold:** the first viewport must answer "am I in the right place" and signal what is below. Secondary sources citing NN/g. **likely**; I did not find NN/g's primary page this session. Do not quote the "3 seconds" or "57 percent above the fold" figures without checking NN/g directly.
- **Deferred sign-in:** Baymard's recommendation is guest-first, account creation after the task; abandonment due to forced account creation is cited between about 26 and 34 percent depending on source, and 60 percent of mobile users had trouble spotting the guest option when it sat under the login. Sources are secondary (e.g., Amazon Pay summary of Baymard). **likely**; ecommerce, not gaming; the principle transfers (do not gate the first value behind identity) but the numbers do not.
- **JTBD and role-based onboarding:** practitioner advice (Appcues, Chameleon, ProductLed) is to segment onboarding by the top two or three jobs; I found no controlled study measuring the effect; the academic literature says job stories are not yet empirically studied. **speculative as evidence, reasonable as design heuristic**
- **Embedded-app specifics:** Discord says the UI and copy must not depend on voice chat to explain the Activity, safe areas must be respected on mobile, keep time-to-first-interaction short, expect late joiners. Source: Discord design patterns page above. **confirmed**
- **Accessibility (WCAG 2.2 AA essentials):** new AA criteria are 2.4.11 Focus Not Obscured (Minimum), 2.5.7 Dragging Movements (single-pointer alternative), 2.5.8 Target Size (Minimum) 24 by 24 CSS pixels, 3.3.8 Accessible Authentication (Minimum); new A criteria 3.2.6 Consistent Help and 3.3.7 Redundant Entry (do not make people re-enter data already given). Source: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ **confirmed**. Reduced motion: 2.3.3 Animation from Interactions is AAA; technique is the `prefers-reduced-motion` media query; do not blanket-disable animations that carry meaning such as progress spinners. Source: https://w3c.github.io/wcag/understanding/animation-from-interactions.html **likely** (search summary). I did not find authoritative guidance on a 12-tab navigation or tablist behavior for screen readers; check the WAI-ARIA Authoring Practices tabs pattern. **Open.**

### 2.2 Applied diagnosis of the current first screen (analysis; screenshots confirmed, mapping is my inference)

| Observation | Principle violated | Evidence |
|---|---|---|
| No statement of what the product is | Value clarity; Discord says first-time users must start quickly without outside explanation | NN/g via secondary; Discord design patterns |
| "Pick your name" from five fixed names | Gate on identity before value; wrong data source; breaks Redundant Entry (3.3.7) for anyone who already gave their name in the Discord form | Apple/Baymard principle; WCAG 3.3.7 |
| Newcomer not among the five | The only primary action has no correct answer for the main persona | Screenshots |
| 12 ribbon tabs plus 5 bottom-bar items plus 3 journeys on one screen | Progressive disclosure: more than two levels, multiple paths to the same options | NN/g progressive disclosure |
| "Guided / Curious / Everything" with no definition | Customization should be content-based, explained, skippable | NN/g mobile onboarding |
| Launch countdown above the card | Not harmful, but is the only fact shown; it answers "when" without "what" | Observation |
| Portrait desktop mostly empty parchment (per the brief) | Layout does not adapt; focus and wayfinding lost | Discord guidance on varied screen sizes |

---

## 3. Simplest-possible newcomer journey (testable)

Design rules used: one primary action per screen; identity comes from Discord, never from a typed list; value before options; two disclosure levels at most; every step skippable; copy states the job in plain words in game-community tone (friendly, short, not twee). All copy below is draft wording to test, not final.

### 3.1 Shared first screen (applies to everyone; replaces "Next steps / Pick your name")

- **Screen says** (one heading, one sentence, one button, one quiet link):
  - Heading: "Your guild's cheat sheet for WoW Forever."
  - Line: "See your group, your next step, and what to do before launch. Two minutes."
  - Button: "Show me my group" (uses Discord identity in an Activity; "Continue with Discord" on the web).
  - Quiet link: "Just take a look" (a read-only sample group, no sign-in).
- **Everything else is hidden**: tabs collapse into a single "Menu" until after the first value moment. Journeys (Guided/Curious/Everything) are removed from this screen.
- **Success measure:** within 10 seconds a first-time viewer can say what it is for (five-second test, Section 4).

### 3.2 Journey steps (testable sequence)

1. **Step 1 (above).** One button. Metric: first-click on the primary button at least 80 percent (first-click benchmark commonly cited; **likely**, vendor sources).
2. **Step 2: who are you (auto).** In an Activity or after Discord login the product reads the Discord display name and the member's guild roles. Screen says: "Hi {name}. Is this you?" Button: "Yes". Link: "Not me". There is no list of five. If the member filled out the build form already, prefill from it and say so ("We used your answers from the form."). Metric: percent who reach step 3 without typing.
3. **Step 3: one card, one job.** A single card titled "Your next step" with one action (for example "Choose your first profession" or "Confirm your Wednesday raid spot"), a one-line reason, and a "Skip, show me around" link. No second card.
4. **Step 4: first value moment** (persona-specific, below), shown with real or sample data, never an empty state.
5. **Step 5: reveal depth.** After the first value, show a small "More" entry and a single contextual tip. Journeys depth (Guided/Curious/Everything) becomes a later setting named by outcome ("Keep it simple" / "Show me everything") in Settings. Metric: percent who open a second area in session one.
6. **Step 6: return hook.** One optional line: "Want a ping when X is due?" Asked once, after value, never at start.

### 3.3 Persona journeys

**(a) Friend just invited to the Discord who filled out a build form**
- First screen: the shared screen, but opened from Discord (Activity or link in the welcome message), so the button reads "Show me my group".
- First action: "Yes, that is me" (auto-identified; their form answers prefilled). No list.
- First value: their own page: "Here is your plan: class, race, first professions, what your friends already picked," in one screen, with one next step (for example "Join Friday's first dungeon night"). Value is seeing themselves and their friends in the product within about 15 seconds. This is also the case the brief says is broken: the new member is not in the five. Fix: member list comes from the Discord roster plus form entries.
- Note: this audience is a friend group; the library voice rule (inform, do not instruct) from the project's CLAUDE.md applies to shared content. Frame the next step as an offer ("Here is what is coming") rather than an assignment. **(project convention, confirmed from the repo notes provided)**

**(b) Stranger who found the website directly**
- First screen: the shared screen with no Discord context, so the line adds one sentence: "Built for friend groups and guilds playing WoW Forever."
- First action: "Just take a look" (sample group, read-only) or "Continue with Discord".
- First value: a sample group's page showing the product with fake people (clearly labelled "Sample guild"), plus one big "Make this for my guild" button. Value is understanding in one screen. The Loggly-style "load demo data" route is NN/g's own empty-state recommendation (**confirmed**). A stranger should never see the original five friends' names; showing real friends' handles to strangers is also a privacy risk (**speculative**).

**(c) Guild officer running 40-player raids with several parties**
- First screen: shared screen, with a second button for this role: "I run a guild" (single role choice; the only question asked, with a stated reason: "so we show the right tools").
- First action: "Connect my Discord server" (OAuth, then bot install; mirrors OXM.GG's "sign in, connect your Discord server, see your own roster").
- First value: a roster built from Discord roles and existing sign-ups, split into parties with a visible bench, plus one shareable link for raiders (the Softres.it pattern: one link, one raider task). Value moment: "40 players, 5 parties, 3 open slots" on one screen. Compare OXM.GG's auto-split and TMB's Discord-role mapping (**confirmed**). Everything else (loot, attendance) stays behind "More".

**(d) Player with three accounts and alts**
- First screen: shared screen; after identification: "Which character is this for?" with the characters pulled from the form or the previous sessions, plus "Add another character".
- First action: pick or add one character; do not ask for all three accounts up front (progressive disclosure; Material's advice to avoid choices that become evident through use).
- First value: that character's next step, with a small switcher ("You have 3: Mage, Priest, Rogue") that never leaves the page. Guild Manager lists main and alt handling as a feature (**confirmed** in its page), so the need is real; our version must keep the first screen to one character.

### 3.4 Acceptance tests for the proposal (copy these into the test plan)

- Five-second test on the first screen: at least 8 of 10 can say what it is for and what they would do next.
- First-click: at least 80 percent click the primary button (stranger and friend variants).
- No list-of-names screen exists anywhere in the first-run.
- A member not in the original five completes step 3 with zero typed names.
- Time from open to first value is 20 seconds or less on a phone in portrait at 390 by 844.
- At 1080 by 1920 portrait and 1366 by 768, the primary button is visible without scroll and the layout is not mostly empty.
- Keyboard: Tab reaches every control; ESC closes any modal; targets at least 24 by 24 CSS pixels (WCAG 2.2 AA); `prefers-reduced-motion` respected; Redundant Entry honoured.

---

## 4. How to test it cheaply with real people

### 4.1 Methods in order of cost

1. **Five-second test** (show the screen for five seconds, then ask "what is this for?" and "what would you do first?"). Needs 20 to 50 strangers for a stable read; ask only two questions. Lyssna lists five-second testing as a product feature; whether the free plan includes it is not stated on the pricing page (**confirmed that the page is silent**). I found no authoritative research on the technique this session; treat the method as practitioner standard. **likely**
2. **First-click test** (task: "You want to see your raid group. Click what you would press first."). Heuristic widely repeated: people who click right first succeed in the whole task about 87 percent of the time versus 46 percent when wrong (Bob Bailey study as cited by vendors; 2006, old). Aim for 80 percent or more correct. Sources: https://www.lyssna.com/guides/first-click-testing/ and https://cleverx.com/blog/first-click-testing-methods-and-benchmarks/ **likely**
3. **Think-aloud with 5 users from the actual audience** (friends, then two guild officers you do not know). Five users find about 85 percent of problems per the Nielsen and Landauer model for one homogeneous group; repeat per persona; the rule resets with a new persona or device type. Sources (secondary): https://thestory.is/en/journal/why-is-it-enough-to-test-5-users/ ; NN/g think-aloud description: https://www.nngroup.com/consulting/usability-testing/ **likely**. With four personas the realistic minimum is about 3 per persona rather than 5 of one; this is a budget compromise, **speculative**.
4. **Unmoderated sessions** (task script plus screen recording). NN/g's benchmarking page suggests 20 to 200 users for unmoderated quantitative work; one vendor blog claims 20 to 40 percent cost saving over moderated (not verified). **likely**
5. **Analytics events** (first_open, identify_confirmed, primary_click, first_value_seen, menu_opened, left_within_10s). Tie each to a Section 3.4 acceptance test.

### 4.2 Tools and prices (as read this session)

| Tool | Use | Pricing (source) | Label |
|---|---|---|---|
| Lyssna | Five-second, first-click, surveys, panel recruit | Free: $0, unlimited quick studies, 3 seats, 15 self-recruited responses; Growth $166 per month (billing period unclear); Enterprise custom; panel priced separately by credits. https://www.lyssna.com/pricing/ | confirmed |
| Maze | Prototype tests, usability analysis | Page showed tiers but not values; third parties cite about $99 per month and a limited free plan. https://maze.co/pricing/ | page confirmed silent; prices speculative |
| PostHog | Event analytics, session replay, surveys, flags | Vendor page says free monthly allowances for each product and pay-as-you-go beyond; a PostHog comparison page lists 1M events, 5,000 web recordings, 1,500 survey responses free per month; my fetch of the pricing page truncated before the numbers. https://posthog.com/pricing , https://posthog.com/compare/posthog-vs-hotjar | likely (vendor) |
| Microsoft Clarity | Session recordings and heatmaps | "Free forever", "no limits on traffic". https://clarity.microsoft.com/ ; I did not confirm custom event support. | confirmed for free claim |
| Hotjar | Heatmaps, recordings, surveys | Redirects to Contentsquare pricing (301); sources conflict on the free allowance (35 daily sessions versus 200,000 monthly). https://www.hotjar.com/pricing/ | free tier unclear; do not rely |
| Cloudflare Web Analytics | Cookieless page views | Free, no cookies, no fingerprinting; page does not state limits; third-party sources agree it has no custom events and updates with a delay. https://www.cloudflare.com/web-analytics/ | confirmed for free and cookieless; "no custom events" likely |
| Plausible | Cookieless analytics with events | From about $9 per month; no free cloud plan; tier prices conflict across sources. | likely |
| Playwright traces | Regression and layout checks | Free. Traces and videos record scripted browsers, not human behaviour, so they are for verifying the acceptance tests in Section 3.4 across viewports, not for learning what people do. https://github.com/microsoft/playwright (docs via search) | likely |

Recommended minimal stack (**speculative**, my choice): Lyssna free plan for five-second and first-click on strangers; think-aloud on a screen share with the real friend group and two outside officers; Clarity (free) or PostHog free tier for session replays and events on the live board; Playwright for viewport acceptance tests. Privacy note for the owner's stated "privacy max" preference (from project memory): prefer Cloudflare Web Analytics for counts and avoid session replay of friends' in-Discord content unless disclosed; replay tools can capture typed text. **speculative**

---

## 5. Open questions I could not settle

1. Current pricing and plan details for Raider.IO, Archon and Method.gg subscriptions; WoWAnalyzer and Icy Veins revenue model. Searches returned nothing usable.
2. OXM.GG pricing (home and pricing pages showed none). Guild Manager pricing. Whether OXM.GG and Guild Order are free during Forever launch.
3. Exact Raid-Helper free versus premium table (my fetch returned only a shell page); a second domain (raidhelper.pl) lists different prices and may be a different product.
4. Discord Premium Apps eligibility, regional availability and approval rules; the 85 percent and 15 percent split came from a support article summary, not the Monetization Terms.
5. Whether any Discord Activity uses a role or identity chooser at first launch, and any per-Activity retention data; Discord's own documents give principles, not numbers.
6. ARIA tab-pattern behavior with 12 tabs on screen readers, and whether a ribbon of 12 should be a tablist at all.
7. Whether Lyssna's free plan includes five-second tests; Maze's and PostHog's exact free limits.
8. GW2 tooling landscape; the current state of Lost Ark's LF.Group.
9. NN/g primary sources for "value proposition above the fold" and for the "five users" article were not fetched this session; secondary summaries only.
10. Whether the owner wants the product tied to Discord as the only identity (Discord login everywhere). That is a product decision that the whole journey above depends on.

## 6. Surprises versus what a team would assume

1. **The first-run fix is not a tutorial.** NN/g's evidence says tutorials do not improve task performance and users who read them rated tasks harder. The winning move is to remove screens and state the purpose, not add a tour. (confirmed)
2. **Playwright is not a usability-testing tool.** Traces and video record scripts. They verify layouts and flows; they do not tell you whether a human understood the screen. (likely)
3. **The category we would have feared (Guilded) is gone,** shut down 2025-12-19, so the market is Discord-native. (confirmed)
4. **Direct competitors for Forever already ship,** including a "Launch Board" and "World Buff Board" at Guild Order and a dedicated forever.oxm.gg. The countdown and buff features are not unique. (confirmed)
5. **Nobody charges per seat.** Event bots charge per server ($6.99 to $7.99 per month); Guild Order charges per guild by member-count ladder with members free. A per-seat model would be an outlier. (confirmed)
6. **Apollo raised its price about 60 percent in April 2026** from the old ~$5 level, so the willingness-to-pay ceiling for a pure scheduling bot is rising, but knowledge sites (Wowhead) still sit at $2 to $9 per month. (Apollo confirmed; the old price likely)
7. **Free is the incumbent.** TMB, Softres.it and RaidPlan.io are free or donation-funded; Warcraft Logs says it wants its Classic site to remain free. A paid tool must beat "free plus a spreadsheet". (confirmed for TMB; likely for others)
8. **Successful Activities lean on Discord identity and rooms and say little about onboarding.** The Playroom study credits removed invite friction, not a tutorial. A typed "pick your name" step is the opposite of that pattern. (confirmed vendor case study; interpretation likely)
9. **Collaborative beats competitive for newcomers** (Mojiworks: +50 percent new-user retention). For a friend group, a "see what we are doing together" first screen is probably stronger than a personal checklist. (confirmed vendor claim; applicability speculative)
10. **Most published onboarding statistics are vendor-generated SaaS data** (Chameleon, Userpilot), with conflicting tour-completion numbers (33.5, 61 and 67 percent in different reports). Use them as direction (shorter is better), not as targets. (confirmed conflict)
11. **WCAG 2.2 target size is only 24 by 24 CSS pixels at AA.** The 44 to 48 pixel touch sizes teams quote come from platform guidance, not WCAG AA; ribbon tabs on a phone should meet the larger platform size anyway. (confirmed for WCAG; 44 to 48 from general knowledge, unverified here)
