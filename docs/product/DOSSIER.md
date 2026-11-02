# Productization dossier

Status: DRAFT for the owner, written 2026-11-02. Not legal advice. Docs only; no code changed, no Discord call made, `/setup` not run.

**Read this first: how well sourced it is.** This session's network blocked every primary host (discord.com, support-dev.discord.com, developers.cloudflare.com, blizzard forums, and the bots' own sites all failed DNS), so no primary page was fetched in full. Each claim below cites the URL a web search returned plus the access date, and is labelled **[snippet]** (search excerpt of that URL, page not read in full), **[secondary]** (third-party summary, weak) or **[repo]** (read from this repo). Treat every **[snippet]** and **[secondary]** item as unconfirmed until someone opens the page. Item 1 on the next-actions list does that. Quotes are short phrases only.

## 1. Discord App Directory and verification

- **Verification trigger.** Discord support says apps must be verified to join over 100 servers [snippet: [Bot Verification thread](https://support.discord.com/hc/tr/community/posts/360061569571-Discord-Bot-Verification), accessed 2026-11-02]. Another snippet says verified apps "will need to apply" for privileged intents "when they are in 75 servers or more" [snippet: [How do I get my app verified](https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified), accessed 2026-11-02]. Community posts also say qualification starts around 76 servers [secondary, accessed 2026-11-02]. **Uncertain:** whether an HTTP-interactions-only app (this Worker's design, `POST /discord`) counts the same way. Assume yes.
- **What verification needs.** Identity verification of the owner and a Developer Team that owns the app [secondary: [wisechecker](https://wisechecker.com/?p=5508), accessed 2026-11-02]. The existing monetization note adds owner 18+ and a US, EU or UK team for Premium Apps [repo: `docs/product/blizzard-independent-monetization.md`].
- **MESSAGE_CONTENT.** Below the verification thresholds it is a toggle in the Developer Portal; at scale it needs approval [snippet: [Privileged Intents](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents), accessed 2026-11-02]. Without it, message content arrives empty except in DMs, messages that mention the app, and the app's own messages [snippet: [Discord privileged intent review](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review.md), accessed 2026-11-02]. Discord steers developers toward application commands instead [snippet: [A Note to App Developers](https://support-dev.discord.com/hc/articles/40281523410967), accessed 2026-11-02]. Reviewers reportedly ask about retention (30 days or less), off-platform storage, opt-out and AI training [secondary: [modmail intents FAQ](https://docs.modmail.dev/faq/intents-review), accessed 2026-11-02]. **Recommendation:** never request it. The product uses slash commands and forms, so the whole review is avoided.
- **Privacy policy and terms URLs.** Not confirmed by any source I could read. The monetization note says Premium Apps need "terms and privacy links live" [repo]. Treat live URLs as required. Drafts exist at `docs/privacy.md` and `docs/terms.md` and are unreviewed by counsel.
- **Developer Policy and Terms points that affect us.** Only secondary: bot privacy templates say users can request deletion of their data under the Developer Policy [secondary: [fables.gg template](https://fables.gg/discord-bot-privacy), accessed 2026-11-02]. The 2017 terms barred using end-user data outside the privacy policy [secondary, outdated]. **Unverified and to read:** the policy on AI use of message content, sale of data, and whether Premium Apps pricing rules apply. The live pages are the [Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy) and [Developer Terms](https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service) (neither fetched).

## 2. Competitor teardown

All six exist as listings; none was tested. Public complaints were hard to find: searches returned bot listings with almost no reviews, so **complaint data is thin** and the table says so.

| Bot | Does | Free vs paid (accessed 2026-11-02) | Public complaints found |
| :-- | :-- | :-- | :-- |
| [Raid-Helper](https://discordbotlist.com/bots/raid-helper) [snippet] | Raid sign-up, role templates; about 271,000 servers listed | Premium reportedly adds custom templates, recurring events, logging, mirrored events; price not found | None found |
| [Apollo](https://apollo.fyi/llms.txt) [snippet] | Event scheduling, RSVP, web dashboard | Free: 5 recurring events, 1 reminder per event, 2-month history. Premium 7.99 USD/month or 5.83 annual | None found; vendor pages only |
| [Sesh](https://sesh.fyi/blog/new-pricing-june-2025/) [snippet] | Calendar, RSVP, reminders | Premium for one server 6.99 USD/month (was 4.99); three-server bundle 12.99; free limits not found | None found |
| [Instancer](https://top.gg/bot/1408499363138896004) [snippet, WoW] | Attendance, analytics, Warcraft Logs link | Free core; Premium 3.99 USD/month per server | 0 reviews |
| [Queue Helper](https://top.gg/bot/1144646161790144552) [snippet, WoW] | Raid queue, 20 templates per server; players `/connect` characters | Not found | One 1-star review, text not read |
| [GoodBot](https://top.gg/bot/525115228686516244) [snippet, WoW Classic] | Sign-up with class and role set first, `+logs`, EPGP import | Not found | None found |

Onboarding pattern (inferred from the listings, **not tested**): invite bot, grant permissions, run a setup or template command, post an event. Pricing pattern: per server, 4 to 8 USD/month, free tier capped on recurrence, reminders or history. That bracket supports the 4/12/24 USD plan in the monetization note [repo]. Note Queue Helper's `/connect` flow points to character import, which this product avoids.

## 3. Blizzard terms

Primary pages not fetched. What is known:

- The monetization note says the Developer API Terms of Use, section 2(b), bar charging premiums to use the APIs, and that three Blizzard forum threads asking about edge cases have no official reply [repo; threads e.g. [Section 2(b) "No Premiums"](https://us.forums.blizzard.com/en/blizzard/t/clarification-on-section-2b-no-premiums%E2%80%94premiummember/59219) and [freemium with character cap](https://us.forums.blizzard.com/en/blizzard/t/question-is-freemium-model-with-character-cap-compliant-wit/58176), snippets, accessed 2026-11-02].
- A third-party compliance guide reads it broadly: no charging for features that use API data, credit Blizzard as source, refresh or delete data within 30 days, and no Blizzard marks in an app's name or URL where that implies endorsement [secondary: [Drupal WoW module](https://project.pages.drupalcode.org/wow/development/api-compliance/), accessed 2026-11-02]. Not Blizzard's own wording.
- I could not find a Blizzard fan-content policy. The Blizzard Video Policy limits use of its content to "non-commercial purposes" [snippet: [Blizzard Video Policy](https://www.blizzard.com/en-gb/legal/2068564f-f427-4c1c-8664-c107c90b34d5/blizzard-video-policy), accessed 2026-11-02]; it is not a fan-site policy. Blizzard has used trademark law against a fan project before [secondary: [Techdirt, Nostalrius](https://www.techdirt.com/articles/20160427/05472834289/blizzard-pretends-ip-made-it-kill-fan-server.shtml), accessed 2026-11-02].
- **Product rules (our decision, not Blizzard's):** no Blizzard API calls in the paid path; no "WoW", "Warcraft", "Blizzard" or "Forever" in the product name; no Blizzard art. Counsel should read the real terms before launch.

## 4. Data protection

Stored today, per `docs/data-inventory.md` [repo]: Discord id, display name and linked identities; characters and builds typed by members; sign-ups; `ask_turns.question` (free text, sent to an AI vendor); hashed guest IPs; per-guild tenant rows and an audit log. Gaps the inventory itself lists: `kv_state` board documents, Cloudflare logs and Discord-side data are outside export and erase.

- **Retention (proposed, not enforced):** Ask turns 90 days; guild data 30 days after the bot is removed; accounts purged within 30 days of deletion [repo: `docs/privacy.md`].
- **Deletion on request:** `GET /api/me/export` and `POST /api/me/erase` exist behind the `DATA_RIGHTS` flag, off until counsel signs off [repo]. Guild-level deletion has no command today.
- **GDPR roles (uncertain, for counsel):** a guild admin chooses to add the bot and so plausibly acts as controller for its members' sign-up data, with us as processor; for our own accounts and login we are a controller. This split is unreviewed. A processor agreement and a subprocessor list (`docs/subprocessors.md`) would be needed. Contact address in `docs/privacy.md` is still "(contact to be added)".

## 5. Guild onboarding with `/setup`

What a new server owner experiences, from `infrastructure/worker/setup-command.js` [repo]:

1. Someone adds the app to the server (the invite step is not in this file).
2. A member with Manage Server or Administrator runs `/setup` (command is hidden from others and DM-blocked, `setup-command.js:15-24`).
3. Optionally picks an announcement channel and an opt-in role.
4. The Worker creates a tenant named `Guild <id>`, records the caller as `owner`, saves the two settings, writes an audit row, and replies privately with a link to the board (`:99-123`).
5. Re-running updates settings; later callers become `admin`.

Gaps found:

- **G1.** Whoever runs `/setup` first becomes `owner`, which need not be the real server owner. Ownership is not tied to Discord's guild owner.
- **G2.** No cap on tenants. Any server that installs the app creates D1 rows, so abuse or a viral spike can burn the free-plan quotas in section 6.
- **G3.** The tenant name is a placeholder (`Guild <id>`); no rename.
- **G4.** The reply links to the single global board URL, not a per-guild one (`:93`).
- **G5.** No check that the app can post in the chosen channel or manage the chosen role.
- **G6.** No terms or privacy acceptance, no explanation of what is stored, no first-value step (sign-up form, first event).
- **G7.** No uninstall handling or guild-delete command in this file; whether the 30-day purge exists is unverified.
- **G8.** Flag `SETUP_COMMAND` is off by default (`:26-28`), and `suspended` servers get a dead-end message.
- **G9.** The opt-in role is saved but nothing here consumes it (unverified elsewhere).

## 6. Pricing, packaging and the free-plan capacity

**Cloudflare limits (accessed 2026-11-02):** Workers Free is 100,000 requests/day, 10 ms CPU, 50 subrequests [snippet: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)]. D1 Free is 5 million rows read/day, 100,000 rows written/day, 5 GB storage account-wide [snippet: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)]. Paid is 5 USD/month [snippet, same page]. A blog claiming 30 ms CPU conflicts with the docs; use 10 ms. The Free plan forbids card collection on a free property [repo, monetization note].

**Assumptions (mine, not measured):** an active guild generates 300 Worker requests/day, 150 D1 rows written/day (counting index rows) and 5,000 rows read/day, and stores 2 MB.

| Limit | Arithmetic | Guilds |
| :-- | :-- | :-- |
| Requests | 100,000 / 300 | 333 |
| Rows written | 100,000 / 150 | 666 |
| Rows read | 5,000,000 / 5,000 | 1,000 |
| Storage | 5 GB (5,000 MB) / 2 MB | 2,500 |

Requests bind first. With a 50 percent safety margin for spikes and the existing friends' tenant sharing the same account, **plan on about 150 active guilds on the free plan.** Measure real per-guild numbers before trusting this. At the next step (Workers Paid, 5 USD/month) the guild ceiling rises sharply [snippet].

Note: 150 exceeds the 75 to 100 server verification threshold in section 1, so verification (owner identity, policies live) must be done before the free plan is the ceiling.

**Packaging, consistent with the monetization note [repo]:**

- Free forever: one guild, one party, the whole sign-up and first-run flow, per guild not per seat. Never paywall before first value.
- Paid by guild capacity, roughly 4, 12 and 24 USD/month (speculative): several raid groups, recurring events, long history, export, branding, the assistant answering from guild rules. Competitors charge 3.99 to 12.99 per server (section 2).
- Never charged: anything touching Blizzard data. Paid features use only data members typed or Discord supplies. Battle.net sign-in stays optional, off, and free.

## Risk register

| # | Risk | Likelihood / impact | Mitigation |
| :-- | :-- | :-- | :-- |
| R1 | Every source here is unread primary text | High / high | Action 1 |
| R2 | Blizzard reads "premium" broadly, or objects to the product | Medium / high | No API use in paid path; written inquiry |
| R3 | Free-plan quota burned by unbounded tenants (G2) | Medium / high | Tenant cap, rate limit, paid fallback |
| R4 | Ownership hijack via first `/setup` (G1) | Medium / medium | Tie owner to guild owner |
| R5 | GDPR roles and retention unenforced | Medium / high | Counsel review, enforce purge |
| R6 | Verification slips and blocks growth at 100 servers | Medium / medium | Start at about 50 servers |

## Five next actions

1. Allow the Discord, Cloudflare, Blizzard and competitor hosts in the session network settings (or open the pages by hand) and re-verify every **[snippet]** and **[secondary]** item.
2. Send the drafted Blizzard inquiry and have counsel read the real API terms.
3. Fix G1, G2 and G4 in the Worker (separate PR from the Worker builders).
4. Measure real requests, rows and storage per guild for a week, then replace the section 6 assumptions.
5. Counsel review of `docs/privacy.md`, `docs/terms.md` and the controller/processor split; publish a contact; enable `DATA_RIGHTS`.
