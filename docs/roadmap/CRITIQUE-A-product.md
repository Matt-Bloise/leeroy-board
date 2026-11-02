# CRITIQUE A (product, UX, community, market): adversarial review of SYNTHESIS.md, 2026-11-02

Read: SYNTHESIS.md (687 lines), OWNER-VISION.md (incl. the night addendum), R1, R2, R4 notes (R3, R5 spot-checked for cited claims), six screenshots in `20261102-firstrun/shots/`, the public repo clone at `20261101-ci/lb` (`discord.js`), `notes/AUTO-SHIP-LOG.md`, `git branch -a`. Read-only; nothing in a repo changed.

Stance: biased against the plan. Severity: **blocker** = ships the plan and tonight repeats; **major** = a persona is lost or a wave is misordered; **minor** = cost, clarity or citation hygiene.

Ranking is by product damage, not by effort.

---

## 1. BLOCKER. The plan contains no item for the thing that failed tonight: votes, decisions and announcements captured in one place.

Evidence: `OWNER-VISION.md:26` "Members posted surname ideas in Discord because it is the natural place; the app did not capture them ... everyone gets the same information, votes on the same things, discusses the same things in the same interface." A grep of `SYNTHESIS.md` for `vote`, `poll`, `decide`, `decision`, `surname` returns zero Part 6 items; the only "decision" mentions are owner yes/no decisions (`SYNTHESIS.md:449, 487, 571`). Meanwhile the board already has a `decide` scene (`board/scenes/decide.js`, `board/data/decide.json`) and a "What to decide" ribbon tab (shot `desktop-1366x768-first.png`), and Discord polls were created and closed by hand (`notes/SESSION-HANDOFF.md:11, 97`: surname poll closed with 2 write-in votes and no name typed; ruleset poll 1 vote). The whole 74-item queue is about identity, ingestion of *builds*, tenancy and compliance. Build posts were not tonight's failure; decisions were.

Change: add Q-DEC (brief in finding 22) to **Wave 1**, before Q02. Rename Part 5c from "builds" to "builds and decisions": the same context-menu import, the same `proposed`/`confirmed` loop, the same poller, applied to Discord native polls (`GET /channels/{id}/polls/{message}/answers/{answer}` lists voters; poll results arrive on the message object) and to free-text ideas in a decisions thread. Note `/vote` is already in flight; the plan must say whether Q-DEC extends or replaces it, or two vote stores will exist by Friday.

## 2. BLOCKER. Notifications are designed as an opt-in role plus one announcement; the addendum says nobody was told anything. Opt-in cannot fix "nobody knew".

Evidence: `SYNTHESIS.md:41` "the lawful shape is an opt-in role plus a Server Guide question, plus ephemeral replies"; `:323-327` one announcement, once, mentioning only the opt-in role; `:281` the ping question is asked "once, after value". `OWNER-VISION.md:8` "Everyone in the server has a role or gets a notification"; `:26` "Nobody notified them: not Leeroy, not the board." R2 section 3 (`notes-R2-discord-platform.md:121-131`) confirms the DM ban and `allowed_mentions` but the opt-in-only pattern is R2's own *speculative* design (`:122`, `:131`). Nothing in the Developer Policy forbids a bot posting in a channel members already read, nor a role the server admin assigns to everyone by default. A 5-person friend server does not need an opt-in flow; it needs the bot to post in the channel they are already in, with the single concrete next step and a button.

Change: split notifications into two tiers in Part 5c. Tier 1 (ships in Wave 1, see Q-NTF, finding 22): every state change the app cares about (new decision open, decision closed, a build confirmed, next date set) posts **one** embed to the server's chosen channel with a `LAUNCH_ACTIVITY` button and a plain "what this means for you" line; silent flag (`SUPPRESS_NOTIFICATIONS`, R2 `:121`) for low-value updates, a role mention for the few that matter. Tier 2 (Wave 6, current Q43) is the opt-in role for guilds over ~25 where @role spam becomes a problem. Default the opt-in role to "everyone in the server" for tenants under 25 members. Delete the sentence at `:281`: a friend group should not be asked "Want a ping?" after value; the officer decides at `/setup`.

## 3. BLOCKER. Q02 duplicates work already in flight and will collide with it.

Evidence: brief from the executor: in flight now are "first-run purpose screen, /vote, /start plus announce route, visual quality audit". `git branch -a` shows `origin/claude/first-run-ver` and `origin/claude/visual-census`; `notes/AUTO-SHIP-LOG.md:585, 590` show `claude/first-run-ver` HELD twice on a red gate. `SYNTHESIS.md:443-444` Q02 rewrites `js/next.js` and `css/next.css` with a new heading, button and link, feature flag `firstrun.v2`; `:475-476` Q12 touches `js/shell.js` and `css/shell.css`; `:504-505` Q21 touches `css/fit.css` and `css/wide.css`. These are exactly the files a first-run purpose screen and a visual audit touch. The plan's own rule (`:434`) says "items in one wave touch disjoint files", but it never lists the in-flight branches as occupants.

Change: Part 6 opens with a table of in-flight branches and their files. Q02 becomes "review and finish `claude/first-run-ver` against the R4 3.4 acceptance tests" (why it is red twice: `guided-atlas.mjs: did not finish: no summary line`), not a fresh PR. Q12 and Q21 wait for `visual-census` to land or are assigned to that builder. Q08 (portrait lock) can stay parallel: it touches `js/brain.js` only.

## 4. BLOCKER. The "after" screenshots show the portrait fix changed nothing a user can see; the plan does not notice.

Evidence: `phone-390x844-first.png` and `phone-390x844-after44.png` are visually identical (369,052 vs 369,059 bytes; same gate, same stray teal square over "Next steps", same six names). `desktop-portrait-1080x1920-after44.png` still shows ten tall banners, "Pick your name", and empty parchment under the name grid; the only difference from `-first` is file size (2.64 MB to 1.50 MB, i.e. compression). `SYNTHESIS.md:18-21` describes only the `-first` shots and never mentions `-after44`. Q21's done-when (`:505`) is "content fills at least 60 percent of the height", which the after shot fails.

Change: add to Part 4 an oracle rule: "a layout PR is not done until a before/after pair at all three viewports is attached and a second agent names the visible difference". Add `tests/browser/` pixel-diff gating (Q62) to Wave 1, not Wave 8: without it, "after" shots that equal "before" keep merging. Pull Q62 forward and merge it with Q21's test.

## 5. MAJOR. Persona (a) still cannot reach value in 4 weeks because the fast path (modal) is Wave 3 and the import path is Wave 4, while `/build` today hard-codes five names.

Evidence: `20261101-ci/lb/infrastructure/worker/discord.js:221-237`: `/build` is "Link to someone's build thread in the party" with `choices` of exactly five names (Bloise, Street Rat, Handsome Squidward, Bible Boi, Santa). a late joiner cannot be the subject of the command, let alone the author. `SYNTHESIS.md:330` admits "The only path is the brain reading his post from the inbox and editing `kv_state` by hand." `:331` promises a late joiner's end-to-end loop "in 4 weeks (after Part 6 waves 1-5)". Q19 (modal) is Wave 3 with Deps Q09 (schema, Wave 2, the architect review); Q27 (import) is Wave 4 with Deps Q19 and Q20; Q28 ("Is this you") is Wave 4 with Deps Q18 (web OAuth, risk 9).

A 5-person beta cannot wait four weeks for the sixth person. The schema is not the bottleneck; the hand-edit is.

Change: add Q-SIXTH (finding 22) to Wave 1: a 1-hour change that lets `/build` accept any member (drop the `choices`, use `user.id` from the interaction, write to the existing `kv_state.discord_members` through the existing admin PUT route), plus the brain adds a late joiner today. Reorder: Q19 moves to Wave 2 (it does not need the full 0002 migration; it needs a `builds` table, which can be migration 0002a alone). Q28 loses the Q18 dependency when opened from the Activity (identity from SDK, Q26) and gets split: Q28a (Activity, Wave 3) and Q28b (web, Wave 4).

## 6. MAJOR. "Everyone gets the same information" is contradicted by the plan's own per-person next-step card and per-journey depth.

Evidence: `OWNER-VISION.md:26` "everyone gets the same information, votes on the same things, discusses the same things in the same interface (parent or not, it does not matter)". `SYNTHESIS.md:278` "one card 'Your next step': the single highest-value action for him"; `:280` depth setting ("Keep it simple" / "Show me everything") survives; `:110` journeys survive as a setting; current shot: "Each of the five has their own next step" (`phone-390x844-first.png`). Personalised next steps are what produced five different understandings tonight. The group's shared state (what is being decided, when, what was decided, what is next for the party) is the first screen's job; the personal card is second.

Change: Part 5b shared first screen gets a **group** card above the personal card: "Your group right now: 2 open decisions (surname, ruleset), next date Wed 6 PM ET, 5 of 6 builds in." Same card for every member, parent or not. The personal card follows. Journeys: delete the depth setting from the plan entirely for the beta (one audience, one depth); re-add when a second tenant exists. The Oct 28 journeys decision is reversed in full, not "for the first screen only" (`:110`).

## 7. MAJOR. Persona (c), the officer, cannot pilot at all under the plan's own evidence, yet the roster items are built anyway.

Evidence: `SYNTHESIS.md:51` "Unverified Activities are team-and-tester only and ... launchable only in servers under 25 members ... A 40-player guild cannot pilot without verification"; `notes-R2-discord-platform.md:56` (likely). Verification (Q68) is Wave 9 and depends on Q04, Q07, Q14, Q55. The officer scene Q38 is Wave 5, Q71 raid composition Wave 9, Q54 multi-party Wave 7. These produce code no officer can open for two months, while the oracle for Q38 is "two outside officers in a think-aloud" (`:559`) who cannot launch an unverified Activity in their own server.

Change: either (a) move Q38, Q54, Q71 to a "post-verification" wave 10 and say so, or (b) make the officer surface **web-first** (the website works for any server size; the Activity cap does not apply) and put Q55 (landing) and Q18 (web login) ahead of them. (b) is correct and also matches OXM.GG (R4 1.2: sign in with Discord, connect server, see roster on the web). State in Part 5b that the officer persona is web, the member persona is Activity. Pull Q68 verification prerequisites (Q04, Q07, Q14) into Wave 1 since they are risk 0 and the critical path for every multi-guild item.

## 8. MAJOR. Persona (b), the stranger, is served a sample guild but no reason to install, and the "Just take a look" link steals the only competing click from the primary button.

Evidence: `SYNTHESIS.md:284-285`: sample guild with "Make this for my guild". R4 3.4 acceptance: 80 percent first-click on the primary button (`notes-R4-market-ux.md:164`). Two calls to action on a five-second screen split clicks; R4's own first-click benchmark will fail by design. Also the sample guild (Q13, Wave 2) is built before any stranger can reach the site (`robots.txt` `Disallow: /`, `index.html` `noindex`, `:151`; landing is Q55, Wave 7).

Change: on the Activity variant, drop "Just take a look" (members are already in the group; the sample is meaningless to them). Keep it only on the web landing (Q55). Move Q13 to the same wave as Q55 (Wave 7) or move both to Wave 3. For the beta, the stranger persona is not a priority; the plan should say "stranger: Wave 7, not before" instead of spending Wave 2 on sample data.

## 9. MAJOR. Persona (d), multi-account, is modelled as a schema (humans, identities) but never as the user's question, which is "which of my characters is in this party tonight".

Evidence: `SYNTHESIS.md:296-300`: "Which character is this for?", a switcher, "Link another Discord account". `OWNER-VISION.md:11` "WoW Forever players have two, three, four accounts". R1 1.4 (`notes-R1-wow-ecosystem.md:36`): up to 8 WoW licenses per Battle.net account; multi-account players typically run several characters **in the same group** (multiboxing is tolerated with separate input, `:35`). The schema (`:366-367`) has `signups PRIMARY KEY(group_id, user_id)` and `:371` "one user holds at most one slot per group". A multiboxer bringing two characters to a 10-man cannot sign up twice. The model fights the persona it is named for.

Change: `signups` key becomes `(group_id, character_id)`; "one slot per user" becomes a per-tenant setting (`tenant_config.settings_json.one_slot_per_user`, default true, officer can turn off). Q37's switcher gets "Bring another character to this group". Q29 brief updated.

## 10. MAJOR. The plan never asks members for ruleset and faction before the build, though its own analyst says they decide who can play together.

Evidence: `SYNTHESIS.md:59` "the newcomer flow must ask ruleset and faction early because they decide who can play with whom" (R1 1.2 confirmed, `notes-R1-wow-ecosystem.md:20-21`). Yet in 5b persona (a) step 3 the card *tells* him "Yours: PvP, Horde, same as the five" (`:278`), which presumes the build post said so; the Q19 modal lists ruleset among several selects (`:499`) with no requirement; Q20's parser leaves low-confidence fields null (`:502`). A build post of "Undead mage, herb/alch" has no ruleset. Tonight's ruleset poll had 1 vote (`SESSION-HANDOFF.md:97`): the party itself has not settled it.

Change: ruleset and faction are a **group** decision first (finding 1, Q-DEC) and a per-character confirmation second. Q19: ruleset and faction selects `required: true`, prefilled from the group's decision when it exists. Q36 next-step rule 1: "your group has not chosen a ruleset yet, vote here" outranks every personal step.

## 11. MAJOR. Wave ordering puts 13 compliance, legal and ops documents (risk 0) ahead of any item a member touches; for a 5-person beta that is inverted.

Evidence: Waves 1-3 contain Q03, Q04, Q05, Q07, Q14, Q16, Q23, Q24, Q25 (docs, letters, accounts, runbooks) and Q15, Q22, Q10 (CI). Member-visible items in those waves: Q02 (duplicate of in-flight), Q12, Q13, Q21. Nothing a member *does* lands until Q19 (Wave 3). `OWNER-VISION.md:10` "First priority: maximise ONE build in ONE guild in ONE party scenario". The plan says the same at `:34` then spends three waves on the product's future, not the party's week.

Change: regroup Part 6 into two parallel tracks with separate numbering: Track P (party, member-visible, each item with a Discord-side oracle: "a friend did X without the brain's help") and Track F (foundations). Each wave carries at most 3 Track F items. Q05 ADR, Q07, Q14, Q23, Q24, Q25, Q40, Q47, Q49 move to Track F waves 3+. Q03 (spike) and Q04 (team) stay in Wave 1 (both unblock Track P).

## 12. MAJOR. The plan is over-engineered for the beta in four places and the evidence it cites says so.

Evidence:
- Tenancy DO per tenant (Q53, risk 9) and the two-tenant isolation test (Q70) exist for a product with one tenant. `SYNTHESIS.md:10` confirms one global DO today; nothing in Waves 1-6 needs a second tenant.
- Humans grouping with a two-OAuth-in-ten-minutes proof (Q66, `:639`; R3 1.3 `:47`): no persona in 5b needs it before Battle.net (Q51) exists.
- Linked Roles (Q60) is marked optional and R2 says "pull-only ... not a broadcast mechanism" (`notes-R2-discord-platform.md:253`); it answers nothing in the vision.
- Entitlements and webhook events (Q67, risk 9) before any pricing decision, trademark or entity (Q42 is "yes before first paid sale; not needed for the free one-guild product", `:572`).

Change: move Q53, Q66, Q60, Q67, Q70 into a Wave 10 "second tenant" gate: "start when a second server has run `/setup`". Keep Q45 (server-side membership) because it protects the first tenant.

## 13. MAJOR. Under-engineered for the product in the one place competitors are strongest: nothing in the plan lets a group **schedule**.

Evidence: R4 1.1-1.2: every competitor's core is an event with RSVP (Raid-Helper, Apollo, Sesh), Guild Order "Raid Signup", OXM.GG scheduling and absence calendar (`notes-R4-market-ux.md:25-37`). The plan's `groups` table has `starts_at, tz, recurrence` (`:363-364`) but no Q item creates a group from Discord, no reminder, no Discord Scheduled Event (R2 2.1 option e: 100 per guild, `GET .../scheduled-events/{id}/users` lists RSVPs, `notes-R2-discord-platform.md:94`). Q52 `/rsvp` (Wave 7) signs up to a group that nothing creates. Tonight's "next steps and party things" confusion is in part a scheduling void: no one could see when the party plays.

Change: add Q-EVT (finding 22) in Wave 2: `/plan` or `/tonight` creates a `groups` row **and** a Discord Scheduled Event; the Scheduled Event is the source of truth for the date and the native "Interested" list is read as a signup. This reuses Discord's own notification (members get Discord's event reminder for free, no opt-in role needed), which also answers finding 2 for dates.

## 14. MAJOR. The pricing section has no price, no free-tier boundary a builder can code, and contradicts the wedge.

Evidence: `SYNTHESIS.md:387` "the whole one-guild, one-party case" is free; `:390` paid is "more than one raid group, recurring events, history ... beyond a season, the assistant answering with the guild's own rules, roster export, custom branding", "about 4 / 12 / 24 USD". But: (a) "the assistant answering with the guild's own rules" is named at `:33` as "the defensible edge" and the thing a newcomer needs most; paywalling the edge contradicts `:391` "never a paywall before first value". (b) R4 1.5 (`:66`) says the strongest paid outcome is "a guild's whole Forever onboarding in one place", which the plan gives away. (c) Guild Order's ladder is by **member count** with every plugin on every plan (`:37`); the plan copies the prices but not the axis. (d) "history beyond a season" is unenforceable until Q41 retention exists; "custom branding" is a feature nobody has asked for. (e) R2 1.6: `startPurchase` is web and desktop only (`:69`), so the Activity-only member persona cannot buy; the plan mentions this at `:94` and then sells "inside Discord" at `:390`.

Change: write the packaging as a table a builder can turn into `requirePlan`: Free = 1 guild, up to 25 members (the unverified-Activity cap, R2 1.5), unlimited parties of 5, 1 raid group, the assistant with library facts; Guild (9 USD, one price, no ladder until a second tenant) = member cap removed, many raid groups, assistant answering with the guild's rules, history. Purchase on the web landing only, state it. Delete branding and export from the paid list. Put a line in Part 7: "pricing is a hypothesis until PR-REVIEW 1.15's ten officer interviews (not in the queue: add as Q-INT, finding 22)".

## 15. MAJOR. The product sentence is for a guild; the beta is a party of five friends plus one, and the sentence does not say what to press.

Evidence: `SYNTHESIS.md:260` "Your guild's companion for World of Warcraft: Forever, inside the Discord you already use ... from the first dungeon night to a 40-player raid." R4 0.1: competitors state the **job** in one line ("loot tracker", "raid sign-ups", `notes-R4-market-ux.md:11`). "Companion" is not a job. R4 3.1 draft was "cheat sheet" (`:122`), which the synthesis replaced without saying why. The five-second oracle (Q64, Wave 8) is six waves after the sentence ships.

Change: run Q64 in Wave 1 on three candidate sentences as a paper test (Lyssna free, 15 responses each, `:187`), before Q02 ships copy. Candidates must name a job: "Your party's plan for WoW Forever: who is playing what, what we decided, when we play." Record the test in `docs/research/`.

## 16. MAJOR. Discord is treated as the input and the app as the output; the addendum says the opposite is also true (discussion stays in Discord) and the plan has no "app writes back to Discord" item except build confirmation.

Evidence: `OWNER-VISION.md:26` "discusses the same things in the same interface". `SYNTHESIS.md:310-311` the only bot writes are Confirm/Fix replies and the one-time announcement. No item posts a decision's outcome, a roster change, a new next step or a date back to the channel; no item creates a thread for a decision so the discussion has a home the poller can read. The Discord Activity is where members act; the text channel is where they talk; the plan links them in one direction.

Change: Q-DEC and Q-NTF (finding 22) define the write-back contract: every app-side state change has exactly one Discord artefact (message id stored on the row), edited in place rather than re-posted, and every Discord artefact links back with a `LAUNCH_ACTIVITY` button. Add to Part 5c a "mirror table": `app object -> Discord object -> who edits -> idempotency key`.

## 17. MINOR. The "Is this you?" step is a screen that Discord's own patterns say to skip.

Evidence: `SYNTHESIS.md:277` "Hi {display name}. Is this you?" with Yes / Not me. R4 1.4 (`:59`): successful Activities "do not ask who the user is, because Discord already knows"; R2 1.2 identity comes from `authorize` (`:31-32`). In an Activity, "Not me" has no valid meaning (the user cannot be someone else). It is a step added to protect against a web-side shared-browser case, imposed on everyone.

Change: Activity variant: no step 2; land on the group card with "Hi {name}" in the header. Web variant only: keep "Not me" as a link in the header ("Not {name}? Sign out"). Q28 brief updated.

## 18. MINOR. The late-joiner path is named as "first" (`:42`) and then not built.

Evidence: `SYNTHESIS.md:42` "Build the late-joiner path first ... a late joiner is the late joiner"; `:302` "late joiners land on the same screen as everyone else". No Q item handles a member who joins the server after `/setup` and after the one announcement (`:324` "One announcement, once"). Discord's Server Guide question (`:325`, likely) is community-server-only (`notes-R2-discord-platform.md:124`: "Community servers only ... at least 7 default channels, 5 of which let @everyone send"). A 5-person friend server is almost certainly not a Community server, so the Server Guide path does not exist for the beta.

Change: add a `GUILD_MEMBER_ADD`-free welcome: the pinned starter message in the builds forum (`:327`) is the late-joiner path; `/setup` pins it; Q-NTF posts a "welcome, here is the one thing to do" embed when a `builds` row is first created for a user. State in Part 5c that Server Guide is a Community-server feature and is not the beta path.

## 19. MINOR. Twelve named roles and three personas, but no role for the one person doing all the work today: the brain.

Evidence: `SYNTHESIS.md:330` "the brain reading his post from the inbox and editing `kv_state` by hand"; `:422` "Stop hand-editing `kv_state`". The admin console is Q58 (Wave 8) and the admin scene Q61. Until then the brain stays the admin, with `wrangler d1 execute` (`:153`). Every "Oracle: a second agent reads D1" in Waves 2-7 depends on the same path.

Change: a tiny Q-ADM0 in Wave 1: a read-only `/api/admin/rows?table=` route behind the existing admin token for the tables the oracles need, plus an "add member by Discord id" admin PUT. It costs an hour and removes the hand-edit the plan calls a stop item.

## 20. MINOR. The plan's own numbers say the free guest ask budget is 54 asks per day and then it adds a parser (Q20) and a poller (Q34) on the same Workers AI neurons without budgeting them.

Evidence: `SYNTHESIS.md:157` "one ask costs about 148 neurons against an 8,000-neuron soft cap ... about 54 asks per day across all guests"; Q20 (`:502`) and Q34 (`:547`) call Workers AI per build post with no cap stated; Q30 caps `ask_turns` only (`:534`). A 40-member guild posting builds in one evening consumes the day's neurons and the assistant goes silent for everyone.

Change: Q20 gets a per-tenant daily parse cap and a "parse later" queue; Q30 counts parses against the tenant cap. Part 7 adds U17: measured neuron cost of one parse.

## 21. MINOR. Citation and support problems in SYNTHESIS.md.

- `:101` "Lyssna's free plan allows 15 self-recruited responses (R4 4.1-4.2, confirmed for the plan page, likely for the method)". R4 `:177` says whether the free plan includes five-second tests "is not stated on the pricing page" and R4 open question 7 (`:208`) repeats it. The plan's Q64 oracle may not exist on the free plan. Label: not confirmed; verify before Q64.
- `:35` "Price ceiling for pure scheduling is about 7-8 USD per server per month (Apollo, Sesh, R4 1.1)". R4 `:26` labels Apollo's 7.99 confirmed and R2 `:194` lists Apollo at 8/mo; fine. But `:35` also says "Guild Order ladders 3.99 / 11.99 / 23.99 by capacity" then `:390` rounds to "4 / 12 / 24" and sells by features, not capacity. Inconsistent with the cited source (R4 `:37`: "plans differ only by capacity").
- `:60` "Raids open Dec 9 at fixed 10 / 20 / 40, no flex (R1 1.5, confirmed and likely)". R1 `:41-42`: Dec 9 and sizes confirmed; "no flex" is likely (Kotaku interview). The schema CHECK `size_max IN (5,10,20,40)` (`:363`) hard-codes a likely claim the plan elsewhere says not to hard-code (`:63` "design for many and do not hard-code"). R1 `:16` also says spring 2027 adds a new 10 and 20; fine, but a future 25 or 15 would need a migration. Make it a `tenant_config` list, not a CHECK.
- `:145` "The countdown is wrong for anyone outside ET today" is correct per R1 `:11` (launch 3 PM PST Americas, 23:00 UTC), but the shots say "6 PM ET" and the project CLAUDE.md says the same; nobody in the beta is outside ET. Minor, but the plan calls it a stop item (`:423`) while the Activity has no region concept until Q51. Downgrade to "show the viewer's local time", one line of JS.
- `:19` describes `desktop-1366x768-first.png` as having "a lantern button"; the shot shows a small torch icon, fine. But `:18` says "the three screenshots" while six exist; the `-after44` set is unexamined (finding 4).
- `:51` cites R2 1.5 "likely" for the 25-member cap and then `:51` and 5b treat it as a hard constraint while Q38/Q71 ignore it (finding 7). Pick one.
- `:402` "convert the application to a Developer Team owned by the owner ... reversible". R2 does not say team transfer is reversible; Discord's portal does not allow transferring an app from a team back to a user in my experience, and R2 `:66` only states teams are required. Label speculative and check before clicking.
- `:324` the announcement copy "/board privacy shows what we hold about you; /board forget deletes it" promises commands that Q59 (Wave 8) explicitly defers "in a later wave" (`:621`). The announcement would lie for two months. Remove the sentence from the announcement until the commands exist, or move the two subcommands into Q46.

## 22. Missing items as builder briefs

**Q-DEC Decisions: open, vote, close, in both places.** Risk 7. Wave 1. Files: `infrastructure/worker/discord.js` (one new `/decide` command: `open <question> <options...>`, `close`, `list`), `infrastructure/migrations/0002a_decisions.sql` (`decisions(id, tenant_id, question, options_json, status, discord_message_id, discord_channel_id, opened_by, closes_at, result_json)`, `decision_votes(decision_id, user_id, option, at)`), `board/scenes/decide.js` (reads `/api/decisions`, votes by button, shows the same tally as Discord), `index.js` routes `GET /api/decisions`, `POST /api/decisions/:id/vote`. Opening a decision creates a Discord native poll in the chosen channel and stores the message id; votes from the board are written to D1; the 15-minute poller (or `/decide sync` until Q34) reads the poll's answers endpoint and merges by `user_id`, so a vote cast in Discord shows on the board and vice versa; closing posts the result as an edit of the poll message plus one line "Decided: X" with a `LAUNCH_ACTIVITY` button. Free-text ideas (surname suggestions) are a `decision` with `options_json` empty; the board offers "Add an option" that writes back as a Discord reply. Done when: a member votes in Discord and the board shows it within 15 minutes; a member votes on the board and the Discord tally shows it; the surname and ruleset decisions from tonight are re-opened through it. Test: fixture test for `/decide open` and the vote button; unit test for the merge (same user, two places, one vote). Oracle: a friend other than the owner votes once in Discord and once on the board and the counts agree, screenshot both. Must be reconciled with the in-flight `/vote` branch before the builder starts: the brief names which one survives.

**Q-NTF Group feed: one channel post per state change, edited in place.** Risk 7. Wave 1. Files: `infrastructure/worker/notify.js` (`announce(tenantId, kind, payload)` -> post or edit; `allowed_mentions` explicit; `SUPPRESS_NOTIFICATIONS` for `kind in ('build_confirmed','roster_changed')`, role mention for `decision_open`, `decision_closed`, `date_set`), `tenant_config.feed_channel_id`, `feed_posts(tenant_id, kind, ref_id, message_id)` for idempotency; callers in `/decide`, `/plan`, build confirm. Every post ends with the same two lines: "What this means for you: ..." and a `LAUNCH_ACTIVITY` button. Done when: tonight's three events (decision opened, decision closed, next date) each produce exactly one message visible to everyone in the channel without opting in. Test: fixture test asserting one message id per `(kind, ref_id)` after two calls. Oracle: a friend reads the channel cold and restates the next step correctly (R4 five-second variant). Risk: mention fatigue in large servers; mitigated by the kind table and the Q43 opt-in role later.

**Q-SIXTH Any member, today.** Risk 5. Wave 1, first. Files: `discord.js:221-237` (drop `choices`; `who` becomes optional `type 6` user option, default the invoker), the `/build` handler at `:1010` (resolve by `user.id`, fall back to display name only for the five), admin PUT for `kv_state.discord_members` to add `{id, display}`. Done when: a late joiner runs `/build` and `/sheet` and gets his own result with no brain edit. Test: fixture with a non-five user id. Oracle: a late joiner, in Discord, without being told how.

**Q-EVT Dates as Discord Scheduled Events.** Risk 7. Wave 2. Files: `discord.js` (`/plan set <when> <what>` creates `groups` row and `POST /guilds/{id}/scheduled-events`; stores `discord_event_id`), `ingest.js` or `/plan sync` reads `GET .../scheduled-events/{id}/users` as `signups intent 'yes'`, `board/scenes/*` "next date" reads from `groups`. Done when: the next party night exists as a Discord event, shows on the board, and Discord's own reminder fires. Test: fixture for create and sync. Oracle: a friend presses "Interested" in Discord and appears on the board roster. Risk: Scheduled Events need `MANAGE_EVENTS` on the bot; state it in `/setup`.

**Q-INT Ten officer interviews before pricing.** Risk 0. Wave 3. Files: `docs/research/officer-interviews.md` (script: current tools, what they pay, what breaks on raid night, what they would pay 9 USD for). Done when: ten officers not known to the owner or the architect are interviewed (recruit in WoW Forever Discords and the Blizzard forums). Oracle: the transcripts; Q67 and the pricing table depend on it.

**Q-ADM0 Read-only admin rows and add-member.** Risk 5. Wave 1. See finding 19.

**Q-CMD Command surface cut.** Risk 5. Wave 2. Evidence: `SYNTHESIS.md:13` lists 22 member commands plus 3 admin; a newcomer typing `/` sees 25 entries and no order. Files: `discord.js` registration: keep `start` (in flight), `build`, `decide`, `plan`, `rsvp`, `sheet`, `ask`, `help`; fold `countdown`, `dates`, `launch`, `tonight` into `plan`; fold `library`, `sources`, `tooltip`, `didyouknow`, `quiz`, `map`, `meet`, `pack`, `journey`, `state` under `ask` or a single `library` command with subcommands. Done when: `/` shows at most 9 top-level commands. Oracle: a friend finds the vote and the plan from the `/` list without help.

## 23. MINOR. Queue items to merge or delete.

- Q25 and Q31 (OpenAPI twice): merge; one item in Wave 4 after the routes exist.
- Q05 ADR and Q09 migration: Q09's brief already restates the schema; the ADR can be the PR description. Delete Q05 or make it the Q09 PR body.
- Q07, Q14, Q40 (privacy, terms, DPA, breach): one item "legal drafts", one PR, Wave 3. Counsel reads them together (Q42).
- Q22 (axe) and Q49 (a11y statement and ARIA decision) and Q50 (screen reader): one lane, Wave 4.
- Q32 and Q63 (monitor, status page): merge.
- Q62 (visual baselines) moves into Q21 (finding 4).
- Q60 Linked Roles: delete until a second tenant asks for it.
- Q17 (image pipeline) and Q39 (Lighthouse): Q39 first (measure), then Q17 (fix) only if the budget fails. The plan does them in the opposite order.

## 24. MINOR. The acceptance tests cite a benchmark the research marks as weak.

Evidence: `SYNTHESIS.md:104` "80 percent first-click" as spec. R4 `:178`: the 87 vs 46 percent figure is "Bob Bailey study as cited by vendors; 2006, old", labelled likely. R4 `:131` "first-click benchmark commonly cited; likely, vendor sources". Setting a pass bar on a vendor-cited 2006 number is fine as a direction, not as a gate that blocks merges.

Change: keep 80 percent as the target, make the gate "majority first-click on the primary button and zero clicks on the name grid", which is what tonight's failure needs.

## 25. MINOR. "What this plan does not do" (`:685`) says "no tutorial" and "no feature that asks a newcomer to type"; Q19's modal asks a newcomer to type notes up to 1000 chars and select five fields.

Evidence: `SYNTHESIS.md:499` Text Input notes, five selects; `:112` WCAG 3.3.7 Redundant Entry; the vision says members already posted builds in threads (`OWNER-VISION.md:9`). For the five plus a late joiner, the modal is a second entry of what the thread already holds.

Change: the modal is the path for people who have **not** posted; the import (Q27) is the path for those who have; the pinned forum message offers both and says which to use. Q19's modal shrinks to three required selects (class, ruleset, faction) plus optional notes; race, role and professions are inferred or asked later on the sheet.

---

## Reply (under 200 words)

The plan is a competent product-foundation programme and a poor answer to tonight. Its 74 items contain no decision, vote or announcement item, although votes-in-Discord-not-in-app and nobody-notified are the two failures in the addendum; the board already has a `decide` scene nothing feeds. Notifications are designed as opt-in, which cannot fix "nobody knew" in a six-person server, and the Server Guide path it relies on is Community-server only. Q02, Q12 and Q21 duplicate in-flight branches (`first-run-ver`, `visual-census`) on the same files, and the "after" screenshots are visually identical to "before", which the plan did not check. a late joiner's loop is promised in four weeks while `/build` hard-codes five names today; a one-hour fix exists. The officer persona cannot launch an unverified Activity at all, so roster items should be web-first and verification prerequisites first. Over-built for the beta: per-tenant DO, humans grouping, Linked Roles, entitlements. Under-built for the product: no scheduling at all, though every competitor's core is an event with RSVP. Pricing names prices but no codeable free-tier line and paywalls the stated edge. Seven briefs supplied (Q-DEC, Q-NTF, Q-SIXTH, Q-EVT, Q-INT, Q-ADM0, Q-CMD); Q-DEC and Q-NTF must reconcile with the in-flight `/vote` and `/start` work before any builder starts.
