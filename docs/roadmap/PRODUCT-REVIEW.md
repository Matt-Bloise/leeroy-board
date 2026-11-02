# Leeroy: from a five-friend beta to a sellable product. Senior advisor review, 2026-11-02

Read-only. No repo changed, no Discord call, no secret read. Labels: **confirmed** = read in code or observed live this session; **likely** = strong inference; **unverified** = needs a live look or counsel.

Evidence base and citation form:
- `index.js:NNN`, `discord.js:NNN`, `ai-models.js:NNN`, `auth.js`, `account.js`, `cors.js`, `room.js`, `scraper.js`, `schema.sql`, `wrangler.toml` = `infrastructure/...` at `origin/master` (`b90e301`, PR #23) of `the-owner/leeroy-board`, read with `git show origin/master:<path> | cat -n` in `C:/projects/_scratch/20261101-ci/lb` after `git fetch origin`.
- Workflows: `.github/workflows/{deploy-cloudflare,pr-preview-cloudflare,preview-tests}.yml`, same ref.
- Private notes: `C:/projects/the archive/notes/...` (ARCHITECTURE-REVIEW.md, SOURCE-MOVE.md and LIGHTHOUSE-2026-11-01.md are not on the working branch; read from commits `42998265`, `4f6157e4`, `62f679ae`).
- Parity audit: `C:/projects/_scratch/20261102-slash-parity/SLASH-PARITY.md`. Persona: `C:/projects/_scratch/20261102-persona/persona.json` (shape only). Traffic: `.../notes/ops-rooms/cf-analytics.json`.
- Live, GET only, no key, 2026-11-02: `https://api.leeroy.party/api/{health,intents,wiki/proposals,signups}`, `https://leeroy.party/` headers and `robots.txt`.
- GitHub API via `gh`: repo visibility, branch protection, rulesets, CODEOWNERS, collaborators, environments, PR list, run list.

New confirmed findings from this pass (beyond the brief):
1. `GET /api/signups` answers **500 `{"error":"putCachedResponse is not defined"}`** on production. `index.js:562` calls a function that does not exist (only `setCachedResponse` at `index.js:148`), and `index.js:561` passes four arguments to a three-argument `jsonResp` (`index.js:65`). Any client of that route is broken today.
2. `KEY_SALT` and `USER_SALT` are plain `[vars]` in the public `wrangler.toml:60-61` and the deploy workflow's secret list (`deploy-cloudflare.yml:262`) does not override them, so production **likely** runs with public salts. Member key hashes (`auth.js:14-16`) and the "Discord id is never stored" claim (`account.js:1-5`, `account.js:39`) rest on a salt anyone can read. With the salt plus a server member list, every `user_key` maps back to a Discord id.
3. Guest IP hashes are `sha256("guest-ask:" + ip)` with no salt (`index.js:779-780`, `index.js:1179-1180`); IPv4 space is enumerable, so the stored value is personal data under GDPR, not an anonymised one.
4. `GET /api/wiki/snapshots` and `GET /api/wiki/proposals` have no key gate (`index.js:831-842`) and the sweep stores the full stripped text of third-party pages in `lib_source_snapshots.body_text` (`schema.sql:63-70`, `scraper.js:227-229`). The product is republishing other sites' text through its API.
5. `PUT /api/data/:name` and `PUT /api/wiki/page` accept any member key (`index.js:1003-1006`, `index.js:846-849`): any friend can overwrite any board document (`party`, `timeline`, `tonight`, `decide`, `marks`, `links`) or any library page. Same class as the `PUT /vocab` finding in the brief.
6. `GET /api/health` lists which AI providers hold keys (`index.js:1380-1398`; live: `gemini` and `workers-ai` on). Harmless today, a map for an attacker on a paid product.
7. The `accounts` and `account_keys` tables exist (`schema.sql:150-165`) and nothing in `worker/` reads them (`git grep account_keys infrastructure/worker` finds nothing). Dead schema that will confuse the next migration author.
8. Repository state (`gh`, 2026-11-02): public; no branch protection on `master` (404); no rulesets (`[]`); no CODEOWNERS; environments: only the legacy `github-pages`; collaborators `the architect`, `the-owner`. PRs #12, #17, #18 were merged by their own author; #13 (the owner's) by the architect; #22 (the architect's) by the owner. Merge authority is ad hoc and unenforced.
9. `leeroy.party` responds with no `Content-Security-Policy`, no `Strict-Transport-Security`, no `X-Frame-Options` or `frame-ancestors` (only `x-content-type-options` and `referrer-policy`). The site is meant to be framed by Discord only (`brain.js:55`), yet any site may frame it.
10. The public `data/signups.json` carries an entry named `=Bloise=` beside `Bloise` (a stray name variant from the old name-matching path), which is the kind of residue a name-keyed identity model leaves behind.
11. `wrangler.toml:59` allows `http://127.0.0.1:8080` and `http://localhost:8080` as browser origins in production. Any local page on a friend's machine can call the API with their stored key's cookies-equivalent (the key is in localStorage, so the risk is CSRF-shaped only when a key is leaked; still, dev origins do not belong in production).

---

## 1. The panel

For each role: what they would do that is not being asked for; the rawest material they would start from; methods and tools; and the external oracle that says the result is right. "External" means not the owner and not the AI.

### 1.1 Principal engineer (system owner)
- Not asked: a written system contract (OpenAPI for the 22 routes in `index.js`, a state-ownership table per `kv_state` key, a sequence diagram for an ask across board, Worker, DO and Discord), a tenancy model, an error taxonomy, and a deprecation path for every route the retired bot used (`/intents`, `/ack`, `/answer`, `index.js:452-553`).
- Raw material: `wrangler tail` output over a week (cpuTime, subrequests, D1 `rows_read/rows_written` per route), the Cloudflare account's quota page, the D1 `EXPLAIN QUERY PLAN` for `buildPartySheetsFromD1` (`index.js:212-214` reads every `sheet_events` row on every cold path), one day of raw request logs, and the git reflog of `master`.
- Methods and tools: Miniflare unit tests for the Worker and DO; contract tests generated from OpenAPI (schemathesis or Dredd); `k6` soak at 5 and at 500 users against a PR preview; dependency and SBOM scan (`npm audit`, `osv-scanner`); architecture decision records in `docs/adr/`.
- Oracles: schemathesis passing against the live contract; k6 report meeting a written SLO; Cloudflare's own quota dashboard staying under 50% at the target user count; a second engineer (the architect) signing the ADR.

### 1.2 Site reliability engineer
- Not asked: SLOs (availability of `/api/bootstrap`, p95 ask latency, WebSocket reconnect time), an on-call rota (even of one), alerting, a tested restore, and runbooks per failure mode (D1 outage, DO eviction, provider outage, Discord outage, Cloudflare incident).
- Raw material: the Cloudflare status page history (cloudflarestatus.com) for Workers, D1, Durable Objects, Pages, AI Gateway and Workers AI incidents over the last 12 months; the zone analytics (`cf-analytics.json`: 8,220 requests, 7 5xx, 6 522 origin timeouts, 146 404s in 24 h); `wrangler tail`; D1 Time Travel bookmarks; the account's free-tier limits page.
- Methods and tools: synthetic monitoring from outside Cloudflare (UptimeRobot, Better Stack, or Checkly, free tiers) on `/api/health`, `/api/bootstrap`, a WebSocket handshake and `leeroy.party/`; Cloudflare Notifications on 5xx rate; a restore drill (`wrangler d1 time-travel restore` into a scratch database, then diff row counts); Logpush or `wrangler tail` to a sink; a status page.
- Oracles: the monitor's uptime number; a restore drill log with before/after counts signed by someone other than the person who ran it; Cloudflare's incident feed correlated with the monitor.

### 1.3 Application security engineer
- Not asked: a threat model (STRIDE over the Discord path, member keys, admin token, webhook, AI prompt injection from scraped pages), an authorization matrix per route, secret rotation, security headers, dependency scanning, and a disclosure policy.
- Raw material: OWASP ASVS 4.0 level 2 as the checklist; the Discord Interactions docs (Ed25519 verification, timestamp, component rules); raw signed interaction captures; `wrangler.toml`, both workflows, the Developer Portal settings as they stand; `js/brain.js` key storage (`brain.js:25-38`, localStorage `board-key`).
- Methods and tools: OWASP ZAP baseline against a PR preview; semgrep with the `javascript` and `secrets` rulesets; `gitleaks` over full history (the repo was imported from a private tree: SOURCE-MOVE.md section 3 says history carried first names and ids); a replay test with a 10-minute-old signed interaction (`discord.js:315-330` verifies the signature over `timestamp + body` but never compares the timestamp to now); an authz test that uses friend A's key against friend B's resources on every member route.
- Oracles: ZAP report with zero high findings; a third-party pen test before the first paying customer; `securityheaders.com` grade A; gitleaks clean on history (or a rewritten history).

### 1.4 Privacy counsel and data protection officer
- Not asked: a data inventory (what is stored per person, where, for how long, who can read it), a lawful basis per processing, a privacy notice, a DPA with each AI provider, a retention schedule, a deletion path for every table that names a person (`ask_turns.by_name`, `sheet_events.name`, `intents.slug`, `fact_fixes.by_name`, `dispatches.name`), and a children's-data position (Discord users can be 13+).
- Raw material: GDPR Articles 5, 6, 13, 17, 28, 32; CCPA/CPRA; Google's Gemini API terms for the free tier (the free tier's data may be used to improve Google products; **likely**, verify the current "Gemini API Additional Terms" text before relying on it); Anthropic's commercial terms; Cloudflare's DPA; Discord's Developer Terms and Policy on user data; the actual D1 rows (`SELECT by_name, question FROM ask_turns`).
- Methods and tools: a record of processing activities; a DPIA for the AI path; data minimisation (hash with a secret salt, drop names from rows, keep slugs); a deletion endpoint per table keyed by member; a retention cron.
- Oracles: counsel's sign-off on the notice and the DPIA; a subject-access request exercised end to end by a friend and answered within 30 days; a deletion request verified by a second person reading the database afterwards.

### 1.5 IP, trademark and gaming-licensing lawyer
- Not asked: a clearance opinion on selling a World of Warcraft companion under the name "Leeroy", using class and zone names, Blizzard news text, and Blizzard's game data; a review of every scraped source's terms; a position on the AI-painted art; a replacement licence for the repo.
- Raw material: Blizzard's Fan Content Policy and the World of Warcraft EULA as published today (not summaries); the USPTO record for "Leeroy Jenkins" (Blizzard has used the name as an in-game NPC and a Hearthstone card; whether a live registration exists is **unverified** and must be checked on TSDR); Wowhead's terms of use (scraping and commercial reuse of their data are restricted; **likely**, verify); warcraft.wiki.gg's content licence (CC BY-SA; share-alike and attribution obligations apply to derived library facts; **unverified** version); wago.tools' terms for client data exports; OpenAI's terms on output ownership; the US Copyright Office's position that purely AI-generated images lack copyright (the `LICENSE.md:5` claim "the art in this repository are copyright the owner Bloise" is therefore **likely** unenforceable for the ChatGPT pieces documented in `board/img/*/CREDITS.md`).
- Methods and tools: a trademark search (TSDR, EUIPO, WIPO Global Brand Database) for the product name; a source-by-source licence table for `data/library/*.json` refs (167 Blizzard, 127 wowforevertools.com, 121 Blizzard forums, 98 wowforevertalents.com, 94 wowhead.com, 37 warcrafttavern.com, 24 wago.tools in `classes.json` alone); a nominative-use rule for game names in copy; a clean-room rule for facts (paraphrase, cite, never store page text).
- Oracles: a written clearance letter; a trademark application accepted for the new product name; the licence table reviewed by counsel; `lib_source_snapshots` dropped or emptied.

### 1.6 Payments and tax specialist
- Not asked: a billing model (per party per month, per seat, free with limits), a merchant of record decision, sales tax and VAT handling, refunds, dunning, invoices, and whether any purchase happens inside Discord (which pulls in Discord's own monetization rules).
- Raw material: Stripe Tax or a merchant of record (Paddle, Lemon Squeezy) terms; Discord's Developer Policy and the Monetization terms for Apps and Activities (if digital goods are sold inside the Activity, Discord's in-app purchase path and its revenue share **likely** apply; verify the current text); state nexus thresholds; the EU OSS scheme.
- Methods and tools: entitlement table in D1 (`tenant_id`, `plan`, `status`, `renews_at`), webhook-driven state from the processor, a free tier enforced in code rather than policy.
- Oracles: a test-mode checkout completed by a non-owner; a real paid invoice and a real refund; tax filings accepted; the processor's compliance questionnaire passed.

### 1.7 Accessibility specialist
- Not asked: a WCAG 2.2 AA audit of the five scenes, keyboard-only paths, screen-reader paths through a 3D tavern room (`room/`, `cloth/`), reduced-motion parity, an accessibility statement, and a VPAT if any customer is an institution.
- Raw material: the rendered DOM at 390 and 1366 wide (4,066 elements, LIGHTHOUSE note), real assistive technology sessions (NVDA + Firefox, VoiceOver + Safari on iPhone), the private harness results referenced in FRONTEND-BUILD-ORDER.md L7 ("13 failing a11y checks", "32 of 32" target).
- Methods and tools: axe-core in Playwright on every scene; manual keyboard sweep; APCA on rendered pixels (the project already does this privately); a user test with one screen-reader user.
- Oracles: axe zero serious or critical in CI; an external audit report; a screen-reader user completing the five core tasks unaided.

### 1.8 Performance engineer
- Not asked: field data (real phones, real networks), a byte and request budget enforced in CI on the public repo (the private gate `perf-pw.mjs` in PERF-BUDGET.md never moved), image delivery (7,074 KiB first load, 6,488 KiB images, LCP 33.8 s simulated, score 37, LIGHTHOUSE note), DO and D1 hot-path cost, and the cost of `buildPartySheetsFromD1` on cache miss.
- Raw material: Chrome traces (Long Animation Frames, decoded image memory) from the friends' real devices; Cloudflare Web Analytics Core Web Vitals (the beacon is on the zone, see `cf-analytics.json` `/cdn-cgi/rum`); `wrangler tail` cpuTime; Lighthouse CI JSON.
- Methods and tools: Lighthouse CI with assertions on a PR preview; `@cloudflare/next-on-pages`-style image resizing is not available on Pages free, so pre-build WebP/AVIF at display sizes; `Cache-Control: immutable` on stamped assets; lazy scene DOM.
- Oracles: CrUX or Web Analytics p75 LCP under 2.5 s on phones; Lighthouse CI budget gate green; the k6 run's p95.

### 1.9 QA lead
- Not asked: a test strategy per risk band, unit tests for the Worker (there are none in `tests/`; 8 API checks and about 60 smoke checks, `tests/README.md:5-6`), Discord handler tests with recorded signed fixtures run locally against Miniflare, a regression suite for the library ranker, flake tracking, and a definition of done per PR template.
- Raw material: raw Discord interaction payloads captured from production (with the signature), the Playwright traces from failed runs (`preview-tests.yml` uploads logs), the private harness suites that never moved (SOURCE-MOVE.md section 2 lists `tools/harness/`).
- Methods and tools: `vitest` with `@cloudflare/vitest-pool-workers` for Worker and DO; Playwright component and e2e; mutation testing on `rank-core.js`; a flake quarantine label.
- Oracles: coverage reported by an independent tool; a defect-escape count per release; the five friends' bug reports trending to zero over two releases.

### 1.10 Design systems lead
- Not asked: tokens (colour, type, spacing, motion) in one file, component inventory, theming for tenants (a product sells to parties who are not Horde and not tavern-themed), and a style guide that survives the owner.
- Raw material: the 23 stylesheets in `css/` and `scenes/*.css`, the art bible that MASTER-PLAN-v2.md says does not exist, DPR 3 captures from real phones.
- Methods and tools: design tokens (W3C format), Storybook or a static kit page, visual regression (Playwright screenshots with a threshold).
- Oracles: a second designer building a screen from the kit alone; visual regression green across releases.

### 1.11 Game-systems analyst (content pack owner)
- Not asked: a content schema that is game-agnostic (entity, fact, source, confidence, as-of, licence), a pipeline from licensed or permitted data only, a review step for AI-extracted facts (today `wiki_proposals` land as `status 'applied'`, `ai-models.js:858`, `schema.sql:82`), and a per-game pack format.
- Raw material: Blizzard's own posts; the game client's data tables through a permitted export (the licence for wago.tools exports is **unverified**); the five friends' real questions (persona.json `examples`, the old `bot/done`).
- Methods and tools: a fact review queue with two-person approval; a schema validator in CI (`data/library/schema.json` exists; whether CI runs it is **unverified**); a source allow-list with licence per host.
- Oracles: a domain expert outside the team spot-checking 50 random facts; zero facts with a source whose licence forbids reuse.

### 1.12 Community manager
- Not asked: community guidelines for a product-run Discord, moderation tools, a feedback loop that is not the owner's DMs, release notes, and onboarding for a new party that has never met the owner.
- Raw material: Discord Community Guidelines and Developer Policy; the existing channel's history (as data); support tickets once they exist.
- Methods and tools: a public roadmap, a changelog, a feedback board, a moderation runbook.
- Oracles: a second party onboarded without the owner present; NPS or a retention number per party.

### 1.13 Support lead
- Not asked: a support channel, an SLA, a knowledge base, an admin console to look up a tenant's state without `wrangler d1 execute`, and a way to reset a member's key.
- Raw material: every question the friends asked that was really a support question; the Worker's error bodies (`index.js:1402-1404` returns `err.message` to the client).
- Methods and tools: a help desk (even a shared inbox), an internal admin page behind a separate auth, structured error codes.
- Oracles: first-response time measured by the help desk tool; a support ticket resolved by someone other than the owner.

### 1.14 Finance
- Not asked: unit economics (AI cost per ask per provider, Cloudflare paid plan thresholds, Durable Object and D1 cost at N tenants), a budget, and a kill threshold.
- Raw material: provider invoices, AI Gateway logs per model, Cloudflare billing, the usage ledger the private notes mention (`notes/ops-rooms/usage-live.jsonl`).
- Methods and tools: a cost per tenant per month dashboard from AI Gateway and Cloudflare analytics; price experiments.
- Oracles: an accountant's P&L; gross margin above a written floor.

### 1.15 Growth and pricing
- Not asked: who buys (party leader, guild officer, Discord server owner), the wedge (one game, one activity), the free tier, pricing tests, and distribution (Discord App Directory listing, which has its own review).
- Raw material: Discord App Directory requirements; interviews with ten party leaders who are not friends of the owner; competitor pricing (Raidbots, Warcraft Logs, Wowhead Premium as reference points, **unverified** current prices).
- Methods and tools: landing page test, waitlist, two price points, cohort retention.
- Oracles: paying strangers; App Directory approval; retention at week 4 for parties with no owner contact.

### 1.16 Platform (Discord) engineer
- Not asked: a staging Discord application with its own URL mapping (MASTER-PLAN-v2.md section 3 proposes it; not done), Activity review requirements, rate-limit handling on interaction follow-ups, the 3-second initial response limit for routes that write D1 synchronously (`discord.js:635-661, 707-727, 809-835`, parity audit section 5 item 5), and per-guild installation for a product.
- Raw material: Discord's Interactions, Activities and Embedded App SDK docs and changelog; raw interaction payloads; the vendored SDK (`vendor/embedded-app-sdk.mjs`) diffed against upstream.
- Methods and tools: a fixture-driven handler test; a second app id for staging; `discord-interactions` library or equivalent for signature and component validation.
- Oracles: Discord's own validation (the Developer Portal PING, App Directory review); the staging app passing a scripted command sweep by a tester account.

### 1.17 Release engineer
- Not asked: branch protection, required checks, CODEOWNERS, merge queue, environments with scoped secrets, an immutable release tag per production deploy, rollback rehearsal (`wrangler rollback`, Pages previous deployment, D1 Time Travel) and a change log.
- Raw material: `gh api` output above (nothing enforced); the Actions run history (Preview Tests failed or cancelled 5 of the last 8 runs on `feat/persona-from-d1`); `deploy-cloudflare.yml` (schema then migrations, `:199-202`; seed only when `kv_state` is empty, `:211-221`).
- Methods and tools: GitHub rulesets, required status checks, merge queue, environments, `actions/dependency-review`, pinned action SHAs, `wrangler versions` for gradual rollout.
- Oracles: a rollback rehearsed and timed by the architect with the owner watching; a release that no human merged by hand.

---

## 2. The hard truths

Ordered by how surely each one blocks a sale.

### 2.1 You cannot sell this as a World of Warcraft product under its current name, art pipeline and data pipeline (**confirmed** facts, **likely** legal reading, counsel needed)
- Facts in the repo: the product is named after Blizzard's character ("You are Leeroy Jenkins, the party librarian", `ai-models.js:608`; `username: "Leeroy Jenkins"` on webhook posts, `index.js:443`; domain `leeroy.party`). The library republishes third-party page text (`lib_source_snapshots.body_text`, `schema.sql:63-70`) and serves previews without a key (`index.js:831-835`). Facts cite Wowhead (94 refs in `classes.json`), fan talent sites and Blizzard posts. Art is ChatGPT-generated and credited as such (`board/img/CREDITS.md`, `crests/CREDITS.md`).
- Likely legal reading (verify against the current Fan Content Policy and EULA text): Blizzard permits non-commercial fan content and prohibits selling it, charging for access, or using Blizzard IP in a product; nominative references to the game, classes and zones in a third-party tool are generally tolerated, but a product name that is a Blizzard character, and a persona that speaks as that character, is not nominative use. Wowhead-derived data in a paid product is **likely** a terms-of-use breach. CC BY-SA wiki facts carry share-alike obligations that are incompatible with "all rights reserved" (`LICENSE.md:3-5`).
- What a sellable product must be re-based on: a game-agnostic **party companion platform** (sign-ups, sheets, next-step engine, atlas, library, chamber, Discord commands) with **per-game content packs**. Pack content comes only from sources with a licence that permits commercial reuse (Blizzard's own public posts quoted minimally and paraphrased, CC BY-SA sources attributed and kept share-alike in a separable pack, client data only through a permitted channel) or from the tenant's own records. A new product name and persona name with a trademark search. "Leeroy" stays the private beta's name for the five friends.
- The art: AI-generated pieces are **likely** not protectable; that is acceptable for a product (anyone could copy them, nobody can stop you using them) but the licence and marketing must not claim copyright in them, and the pipeline should record prompts and dates as provenance.

### 2.2 There is no tenant; there is one hard-coded party (**confirmed**)
- `PARTY_MEMBERS` is a constant with five slugs (`index.js:29-35`); the admin token maps to `PARTY_MEMBERS[3]` (`index.js:50-52`); every board document is a singleton key in `kv_state` (`index.js:627-628`); the Durable Object is `idFromName("global")` (`index.js:172`); the Discord application id is a literal (`index.js:700`); the guild id is a literal in `bot-data.js` (parity audit row 3); `ALLOWED_ORIGINS` is a fixed list (`wrangler.toml:59`); the system prompt names the five (`ai-models.js:608`). Making a second party requires a schema with `tenant_id` on every table, a per-tenant DO, per-tenant Discord installation (guild id and channel from the install flow), per-tenant members and roles, and per-tenant content pack selection. This is the largest piece of engineering between here and a sale, and it is the architect's domain.

### 2.3 Identity and authorization are not product-grade (**confirmed**)
- Member keys are bearer secrets in localStorage (`brain.js:32-38`) with no expiry, rotation or revocation path besides editing D1 by hand (`infrastructure/scripts/hash-key.mjs`); the members cache lasts 15 min per isolate and the invalidator is never called (`auth.js:18-36`).
- `resolveMemberAuth` establishes *who* but routes never check *what they may touch*: `PUT /vocab` (`index.js:408-421`), `PUT /data/:name` (`index.js:1003-1016`), `PUT /wiki/page` (`index.js:846-849`), `POST /signups` legacy branch writing arbitrary `entries` (`index.js:727-737`). Any friend can rewrite any shared document.
- Discord identity is a display-name substring with first names in public source and a fallback to the owner (`discord.js:393-399`, `:449-455`), so an unknown user writes the owner's sheet and sign-up.
- `/intents`, `/ack`, `/answer` HTTP routes have no key (`index.js:452-553`; live: `/api/intents` 200, 874 bytes) and the slash commands of the same names are open to any server member (`discord.js:1207-1328`).
- The admin token is accepted in the query string (`index.js:82`) and the preview deploys it as a plaintext `--var` (`pr-preview-cloudflare.yml:237`).
- Discord signature verification has no timestamp freshness (`discord.js:315-330`).
- A product needs: OAuth (Discord) as the only identity, short-lived sessions (the `account.js` pattern is the right shape and already exists), a roles table (owner, member, guest) per tenant, an authorization check on every write, and admin routes under a separate admin identity. The `accounts`/`account_keys` tables should be deleted rather than finished.

### 2.4 Friends' personal data is in public source, public data and third-party AI (**confirmed**)
- First names and nicknames in the public repo: `ai-models.js:29-35`, `discord.js:395-398`, `bot-data.js:611-640` (including a private nickname). CONTRIBUTING.md:12 forbids exactly this. The repo's history came from a tree that SOURCE-MOVE.md says held names and Discord ids throughout.
- Questions with the asker's display name are stored forever in `ask_turns` and sent to Gemini free tier (`health` shows `aiProvider: gemini`). Free-tier Gemini terms **likely** permit Google to use prompts to improve its products; for a product, a paid tier with a DPA or a provider with a zero-retention commitment is required.
- Public salts (finding 2 above) and unsalted IP hashes (finding 3).
- A product needs: a data inventory, a privacy notice, DPAs, a retention schedule (`ask_turns` 90 days, `guest_rate_limits` 2 hours is already pruned at `index.js:1213-1218`), per-member deletion across all tables, and a scrubbed or rewritten git history. Until then the repo should be private.

### 2.5 AI cost and abuse are uncapped for members and the content pipeline writes itself (**confirmed**)
- Member asks have no per-member or per-tenant budget; `left: 5` and `limit: { left: 6 }` are constants (`index.js:1272`, `:821`). Guest limit is 2 per hour per IP (`index.js:1189-1203`), easily rotated through proxies. Provider fetches have no timeout (no `AbortSignal` anywhere in `worker/`; `ai-models.js:159-175`).
- AI-extracted facts are applied without review (`ai-models.js:858`, `schema.sql:82`), from pages the sweep fetched (`scraper.js:206-229`), so a changed or compromised source page rewrites the library and the next answer. That is prompt injection with persistence.
- Seven providers (`ai-models.js:19-27`) means seven terms of service, seven key rotations and seven failure modes for a product that needs one dependable path and one fallback.
- A product needs: an entitlement check before every AI call, AI Gateway rate limits and spend caps per tenant, `AbortSignal.timeout`, a review queue for proposals, and two providers (Workers AI as the free floor, one paid provider under a DPA).

### 2.6 Discord platform rules for Activities and selling inside Discord (**likely**, verify)
- The board runs as an Activity under app `1561857940174938114` (`brain.js:55`, `infrastructure/README.md:280-289`). For a product: each tenant installs the app in their own guild, the Activity must pass Discord's App Directory and Activity review (verification requirements, privacy policy URL, terms URL, 75+ server threshold for verification), and any purchase inside the Activity **likely** has to go through Discord's in-app purchase path with its revenue share. Selling on the web and letting Discord be a free surface avoids that; the plan assumes it.
- The Worker can only answer HTTP interactions (no bot token: `git grep BOT_TOKEN infrastructure/` is empty per the parity audit). Pinned cards, scheduled posts, threads and reactions, which the friends had, need a bot token or a gateway process; a product that promises them needs a hosted gateway (Cloudflare has no long-lived gateway process on the free tier; a small VM or Fly.io machine is the honest answer).

### 2.7 The platform account, the domain and the deploy path belong to the partner (**confirmed**)
- JOSH-RULES.md answer Q1: the Cloudflare account is the architect's; the owner is a member; `leeroy.party`, Pages, the Worker and D1 live there. the owner holds the API token as a GitHub secret. If the partnership changes, the product's runtime, data and domain are not the owner's. A sellable product needs the account and the domain under the selling entity with both people as admins, a written agreement on IP assignment for contributions (CONTRIBUTING.md:16 is a start but the architect's architecture was contributed before it existed; **unverified** whether he agreed to it), and a documented path to migrate (D1 export, Pages redeploy, DNS).

### 2.8 Bus factor is one, twice (**confirmed**)
- the owner is the only person who knows the front end, the art pipeline, the content voice, the Discord application and the friends. the architect is the only person who knows the Worker's intent, the deploy path and the Cloudflare account. The notes record an eleven-day sprint of agents and sessions (MASTER-PLAN-v2.md: "109 shipped and 81 held lines"), whose knowledge is in private notes that SOURCE-MOVE.md says cannot be made public. The public repo's `README.md` and `infrastructure/README.md` are vendor-style setup guides, not a system design. A product needs the design written where the next engineer reads it, and two people able to deploy, restore and rotate.

### 2.9 Observability, backups and recovery are not there (**confirmed**)
- Logging is `console.error` (`index.js:1403`); no sink, no retention, no alert. Traffic numbers were read by eye from the dashboard (`cf-analytics.json` "no API token yet"). Backup is `export-d1.mjs` run by hand (`infrastructure/README.md:538`); D1 Time Travel (30 days) is the real restore and has no runbook or drill. The DO holds no state (`room.js:1-5`), good. No uptime monitor. No error budget. The five 522 origin timeouts and seven 5xx in 24 h are unexplained.

### 2.10 Quality gates exist on paper and are not enforced (**confirmed**)
- CONTRIBUTING.md:7 and the PR template set the 0 to 10 rule, but GitHub enforces none of it (no protection, no rulesets, no CODEOWNERS). Preview tests run with `continue-on-error: true` (`preview-tests.yml:81, 93`) and then a summary step fails the job; a reviewer must read the comment. Forks and drafts get no tests (`:18`). There are no unit tests for `worker/`. The Discord handler is "checked on production after merge" (CONTRIBUTING.md:9); a product cannot test on customers.

### 2.11 Performance and accessibility are below a sellable bar (**confirmed** numbers, pre-Cloudflare host)
- Mobile Lighthouse 37, 7 MB first load, LCP 33.8 s simulated (LIGHTHOUSE note, measured on the github.io host 2026-11-01). The private a11y work (L7 in FRONTEND-BUILD-ORDER.md) never shipped to the public repo. The 3D room and cloth are a differentiator for a showcase and a liability for a product used beside a game on a laptop.

### 2.12 Support, billing, terms and docs do not exist (**confirmed** absence)
- No terms, no privacy policy, no support path, no billing, no admin console, no status page, no changelog. `robots.txt` is `Disallow: /` and `index.html:6` is `noindex`, so there is also no public front door.

---

## 3. The rewritten plan

Rules: one PR per item, one open PR per person, risk per the repo scale (0 docs, 3 CSS or copy, 5 front-end logic in one scene, 7 API behaviour keeping its contract, 8 to 10 auth, schema, secrets, DO, workflows, Discord handler). Owner: the owner = product, front end, decisions; the architect = back end, architecture; Claude = execution (writes the PR, runs the tests, drafts the docs). "Oracle" is what proves it, other than the author. "Rollback" is the one-line undo. Items marked **gate** need the architect's approving review before merge (section 4); items marked **courtesy** get his review request but can merge on green checks.

### Stop doing (now)
1. Stop new scenes, art lanes and cloud build sessions on the front end until Phase 0 and Phase 1 are merged. Every new feature widens the surface that Phase 2 must multi-tenant.
2. Stop merging by hand around a red or missing check. Stop merging your own PRs rated 6 or higher.
3. Stop the sweep auto-applying facts and stop storing third-party page text (Phase 1).
4. Stop adding AI providers. Freeze at Workers AI plus one paid provider.
5. Stop publishing from or referring to the private tree; the public repo is the only home (JOSH-RULES.md rule 11). Stop putting first names anywhere, including notes that will be copied.
6. Stop claiming "full parity" in file headers (`discord.js:2`) and READMEs; write what the code does.
7. Stop treating "the five friends are the beta forever" as a product test. They are a usability panel; paying strangers are the product test.

### Phase 0: security and privacy fixes already found (this week; all small PRs)

| # | What | Why | Owner | Risk | Oracle | Rollback |
|---|---|---|---|---|---|---|
| 0.1 | Fix `GET /api/signups`: replace `putCachedResponse` with `setCachedResponse(ctx, ...)` and the 4-arg `jsonResp` call (`index.js:555-566`) | Live 500 on production | Claude, **gate** the architect | 7 | API test `GET /api/signups` 200 with `entries` array, added to `tests/api/api.test.mjs`; live curl after deploy | `wrangler rollback` |
| 0.2 | Gate `GET /intents`, `POST /ack`, `POST /answer`, `GET /wiki/snapshots`, `GET /wiki/proposals` behind the admin token only (not member keys); remove `?k=` from `extractKey` (`index.js:76-83`) | Ungated reads of every member's intents; destructive ack; answer injection into every browser; URL keys in logs | Claude, **gate** the architect | 9 | API tests: each route 401 with no key, 401 with a member key, 200 with admin; ZAP baseline on the preview shows no unauthenticated write | `wrangler rollback` |
| 0.3 | Delete the `/intents`, `/ack`, `/answer` slash commands from the manifest and handler (`discord.js:278-301`, `:1207-1328`) | Any server member can delete the mailbox or overwrite answers | Claude, **gate** the architect | 8 | Manifest at `GET /api/discord/commands` no longer lists them; re-register commands; a non-owner test account sees no such command | revert commit; re-register |
| 0.4 | Authorization on member routes: `PUT /vocab`, `PUT /data/:name`, `PUT /wiki/page`, legacy `POST /signups` entries array become admin-only; `POST /sheet`, `POST /signups` patch, `/intent` stay member-scoped to the caller's slug (already true for sheet) | Any friend can rewrite shared documents | Claude, **gate** the architect | 9 | API test: member key on each admin route gets 403; member A cannot change member B's sign-up (add a second preview member via `hash-key.mjs` in the preview seed) | `wrangler rollback` |
| 0.5 | Discord identity by `user.id` allow-list (env var `DISCORD_MEMBER_IDS` as `id=slug,...`, Worker secret) and refuse unknown users with an ephemeral message; delete `slugFromDisplayName` and the first-name map (`discord.js:393-399`); delete `FIRST_NAME_MAP` (`ai-models.js:29-35`) and the name rows in `bot-data.js:609-660` | Wrong-person writes; first names in public source | Claude, **gate** the architect | 9 | `git grep -i` for the five first names and the nickname returns nothing; a tester account that is not on the list gets the refusal on production (Discord is production-only by process) | `wrangler rollback`; names were never needed |
| 0.6 | Move `KEY_SALT` and `USER_SALT` to Worker secrets (`wrangler secret put` in both workflows), remove them from `wrangler.toml`, rotate both, re-issue the five member keys (hashes change) | Public salts void the hashing | Claude, **gate** the architect | 10 | `wrangler.toml` has no salt; `/api/me` with an old key is 401; each friend's new key works; a `sessions` row count after login | restore the old salt as a secret (keys valid again) |
| 0.7 | Salt the guest IP hash with `USER_SALT` (`index.js:779-780`, `:1179-1180`) | Reversible IP hashes are personal data | Claude, **gate** the architect | 8 | Unit test that two salts give two hashes; retention already 2 h | `wrangler rollback` |
| 0.8 | Fix `/signup` components: `type: 5` to a `type: 2, style: 5` link button (`discord.js:863`); parse booleans (`discord.js:542`); route only `signup:` prefixes in the component handler (`discord.js:1425-1465`) | Invalid component likely errors; `private:false` treated as private; `launch:` ids corrupt sign-ups | Claude, **gate** the architect | 8 | A fixture test of the response body against Discord's component schema (a JSON schema in `tests/unit/`); production try by a friend | revert |
| 0.9 | Discord signature freshness: reject `X-Signature-Timestamp` older than 300 s (`discord.js:315-330`); `allowed_mentions: { parse: [] }` on every webhook and PATCH body (`index.js:442-446`, `ai-models.js:634-641`, `discord.js:565-573`); clamp PATCH content to 2,000 chars | Replay; mass pings; silent PATCH failures | Claude, **gate** the architect | 8 | Unit test with a stale signed fixture returns 401; a shared ask containing `@everyone` on the preview webhook (preview has no webhook, so: unit test on the body builder) | `wrangler rollback` |
| 0.10 | Preview secrets as secrets: `wrangler secret put BOARD_ADMIN_TOKEN` in `pr-preview-cloudflare.yml:237` instead of `--var`; a separate preview token value in a `preview` GitHub environment | Plaintext binding; shared token across prod and previews | Claude, **gate** the architect | 9 | `wrangler secret list` on a preview shows the name; the preview tests pass with the preview-environment token | revert the workflow |
| 0.11 | Remove `http://localhost:8080` and `http://127.0.0.1:8080` from production `ALLOWED_ORIGINS` (`wrangler.toml:59`); keep them only in the local override | Dev origins in production | Claude, **gate** the architect | 8 | CORS test from `http://localhost:8080` gets 403 | revert |
| 0.12 | Minimise `/api/health`: `ok`, `service`, `at`; providers only with the admin token (`index.js:1380-1398`); stop returning `err.message` on 500 (`index.js:1402-1404`), log it instead | Information disclosure | Claude, **gate** the architect | 7 | API test on the health shape; the preview test `aiProvider` assertion (`api.test.mjs:20`) moves behind the token | `wrangler rollback` |
| 0.13 | Security headers on Pages: `_headers` file with `Content-Security-Policy` (`frame-ancestors https://discord.com https://*.discordsays.com`), `Strict-Transport-Security`, `X-Frame-Options` is superseded by CSP, `Permissions-Policy` | No CSP, no HSTS, framable by anyone | Claude, courtesy | 5 | `securityheaders.com` A on the preview; the Activity still loads (Discord is production-only: test on a staging app, item 1.6) | delete `_headers` |
| 0.14 | Disable Cloudflare Web Analytics auto-injection on preview deployments (Pages project setting) or scope the beacon to the production hostname | Beacon CORS errors on previews pollute the smoke test's console-error check | the owner (dashboard) | 0 | Preview smoke shows zero beacon errors | re-enable |
| 0.15 | Make the repo private until 0.5 and a history scrub land; then decide public again under a real licence (D8) | First names, salts and a chat-derived nickname are public now | the owner | 0 | `gitleaks` and a name grep over full history are clean before flipping back | flip visibility |
| 0.16 | Rotate the Gemini key pasted in a DM (JOSH-RULES.md rule 10) and the admin token (it was deployed as a var) | Known exposure | the architect (his key), the owner (the token) | 10 | `/api/health` shows gemini still true after rotation; old token gets 401 | none needed |

### Phase 1: make the gates real and the data lawful (next two weeks)

| # | What | Why | Owner | Risk | Oracle | Rollback |
|---|---|---|---|---|---|---|
| 1.1 | GitHub ruleset on `master` (section 4): PR required, required checks `Preview Tests / api` and `/ browser` as separate check names, code-owner review required, linear history, no force push, merge queue on | Gates on paper become gates in fact | the owner (settings), Claude drafts CODEOWNERS and the risk workflow | 8 (workflows) | A PR touching `infrastructure/` cannot merge without the architect's approval; a front-end PR auto-merges on green | disable the ruleset |
| 1.2 | Split `preview-tests.yml` into two jobs with distinct names, remove `continue-on-error`, run on drafts too | Required checks need stable names | Claude, **gate** the architect | 8 | Branch rule lists both checks; a failing API test blocks merge | revert workflow |
| 1.3 | Risk label workflow: compute the label from changed paths (`infrastructure/**`, `.github/**`, `wrangler.toml`, `schema.sql`, `migrations/**` = 8+; `js/brain.js`, cross-scene = 7; one scene = 5; `css/**`, `data/**` copy = 3; `*.md` = 0); a check fails if a PR at 6+ lacks a code-owner approval | The template's rule, enforced | Claude, courtesy | 8 | A test PR touching `css/` gets `risk:3` and merges alone; one touching `worker/auth.js` gets `risk:9` and waits | disable the workflow |
| 1.4 | Worker unit tests with `@cloudflare/vitest-pool-workers`: auth, authz matrix, Discord signature and component shapes, `recomputeSignupTallies`, `rank-core` | No unit tests exist for the back end | Claude, courtesy the architect | 5 (tests only) | Coverage report in CI; the authz matrix test enumerates every route in `index.js` and fails on a new ungated write | none |
| 1.5 | Stop storing third-party page text: drop `body_text` from `lib_source_snapshots` (keep `sha8`, headers), empty the table; proposals land as `status 'proposed'` and a reviewed `PUT /wiki/proposal/:id` (admin) applies them | Republishing others' text; self-writing library | Claude, **gate** the architect | 9 (schema, migration) | Migration applied on a fresh local D1 and on a preview; `GET /api/wiki/snapshots` returns no text; a proposal appears in a review list and does not change `lib_pages` until approved | D1 Time Travel to before the migration |
| 1.6 | Source allow-list with licence per host in `lib_sources` (new column `licence`); remove Wowhead and any host whose terms forbid reuse from the sweep; attribution block for CC BY-SA facts on the library page | Licence hygiene for a sellable pack | the owner decides hosts, Claude executes, **gate** the architect (schema) | 8 | A CI check that every `refs[].host` in `data/library/*.json` is on the allow-list | revert the data change |
| 1.7 | Deploy order: migrations only (`deploy-cloudflare.yml:199-202`, `pr-preview-cloudflare.yml:208-211`); fold `schema.sql` into `0000_baseline.sql`; prove on an empty local D1 | The private review found a duplicate-column failure path (ARCHITECTURE-REVIEW.md finding 3; the public tree has only `0001`, so verify whether it still applies, **unverified**) | Claude, **gate** the architect | 9 | `wrangler d1 migrations apply --local` from empty succeeds twice (idempotent) | revert workflow |
| 1.8 | Restore drill and runbook: `docs/runbooks/restore.md`; run `wrangler d1 time-travel restore` into a scratch database on the preview account, diff row counts | Nobody has restored | the architect runs, Claude writes, the owner watches | 0 (docs) + the drill | A dated drill log with counts, signed by the architect | none |
| 1.9 | External uptime monitor on `/api/health`, `/api/bootstrap`, `leeroy.party/`, plus a WebSocket check; Cloudflare notification on 5xx rate; `wrangler tail` to a free log sink for errors | No observability | the owner (accounts), Claude (config docs) | 0 | A forced 5xx on a preview triggers the alert | delete monitors |
| 1.10 | AI budget: `AbortSignal.timeout(20000)` on every provider call; per-member daily ask count in `ask_turns` returning 429 with `retryAfter`; AI Gateway rate limit per tenant and a spend cap | Uncapped cost and hangs | Claude, **gate** the architect | 8 | Unit test for the counter; a k6 burst of 50 asks from one member yields 429 after the cap | `wrangler rollback` |
| 1.11 | Data inventory and privacy notice (`docs/privacy.md`, `/privacy` page), retention cron (ask_turns 90 d, intents 7 d, dispatches 90 d), `DELETE /api/me` extended to erase `ask_turns`, `sheet_events`, `intents`, `fact_fixes`, `dispatches` by slug | Lawful basis and erasure | Claude drafts, the owner approves, counsel reviews before sale | 8 (schema touch) | A friend requests erasure; a second person reads D1 and finds no rows | Time Travel |
| 1.12 | Replace Gemini free tier for member asks with a provider under a DPA (paid Gemini, Anthropic commercial, or Workers AI only); keep Workers AI as the floor; delete the other four providers | Seven ToS, training-use risk | the owner decides (D5), Claude executes, **gate** the architect | 8 | `AI_PROVIDER_LABELS` has two entries; `/api/health` (admin) shows two | revert |
| 1.13 | Persona pack (PR #24) lands only after 0.5 and with a unit test that the built prompt contains no first name | PR #24 touches `ai-models.js`, `discord.js`, `index.js` | Claude, **gate** the architect | 8 | `tests/unit/persona.test.mjs` plus the name grep | `wrangler rollback` |

### Phase 2: the product skeleton (4 to 8 weeks; the architect's architecture, the owner's product calls)

| # | What | Why | Owner | Risk | Oracle | Rollback |
|---|---|---|---|---|---|---|
| 2.1 | ADR: tenancy model. `tenants`, `tenant_members(tenant_id, user_key, role)`, `tenant_id` on every table, `kv_state` key becomes `(tenant_id, key)`, one DO per tenant (`idFromName(tenant_id)`), content pack reference per tenant | The product is one party today | the architect writes, the owner approves, Claude drafts options | 0 (ADR) | the architect and the owner both sign the ADR | none |
| 2.2 | Identity: Discord OAuth as the only sign-in (extend `account.js`), member keys retired, invitations by Discord id, roles owner/member/guest | Bearer keys in localStorage cannot be sold | Claude, **gate** the architect | 10 | Authz matrix test extended to roles; a second tenant's member cannot read the first's bootstrap | staged behind a flag; Time Travel |
| 2.3 | Migrations for 2.1 and 2.2, in three PRs: add columns and backfill the five friends as tenant 1; switch reads; drop old paths | Schema | Claude, **gate** the architect | 10 | Fresh-D1 migration run; preview tests; a second seeded tenant on a preview | Time Travel per step |
| 2.4 | Discord install flow per tenant: `/setup` command binds guild and channel to the tenant; webhook created through the install (needs bot token scope `webhooks`) | Product install | Claude, **gate** the architect | 9 | A staging app installed in a test guild by a non-owner | uninstall |
| 2.5 | Staging Discord application and a `staging` environment (second app id, URL mapping to a long-lived `staging` branch deployment) | Discord is untestable today | the owner (portal), Claude (workflow), **gate** the architect | 8 | A scripted command sweep by a tester account on staging | delete the app |
| 2.6 | Content pack format: `packs/<game>/` with schema, licence manifest, attribution; the WoW Forever library becomes pack 1 after the 1.6 scrub | Game-agnostic platform | the owner (content), Claude (tooling) | 5 | Schema validation in CI; a second, tiny pack (any game) loads on a preview | revert |
| 2.7 | Rename: product name and persona name (trademark search first), domain, prompt, webhook username, `og:title`; "Leeroy" remains the five friends' private tenant name | 2.1 of hard truths | the owner decides (D1), counsel clears | 3 (copy) then 7 (Worker strings) | TSDR and EUIPO searches clean; counsel letter | revert |
| 2.8 | Perf lane on the public repo: Lighthouse CI budget on previews (LCP, bytes, requests), image pipeline to WebP/AVIF at display size, `_headers` immutable cache for stamped assets, lazy scene DOM | Mobile 37 | Claude, courtesy | 5 | Lighthouse CI assertions green; p75 LCP from Web Analytics under 2.5 s on phones over two weeks | revert |
| 2.9 | Accessibility lane: axe in the browser suite as a required check (zero serious), keyboard paths, reduced-motion parity, accessibility statement | Sellable bar | Claude, courtesy | 5 | axe in CI; one external screen-reader session | revert |
| 2.10 | Admin console (behind the admin identity): tenant lookup, member reset, proposal review, retention stats | Support without `wrangler d1 execute` | Claude, **gate** the architect (routes) | 8 | A support ticket resolved by the architect without the owner | feature flag |

### Phase 3: sell it (after Phase 2 passes its oracles)

| # | What | Why | Owner | Risk | Oracle | Rollback |
|---|---|---|---|---|---|---|
| 3.1 | Billing: Stripe (or a merchant of record) with Stripe Tax; `entitlements` table driven by webhooks; free tier enforced in code | Revenue | the owner (accounts), Claude, **gate** the architect (webhook route, schema) | 10 | Test-mode checkout by a non-owner; one real invoice and one refund | disable checkout |
| 3.2 | Terms of service, privacy policy, acceptable use, DPA template, subprocessor list | Legal front door | Counsel; Claude drafts | 0 | Counsel sign-off | none |
| 3.3 | Status page, support inbox, changelog, public docs, `robots.txt` and `noindex` reversed for the marketing page only | Front door | Claude | 3 | A stranger finds the product and signs up without talking to the owner | revert |
| 3.4 | Discord App Directory listing (if desired) with verification | Distribution | the owner | 0 | Discord's review | withdraw |
| 3.5 | Pen test and accessibility audit by third parties | Enterprise asks | the owner buys, the architect fixes | varies | Reports with zero high findings | none |
| 3.6 | SLA, incident process, on-call, DR test | Enterprise asks | the architect | 0 | A tabletop exercise log | none |

### Decisions that need the owner or the architect (yes/no, with recommendation)

| # | Question | Who | Recommendation |
|---|---|---|---|
| D1 | Re-base the product as a game-agnostic party companion with per-game content packs, under a new name, and keep "Leeroy" only as the private beta tenant? | the owner | **Yes.** Nothing else is sellable. |
| D2 | Move the Cloudflare account and the `leeroy.party` domain (or the new domain) into an account owned by the selling entity with both the owner and the architect as admins before any paying user? | the owner and the architect | **Yes.** Keep the architect's account for previews if he prefers. |
| D3 | Make the architect's review a hard gate (CODEOWNERS required review) for `infrastructure/**`, `.github/**`, `wrangler.toml`, `schema.sql`, `migrations/**`, `tests/api/**`? | the architect | **Yes.** It encodes rule 7 of JOSH-RULES.md so nobody has to remember it. |
| D4 | Let risk 0 to 5 front-end PRs auto-merge through the merge queue on green checks with no human? | the owner | **Yes.** That is CONTRIBUTING.md:7 today, enforced. |
| D5 | Drop Gemini free tier (and the four other free providers) for member asks in favour of Workers AI plus one paid provider under a DPA? | the owner (cost), the architect (design) | **Yes** before any stranger uses it; for the five friends, acceptable now with their informed consent. |
| D6 | Stop storing third-party page text and stop auto-applying AI proposals? | the architect | **Yes.** Hashes and reviewed facts only. |
| D7 | Remove Wowhead and any forbidding host from the sweep and the refs; keep Blizzard, CC BY-SA wiki with attribution, and permitted client-data exports? | the owner | **Yes**, with counsel confirming the wiki licence version and wago.tools' terms. |
| D8 | Make the repo private now; reconsider public after the scrub under a real licence (proprietary or BUSL), with the AI art licensed honestly? | the owner | **Yes** private now. Public later only if there is a reason (contributors), not by default. |
| D9 | Delete the unused `accounts` and `account_keys` tables rather than finish them? | the architect | **Yes.** Phase 2 replaces them. |
| D10 | Delete the three admin slash commands rather than gate them? | the architect | **Yes.** They were a bot-era bridge; the bot is retired. |
| D11 | Hosted gateway process (small VM or Fly machine, bot token) for pinned cards, scheduled posts and threads, or accept that the product has HTTP-only Discord features? | the owner (product), the architect (hosting) | **Yes** to a gateway, after Phase 2, as its own service with its own ADR; do not bolt it onto the Worker. |
| D12 | Does PR #24 (persona from D1) merge before 0.5? | the owner | **No.** It touches three Worker files and builds prompts; land 0.5 first so the test for "no first names in the prompt" means something. |

---

## 4. The merge-authority model

Principle: checks carry the load; the architect keeps architectural authority over the back end without becoming a bottleneck for copy and CSS; the owner keeps ownership and the final say; Claude merges nothing a human has not pre-authorised by rule.

### 4.1 Who merges what

| Paths | Risk band | the architect's review | Who merges |
|---|---|---|---|
| `infrastructure/worker/{auth,account,cors,crypto,room,discord}.js`, `infrastructure/schema.sql`, `infrastructure/migrations/**`, `infrastructure/wrangler.toml`, `.github/workflows/**` | 8 to 10 | **Gate** (required code-owner review) | the owner presses merge after the architect approves and checks are green; the architect may merge his own only with the owner's approval (two-person rule on 9 to 10) |
| `infrastructure/worker/{index,ai-models,scraper,bot-data,persona}.js`, `infrastructure/scripts/**`, `tests/api/**` | 7 to 8 | **Gate** for `index.js` and `scraper.js`; **courtesy** (requested, not required) for prompt text, `bot-data.js`, `persona.js`, `tests/api/**` | the owner (or merge queue when the architect has approved) |
| `js/brain.js`, `vendor/**`, `index.html` script block, `room/**`, `cloth/**` | 7 | Courtesy for `brain.js` and `vendor/discord-auth.js` (they implement his API contract) | the owner |
| `js/**` (other), `scenes/**`, `atlas/**`, `next/**` | 5 | None | Merge queue on green checks (Claude opens, auto-merge enabled) |
| `css/**`, `data/**` (copy and facts), `img/**`, `fonts/**` | 3 | None | Merge queue on green checks |
| `*.md`, `docs/**`, `.github/*.md` | 0 | None | Merge queue on green checks |

Claude never merges by hand: it opens the PR, enables auto-merge, and the queue merges when the rules pass. A PR Claude opens that trips a gate waits for the named human.

### 4.2 GitHub mechanics (all free on a public or private repo; rulesets available on private repos only for organisations on paid plans, **verify** on this account; classic branch protection works on any plan)

1. **CODEOWNERS** (`.github/CODEOWNERS`):
   ```
   /infrastructure/worker/auth.js      @the architect
   /infrastructure/worker/account.js   @the architect
   /infrastructure/worker/cors.js      @the architect
   /infrastructure/worker/crypto.js    @the architect
   /infrastructure/worker/room.js      @the architect
   /infrastructure/worker/discord.js   @the architect
   /infrastructure/worker/index.js     @the architect
   /infrastructure/worker/scraper.js   @the architect
   /infrastructure/schema.sql          @the architect
   /infrastructure/migrations/         @the architect
   /infrastructure/wrangler.toml       @the architect
   /.github/workflows/                 @the architect @the-owner
   /.github/CODEOWNERS                 @the-owner
   ```
   Everything not listed has no owner, so "require review from code owners" does not block it.
2. **Ruleset (or classic protection) on `master`**: require a pull request; require review from code owners; dismiss stale approvals on new commits; require status checks `preview-tests / api`, `preview-tests / browser`, `risk / label` (from 1.2 and 1.3); require conversation resolution; require linear history; block force pushes and deletions; **no bypass actors** (the owner included; emergencies go through a documented break-glass that disables the rule and re-enables it, logged in the audit log).
3. **Merge queue** on `master`: required checks re-run on the merged result; one PR at a time matches the 9-preview constraint; set max queue size 2.
4. **Environments**: `preview` (secrets: a preview-only `BOARD_ADMIN_TOKEN`, Cloudflare token scoped to preview resources if the architect can mint one; deployment branch policy: any branch) and `production` (secrets: production token, provider keys, Discord secrets; deployment branch policy: `master` only; **no required reviewers**, because the gate is on the PR, not the deploy; optional 2-minute wait timer so a bad merge can be cancelled). `preview-tests.yml` runs with `environment: preview`; `deploy-cloudflare.yml` with `environment: production`. Today both read repository-level secrets, so a preview can reach production secrets by construction (`preview-tests.yml:85`); environments fix that.
5. **Auto-merge** enabled on the repo; Claude turns it on per PR. Auto-merge honours the rules, so a code-owner gate simply holds the PR.
6. **Labels**: `risk:0` to `risk:10` set by the workflow (1.3); humans may raise, never lower (the workflow re-applies the computed floor on every sync).
7. **Dependabot** for `tests/` and `infrastructure/` with grouped weekly PRs at risk 5 (lockfile) and `actions/dependency-review` as a check.
8. **Signed commits** optional; **pinned action SHAs** required (a check).

### 4.3 What this preserves and changes
- the architect's authority over the back end becomes a mechanism (he must approve changes to his files) rather than a norm. He is not asked to review CSS.
- the owner keeps the repo, the settings and the production merge button on 8+; he no longer merges his own 8+ without the architect.
- Claude's throughput on 0 to 5 is unblocked and auditable (every merge is a queue merge with green checks).
- Fork PRs still get no secrets (`pr-preview-cloudflare.yml:41`); the architect works from a branch in the repo (he has write access), so his PRs get previews.

---

## 5. Enterprise readiness checklist

| Area | Current state | Target | First concrete step |
|---|---|---|---|
| Security: authn | Bearer member keys in localStorage, no expiry (`brain.js:32-38`, `auth.js`); admin token also in query string (`index.js:82`); Discord OAuth sessions exist only for prefs (`account.js`) — **confirmed** | OAuth-only identity, 30-day sessions with refresh, revocation, roles | Phase 0.2 (drop `?k=`), then 2.2 |
| Security: authz | Any member key can write any shared document (`index.js:408-421`, `:1003-1016`, `:846-849`); admin routes ungated (`:452-553`) — **confirmed** | Authorization matrix per route and role, tested | Phase 0.2 and 0.4; 1.4 matrix test |
| Security: Discord | Name-substring identity with owner fallback (`discord.js:393-399`); no timestamp freshness (`:315-330`); invalid component (`:863`); admin commands open (`:1207-1328`) — **confirmed** | Id allow-list per tenant, replay-safe, schema-validated components, no admin commands | 0.3, 0.5, 0.8, 0.9 |
| Security: secrets | Salts public (`wrangler.toml:60-61`); preview token as `--var` (`pr-preview-cloudflare.yml:237`); repo-level secrets readable by preview workflow — **confirmed** | All secrets as Worker secrets, per-environment, rotated on a schedule | 0.6, 0.10, 4.2 item 4 |
| Security: headers and transport | No CSP, no HSTS on `leeroy.party` — **confirmed** live | `securityheaders.com` A; CSP with `frame-ancestors` for Discord only | 0.13 |
| Security: supply chain | Actions by tag not SHA (**likely**, `actions/checkout@v4` at `deploy-cloudflare.yml:24`); no dependency scanning — **confirmed** absence | Pinned SHAs, Dependabot, dependency review | 4.2 items 7 and 8 |
| Security: testing | 8 API checks, ~60 smoke checks, no unit tests, no scanner — **confirmed** | Unit, contract, ZAP baseline in CI, annual pen test | 1.4; ZAP step in `preview-tests.yml`; 3.5 |
| Privacy | First names in public source (`ai-models.js:29-35`, `discord.js:395-398`, `bot-data.js:611-640`); questions sent to Gemini free tier (live `aiProvider: gemini`); unsalted IP hashes; no notice, no retention, partial erasure (`account.js:169-175` only) — **confirmed** | Inventory, notice, DPAs, retention, full erasure, scrubbed history | 0.5, 0.7, 0.15, 1.11, 1.12 |
| Legal: IP | Product and persona named after a Blizzard character; Wowhead-derived facts; third-party page text stored and served; "all rights reserved" over CC BY-SA-derived facts and AI art (`LICENSE.md`) — **confirmed** facts, **likely** reading | New name cleared by search; licence table per source; share-alike handled; honest art licence | 1.6, 2.7, counsel |
| Legal: terms | None — **confirmed** | ToS, privacy policy, AUP, DPA, subprocessors | 3.2 |
| Legal: ownership | Cloudflare account and domain are the architect's (JOSH-RULES.md Q1); contributor licence in CONTRIBUTING.md:16 postdates his main contribution — **confirmed** / **unverified** | Account and domain under the selling entity; signed contributor agreement | D2 |
| Reliability | One region-less Worker (good), D1 single database, DO stateless (good); 7 5xx and 6 522 in 24 h unexplained (`cf-analytics.json`); `GET /api/signups` 500 — **confirmed** | SLO 99.9% on bootstrap; error budget; incident process | 0.1; 1.9; 3.6 |
| Backups and recovery | Hand-run export (`infrastructure/README.md:538`); Time Travel 30 days untested — **confirmed** | Weekly export to a second account, quarterly restore drill, runbook | 1.8 |
| Observability | `console.error` only; dashboard read by eye — **confirmed** | Logs to a sink, uptime monitor, alerts, dashboards per tenant | 1.9 |
| Performance | Mobile Lighthouse 37, 7 MB first load (LIGHTHOUSE note, github.io host) — **confirmed** for that host; Cloudflare host **unverified** | p75 LCP under 2.5 s on phones; CI budget | 2.8 |
| Accessibility | Private a11y lane never shipped; no statement — **confirmed** absence in public repo | WCAG 2.2 AA, axe zero serious in CI, statement | 2.9 |
| Multi-tenancy | None; one hard-coded party (`index.js:29-35`, `:172`) — **confirmed** | `tenant_id` everywhere, per-tenant DO and Discord install | 2.1 to 2.4 |
| AI cost and abuse | No member cap; constants `left: 5` (`index.js:1272`); no timeouts; seven providers; auto-applied facts (`ai-models.js:858`) — **confirmed** | Entitlement check, per-tenant caps, timeouts, two providers, reviewed facts | 1.5, 1.10, 1.12 |
| Billing | None — **confirmed** | Processor, tax, entitlements, invoices, refunds | 3.1 |
| Support | None; errors leak `err.message` (`index.js:1404`) — **confirmed** | Help desk, admin console, error codes, SLA | 0.12, 2.10 |
| Docs | Setup guides (`README.md`, `infrastructure/README.md`); design lives in private notes — **confirmed** | ADRs, OpenAPI, runbooks, user docs, changelog in the public repo | 2.1 ADR; OpenAPI in 1.4 |
| Onboarding | Key handed out by hand (`hash-key.mjs`), `#k=` URL (`infrastructure/README.md:149-155`) — **confirmed** | Discord install, invite by id, first-run walk | 2.2, 2.4 |
| Data portability | `export-d1.mjs` for the operator only — **confirmed** | Per-tenant export (JSON) from the admin console | 2.10 |
| Deletion | `DELETE /api/me` erases prefs and sessions only (`account.js:169-175`) — **confirmed** | Erasure across every table by member and by tenant | 1.11 |
| SLAs and incident process | None — **confirmed** | Written SLA, status page, postmortems | 3.6 |
| Release engineering | No protection, rulesets, CODEOWNERS; self-merges — **confirmed** via `gh` | Section 4 | 1.1 to 1.3 |
| Discord platform | One production app; untestable before merge (CONTRIBUTING.md:9); HTTP-only features — **confirmed** | Staging app, fixture tests, gateway service if promised | 2.5, D11 |
