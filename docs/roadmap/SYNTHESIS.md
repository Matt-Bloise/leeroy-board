# SYNTHESIS: the deep (not bigger) reimagining of the board, 2026-11-02

Lead advisor deliverable. Read-only pass: no repo change, no external API call, no secret read.
Audience: the executor brain (turns each Part 6 item into a PR built by a cloud builder) and the owner.

Evidence and citation form. Every claim taken from an input names its file: `OWNER-VISION.md`, `notes-R1-wow-ecosystem.md` (R1), `notes-R2-discord-platform.md` (R2), `notes-R3-identity-privacy.md` (R3), `notes-R4-market-ux.md` (R4), `notes-R5-ip-commercial.md` (R5), `PRODUCT-REVIEW.md` (PR-REVIEW), the three screenshots in `20261102-firstrun/shots/`, and the public repo `the-owner/leeroy-board` at `origin/master` `9cbeb54` (read in `C:/projects/_scratch/20261101-ci/lb`, cited as `repo:<path>`). Labels: **confirmed** = read directly this session (file, code, screenshot) or the research note labels it confirmed from a primary page; **likely** = strong inference or secondary source; **speculative** = my design call or an unverified claim.

Current-state facts I verified in the repo this session (confirmed):
- `repo:infrastructure/wrangler.toml` still carries `USER_SALT` and `KEY_SALT` as plain `[vars]` at `9cbeb54`; the Phase 0 list given in the brief does not include that item, and it is not done.
- `repo:infrastructure/worker/index.js:34` still declares `PARTY_MEMBERS`; `:56` defaults the admin to `PARTY_MEMBERS[3]`; `:189` and `:757` use `idFromName("global")`. There is still one hard-coded party and one global Durable Object.
- `repo:infrastructure/worker/config.js` holds `name_map`, `discord_members`, `discord_roster` in D1 `kv_state` (PR #36). Names and ids are out of code; identity is still a display-name match list (`match` arrays of lowercase strings), not a Discord id.
- D1 tables: `kv_state, lib_pages, lib_blobs, lib_sources, lib_source_snapshots, wiki_proposals, ask_turns, fact_fixes, sheet_events, dispatches, members, accounts, account_keys, sessions, user_state, intents, guest_rate_limits` (`repo:infrastructure/schema.sql`). No `tenants`, `users`, `identities`, `characters`, `groups`, `signups` tables.
- Slash commands registered in `repo:infrastructure/worker/discord.js` include `ask, build, countdown, dates, didyouknow, help, journey, launch, leeroy, library, map, meet, pack, plan, quiz, rsvp, sheet, signup, sources, state, tonight, tooltip` plus the admin-era `ack, answer, intents`. `/build` exists; nothing reads what members post in threads because the Worker has no bot token and no gateway (PR-REVIEW 2.6; brief).
- `wrangler.toml` `[vars] AI_PROVIDER = "claude"` with seven provider model vars; the brief says Workers AI serves guests and Gemini serves members. The routing lives in `ai-models.js`, not in the var. The provider sprawl PR-REVIEW 2.5 flagged is still configured.
- Tests: `tests/unit/{budget,format,ids,names,persona,stamps}.test.mjs`, `tests/api/api.test.mjs`, two browser smoke files. No Discord handler fixtures, no authorization matrix, no tenancy test.
- Cron: `0 */6 * * *` (`wrangler.toml [triggers]`).

What the three screenshots show (confirmed, viewed):
- `desktop-1366x768-first.png`: top bar with Settings, "Look at the room", the scene title "Next steps", Guided / Curious / Everything, Sensory, a lantern button, close. Twelve ribbon tabs: Dates, The five, Three roads, Race skills, Bonuses, Who buffs whom, Ledger, Sign-ups, Leeroy, Library, What to decide, Next steps. One line "Launch: Wed, Nov 4, 6 PM ET, in 2 days." One card "NEXT. Pick your name. Each of the five has their own next step, shown once a name is picked here or Just looking." Six buttons: Santa, Bible Boi, Street Rat, Bloise, Handsome Squidward, Just looking. A decorative moon. Nothing says what the product is.
- `desktop-portrait-1080x1920-first.png`: the ribbon becomes tall banners (about 230 px) with ten visible and an arrow; the card and the name grid end at about 40 percent of the height; the lower 60 percent is empty parchment. The three journeys sit beside the title; two eye icons replace Settings and the room toggle.
- `phone-390x844-first.png`: "Guided" becomes a dropdown; a small teal square overlaps the title "Next steps" (a stray element, likely a mis-positioned avatar or marker); the name grid fills the middle; a lone round icon floats above a five-item bottom bar (Next, The five, My sheet, Leeroy, More). Same gate, same six names.

The owner's diagnosis in `OWNER-VISION.md` ("confused and overwhelmed", "portrait inconsistent") is confirmed by the shots. R4 section 2.2 maps each defect to a principle; I adopt that mapping.

---

## Part 1. What every top professional would say or do that we are not asking for

Each role: the opinions and actions nobody has asked for, concrete, grounded in the inputs. Where PR-REVIEW already covered a role, I only add what is new or changed by the five research rounds.

### 1.1 Product strategist
- The product has no one-line job (R4 0.1, confirmed from the shots). OXM.GG, That's My BIS, Raid-Helper, Guild Order all state theirs on the front page (R4 1.1-1.2, confirmed). First deliverable is a sentence, not a feature.
- Direct, funded Forever competitors ship this week: forever.oxm.gg, Guild Order's Forever plugins ("Launch Board", "World Buff Board", "Raid Signup"), TMB lists Forever (R4 0.3, confirmed). "Who buffs whom" and the countdown are not differentiators. The defensible edge is the guided newcomer layer plus an assistant that lives in the group's own Discord with the group's own rules (R4 1.5, speculative but the only uncontested space).
- Pick the wedge and say it: one build, one guild, one party, as `OWNER-VISION.md` orders. Everything beyond (alts, multi-account, raids, multi-guild) is a schema decision now and a feature later.
- Nobody charges per seat; everyone charges per server or per guild, members free (R4 1.6, confirmed). Price ceiling for pure scheduling is about 7-8 USD per server per month (Apollo, Sesh, R4 1.1). Guild Order ladders 3.99 / 11.99 / 23.99 by capacity (R4 1.2, confirmed). Set the free tier to the whole one-party case.
- Separate the private beta ("Leeroy", the five) from the product. The five are a usability panel, not the market (PR-REVIEW Stop 7).
- Write the "why Discord" answer Mojiworks asks (R4 1.4): the group already lives there; the product must be worth opening *inside* the call.

### 1.2 Community-platform PM
- Define the roles that exist in a guild tool before the schema: owner, officer, raid lead, member, guest, "just looking". TMB maps access to the guild's Discord roles (R4 1.2, confirmed); copy that instead of inventing a parallel role system.
- Design the notification contract: every member is told, once, what the product reads and why, with an opt-in role for pings, never DMs (R2 section 3, confirmed for allowed_mentions and the DM policy; the pattern is R2's inference). `OWNER-VISION.md` wants "everyone has a role or gets a notification"; the lawful shape is an opt-in role plus a Server Guide question, plus ephemeral replies for anything personal.
- Build the late-joiner path first (Discord design patterns, R2 1.3 and R4 1.4, confirmed): a late joiner is the late joiner.
- Add a bench concept for raids (Destiny LFG bots, R4 1.1) and a "which alt tonight" concept (Guild Manager, R4 1.2).
- Community guidelines, moderation runbook and a feedback board for a product-run server (PR-REVIEW 1.12). Not asked for and still missing.

### 1.3 Discord platform engineer
- Ingestion is the central gap. Without the Message Content intent, `content` is empty on gateway and very likely on REST (R2 2.0 item 1, confirmed for gateway, likely for REST). The cheapest legitimate reads are modals and a message context-menu command (full content, no intent) (R2 2.1 option a, confirmed). A cron REST poller needs the intent toggle (free under 100 guilds) plus `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` (R2 2.3).
- A bot token is required for any REST read; the Worker has none today (PR-REVIEW 2.6, confirmed by `git grep`). Decide where the token lives (Worker secret) and what scopes the install carries (`bot` + `applications.commands`, R2 2.3).
- Activities: instances die when the last participant leaves; key durable state by guild and your own ids, never `instance_id` (R2 1.1, confirmed). The SDK throws without `frame_id`/`instance_id`/`platform`, so the website and the Activity need distinct entry branches (R2 1.1, confirmed from SDK source).
- Portrait on phones: set the Developer Portal default orientation lock and call `setOrientationLockState` after `ready()` (R2 1.3, confirmed). This directly answers the owner's "portrait inconsistent" complaint for the phone case; the desktop-portrait case is CSS.
- Unverified Activities are team-and-tester only and (per an old help article) launchable only in servers under 25 members (R2 1.5, likely). A 40-player guild cannot pilot without verification. Plan verification now: team ownership, Stripe identity, privacy policy and terms links (R2 1.5-1.6, confirmed for monetization prerequisites).
- Entry Point command with handler 2 (Discord launches) as the one discoverable way in (R2 1.1, confirmed).
- Interaction routes that write D1 synchronously risk the 3 s limit: defer (type 5) and finish in `ctx.waitUntil` (R2 2.3; PR-REVIEW 1.16).
- Workers share egress IPs; Discord 1015/429 bans have hit Workers bots; add backoff and a retry budget (R2 section 6, likely).
- A staging Discord application (PR-REVIEW 2.5). Still not done.

### 1.4 Game-systems analyst
- Forever is realmless: identity is region + ruleset + two-part name; any schema with `realm_slug` breaks (R1 surprises, confirmed). R3's schema sketch has `realm_slug` in `characters`; replace with `ruleset` and `region`.
- Grouping is only within the same ruleset and faction (R1 1.2, confirmed). The party and raid model must refuse mixed-ruleset and mixed-faction rosters at the data layer, and the newcomer flow must ask ruleset and faction early because they decide who can play with whom.
- Raids open Dec 9 at fixed 10 / 20 / 40, no flex (R1 1.5, confirmed and likely). `size_max` in {5, 10, 20, 40}. Onyxia needs an attunement item (R1 1.5, confirmed); attunement tracking is a real officer need.
- Addons are weaker than Classic (no combat log to addons, no addon messaging in instances; R1 1.6, likely). Do not plan companion data from WeakAuras or parses at launch; Blizzard's damage meter and Warcraft Logs' pending Forever support are the sources, if any.
- Legacy points are account-wide, spent per character, 16 at launch (R1 1.2, confirmed): a per-character field worth tracking.
- Character cap and guild cap are unsettled (R1 1.3, 1.5): design for "many" and do not hard-code either.
- Content schema must carry source, licence, confidence and as-of per fact (PR-REVIEW 1.11); Wowhead refs (94 in `classes.json`) and wago.tools refs are licence problems (R5 3.2-3.3, likely/confirmed for robots.txt).

### 1.5 Identity and auth engineer
- Root identity is the Discord snowflake; username is not unique; never key on email; Discord can return `verified:false` email (R3 1.1, confirmed). The current `discord_members.match` list (`repo:infrastructure/worker/config.js`) is a display-name matcher and must go.
- Google and Battle.net are attach-only, keyed on `sub`, linked only inside an authenticated session with fresh `state`; no implicit linking; no email+password ever (R3 1.2, confirmed; CVE-2026-53516 as the cautionary case).
- Activity sessions: no cookies in the iframe; SDK `authorize` -> code -> Worker exchange -> short-lived bearer in memory plus rotating refresh; websocket ticket in the first message (R3 1.4, confirmed for the Discord rule, likely for the iOS failure).
- Web sessions: opaque `__Host-` cookie, hash in D1, sliding expiry; one `sessions` table with `kind` for both surfaces (R3 1.4).
- Battle.net: 24 h token, no refresh in practice, no email; it is a snapshot import, not a sync (R3 2.2, likely). `/profile/user/wow` coverage of Forever is unknown (R3 2.3). Build manual character entry first.
- Step-up (fresh OAuth round trip) for link, unlink, merge, delete, export (R3 1.6).
- Hand-roll a small session layer (Lucia pattern) plus thin fetch-based OAuth clients; Better Auth only if pinned >= 1.6.11 with implicit linking off (R3 1.7, likely). the architect decides.
- Verify guild membership server-side before granting tenant access; never trust SDK-supplied `guild_id` (R3 1.4, likely).

### 1.6 Data and privacy counsel
- Blizzard Dev API ToU 2(s): 30-day maximum TTL on all API data; delete characters that no longer exist (R5 1.2, confirmed). A purge job is mandatory the day Battle.net import ships.
- Discord Developer Policy: no training ML/AI on message content; delete API data on request and when no longer needed; notify Discord and users of unauthorized access (R3 0.7, R2 section 5, likely because the page returned 403). Inference by a no-train vendor under a DPA is the defensible reading (R2 section 5 inference, R3 4.7).
- Gemini free tier trains on and human-reviews content and forbids clients likely used by under-18s; EU/UK users get paid terms (R5 section 4, confirmed). It is the wrong tier for member asks today (PR-REVIEW 2.4 found members on Gemini).
- UK Children's Code reaches under-18s and names games; default-off profiling, no dark patterns (R3 4.2, likely). Discord's 13+ floor helps with COPPA, not with the Code.
- Documents: privacy policy, terms, DPA, subprocessor list, breach runbook with the Blizzard 24 h, Discord, GDPR 72 h clocks (R3 4.6, R5 6.4).
- Data inventory per table with a person in it (`ask_turns.by_name`, `sheet_events.name`, `intents`, `fact_fixes`, `dispatches`, `members`, `user_state`; PR-REVIEW 1.4) and an erasure path across all of them, not just prefs and sessions (PR-REVIEW enterprise table, "Deletion").
- Controller vs processor split for guild content needs counsel once (R3 4.1).

### 1.7 IP lawyer
- Dev API ToU 2(b): no premium versions, no charging to access an app whose features use the API (R5 0, confirmed). Everything Battle.net-fed stays free or is isolated from the paid tier until Blizzard answers in writing (R3 2.5, R5 1.7).
- 2(m) and the trademark guidelines: no Blizzard mark in the app title or URL; no combining marks with your brand; "Forever" coverage is an inference (R5 1.4, confirmed rule, likely scope). `leeroy.party` contains no Blizzard word, but the persona *is* a Blizzard character and speaks as him (PR-REVIEW 2.1). Keep "Leeroy" as the private tenant's name; the product brand is neutral.
- Art: AI-generated images have weak or no copyright; the bigger risk is derivation from Warcraft designs; keep a generation log per asset; `LICENSE.md` must not claim copyright it cannot hold (R5 3.5, PR-REVIEW 1.5).
- Library: CC BY-SA wiki text needs attribution and share-alike in a separable pack; Wowhead and Icy Veins text must not be stored; wago.tools robots.txt disallows everything but the home page (R5 section 3, confirmed for robots and the wiki licence).
- Six written questions to Blizzard (R5 1.7) and ten to counsel (R5 section 8). Nobody has asked them.
- Entity before the first paid sale: the Dev ToU indemnity and the Discord team owner bind a person today (R5 5.4, likely).

### 1.8 Payments specialist
- Discord Premium Apps: verified app, team-owned, owner 18+, US/EU/UK team, ToS and privacy links, 15 percent of the first 1M USD, parity pricing rule, `startPurchase` is web and desktop only (R2 1.6, R5 5.1, confirmed). Guild subscription SKU fits a guild tool.
- Merchant of record for off-Discord sales: Paddle 5 percent + 0.50 USD hurts at 2-6 USD price points; Stripe Managed Payments requires that you "hold all necessary rights and licenses", which ties payments to the Blizzard IP question (R5 5.2, confirmed).
- Cloudflare Free plan terms forbid collecting card data on a Free property (R5 6.1, confirmed): hosted checkout only.
- VAT: non-EU seller owes EU VAT from the first consumer sale via non-Union OSS (R5 5.3, likely). A merchant of record sidesteps it.
- Entitlements table in D1 driven by processor webhooks; the free tier enforced in code (PR-REVIEW 1.6).

### 1.9 UX researcher
- Run the five-second test and the first-click test on the real first screen before building anything else; Lyssna's free plan allows 15 self-recruited responses (R4 4.1-4.2, confirmed for the plan page, likely for the method).
- Think-aloud with three people per persona, including two officers who do not know the owner (R4 4.1).
- Instrument six events: first_open, identify_confirmed, primary_click, first_value_seen, menu_opened, left_within_10s (R4 4.1). Cookieless first-party counts; no session replay of in-Discord content (R4 4.2 privacy note, matching the owner's privacy-max rule).
- The acceptance tests in R4 3.4 are the spec: 8 of 10 can say what it is for; 80 percent first-click; no list-of-names screen; a non-founder completes step 3 with zero typing; first value in 20 s on a 390 by 844 phone.

### 1.10 Onboarding designer
- Remove screens, do not add a tour: NN/g evidence says tutorials do not raise success and make tasks feel harder (R4 2.1, confirmed). The fix is one heading, one sentence, one button.
- Identity comes from Discord, never from a typed list (R4 0.2). "Pick your name" from five names is a data-model defect, not a copy defect.
- One primary action per screen; two disclosure levels at most; twelve tabs plus five bottom items plus three journeys is three levels on one screen (R4 2.2).
- Journeys (Guided / Curious / Everything) become a later setting named by outcome ("Keep it simple" / "Show me everything"), not a first-screen axis (R4 3.2 step 5). This reverses the Oct 28 journeys decision for the first screen only; the depth setting survives.
- Empty states get sample data ("Sample guild"), per NN/g (R4 2.1, confirmed).
- Honour WCAG 3.3.7 Redundant Entry: someone who filled the Discord build form must never retype it (R4 2.1, confirmed).

### 1.11 Accessibility specialist
- WCAG 2.2 AA specifics: 24 by 24 CSS px targets, Focus Not Obscured, Dragging alternatives, Consistent Help, Redundant Entry (R4 2.1, confirmed). The ribbon on a phone should meet the platform 44-48 px size anyway (R4 surprise 11).
- Decide whether a twelve-item ribbon is a `tablist` at all; WAI-ARIA tabs with twelve tabs on a screen reader is an open question (R4 open 6).
- `prefers-reduced-motion` with parity, not blanket removal (R4 2.1).
- axe in the browser suite as a required check; one external screen-reader session (PR-REVIEW 1.7). The private a11y lane never shipped (PR-REVIEW 2.11).
- The 3D room and the cloth ribbon are an accessibility and performance liability beside a running game (PR-REVIEW 2.11); keep them behind "Look at the room", never on the first screen.

### 1.12 QA lead
- Fixture-driven Discord handler tests with recorded signed interactions (PR-REVIEW 1.9, 1.16): none exist (`repo:tests/unit/`).
- An authorization matrix test that enumerates every route in `index.js` and fails on a new ungated write (PR-REVIEW 1.4).
- A tenancy isolation test with two seeded tenants on a preview (PR-REVIEW 2.2 oracle).
- Playwright viewport acceptance at 390 by 844, 1080 by 1920 and 1366 by 768 for the primary button being visible without scroll (R4 3.4); Playwright is a regression oracle, not a usability oracle (R4 surprise 2).
- Contract tests from an OpenAPI file (PR-REVIEW 1.1).
- The builder never grades itself (memory `qa-outside-oracles`): every item in Part 6 names an oracle other than its author.

### 1.13 SRE
- SLOs for `/api/bootstrap` availability, p95 ask latency, websocket reconnect; external synthetic monitor; Cloudflare 5xx notifications; a restore drill with D1 Time Travel; runbooks per failure (PR-REVIEW 1.2). None exist.
- The cron poller and the retention job share the five-cron Free-plan cap and the 10 ms Free CPU per trigger; Workers Paid at 5 USD removes the question (R2 section 6, confirmed). Workers Free is contractually fine and operationally unfit for paying users (R5 6.1).
- Durable Object gateway option costs about 83 percent of the Paid duration allowance for one always-on object (R2 2.1 option c, arithmetic); do not choose it.
- Account ownership is the real exposure: the production account is the partner's personal account (PR-REVIEW 2.7, R5 6.1). Migration plan before any paying user.

### 1.14 Security engineer
- Salts are public in `wrangler.toml` (confirmed again at `9cbeb54`); member key hashes and the "Discord id never stored" claim rest on them (PR-REVIEW finding 2).
- Interaction signature freshness, `allowed_mentions: {parse: []}`, 2,000-char clamp (PR-REVIEW 0.9). Verify whether shipped; the brief's list does not name it.
- OWASP ASVS 5.0 L1 plus L2 for auth, session, OAuth/OIDC and access control before charging (R3 section 5, likely).
- Secrets rotation with dual-key `kid`; Secrets Store or `wrangler versions secret put` for staged rollout (R3 section 5).
- Prompt injection with persistence: the sweep auto-applies AI proposals from fetched pages (PR-REVIEW 2.5, confirmed). Review queue before any further library automation.
- ZAP baseline on previews, semgrep, gitleaks over history (PR-REVIEW 1.3).
- Rate limiting: the Workers binding is per-location and eventually consistent; precise per-user quotas need a Durable Object counter (R3 section 5, confirmed).

### 1.15 Content and localisation lead
- Blizzard's preferred-language setting is account-wide (R1 1.2); regions are Americas, EU, KR, TW, ANZ (R1 1.4). Launch times differ per region (R1 1.1). The countdown is wrong for anyone outside ET today ("6 PM ET" on the shots).
- All shared copy follows the library voice: informs, never instructs or assigns (project CLAUDE.md; memory `shared-content-library-voice`). R4's draft copy says "Show me my group" and "Here is what is coming"; keep that register.
- Every fact dated and labelled; beta numbers change by hotfix (project CLAUDE.md rules).
- Strings out of code into one copy file per surface so a second language is a file, not a refactor (speculative, standard practice).

### 1.16 Growth and support lead
- A stranger has no front door: `robots.txt` is `Disallow: /` and `index.html` is `noindex` (PR-REVIEW 2.12, confirmed). One marketing page with the sentence, a sample guild and "Continue with Discord".
- Distribution is the Discord App Directory, which needs verification and discovery opt-in (R2 1.5, confirmed).
- Support path, admin console, error codes, SLA; today `wrangler d1 execute` is the console (PR-REVIEW 1.13).
- Interviews with ten party leaders who are not the owner's friends before any pricing (PR-REVIEW 1.15).

### 1.17 Finance
- Unit economics: one ask costs about 148 neurons against an 8,000-neuron soft cap (brief), so the free guest floor is about 54 asks per day across all guests; a paid provider under a DPA for members has a per-ask price that must be bounded per tenant (PR-REVIEW 1.14; R5 5.5 says margins at 2-6 USD per server are thin after 5-15 percent fees).
- A kill threshold and a cost-per-tenant view from AI Gateway logs.

### 1.18 Release engineer
- Branch protection, CODEOWNERS, merge queue, environments with scoped secrets, pinned action SHAs (PR-REVIEW section 4). The brief says the brain merges with adversarial review at 8+; the repo must enforce that mechanically or it is a norm again.
- One PR per change, risk-labelled by changed paths (PR-REVIEW 1.3).

### 1.19 Roles missing from the brief
- **Localisation and time-zone engineer**: see 1.15; region-aware launch times and raid times.
- **Trust and safety**: a report/block flow, guest-role expiry, per-tenant caps on signups per user per hour, Turnstile on any public form (R3 section 5 abuse paragraph).
- **Technical writer**: ADRs, OpenAPI, runbooks and user docs in the public repo instead of private notes (PR-REVIEW 2.8).
- **Data engineer**: an outbox pattern between the per-tenant Durable Object and global D1 so live roster state and durable records do not drift (R3 3.2 hybrid topology).
- **Ethics and children's-design reviewer**: conservative defaults for everyone because Discord OAuth does not reveal age (R3 4.2).
- **Discord server administrator (the guild's own)**: the product must be installable and configurable by a guild admin who is not the author: `/setup`, Server Guide question, opt-in role, channel permissions (R2 2.3, 3).

---

## Part 2. The rawest materials each professional would start from instead of our digested ones

Named concretely. Our digested materials are the research notes, the board JSON files, and the library pages; these are what sits underneath them.

1. **Discord primary documents, read in a browser, not through a fetcher**: the Developer Policy, Developer Terms, "Verified and Unverified Activities", "How do I get my app verified", Premium Apps Payout, Monetization Terms, Required Support. All returned 403 to automated readers (R2 source note, R3 7.6, R5 section 9). Everything we believe about AI-training bans, the under-25-member cap and the 15 percent fee rests on snippets until a human reads the pages.
2. **Raw signed interaction payloads** from the production Worker (headers plus body), captured to a fixture folder with secrets stripped (PR-REVIEW 1.9). Today the handler is "checked on production after merge".
3. **The Embedded App SDK source** (`vendor/embedded-app-sdk.mjs` diffed against upstream `src/Discord.ts`; R2 1.1 cites the constructor's required query params) and the SDK issue tracker for the open mobile bugs #379, #355, #386, #41 (R2 1.3).
4. **A live `GET /channels/{id}/messages` response** from the real forum thread with and without the Message Content intent toggled (R2 open 1). Ten minutes; settles the ingestion architecture.
5. **Blizzard's own legal pages as current text**: Developer API Terms of Use (2019-10-01), the Logo and Trademark Guidelines, the EULA (2024-03-21), the Legal FAQ, the UI Add-On policy (R5 1.1, all confirmed read). Plus a written answer from legal@blizzard.com (address is a community suggestion, R5 1.7).
6. **A live Battle.net `/profile/user/wow` response** for a real Forever account after Nov 4, across namespaces (R3 2.3, R1 2.2). The only way to know whether Forever characters are visible and under which namespace.
7. **The USPTO TSDR, EUIPO and WIPO records** for "Leeroy Jenkins" and for any candidate product name (PR-REVIEW 1.5).
8. **The actual D1 rows**: `SELECT by_name, question FROM ask_turns`, `SELECT * FROM members`, `kv_state` keys `name_map`, `discord_members`, `discord_roster` (PR-REVIEW 1.4; `repo:infrastructure/worker/config.js`). The data inventory is written from rows, not from the schema.
9. **`wrangler tail` for a week** (cpuTime, subrequests, D1 rows read and written per route) and the Cloudflare account quota page (PR-REVIEW 1.1-1.2).
10. **The git reflog and full history** of the public repo for names and ids (PR-REVIEW 2.4; `gitleaks`).
11. **The rendered DOM at 390, 1080 by 1920 and 1366 wide** and Chrome traces from the friends' real phones (PR-REVIEW 1.7-1.8).
12. **The friends' real questions and a late joiner's actual build post** (the text, the tags, the thread id) as the first ingestion fixture.
13. **Blizzard's news posts and blue posts** as the only Forever facts with a licence we can live with, paraphrased (R1 section 3; project CLAUDE.md source order).
14. **The Warcraft Wiki licence page** and per-file image licences (R5 3.1); **wago.tools `robots.txt`** (R5 3.3).
15. **Cloudflare primary docs**: D1 limits, DO alarms and WebSocket billing, Workers limits, rate-limit binding semantics, Self-Serve terms (R2 section 6, R3 3.1, R5 6.1, all confirmed).
16. **The competitors' own screens**: forever.oxm.gg demo, Guild Order's Launch Board, Raid-Helper's sign-up embed, Softres.it's one-link flow (R4 1.2). Screenshots, not descriptions.
17. **Twenty strangers' five-second answers** on Lyssna (R4 4.1).
18. **Twelve months of cloudflarestatus.com incidents** for Workers, D1, DO, Pages and Workers AI (PR-REVIEW 1.2).
19. **Stripe Managed Payments eligibility page** and the Discord monetization pages (R5 5.1-5.2, confirmed).
20. **The Cloudflare Customer DPA v6.4 and its sub-processor list** (R3 4.2, likely; not opened).

---

## Part 3. Specific methods and tools

Named, by purpose. Pricing and availability as the research notes state them; verify before buying.

- **Ingestion**: Discord modals (Label + Text Input up to 4000 chars, String Select, Radio Group, Checkbox Group, File Upload; R2 2.1 limits, confirmed); message context-menu commands (full message content, no intent); `GET /guilds/{id}/threads/active` and `GET /channels/{id}/messages?limit=100&after=` incremental by snowflake; interaction defer type 5 plus `ctx.waitUntil`; `allowed_mentions` explicit (R2 sections 2 and 3).
- **Activity layout**: Developer Portal default orientation lock (phones and tablets separately); `setOrientationLockState`; `ORIENTATION_UPDATE` and `ACTIVITY_LAYOUT_MODE_UPDATE` events; `THERMAL_STATE_UPDATE`; `getPlatformBehaviors().iosKeyboardResizesView`; safe-area insets (R2 1.3, confirmed).
- **Identity**: OAuth2 authorization code with `state` and PKCE where supported; Discord `identify` first, `guilds.members.read` only when roles are needed; Google OIDC with JWKS verification of `iss`, `aud`, `exp`, `nonce`; Battle.net `openid wow.profile` snapshot (R3 sections 1-2). Session layer hand-rolled on the Lucia v3 pattern; Arctic for provider clients if its Battle.net support is confirmed (R3 1.7).
- **Tenancy**: global D1 with `tenant_id` first in every primary key; one SQLite Durable Object per guild for live roster state; outbox write-through; D1 Sessions API bookmarks for read replicas; D1 per tenant as the escape hatch up to 1M databases (R3 3.1-3.2, confirmed limits).
- **Quotas**: Durable Object counters for precise per-user and per-tenant limits; the Workers rate-limit binding only for coarse abuse limits (R3 section 5).
- **AI**: Workers AI (zero data retention, no training; R5 section 4, confirmed) as the floor; one paid provider under a DPA (Anthropic commercial terms or paid Gemini; R5 section 4); AI Gateway for logs, caching and spend caps; `AbortSignal.timeout` on every call (PR-REVIEW 2.5).
- **Testing**: `vitest` with `@cloudflare/vitest-pool-workers` for Worker and DO; Playwright for viewport acceptance and axe-core; schemathesis against an OpenAPI file; k6 soak at 5 and 500 users; mutation testing on `rank-core.js` (PR-REVIEW 1.1, 1.9).
- **Security**: OWASP ZAP baseline on previews; semgrep `javascript` and `secrets` rules; gitleaks over history; `securityheaders.com`; a replay test with a 10-minute-old signed interaction (PR-REVIEW 1.3).
- **Performance**: Lighthouse CI with budget assertions on previews; pre-built WebP/AVIF at display sizes; immutable caching on stamped assets (already in `_headers`, PRs #35 and #40); Cloudflare Web Analytics Core Web Vitals (PR-REVIEW 1.8).
- **Observability**: external synthetic monitor (UptimeRobot, Better Stack or Checkly free tiers); Cloudflare Notifications; Logpush or `wrangler tail` to a sink; D1 Time Travel restore drill (PR-REVIEW 1.2).
- **UX research**: Lyssna five-second and first-click (free: 15 responses); think-aloud on a screen share; cookieless event counts in D1 or Analytics Engine; Microsoft Clarity only on the marketing page, never inside the Activity (R4 section 4).
- **Accessibility**: axe-core in Playwright; NVDA + Firefox and VoiceOver + Safari manual passes; APCA contrast on rendered pixels; WAI-ARIA Authoring Practices tabs pattern review (PR-REVIEW 1.7, R4 2.1).
- **Legal and IP**: TSDR, EUIPO, WIPO Global Brand Database searches; a per-source licence table; a generation log per AI asset; written inquiries to Blizzard; counsel's clearance letter (R5 sections 1, 3, 8).
- **Payments**: Discord Premium Apps guild-subscription SKU with `ENTITLEMENT_*` webhook events; Stripe Managed Payments or Paddle for web; entitlements table in D1 (R2 1.6, R5 section 5).
- **Release engineering**: GitHub rulesets or classic protection, CODEOWNERS, merge queue, environments `preview` and `production`, pinned action SHAs, Dependabot, risk-label workflow (PR-REVIEW section 4).
- **Data pipeline hygiene**: `data/library/schema.json` validated in CI; a host allow-list with licence per host; proposals with `status 'proposed'` and two-person approval (PR-REVIEW 1.11, 1.5).

---

## Part 4. What, other than Claude or the owner, would show each result is right

Named external oracles, by result.

| Result | Oracle (not the author, not the owner) |
|---|---|
| The first screen says what the product is | Lyssna five-second test: 8 of 10 strangers answer "what is this for" correctly (R4 3.4, 4.1); first-click 80 percent on the primary button |
| Newcomer completes step 3 without typing | Playwright script with a Discord-id-based test identity; one real newcomer (a late joiner) on a screen share, observed by the architect |
| Portrait layouts are consistent | Playwright screenshots at 390 by 844, 1080 by 1920, 1366 by 768 compared with a stored baseline; the primary button visible without scroll (R4 3.4); Discord mobile client on a real iPhone and Android with the orientation lock set |
| Accessibility | axe-core zero serious or critical in CI; one external screen-reader user completing the five core tasks (PR-REVIEW 1.7); WCAG 2.2 AA checklist from w3.org (R4 2.1) |
| Security headers | securityheaders.com grade A (PR-REVIEW 1.3) |
| No unauthenticated or wrong-person writes | OWASP ZAP baseline on a preview; the authorization matrix unit test; a tester account not on any allow-list refused on staging |
| Discord handler correctness | Discord's own validators: PING/PONG at endpoint registration, invalid-signature probes Discord sends, component JSON accepted without error on a staging app (R2 section 6; PR-REVIEW 1.16) |
| REST reads of forum content | The live Discord API response with and without the Message Content intent (R2 open 1) |
| Activity auth works on phones | Discord mobile clients on iOS and Android, by a non-author tester, after the SDK `authorize` -> exchange -> `authenticate` path (R3 1.4) |
| Identity model safe against takeover | ASVS 5.0 OAuth/OIDC chapter checklist (R3 section 5); a third-party pen test before the first paying user (PR-REVIEW 3.5); the CVE-2026-53516 scenario scripted as a negative test |
| Tenancy isolation | A second seeded tenant on a preview; member of tenant B cannot read tenant A's bootstrap (PR-REVIEW 2.2) |
| Battle.net import compliance | A 30-day purge job proven by a row with `expires_at` in the past being gone after the cron; Blizzard's written answer on 2(b) |
| Licence hygiene | A CI check that every `refs[].host` is on the allow-list with a licence; counsel's review of the licence table (PR-REVIEW 1.5-1.6) |
| Product name is clear | TSDR, EUIPO, WIPO searches with no live conflicting mark; counsel's clearance letter (PR-REVIEW 2.7) |
| Privacy claims are true | A friend's subject-access and erasure request exercised end to end and verified by a second person reading D1 (PR-REVIEW 1.4) |
| AI budget holds | k6 burst of 50 asks from one member yields 429 after the cap (PR-REVIEW 1.10); AI Gateway spend graph |
| Reliability | External monitor uptime; a dated D1 restore drill log signed by the architect (PR-REVIEW 1.8-1.9) |
| Performance | Lighthouse CI budget gate green on previews; Web Analytics p75 LCP under 2.5 s on phones over two weeks (PR-REVIEW 1.8) |
| Activity distribution | Discord's verification review and App Directory review (R2 1.5) |
| Monetization eligibility | Discord's Premium Apps enablement checklist in the portal; Stripe's eligibility review (R5 5.1-5.2) |
| Market fit | Paying strangers; week-4 retention of a party with no owner contact (PR-REVIEW 1.15) |
| Game facts | A domain expert outside the team spot-checking 50 random facts against Blizzard posts (PR-REVIEW 1.11) |
| Forever API coverage | The live `/profile/user/wow` response after Nov 4 (R3 2.3) |

---

## Part 5. The deep rewrite

### 5a. Product definition and promise (one paragraph, five seconds)

**Your guild's companion for World of Warcraft: Forever, inside the Discord you already use.** Open it from Discord and it already knows who you are, which friends you play with, what you said in your build post, and what is coming next for your group, from the first dungeon night to a 40-player raid. Free for one guild and one party; it never instructs, it shows you your group and your next step.

Wording constraints: nominative mention of the game in body text only; no Blizzard mark in the product name, domain or app name (R5 1.4). "Leeroy" stays the name of the five friends' private tenant and persona until counsel clears or replaces it (PR-REVIEW D1; R5 section 7 item 3).

### 5b. The simplest newcomer journey per persona

Design rules (R4 section 3, adopted): one primary action per screen; identity from Discord, never typed; value before options; two disclosure levels; every step skippable; shared copy informs, never assigns (project CLAUDE.md voice rule).

**Shared first screen (every surface, replaces "Next steps / Pick your name")**
- Heading: "Your guild's companion for WoW Forever." Line: "See your group, your next step, and what is coming. Two minutes." One button. One quiet link "Just take a look" (read-only sample guild). Nothing else: the ribbon, journeys, Sensory, room toggle and bottom bar are hidden behind a single "Menu" until first value (R4 3.1).
- Discord Activity: button says "Show me my group". Identity is already known from the SDK `authorize` exchange (R2 1.2); no name step at all.
- Website, signed out: button says "Continue with Discord"; the line adds "Built for friend groups and guilds playing WoW Forever." (R4 3.3 b).
- Portrait desktop (1080 by 1920): one centred column, max width about 720 px, heading, line, button, sample card below; no banners. The current empty lower 60 percent (shot, confirmed) disappears because the column is content-sized and the ribbon is gone from the first screen.
- Phone (390 by 844): the same column; the button sits above the fold; orientation locked to portrait by the Developer Portal default and `setOrientationLockState` (R2 1.3); bottom bar reduced to three items after first value (Next, My sheet, Menu).

**Persona (a): a friend just invited who filled the build form (a late joiner)**
1. Opens the Activity from the "Launch" entry point or the link Leeroy posted in his build thread (R2 1.1). Screen: shared first screen, button "Show me my group".
2. Screen: "Hi {display name}. Is this you?" with his avatar. Button "Yes". Link "Not me". If a `builds` row exists for his Discord id (from the modal or the thread import, 5c), the screen adds "We used your build post from {thread name}." (WCAG 3.3.7, R4 2.1).
3. Screen: one card "Your next step": the single highest-value action for him (for example "Your ruleset and faction decide who you can group with. Yours: PvP, Horde, same as the five.") and one button that opens his sheet. Link "Skip, show me around".
4. Screen: his sheet: class, race, ruleset, faction, first professions, with "what your friends picked" beside it, and the next group date. Value moment within about 15 s (R4 3.3 a).
5. After first value: a small "Menu" entry and one contextual tip. Depth setting ("Keep it simple" / "Show me everything") lives in Settings, not here.
6. Once, after value: "Want a ping when your group's next date is set? Adds the Board updates role." Yes / Not now (R2 section 3 pattern).

**Persona (b): a stranger on the website**
1. Shared first screen with the extra line. Primary "Continue with Discord"; quiet link "Just take a look".
2. "Just take a look": a clearly labelled "Sample guild" page with fake members, a sample next step, a sample roster, and one button "Make this for my guild". Real members' handles are never shown to strangers (R4 3.3 b).
3. "Continue with Discord": OAuth `identify` (web redirect flow, `__Host-` cookie session, R3 1.4). Then: "Which server?" listing the guilds where the app is installed (from `GET /users/@me/guilds` intersected with `tenants`), or "Install in my server" (bot + applications.commands install link, R2 2.3).
4. Then persona (a) step 2 onward.

**Persona (c): an officer running 40-player raids across parties**
1. Shared first screen; second button "I run a guild" (the only question asked, with the reason "so we show the right tools"; R4 3.3 c).
2. "Connect my Discord server": install link; `/setup` in the server binds guild to tenant, picks the builds forum, the announcements channel and the opt-in role (5c).
3. First value: "Your roster" built from Discord roles plus existing builds and sign-ups: "38 signed up, 2 open, bench 4" across groups sized 10 / 20 / 40, with ruleset and faction conflicts flagged at the data layer (R1 1.2). One shareable link per raid for raiders (Softres.it pattern, R4 1.2).
4. Everything else (loot, attendance, attunement) behind "More".
5. Portrait and phone: the roster is a vertical list of slots grouped by role with a bench section; drag has a single-pointer alternative (WCAG 2.5.7).

**Persona (d): a player with several accounts and alts**
1. Shared first screen; identify as (a).
2. "Which character is this for?" listing characters already known (from the build post, from manual entry, or from a Battle.net snapshot if linked) plus "Add another character". One character to start; never all accounts up front (R4 3.3 d).
3. First value: that character's next step with a small switcher ("You have 3: Mage, Priest, Rogue") that never leaves the page.
4. Later, in Settings: "Link Battle.net" (attach-only, snapshot import, 30-day expiry stated plainly; R3 2.2-2.5) and "Link another Discord account" (humans grouping; R3 1.3).

**Discord Activity specifics**: late joiners land on the same screen as everyone else (spectate-first; R2 1.3); no login wall before the first screen (the SDK exchange happens on the "Show me my group" press, not on load); ESC closes modals, Tab is not trapped (R2 1.3).

### 5c. The Discord-derived data model and ingestion

**Goal from `OWNER-VISION.md`**: forms and threads are read regularly, understood and applied to the site; every member knows what is tracked and why.

**Architecture (choosing from R2 2.1, hybrid in R2 2.3 order):**
1. **Forms = modals, served by the existing HTTP interactions Worker.** A pinned bot message in the builds forum (and the `/build` command) opens a modal: Label + Text Input (free text build notes), String Select (class, race, ruleset, faction), Radio Group (role), optional file upload. The interaction payload carries `member.roles` and `user.id`. Defer type 5, write a `builds` row keyed by Discord id with `status 'confirmed'` in `ctx.waitUntil`, edit the original response with "Saved. Open your sheet" and a `LAUNCH_ACTIVITY` button (R2 1.1, 2.1 option a, confirmed).
2. **Existing threads = message context-menu command "Import to board".** Any member (or Leeroy's operator) right-clicks a build post; the command returns the full message content with no privileged intent (R2 2.0 exception list, confirmed). The Worker parses it (5c parsing) into a `builds` row with `status 'proposed'` and replies in the thread with "Here is what I read: ... Confirm / Fix" buttons.
3. **Passive reads = cron REST poller with a bot token.** Every 15 minutes on Workers Paid (hourly on Free): `GET /guilds/{id}/threads/active`, compare `last_message_id` with the stored cursor per thread, fetch only changed threads with `GET /channels/{id}/messages?after=`. Requires `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` on the forum and, if the spike in Part 7 shows blank content, the Message Content intent toggled in the Developer Portal (free under 100 guilds; R2 2.0 item 2, confirmed). New posts become `builds` or `notes` rows with `status 'proposed'` and the same Confirm / Fix reply.
4. **Not chosen**: a Durable Object gateway (always-on cost, community-only code; R2 2.2) and a VM gateway (retired once; only if sub-minute latency is proven necessary; R2 2.3 item 3). Webhook events for apps carry no message or thread events (R2 2.1 option e).

**Install and permissions**
- Install scopes: `bot`, `applications.commands` (R2 2.3).
- Bot permissions on the builds forum and announcements channel: View Channel, Read Message History, Send Messages, Send Messages in Threads, Embed Links, Use Application Commands. Manage Threads only if the bot must unarchive. Manage Roles only to grant the opt-in role, with the bot's role above it. Never Administrator, never Mention Everyone (R2 2.3).
- Intents: none for modals and context menus. `GUILDS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT` only when the poller proves it needs them. Never `GUILD_MEMBERS`; use the interaction `member` payload and `GET /guilds/{id}/members/{user}` (R2 2.3, confirmed alternatives page).
- Bot token stored as a Worker secret; never in `wrangler.toml`.

**Parsing ("understand")**: Workers AI (no training, zero retention; R5 section 4) turns free text into `{class, race, ruleset, faction, role, professions[], notes, confidence}`; any field under a confidence threshold stays empty and the Confirm / Fix buttons ask the member. Strip Discord ids and usernames from the prompt; log a hash of what was sent to `audit_log` (R3 4.7). Parsed rows, not raw message text, are stored; the raw text is kept only until confirmation, then dropped (Discord retention duty, R3 4.2).

**Roles and notification design**
- `/setup` (officer, MANAGE_GUILD) binds the guild to a tenant, chooses the builds forum, the announcements channel and creates or picks the "Board updates" opt-in role.
- One announcement, once, in the announcements channel, mentioning only that role with explicit `allowed_mentions: {roles: [id]}` (R2 section 3, confirmed): "This server uses the board. It reads build posts in #builds and sign-ups you make with /rsvp. It stores your Discord id, your build, your sign-ups. It never reads other channels or DMs. /board privacy shows what we hold about you; /board forget deletes it."
- A Server Guide onboarding question grants the opt-in role (R2 section 3, likely for behaviour).
- Everything personal is ephemeral (flag 64). No DMs, ever (Developer Policy, R2 section 3, likely).
- Pinned starter message in the forum: "Post your build here or press Submit build. Leeroy reads this forum every 15 minutes and asks you to confirm what it understood."

**The a late joiner case, end to end**
- Today (confirmed state): a late joiner posted a build in a thread. The Worker has no bot token and no gateway, so nothing reads it. He is not in `discord_members` in `kv_state`, so `/sheet` and `/signup` match nobody (or fall back; `repo:infrastructure/worker/config.js` falls back to null, which refuses). He opens the Activity and sees "Pick your name" with five names that are not his (shot, confirmed). The only path is the brain reading his post from the inbox and editing `kv_state` by hand.
- In 4 weeks (after Part 6 waves 1-5): an officer right-clicks his post, "Import to board"; Leeroy replies in the thread with the parsed build and Confirm / Fix; a late joiner presses Confirm; a `users` row (Discord id), an `identities` row, a `memberships` row for the guild and a `builds` row exist. He presses the "Open your sheet" button; the Activity exchanges the SDK code for a bearer, his sheet opens prefilled, "We used your build post from #builds." His next step card shows ruleset and faction compatibility with the party. If he edits his post later, the 15-minute poller sees a new `last_message_id`, re-parses, and asks him to confirm the change. He got the opt-in role from the Server Guide question, so the next group date pings him once.

### 5d. Tenancy, identity and account model

Adopted from R3 section 6 with Forever-specific corrections (realmless, rulesets, factions, fixed raid sizes). Discord id is the root; Google and Battle.net are attach-only; no email anywhere in the model.

**Topology**: global D1 for identity, tenancy, builds, groups, signups, billing, audit; one SQLite Durable Object per tenant (`idFromName(tenant_id)`) for live presence and roster editing with write-through to D1; D1 per tenant as the escape hatch (R3 3.2, limits confirmed). Every table has `tenant_id` first in its primary key where it is tenant-scoped.

**Schema sketch (SQLite dialect; additive migrations 0002-0004)**
```sql
users(id TEXT PK /* ULID */, created_at, display_name, locale, deleted_at, status)
identities(id PK, user_id FK, provider CHECK(provider IN ('discord','google','battlenet')),
           provider_subject TEXT, handle TEXT, region TEXT, linked_at, last_login_at,
           UNIQUE(provider, provider_subject))              -- several battlenet rows per user allowed
humans(id PK); human_members(human_id, user_id UNIQUE)      -- one person, several Discord accounts
sessions(id_hash PK, user_id FK, kind CHECK(kind IN ('web','activity')), created_at, last_seen_at, expires_at, revoked_at)
provider_tokens(identity_id FK, kid, ciphertext, nonce, expires_at, scope)   -- discord only; none for battlenet

tenants(id PK, discord_guild_id UNIQUE, name, plan, created_at, deleted_at)
tenant_config(tenant_id PK, builds_channel_id, announce_channel_id, optin_role_id, pack TEXT, settings_json)
memberships(tenant_id, user_id, role CHECK(role IN ('owner','officer','raid_lead','member','guest')),
            discord_roles_json, joined_at, left_at, PRIMARY KEY(tenant_id, user_id))

characters(id PK, owner_user_id FK, bnet_identity_id NULL FK, game TEXT, region TEXT, ruleset TEXT,
           faction TEXT, name TEXT, class, race, level, legacy_points_spent, source CHECK(source IN ('manual','discord','bnet')),
           verified INTEGER, fetched_at, expires_at NULL,    -- expires_at = fetched_at + 30 days when source='bnet'
           UNIQUE(game, region, ruleset, lower(name)))        -- realmless: no realm_slug (R1)
builds(id PK, tenant_id, user_id, character_id NULL, source CHECK(source IN ('modal','context_menu','poll')),
       source_message_id, source_thread_id, status CHECK(status IN ('proposed','confirmed','rejected')),
       fields_json, confidence_json, raw_text NULL /* dropped on confirm */, created_at, confirmed_at)
thread_cursors(tenant_id, thread_id, last_message_id, last_seen_at, PRIMARY KEY(tenant_id, thread_id))

groups(id PK, tenant_id, kind CHECK(kind IN ('party','raid')), name, size_max CHECK(size_max IN (5,10,20,40)),
       ruleset, faction, starts_at, tz, recurrence, status, created_by)
slots(group_id, slot_no, role, character_id NULL, user_id NULL, state, PRIMARY KEY(group_id, slot_no))
signups(group_id, user_id, character_id, intent CHECK(intent IN ('yes','maybe','no','bench')), note, created_at,
        PRIMARY KEY(group_id, user_id))
entitlements(tenant_id PK, plan, status, source CHECK(source IN ('discord_sku','stripe','manual')), renews_at, updated_at)
audit_log(id, tenant_id NULL, actor_user_id, action, target, at, details_json)   -- append only
```
Constraints enforced in SQL: a character's `ruleset` and `faction` must equal the group's; one user holds at most one slot per group; `size_max` is one of the four Blizzard sizes (R1 1.5). A character appears in many tenants through signups, never by copying.

**Account rules**
- Activity: SDK `authorize({scope:['identify'], prompt:'none', code_challenge})` -> `POST /api/activity/token` -> Worker exchanges at `discord.com/api/oauth2/token`, reads `/users/@me` itself, verifies guild membership server-side with the bot token, upserts `users`/`identities`/`memberships`, returns a 30-minute bearer plus a rotating refresh. Bearer lives in JS memory; websocket authenticated by a one-time ticket in the first frame (R3 1.4, 6).
- Web: redirect flow with `state`; `__Host-` cookie; same `sessions` table.
- Google: attach-only inside an authenticated session; keyed on `sub`; `email_verified` is a contact attribute only (R3 1.1).
- Battle.net: attach-only; `openid wow.profile`; snapshot `/profile/user/wow` across the regions the user names; store character rows with `expires_at`; purge cron daily; no tokens stored after import (R3 2.2-2.5). Manual character entry ships first because Forever API coverage is unknown (R3 2.3, R1 open 1).
- Multiple accounts: several `battlenet` identities per user; several Discord accounts per human via `humans` with a two-OAuth-in-ten-minutes proof (R3 1.3).
- Multi-party, multi-raid, multi-guild: memberships in many tenants; groups per tenant; a user's sheet shows a party switcher scoped to the tenant they opened.
- Step-up: a fresh OAuth round trip within five minutes for link, unlink, merge, export, tenant delete (R3 1.6).
- Member keys (`members`, `hash-key.mjs`) retire once the Activity bearer and web cookie carry every route; the `accounts` and `account_keys` tables are dropped (PR-REVIEW D9).
- The `discord_members.match` name list in `kv_state` retires once `identities(provider='discord')` exists; `name_map` stays only for display aliases.

### 5e. Monetization and IP posture, and the two account moves

**What must stay free (R5 1.2, 1.7; R3 2.5, confirmed terms, likely reading)**
- Anything whose function uses Battle.net API data: character import, verification, armory-linked views. Also the whole one-guild, one-party case, because that is the wedge and because free is the incumbent (R4 surprise 7).

**What can be paid (R4 1.5-1.6; R2 1.6)**
- Capacity and convenience that use no Blizzard API data: more than one raid group, recurring events, history and archives beyond a season, the assistant answering with the guild's own rules, roster export, custom branding. Priced per guild (Guild Order ladder as the anchor: about 4 / 12 / 24 USD per month by capacity), sold as a Discord guild-subscription SKU inside Discord and as a web subscription through a merchant of record, at the same price (parity rule, R5 5.1).
- Never per seat; never a paywall before first value (R2 design patterns; R4 1.6).

**Naming and trademark (R5 1.4; PR-REVIEW 2.1)**
- Product name, domain, bot name and app name: no "WoW", "Warcraft", "Blizzard", and treat "Forever" as covered until counsel says otherwise. "Leeroy" (a Blizzard character) stays the five friends' private tenant and persona; the sellable product gets a neutral name after TSDR, EUIPO and WIPO searches.
- Body copy: "for players of World of Warcraft: Forever", "not affiliated with or endorsed by Blizzard Entertainment", Blizzard credited as the data source.

**What to ask Blizzard, in writing (R5 1.7)**: the six questions, verbatim from R5: 2(b) and a paid tier that shares a bot with free API features; a commercial exception; "Forever" mark coverage and nominative wording; a community-tool licence for limited imagery; the Forever API namespace plan; whether AI processing of API data is a "transfer" under 2(h)/(i).

**What to ask a lawyer**: the ten questions in R5 section 8, plus the controller/processor split (R3 4.1) and the entity form before the first sale (R5 5.4).

**First two account moves (do these before any stranger uses the product)**
1. **Discord application ownership**: convert the application `1561857940174938114` to a Developer Team owned by the owner (monetization and verification both require a team; only the owner enables payouts; R2 1.6, R5 6.2, confirmed). Add the architect as a team member. Once an entity exists, the team owner becomes the entity's principal. Recommendation: yes, now; it is reversible and costs nothing.
2. **Cloudflare account**: create an account owned by the selling entity (or by the owner until the entity exists), on Workers Paid (5 USD), add the architect as a member with a scoped role, migrate the Worker, D1 (export plus import), Pages project and the domain, and keep the architect's personal account for previews if he prefers (PR-REVIEW D2; R5 6.1, confirmed that the agreement cannot be assigned without consent). Recommendation: yes, before the first paying user; sequence it after the identity migration so D1 is moved once.

### 5f. The quality system

- **Tests, by layer**: `vitest` Worker and DO unit tests (auth, authz matrix, Discord signature and component shapes, parsers, tallies); contract tests from `docs/openapi.yaml` (schemathesis); Playwright viewport acceptance and axe at three sizes; Discord fixture tests from recorded signed payloads; a two-tenant isolation test; k6 soak; mutation testing on `rank-core.js`.
- **Oracles**: Part 4, one named per item in Part 6; never the author.
- **Observability**: external uptime monitor, Cloudflare 5xx notifications, `wrangler tail` to a sink, AI Gateway spend graph, a restore drill each quarter, a status page.
- **Privacy**: data inventory from rows; privacy notice; retention cron (ask_turns 90 d, intents 7 d, dispatches 90 d, guest limits 2 h, Battle.net 30 d, raw build text until confirmation); `/board privacy` and `/board forget` plus web export and erase across every table; AI features opt-in per tenant with a no-train vendor; no session replay inside Discord.
- **Security**: salts and tokens as secrets; signature freshness; explicit allowed_mentions; ZAP baseline and semgrep in CI; gitleaks on history; ASVS 5.0 L1 plus L2 auth chapters before charging; step-up for sensitive actions; audit log append-only.
- **Accessibility**: axe required; WCAG 2.2 AA checklist; reduced-motion parity; one external screen-reader session per release of the first-run flow; accessibility statement page.
- **Release**: CODEOWNERS gate on `infrastructure/**`, `.github/**`, `wrangler.toml`, `schema.sql`, `migrations/**`; risk label from changed paths; merge queue; environments; pinned SHAs. The brain merges only through the queue.

### 5g. What to STOP doing

1. Stop the "Pick your name" gate and every name-keyed identity path (`discord_members.match`, `name_map` as identity). Discord id or nothing.
2. Stop building new scenes, art lanes and board features until waves 1-4 of Part 6 land (PR-REVIEW Stop 1). The twelve tabs are the problem, not the solution.
3. Stop showing the journeys switch, Sensory, the room toggle and the ribbon on the first screen.
4. Stop sending member asks to Gemini free tier; stop adding providers (PR-REVIEW Stop 4; R5 section 4).
5. Stop storing third-party page text and auto-applying AI proposals (PR-REVIEW Stop 3).
6. Stop hand-editing `kv_state` to add a member; every member arrives through Discord.
7. Stop framing the countdown in ET only; regions launch at different times (R1 1.1).
8. Stop using "Leeroy Jenkins" as the sellable product's name or persona voice (keep it for the private tenant).
9. Stop treating the five as the market test (PR-REVIEW Stop 7).
10. Stop merging anything above risk 7 without the adversarial review the brief promises, and make GitHub enforce it.
11. Stop writing product design into private notes only; ADRs and runbooks go in the public repo (PR-REVIEW 2.8).
12. Stop the 6-hour library sweep writing facts without review; the cron slot is needed for ingestion and retention.

---

## Part 6. The execution queue

Rules for the executor: one PR per item; the PR carries the risk rating, the item id and the oracle; a cloud builder works from the public repo alone (`the-owner/leeroy-board`) plus this file's brief; items in one wave touch disjoint files so eight can run at once (one preview environment stays free for the architect); the brain merges through the queue; risk 8 and above gets adversarial review and the architect's approval on his files. If a builder finds an item already implemented on `master`, it closes the PR with the evidence (file and line) instead of re-doing it. Every builder brief forbids killing processes by image name and forbids staging in the main checkout (memories `agents-never-mass-kill-node`, `never-stage-in-main-checkout`).

Field key: **Risk** 0-10 per the repo scale (0 docs, 3 CSS or copy or data, 5 front-end logic in one scene, 7 API behaviour keeping its contract, 8-10 auth, schema, secrets, DO, workflows, Discord handler). **Owner**: builder, the architect review, owner decision, external. **Par**: parallelisable within its wave.

### Wave 1: foundations and the spikes (no shared files)

**Q01 Salts become secrets; rotate; re-key.** Risk 10. Owner: builder, the architect review. Par: yes. Deps: none.
Brief: remove `USER_SALT` and `KEY_SALT` from `infrastructure/wrangler.toml [vars]`; add both to the secret lists in `.github/workflows/deploy-cloudflare.yml` and `pr-preview-cloudflare.yml` (`wrangler secret put`), with distinct preview values from a `preview` GitHub environment; document rotation in `infrastructure/README.md`. Because member key hashes change, add a script note that the five keys must be re-issued with `infrastructure/scripts/hash-key.mjs`. Done: `grep -n SALT infrastructure/wrangler.toml` is empty; deploy succeeds; `/api/me` with an old key is 401. Tests: `tests/api/api.test.mjs` gains a case that `/api/me` without a key is 401. Oracle: `wrangler secret list` on the preview shows both names; a friend's new key works on production.

**Q02 First screen: purpose, one button, one quiet link.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: in `js/next.js` and `css/next.css`, replace the "Pick your name" card and the six name buttons with: heading "Your guild's companion for WoW Forever.", line "See your group, your next step, and what is coming. Two minutes.", primary button ("Show me my group" when `window.__ACTIVITY__` or the Discord SDK query params are present, otherwise "Continue with Discord"), quiet link "Just take a look". Strings live in `data/cta.json`. Until Q19/Q27 ship, the primary button routes to the existing identity path behind a feature flag `firstrun.v2` in `data/client.json`; the old name grid stays reachable only via "Just take a look" for the five. Done: no list of names on first open at any viewport. Tests: Playwright screenshot at 390 by 844, 1080 by 1920, 1366 by 768 in `tests/browser/` asserting the primary button is inside the viewport without scroll. Oracle: Lyssna five-second test (Q65).

**Q03 Spike: does REST return message content without the Message Content intent?** Risk 0. Owner: owner (bot token creation), brain runs. Par: yes. Deps: none.
Brief: in a test guild, with the current application's bot token (created in the Developer Portal if none exists), call `GET /channels/{forum_thread_id}/messages?limit=5` once with the intent off and once with it on; record the two bodies (secrets stripped) in `docs/spikes/2026-11-rest-content.md`. Done: the file states which fields were blank in each case. Oracle: the Discord API response itself (R2 open 1).

**Q04 Convert the Discord application to a Developer Team.** Risk 0. Owner: owner decision (yes/no). Par: yes. Deps: none.
Brief: Developer Portal: create a team owned by the owner, transfer app `1561857940174938114` to it, add the architect as a member, enable 2FA and verified email on both. Recommendation: **yes** (required for verification and monetization; R2 1.6; reversible). Oracle: the Developer Portal team page.

**Q05 ADR-0001: tenancy and identity.** Risk 0. Owner: builder drafts, the architect review required. Par: yes. Deps: none.
Brief: write `docs/adr/0001-tenancy-and-identity.md` from Part 5d: Discord id root, attach-only providers, global D1 plus DO per tenant, schema sketch, migration plan in three steps (add, switch reads, drop), retirement of member keys and `discord_members.match`. Done: the architect approves the PR. Oracle: the architect's approval.

**Q06 Authorization matrix test.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: add `tests/unit/authz.test.mjs` that imports the route table from `infrastructure/worker/index.js` (extract a `ROUTES` export if needed, touching only the export, not behaviour), and asserts a hand-written table of route -> allowed principals (anonymous, member, admin). The test fails when a route exists that the table does not list. Done: CI green with the table covering every route. Oracle: CI; a reviewer other than the author checks the table against PR-REVIEW 0.2 and 0.4.

**Q07 Privacy notice and data inventory drafts.** Risk 0. Owner: builder drafts, counsel later. Par: yes. Deps: none.
Brief: `docs/privacy.md` (categories per R3 4.6: Discord id, display name, avatar, guild and roles, builds, sign-ups, device logs; purposes; recipients Cloudflare, Discord, Blizzard, Google optional, AI vendor; retention table; rights; children statement; "we do not sell or share"; Blizzard attribution; message-content disclosure) and `docs/data-inventory.md` listing every table and column that names a person, from `infrastructure/schema.sql`. Done: both files exist and the notice links from `index.html` footer in a later item. Oracle: counsel review before first sale (Q42).

**Q08 Activity portrait lock.** Risk 7. Owner: builder; owner sets the portal default. Par: yes. Deps: none.
Brief: in `js/brain.js` after `ready()`, call `setOrientationLockState({lock_state: PORTRAIT, picture_in_picture_lock_state: UNLOCKED, grid_lock_state: UNLOCKED})` on iOS and Android only (SDK platform value), subscribe to `ORIENTATION_UPDATE` and `ACTIVITY_LAYOUT_MODE_UPDATE` and expose them as `document.documentElement.dataset.layout`. Owner sets the Developer Portal default lock to portrait for phones, unlocked for tablets. Done: no visible rotation on launch. Oracle: a non-author tester on a real iPhone and Android in the Discord client.

### Wave 2: schema, Discord hygiene, first-screen structure

**Q09 Migration 0002: identity and tenancy tables (additive, unused).** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q05.
Brief: `infrastructure/migrations/0002_identity_tenancy.sql` creating `users, identities, humans, human_members, sessions_v2, provider_tokens, tenants, tenant_config, memberships, characters, builds, thread_cursors, audit_log` exactly as Part 5d; update `infrastructure/schema.sql` to match; no reads or writes yet. Done: `wrangler d1 migrations apply --local` from empty succeeds twice. Tests: a unit test that loads `schema.sql` into an in-memory SQLite (`better-sqlite3` in `tests/`) and checks the CHECK constraints by inserting bad rows. Oracle: the migration applied on a PR preview with no errors.

**Q10 Provider call timeouts.** Risk 7. Owner: builder, the architect courtesy. Par: yes. Deps: none.
Brief: in `infrastructure/worker/ai-models.js`, wrap every provider `fetch` and Workers AI call with `AbortSignal.timeout(20000)` and map the abort to a structured error `{code:'ai_timeout'}`; no change to routing. Done: no `fetch(` without a signal in the file. Tests: `tests/unit/ai-timeout.test.mjs` with a stubbed slow fetch. Oracle: CI; k6 later (Q48).

**Q11 Discord signature freshness and mention safety.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: none.
Brief: in `infrastructure/worker/discord.js`: reject interactions whose `X-Signature-Timestamp` is older than 300 s; add `allowed_mentions: {parse: []}` to every message body the handler builds; clamp content to 2,000 chars. If already present, close with evidence. Tests: `tests/unit/discord-signature.test.mjs` with a stale signed fixture. Oracle: Discord's own invalid-signature probes continue to pass; CI.

**Q12 Collapse navigation until first value.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: in `js/shell.js` and `css/shell.css`: behind flag `firstrun.v2`, hide the ribbon, the journeys switch, Sensory and the room toggle on first open; show one "Menu" button; after the first value event (`board:first-value`, dispatched by the sheet scene) reveal the ribbon. Phone bottom bar becomes Next, My sheet, Menu. Remove the stray teal element that overlaps the "Next steps" title on phone (shot). Done: first screen shows heading, line, button, link, Menu only. Tests: Playwright at three viewports counting visible nav items. Oracle: screenshots reviewed by a second agent.

**Q13 Sample guild data and empty-state sheet.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: add `data/sample/party.json`, `data/sample/signups.json`, `data/sample/builds.json` with fictional names; in `scenes/sheet.js` and `scenes/sheet.css`, render a labelled "Sample guild" sheet when the viewer has no identity, with one button "Make this for my guild". Done: a signed-out visitor sees a sheet, never an empty parchment. Tests: Playwright sample-mode screenshot. Oracle: five-second test (Q65).

**Q14 Terms of service and subprocessor list drafts.** Risk 0. Owner: builder drafts. Par: yes. Deps: none.
Brief: `docs/terms.md` (eligibility 13+ or local minimum, acceptable use, tenant admin responsibilities, termination, Blizzard and Discord non-affiliation, liability) and `docs/subprocessors.md` (Cloudflare, Discord, Blizzard, Google optional, AI vendor, payment processor) per R3 4.6 and R5 5.4. Oracle: counsel (Q42).

**Q15 CI jobs with stable names, no continue-on-error.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: none.
Brief: in `.github/workflows/preview-tests.yml`, split into jobs `unit`, `stamps`, `api`, `browser` with those exact names, remove `continue-on-error`, run on drafts; pin action SHAs. If already done (the brief says Unit, Stamps, API, Browser exist), close with evidence or only pin SHAs. Oracle: GitHub required-checks list shows the four names.

**Q16 Cloudflare entity account and Workers Paid.** Risk 0. Owner: owner decision (yes/no). Par: yes. Deps: none.
Brief: create a Cloudflare account owned by the owner (or the entity once formed), Workers Paid, add the architect with a scoped role; do not migrate yet (Q53 and the identity migration go first). Recommendation: **yes**. Oracle: the account exists with both members listed.

**Q17 Image pipeline at display sizes.** Risk 3. Owner: builder. Par: yes. Deps: none.
Brief: `tools/images.mjs` producing WebP and AVIF at the display widths actually used (read from `css/` and `scenes/`) for everything under `img/`; update `<picture>` sources in `index.html` and scene templates only where the image is referenced; keep originals. Done: first-load image bytes under 1.5 MB at 390 wide. Tests: Lighthouse CI later (Q40). Oracle: Lighthouse CI budget.

### Wave 3: web login, build modal, parser, layout, oracles

**Q18 Web Discord OAuth login and session.** Risk 9. Owner: builder, the architect review. Par: yes. Deps: Q09.
Brief: extend `infrastructure/worker/account.js` and route in `index.js`: `GET /api/auth/discord/start` (state bound to a pre-session cookie, PKCE if the app's Public Client toggle allows; see Part 7), `GET /api/auth/discord/callback` (exchange, `/users/@me`, upsert `users` and `identities`, create `sessions_v2` row, set `__Host-sess` cookie Secure HttpOnly SameSite=Lax), `POST /api/auth/logout` (revoke). `/api/me` reads either the new session or the legacy key during migration. Tests: `tests/unit/auth-web.test.mjs` with a stubbed Discord; `tests/api/` case for 401 without cookie. Oracle: ZAP baseline on the preview; the architect's approval.

**Q19 `/build` modal writes a confirmed build.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q09.
Brief: in `infrastructure/worker/discord.js`, make `/build` open a modal (Text Input notes up to 1000 chars; String Selects class, race, ruleset [Normal, PvP, Roleplay, Roleplay PvP], faction; Radio Group role tank/healer/dps); on submit, defer type 5, upsert `users`/`identities` by `user.id`, insert `builds` with `source 'modal'`, `status 'confirmed'`, then edit the response "Saved. Open your sheet" with a `LAUNCH_ACTIVITY` button. Tests: `tests/unit/discord-build.test.mjs` with a recorded modal-submit fixture asserting the D1 statements. Oracle: a tester account on staging (Q70) or production by a friend; the component JSON accepted by Discord.

**Q20 Build parser (free text to fields) on Workers AI.** Risk 7. Owner: builder. Par: yes. Deps: none.
Brief: new `infrastructure/worker/build-parse.js`: `parseBuild(text, env)` calling Workers AI with a strict JSON schema prompt, returning `{fields, confidence}`; fields under 0.7 confidence are null; ids and mentions stripped before the call; a hash of the input logged. Tests: `tests/unit/build-parse.test.mjs` with six fixtures (including a late joiner-shaped text with no real name) and a stubbed AI binding. Oracle: fixture agreement judged by a second agent against hand labels.

**Q21 Portrait desktop and phone layout column.** Risk 3. Owner: builder. Par: yes. Deps: none.
Brief: in `css/fit.css` and `css/wide.css`: for portrait aspect ratios (`(orientation: portrait)`) and widths under 1200 px, lay the first screen in one centred column, max width 720 px, content-sized, no banner ribbon; cards stack; the moon decoration stays below content. Done: at 1080 by 1920 the content fills at least 60 percent of the height or ends with the sample card, never empty parchment. Tests: Playwright screenshot baselines. Oracle: screenshots compared by a second agent.

**Q22 axe in the browser suite.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: add `@axe-core/playwright` to `tests/package.json`; run axe on the first screen and the sheet at 390 and 1366; fail on serious or critical. Tests: the suite itself. Oracle: CI; an external screen-reader session later (Q50).

**Q23 Restore runbook and drill.** Risk 0. Owner: builder writes; the architect runs. Par: yes. Deps: none.
Brief: `docs/runbooks/restore.md` with `wrangler d1 time-travel restore` into a scratch database, row-count diff, and a signed log template. the architect runs it once and commits the log. Oracle: the dated drill log signed by the architect.

**Q24 Blizzard inquiry letter.** Risk 0. Owner: builder drafts; owner sends. Par: yes. Deps: none.
Brief: `docs/legal/blizzard-inquiry.md` with the six questions from R5 1.7, product description without marks, and the request for the Forever namespace plan. Owner emails legal@blizzard.com (address is a community suggestion; R5) and posts on the API forum. Oracle: Blizzard's written reply.

**Q25 Contract tests from OpenAPI.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: `docs/openapi.yaml` for `/api/bootstrap`, `/api/signups`, `/api/state`, `/api/me`, `/api/health`; `tests/api/contract.test.mjs` validating live preview responses against the schemas. Oracle: schemathesis or the contract test green on the preview.

### Wave 4: Activity auth, import, "Is this you", groups schema, budget

**Q26 Activity bearer auth.** Risk 9. Owner: builder, the architect review. Par: yes. Deps: Q18.
Brief: `vendor/discord-auth.js` and `js/brain.js`: on "Show me my group", `authorize({scope:['identify'], prompt:'none', code_challenge})`, `POST /api/activity/token` with the code, keep the returned bearer in memory, call `authenticate`, send `Authorization: Bearer` on every API call and a one-time ticket as the first websocket frame; refresh with `prompt:'none'` on expiry. Worker side (`index.js` route plus `account.js` helper): exchange, read `/users/@me`, verify guild membership with the bot token, upsert, mint bearer and refresh (sessions kind 'activity'). No cookies in the iframe. Tests: unit with stubbed Discord; a Playwright test running the page with SDK query params and a mocked SDK. Oracle: a non-author tester on iOS and Android in the Discord client.

**Q27 Context-menu command "Import to board".** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q19, Q20.
Brief: register a message command in `discord.js`; on use, read the target message content from the interaction payload, call `parseBuild`, insert `builds` with `source 'context_menu'`, `status 'proposed'`, `source_message_id`, `source_thread_id`, then reply in the thread (not ephemeral) with the parsed fields and Confirm / Fix buttons (`build:confirm:<id>`, `build:fix:<id>`); Confirm sets `status 'confirmed'` and drops `raw_text`; Fix opens the Q19 modal prefilled. Tests: fixture test for the message command and both buttons. Oracle: a late joiner's real post imported on production by an officer; Discord accepts the command registration.

**Q28 "Is this you?" and prefill from builds.** Risk 5. Owner: builder. Par: yes. Deps: Q18.
Brief: `scenes/account.js` (and `.css`): after login, show avatar, display name, "Yes" / "Not me"; on Yes, fetch `/api/me` which now returns `builds` for the user; if present, show "We used your build post from {thread}." and skip typing. Done: a new user with a confirmed build reaches the sheet with zero typed fields. Tests: Playwright with a seeded test user on the preview. Oracle: a late joiner on a screen share, observed by the architect.

**Q29 Migration 0003: groups, slots, signups, entitlements.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q09.
Brief: `infrastructure/migrations/0003_groups.sql` per Part 5d with the CHECK constraints (size_max in 5/10/20/40; ruleset and faction match via trigger); `schema.sql` updated. Tests: in-memory SQLite constraint test. Oracle: migration applies on a preview from empty twice.

**Q30 Per-user and per-tenant ask budget.** Risk 7. Owner: builder, the architect courtesy. Par: yes. Deps: Q09.
Brief: `infrastructure/worker/budget.js`: add `userDailyCap` (default 20) and `tenantDailyCap` (default 200) counted in `ask_turns` by `user_id` and `tenant_id`, returning 429 with `retryAfter`; keep the neuron soft cap. Tests: extend `tests/unit/budget.test.mjs`. Oracle: k6 burst (Q48) yields 429 after the cap.

**Q31 OpenAPI for new auth and build routes.** Risk 0. Owner: builder. Par: yes. Deps: Q18 (spec can lead code). Brief: extend `docs/openapi.yaml` with `/api/auth/*`, `/api/activity/token`, `/api/me` (new shape), `/api/builds`. Oracle: contract test (Q25) green.

**Q32 External uptime monitor and alerts.** Risk 0. Owner: owner (accounts); builder documents. Par: yes. Deps: none.
Brief: UptimeRobot or Better Stack free tier on `/api/health`, `/api/bootstrap`, `leeroy.party/`; Cloudflare Notification on 5xx rate; `docs/runbooks/alerts.md`. Oracle: a forced 5xx on a preview triggers the alert.

**Q33 Discord handler fixture library.** Risk 5. Owner: builder. Par: yes. Deps: none.
Brief: `tests/fixtures/discord/` with recorded, secret-stripped signed interaction payloads for `/ask`, `/sheet`, `/rsvp`, a component press and a modal submit (generated with a test key pair in CI); `tests/unit/discord-fixtures.test.mjs` running each through the handler with a stubbed D1. Oracle: CI; Discord's own probes on the endpoint continue to pass.

### Wave 5: the poller, the confirmation loop, next-step engine, roster, perf gate

**Q34 Cron REST poller for build threads.** Risk 9. Owner: builder, the architect review. Par: yes. Deps: Q03, Q09, Q20, bot token secret, `tenant_config.builds_channel_id`.
Brief: new `infrastructure/worker/ingest.js` and a `scheduled` branch in `index.js`: every 15 minutes (cron `*/15 * * * *` added to `wrangler.toml [triggers]`; keep the 6-hour sweep slot), for each tenant with a builds channel: `GET /guilds/{id}/threads/active`, filter by `parent_id`, compare `last_message_id` with `thread_cursors`, fetch changed threads with `GET /channels/{id}/messages?after=`, parse starter and edits into `builds` rows `status 'proposed'`, update cursors; respect `X-RateLimit-*` and back off on 429 and 1015 with a retry budget of 3. If Q03 showed blank content without the intent, the owner toggles Message Content in the portal first. Tests: `tests/unit/ingest.test.mjs` with stubbed Discord responses, including a 429. Oracle: a new post in the real forum appears as a proposed build within 15 minutes, verified by a second agent reading D1.

**Q35 Confirmation loop and thread reply for polled builds.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q27, Q34.
Brief: in `discord.js` (reply builder shared with Q27) and `ingest.js`: after a polled build is stored, post one reply in the thread with the parsed fields and Confirm / Fix; never DM; one reply per message id (idempotent via `builds.source_message_id`). Tests: fixture test for idempotency. Oracle: a late joiner's thread shows exactly one Leeroy reply after two poller runs.

**Q36 Next-step engine from builds and groups.** Risk 5. Owner: builder. Par: yes. Deps: Q28, Q29.
Brief: `next/rules.js` and `js/next.js`: compute one card from the user's confirmed build and the tenant's next group: ruleset and faction compatibility first, then missing profession, then next date; copy in library voice (informs). Tests: `tests/unit/next-rules.test.mjs` with five user states. Oracle: a second agent checks the copy against the voice rule; a late joiner sees a sensible card.

**Q37 Character switcher on the sheet.** Risk 5. Owner: builder. Par: yes. Deps: Q29.
Brief: `scenes/sheet.js`: when `/api/me` returns more than one character, show "You have N" with an inline switcher; "Add another character" opens the manual character form (name, class, race, ruleset, faction, region). Tests: Playwright with a seeded three-character user. Oracle: persona (d) think-aloud with one real multi-account friend.

**Q38 Officer roster scene with bench.** Risk 5. Owner: builder. Par: yes. Deps: Q29.
Brief: new `scenes/roster.js` and `scenes/roster.css`: for a group, show slots grouped by role, a bench list, open-slot count, and conflict flags from the API (ruleset, faction); single-pointer alternative to drag (move buttons). Portrait layout is a vertical list. Tests: Playwright at three viewports; axe. Oracle: two outside officers in a think-aloud.

**Q39 Lighthouse CI budget on previews.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q17.
Brief: `.github/workflows/lighthouse.yml` running Lighthouse CI against the PR preview URL with assertions: LCP under 4 s mobile simulated now (tighten later), total bytes under 2.5 MB, requests under 60. Oracle: Lighthouse CI report; Web Analytics p75 later.

**Q40 DPA template and breach runbook.** Risk 0. Owner: builder drafts. Par: yes. Deps: none. Brief: `docs/legal/dpa-template.md` (Art. 28(3) items, R3 4.2) and `docs/runbooks/breach.md` with the Blizzard 24 h, Discord, GDPR 72 h clocks. Oracle: counsel (Q42).

**Q41 Retention and purge cron.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q09, Q34 (shares `scheduled`; land after Q34).
Brief: in `index.js` `scheduled` (daily cron `15 4 * * *`): delete `ask_turns` older than 90 d, `intents` older than 7 d, `dispatches` older than 90 d, `builds.raw_text` for confirmed rows, `characters` with `expires_at` in the past (Blizzard 30-day rule), `sessions_v2` expired. Tests: unit test with seeded old rows and a fake clock. Oracle: a second agent reads D1 after the cron on a preview.

### Wave 6: setup, attach-only Google, membership checks, notifications, licence hygiene

**Q42 Entity, counsel and the ten questions.** Risk 0. Owner: owner decision (yes/no). Par: yes. Deps: Q07, Q14, Q40.
Brief: decide to form an entity (US LLC recommended, R5 5.4) and engage counsel with R5 section 8's ten questions plus R3 4.1. Recommendation: **yes before the first paid sale; not needed for the free one-guild product.** Oracle: counsel's letter.

**Q43 `/setup` command and tenant binding.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q09.
Brief: `discord.js`: `/setup` (requires MANAGE_GUILD on the invoking member) with channel selects for the builds forum and announcements channel and a role select for the opt-in role; writes `tenants` and `tenant_config`; replies ephemeral with the one-time announcement text for the officer to post (or posts it with `allowed_mentions: {roles:[optin]}` on a second confirm). Tests: fixture test. Oracle: a non-owner admin runs it on staging (Q70).

**Q44 Google attach-only link.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q18.
Brief: `account.js`: `GET /api/link/google/start` and callback, only inside an authenticated session with fresh `state` and `nonce`; verify the ID token via JWKS (`iss`, `aud`, `exp`, `nonce`); insert `identities(provider='google', provider_subject=sub)`; refuse if the subject is linked elsewhere; refuse unlinking the last identity. Tests: unit with a stubbed JWKS. Oracle: ASVS OAuth chapter checklist reviewed by the architect; the CVE-2026-53516 scenario as a negative test.

**Q45 Server-side guild membership on every tenant request.** Risk 9. Owner: builder, the architect review. Par: yes. Deps: Q26.
Brief: `infrastructure/worker/auth.js`: a `requireTenantMember(req, tenantId)` helper that derives the tenant from the session's verified memberships, never from a client-sent id; cache membership checks 10 minutes; re-verify via `GET /guilds/{id}/members/{user}` on miss. Tests: the authz matrix (Q06) gains the tenant dimension. Oracle: the two-tenant isolation test (Q71).

**Q46 "What we track and why" card.** Risk 3. Owner: builder. Par: yes. Deps: none.
Brief: `scenes/settings.js` and `.css`: a card listing what the product reads (builds forum, /rsvp, Discord id, display name, roles), what it never reads (other channels, DMs), the retention table from Q07, and buttons "Export my data" and "Forget me" (wired in Q61). Copy in library voice. Oracle: a friend reads it and restates it correctly (five-second test variant).

**Q47 k6 soak script.** Risk 0. Owner: builder. Par: yes. Deps: none. Brief: `tests/load/soak.js` for `/api/bootstrap`, `/api/ask` (member), websocket handshake at 5 and 500 virtual users against a preview; `docs/runbooks/load.md` with the SLO (bootstrap p95 under 800 ms). Oracle: the k6 report against the written SLO.

**Q48 Library source allow-list with licence.** Risk 5. Owner: builder; owner decides the hosts. Par: yes. Deps: none.
Brief: `data/library/sources-allowlist.json` with host, licence, attribution text; `tools/check-sources.mjs` run in CI (`unit` job) failing on any `refs[].host` not on the list; remove Wowhead, wago.tools and Icy Veins refs or move those facts to "unsourced, needs Blizzard source". Owner decision (yes/no): **yes** (R5 section 3; PR-REVIEW D7). Oracle: CI check; counsel review of the list.

**Q49 Accessibility statement and ARIA decision.** Risk 0. Owner: builder. Par: yes. Deps: none. Brief: `docs/accessibility.md` with WCAG 2.2 AA scope, known gaps, contact; a one-page decision that the ribbon is a navigation list, not a `tablist`, with the keyboard model. Oracle: an external screen-reader session (Q50).

### Wave 7: Battle.net, RSVP, tenant DO, multi-party, landing, ZAP, naming

**Q50 External screen-reader session.** Risk 0. Owner: owner recruits. Par: yes. Deps: Q22, Q49. Brief: one NVDA or VoiceOver user completes: open, identify, read next step, open sheet, RSVP. Findings filed as issues. Oracle: the user's completion, recorded.

**Q51 Battle.net attach and snapshot import.** Risk 9. Owner: builder, the architect review; owner creates the Blizzard client. Par: yes. Deps: Q44 (pattern), Q29.
Brief: `account.js`: `GET /api/link/battlenet/start` with scopes `openid wow.profile` against `https://oauth.battle.net`, callback exchange with HTTP Basic, `/userinfo` for `sub` and battletag, then `GET /profile/user/wow` with `Battlenet-Namespace` tried across `profile-{region}`, `profile-classic-{region}`, `profile-classic1x-{region}` and any Forever namespace Q24 or Part 7 reveals, for the regions the user ticks; insert `characters(source='bnet', expires_at = now + 30 d)`; store no token. Show the consent text plainly (account id, BattleTag, character list; 30-day expiry). Tests: unit with stubbed Blizzard; the purge cron test (Q41). Oracle: a live Forever account after Nov 4 (Part 7 spike); Blizzard ToU 2(s) purge verified by a second agent.

**Q52 `/rsvp` into groups and slots.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q29, Q43.
Brief: `discord.js`: `/rsvp` with autocomplete over the tenant's open groups (25 results max) and the user's characters; writes `signups`; replies ephemeral with the group's counts; a group's pinned card is edited via the interaction token where possible. Tests: fixture test. Oracle: a friend's RSVP appears on the roster scene within one bootstrap.

**Q53 Durable Object per tenant.** Risk 9. Owner: builder, the architect review. Par: yes. Deps: Q09, Q45.
Brief: `infrastructure/worker/room.js` and the two `idFromName("global")` call sites in `index.js`: `idFromName(tenantId)`; websocket joins carry the Q26 ticket; presence and roster-edit fan-out scoped to the tenant; the five friends are tenant 1 (backfill migration `0004_backfill_tenant1.sql`). Tests: unit with two tenant ids and the miniflare DO. Oracle: the two-tenant isolation test (Q71).

**Q54 Multi-party switcher.** Risk 5. Owner: builder. Par: yes. Deps: Q29. Brief: `js/shell.js`: when `/api/me` lists more than one group or tenant, a small switcher in the Menu; the first screen never asks. Tests: Playwright with a seeded two-group user. Oracle: persona (c) think-aloud.

**Q55 Stranger landing page.** Risk 3. Owner: builder. Par: yes. Deps: Q02, Q13.
Brief: `landing/index.html` (static, no SDK): the sentence, the sample guild screenshot, "Continue with Discord", links to `docs/privacy.md` and `docs/terms.md` rendered as pages; `robots.txt` allows `/landing/` only; `index.html` keeps `noindex`. Oracle: a stranger finds and understands it (Q65); securityheaders.com stays A.

**Q56 ZAP baseline and semgrep in CI.** Risk 5. Owner: builder. Par: yes. Deps: none. Brief: `.github/workflows/security.yml`: OWASP ZAP baseline against the preview URL, semgrep `p/javascript` and `p/secrets`, gitleaks on the PR diff; fail on high. Oracle: the ZAP and semgrep reports.

**Q57 Trademark search and candidate product names.** Risk 0. Owner: owner decision with counsel. Par: yes. Deps: none. Brief: three candidate neutral names; TSDR, EUIPO, WIPO searches recorded in `docs/legal/name-search.md`; also record the "Leeroy Jenkins" result. Recommendation: **yes, pick a neutral name; keep Leeroy private.** Oracle: the search records and counsel's clearance.

### Wave 8: admin, export and erase, Linked Roles, visual regression, provider decision

**Q58 Admin console routes.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q45.
Brief: `index.js` routes under `/api/admin/*` for tenant lookup, member list, proposed builds review (approve, reject), retention stats; admin identity is a `memberships.role='owner'` session plus step-up, not the legacy token. Tests: authz matrix. Oracle: the architect resolves a support task without `wrangler d1 execute`.

**Q59 Export and erase across every table.** Risk 7. Owner: builder, the architect review. Par: yes. Deps: Q09, Q29.
Brief: `account.js`: `GET /api/me/export` (JSON of every row keyed to the user across `users, identities, memberships, characters, builds, signups, ask_turns, sheet_events, intents, fact_fixes, dispatches, user_state`) and `DELETE /api/me` extended to erase all of them and tombstone only a hash of the Discord id; both behind step-up. Add `/board privacy` and `/board forget` slash subcommands in a later wave (to avoid touching `discord.js` here). Tests: unit with seeded rows asserting zero remaining. Oracle: a friend's erasure verified by a second person reading D1.

**Q60 Linked Roles metadata (optional).** Risk 7. Owner: builder; owner configures the role. Par: yes. Deps: Q18. Brief: `discord.js` registration of up to 5 metadata keys (`has_confirmed_build` boolean, `characters` integer) and the `PUT /users/@me/applications/{app}/role-connection` push on confirm; a verification URL route in `account.js`. Oracle: a role gated on the metadata appears for a tester after confirming a build.

**Q61 Admin scene.** Risk 5. Owner: builder. Par: yes. Deps: Q58. Brief: `scenes/admin.js` and `.css`: proposed builds review list with Approve and Reject, tenant members, retention counters. Oracle: the architect uses it for one real review.

**Q62 Visual regression baselines.** Risk 5. Owner: builder. Par: yes. Deps: Q21. Brief: Playwright `toHaveScreenshot` baselines for first screen, sheet, roster at the three viewports with a 0.5 percent threshold; stored under `tests/browser/__screenshots__/`. Oracle: CI diff review by a second agent.

**Q63 Changelog and status page.** Risk 0. Owner: builder. Par: yes. Deps: Q32. Brief: `CHANGELOG.md` kept per merged PR by the brain; a public status page on the monitor's free tier linked from the landing page. Oracle: a stranger can see uptime and the last change.

**Q64 Five-second and first-click tests with strangers.** Risk 0. Owner: owner runs on Lyssna free. Par: yes. Deps: Q02, Q12, Q13.
Brief: upload the first screen (Activity variant and web variant); ask "What is this for?" and "What would you press first?"; 15 responses per variant; record results in `docs/research/2026-11-five-second.md`. Pass: 8 of 10 correct; 80 percent first-click on the primary button (R4 3.4). Oracle: the strangers.

**Q65 Member asks move off Gemini free tier.** Risk 8. Owner: owner decision (yes/no), builder, the architect review. Par: yes. Deps: Q10.
Brief: `ai-models.js` and `wrangler.toml`: route member asks to Workers AI by default and to one paid provider under a DPA (Anthropic commercial or paid Gemini on a billing-linked project) when `AI_PAID_PROVIDER` is set; delete the Groq, Cerebras, GitHub Models and OpenRouter paths. Recommendation: **yes** (R5 section 4: free Gemini trains on content, bars under-18 clients, EU/UK terms). Oracle: `/api/health` (admin) lists two providers; AI Gateway shows no traffic to the deleted ones.

### Wave 9: humans, entitlements, verification, staging, isolation proof, raid composition, rename

**Q66 Humans grouping for several Discord accounts.** Risk 8. Owner: builder, the architect review. Par: yes. Deps: Q18, Q59. Brief: `account.js`: `POST /api/link/discord-alt/start` creating a `link_session`; a second Discord OAuth completion within 10 minutes in the same browser session inserts `humans` and two `human_members` rows; reversible for 30 days; audit logged; both accounts notified ephemerally on next open. Tests: unit. Oracle: a friend with two Discord accounts links and unlinks on a preview.

**Q67 Entitlements and Discord webhook events endpoint.** Risk 9. Owner: builder, the architect review; owner decision on monetization timing. Par: yes. Deps: Q04, Q29, Q42.
Brief: `index.js` route `POST /api/discord/events` verifying Ed25519 and answering 204 in under 3 s; handle `APPLICATION_AUTHORIZED/DEAUTHORIZED` (tenant lifecycle) and `ENTITLEMENT_CREATE/UPDATE/DELETE` into `entitlements`; a free-tier check helper `requirePlan(tenantId, feature)` used by nothing yet. Tests: fixture test with signed event payloads. Oracle: Discord's endpoint validation in the portal; a test SKU entitlement appearing in D1.

**Q68 Activity verification submission.** Risk 0. Owner: owner. Par: yes. Deps: Q04, Q07, Q14, Q55. Brief: complete the App Verification checklist in the portal (team, Stripe identity, privacy and terms URLs from Q55). Oracle: Discord's review outcome.

**Q69 Staging Discord application and environment.** Risk 8. Owner: owner (portal), builder (workflow), the architect review. Par: yes. Deps: Q04. Brief: a second application id with URL mappings to a long-lived `staging` Pages branch and a `staging` Worker; `.github/workflows/deploy-staging.yml`; `staging` GitHub environment with its own secrets. Oracle: a scripted command sweep by a tester account on staging.

**Q70 Two-tenant isolation test.** Risk 5. Owner: builder. Par: yes. Deps: Q45, Q53. Brief: `tests/api/isolation.test.mjs`: seed tenants A and B on the preview; a session in B gets 403 on A's bootstrap, groups, builds, websocket join. Oracle: CI; the architect reviews the seed.

**Q71 Raid composition with bench and alts.** Risk 5. Owner: builder. Par: yes. Deps: Q38, Q37. Brief: `scenes/roster.js`: for 20 and 40 groups, show role counts against editable targets (default from community conventions, labelled as such; R1 section 4), the bench, and the alt a member brought (signup `character_id`). Oracle: two outside officers in a think-aloud.

**Q72 Gateway decision (real-time or not).** Risk 0. Owner: owner decision (yes/no). Par: yes. Deps: Q34 measured latency over two weeks. Brief: if the 15-minute poller is enough for the a late joiner loop, no gateway. Recommendation: **no gateway** (R2 2.3; PR-REVIEW D11 only if sub-minute reads are proven necessary). Oracle: the poller latency log.

**Q73 Rename copy and assets to the neutral name.** Risk 3 (copy) then 7 (Worker strings). Owner: builder; owner decision. Par: yes. Deps: Q57. Brief: `data/cta.json`, `index.html` `og:title`, the webhook username in `index.js`, persona system prompt in D1 (admin PUT), `landing/`; "Leeroy" remains tenant 1's persona name in `tenant_config`. Oracle: counsel's clearance; a grep for the old brand outside tenant 1 config returns nothing.

**Q74 Cloudflare resource migration to the entity account.** Risk 10. Owner: the architect executes, owner approves. Par: no (runs alone). Deps: Q16, Q53, Q41. Brief: D1 export and import, Worker deploy, Pages project, domain and DNS move, secrets re-entered, monitors repointed; a rollback plan to the old account for 7 days. Oracle: the external monitor stays green through the move; the architect's signed migration log.

---

## Part 7. Decisions and unknowns

Each unknown with the cheapest experiment that settles it.

| # | Unknown | Why it matters | Cheapest experiment | Cost |
|---|---|---|---|---|
| U1 | Does REST `GET /channels/{id}/messages` return `content` without the Message Content intent? (R2 open 1) | Decides whether the poller needs the privileged intent and whether to rely on context menus alone | Q03: two calls on a test thread, intent off then on | 10 minutes, a bot token |
| U2 | Does `/profile/user/wow` return Forever characters, and under which namespace? (R3 2.3, R1 open 1) | Decides whether Battle.net linking does anything useful | After Nov 4, one real Forever account, one user token, a loop over candidate namespaces and the four regions, logged | 30 minutes after launch |
| U3 | Does Battle.net support PKCE and refresh tokens? (R3 2.2) | Token handling in Q51 | One authorization with `code_challenge` and one with `offline_access`; inspect the token response | 20 minutes |
| U4 | Does Discord PKCE work with a confidential client, or only with "Public Client"? (R2 open 4) | Q18 and Q26 flow shape | One code exchange with and without the toggle on a test app | 15 minutes |
| U5 | Is the unverified-Activity cap really "servers under 25 members"? (R2 open 3) | Whether a 40-player guild can pilot before verification | Launch the Activity in a test server with 26 members; read the portal checklist in a browser | 30 minutes |
| U6 | Do `SameSite=None; Partitioned` cookies and `localStorage` work inside the Activity on iOS? (R3 7.5) | Only matters if anyone wants cookies in the iframe; the design uses bearer tokens | Skip unless the bearer design fails; otherwise a test page on a real iPhone | 20 minutes |
| U7 | Exact Developer Policy wording on AI, retention, privacy policy; Premium Apps fee and payout articles (R2 open 7, R5 section 9) | Compliance text and pricing math | A human reads the six support-center pages in a browser and saves PDFs to `docs/legal/sources/` | 30 minutes |
| U8 | Will Blizzard answer 2(b) and the Forever namespace question? (R5 open) | Whether any paid tier can coexist with Battle.net features | Q24 letter; wait; meanwhile build nothing paid that uses API data | Free, slow |
| U9 | Does the 15-minute poller fit Workers Free CPU (10 ms per cron) with parsing? (R2 section 6 cost note) | Whether Workers Paid is a prerequisite for Q34 | Run Q34 on the preview with `wrangler tail` and read cpuTime for one pass | 15 minutes |
| U10 | Are the open SDK mobile bugs (#379, #355, #386) present in the pinned `vendor/embedded-app-sdk.mjs`? (R2 1.3) | Phone Activity reliability | Diff the vendored version against upstream tags; test open-close twice on iOS and Android | 30 minutes |
| U11 | Is "Leeroy Jenkins" a live registered mark, and is "Forever" covered? (PR-REVIEW 1.5, R5 1.4) | Naming | Q57 searches; counsel | 1 hour plus counsel |
| U12 | Character cap, guild cap, guild bank, guilds per ruleset (R1 open 4) | Schema limits only; design for "many" | Read Blizzard posts after launch; no code depends on it | None |
| U13 | Will Warcraft Logs, Raider.IO and Archon support Forever, and under what API terms? (R1 open 5) | Only for a later analytics feature | Re-check their sites after Dec 9; nothing in Part 6 depends on it | None now |
| U14 | Controller vs processor for guild content; Art. 27 representative (R3 7.7) | DPA wording | One counsel question in Q42 | Counsel |
| U15 | Has the Cloudflare 1015 problem for Workers calling Discord fully gone? (R2 open 12) | Poller reliability | Log 1015 and 429 counts from Q34 for two weeks | None extra |
| U16 | Did signature freshness, dev origins removal and `err.message` suppression already ship? (PR-REVIEW 0.9, 0.11, 0.12; not in the brief's shipped list) | Avoid duplicate PRs | The builder of Q11 greps `discord.js` and `index.js` first and closes with evidence if present | 5 minutes |

Owner decisions isolated above, all yes/no with recommendation: Q04 (team: yes), Q16 (entity Cloudflare account: yes), Q42 (entity and counsel before first sale: yes), Q48 (drop forbidding hosts: yes), Q57 (neutral name: yes), Q65 (off Gemini free: yes), Q72 (gateway: no). the architect's architectural authority covers Q01, Q09, Q11, Q15, Q18, Q19, Q26, Q27, Q29, Q34, Q35, Q41, Q43, Q44, Q45, Q51, Q52, Q53, Q58, Q59, Q65, Q66, Q67, Q69, Q74.

What this plan does not do, on purpose: no new scenes, no new art, no gateway process, no per-seat billing, no Blizzard data in a paid feature, no tutorial, no second brand before counsel, and no feature that asks a newcomer to type what Discord already knows.

