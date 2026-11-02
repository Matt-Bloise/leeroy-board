# R1: WoW Forever ecosystem, Blizzard APIs, data sources, group management

Access date for every source: 2026-11-02. Labels: confirmed = primary source (Blizzard, vendor docs) read directly; likely = consistent secondary sources or primary source read only via a summarizing fetch; speculative = single or weak source, or inference.

Method note: WebFetch returns a model-summarized page, not raw text. "confirmed" below means the primary source's page was fetched and the summary stated the fact. Blizzard's developer portal (community.developer.battle.net / develop.battle.net) is a JS shell and returned no documentation text; OAuth and namespace facts therefore rest on secondary sources, labelled accordingly.

## 1. WoW Forever: what it is

### 1.1 Product, access, release
- Forever is a Classic-style game covering levels 1-60 on the original continents, set between Warcraft III Reforged: Forsaken Kingdom and Molten Core, with 1,000+ new quests, new zones (Mount Hyjal, Shen'dralas, Riverglades, Zephras Isle), nine new 5-player dungeons (levels 13-60), a new race (Skyborne) and six new race/class combinations. Source: https://news.blizzard.com/en-us/article/24315820/world-of-warcraft-forever-goes-live-globally-november-4 . confirmed.
- Launch: 2026-11-04 3:00 p.m. PST in the Americas (23:00 UTC), UK 11 p.m. GMT on Nov 4, Europe 12:00 a.m. CET on Nov 5, Korea/Taiwan/ANZ morning of Nov 5. Same Blizzard page. confirmed.
- Subscription model: access is included with a WoW Subscription or Game Time; no separate purchase needed. Optional upgrades (Skyborne Heroic Pack, Skyborne Epic Pack, Warcraft Forever Collection) add cosmetics, the Skyborne race, early name reservation, beta access (Epic and up). Epic/Collection add 30 days of Game Time from Nov 4. Source: https://worldofwarcraft.blizzard.com/en-us/news/24301508/pre-purchase-world-of-warcraft-forever-upgrades-and-begin-your-next-journey-in-azeroth . confirmed.
- Invite-A-Friend codes allow play Nov 4-11 without subscription. Same source. confirmed.
- Beta ran 2026-09-17 to 2026-10-21; Blizzard wiped beta characters, names and guilds before name reservation. Beta dates: Blizzard pre-purchase post (confirmed). Wipe: forum thread https://us.forums.blizzard.com/en/wow/t/character-limit-in-forever/2350760 and secondary summaries (likely).
- Early Name Reservation: Oct 27 to Nov 3, up to 3 characters in total across all rulesets, first come first served, only during that window. Source: https://news.blizzard.com/en-us/article/24303866/claim-your-world-of-warcraft-forever-character-names . confirmed. Subscription not needed to reserve (secondary, likely): https://eu.forums.blizzard.com/en/wow/t/storefront-oversight-gm-confirms-sub-needed-for-wow-forever-early-name-reservation-but-store-says-otherwise/632069 (the thread itself shows confusion).
- Roadmap: raids Dec 9 2026; Hardcore "sometime after launch" (after Dec 9); spring and summer 2027 updates with further raids (secondary: wowguide.net roadmap, not fetched directly; "Spring 2027: 1 new 10-player and 1 new 20-player raid" is likely, single-sourced). Blizzard roadmap post https://news.blizzard.com/en-us/article/24303862/world-of-warcraft-forever-whats-next-panel-recap says "more raids, dungeons, PvP, Hardcore, a revamped iconic raid" without dates. confirmed for the vague statement.

### 1.2 Account and world structure
- Forever is "realmless". Players pick a ruleset (Normal, PvP, Roleplay, Roleplay PvP, Hardcore later) instead of a realm; each ruleset is a large shared ecosystem per region. Character names are two parts and unique per region. Sources: https://news.blizzard.com/en-us/article/24315820/... and https://worldofwarcraft.blizzard.com/en-us/news/24302070/ . confirmed.
- Grouping, dungeons and raids only within the same ruleset ("Cross-ruleset grouping is not supported"). Horde and Alliance cannot group. Battlegrounds can mix rulesets except Hardcore. https://worldofwarcraft.blizzard.com/en-us/news/24302070/ . confirmed.
- PvP ruleset: one faction per account on that ruleset. Normal, Roleplay, Hardcore allow both. Same source. confirmed.
- No free transfers between rulesets; new character required. A dead Hardcore character may transfer out. Same source. confirmed.
- Collections and Legacy Points are account-wide across rulesets (Hardcore asymmetry: Hardcore progress flows out, nothing flows in). Same source and https://news.blizzard.com/en-us/article/24307383/get-to-know-the-world-of-warcraft-forever-legacy-system . confirmed.
- Legacy System: account-wide on the Battle.net account across non-Hardcore characters; 65 Legacy Challenges; each character can spend up to 16 points at launch; points spent per character. Legacy post above. confirmed.
- Preferred online language is account-wide with a 24-hour change cooldown. Ruleset post. confirmed.
- Layering exists and is controversial (beta forum threads). Blizzard has not published specifics in the posts I read. Player threads: https://us.forums.blizzard.com/en/wow/t/layering-solved-for-all-time/2387144 . likely that layering exists; details speculative. Addon authors report GUIDs obfuscated since Oct 16 so addons cannot detect the layer (forevermeta.me, secondary, likely).

### 1.3 Characters per realm/account (UNSETTLED)
- No Blizzard-published launch cap found. Dev answer reported as "still open because of technical limits" (secondary, pewpewshop/other, speculative).
- Beta player reports: about 70 characters account-wide per game version, others recall 10-12 per play style or 50 total. Source: https://us.forums.blizzard.com/en/wow/t/character-limit-in-forever/2350760 (player posts only). speculative.
- Icy Veins claims 10 per realm and 50 per license; that page returned 403 and the claim is contradicted by the "no realms" structure. Via search snippet only. speculative.
- Per the same forum thread, the cap is per game version (Classic Era characters do not count). speculative (single poster).

### 1.4 Multiple WoW accounts, multiboxing
- Blizzard: input broadcasting/mirroring commands to multiple clients is actionable (warnings, then suspension/closure). https://worldofwarcraft.blizzard.com/en-gb/news/23558957/policy-update-for-input-broadcasting-software (dated Nov 3, 2020 per Wowpedia/Wowhead coverage). confirmed as a general WoW policy; no Forever-specific restatement found. Multiboxing with separate input per client is tolerated: https://www.wowhead.com/news/multiboxing-is-not-bannable-blizzard-clarifies-tos-measures-taken-to-prevent-318925 (headline only via search). likely.
- Up to 8 WoW licenses per Battle.net account; only one Battle.net login session at a time but multiple WoW licenses can run; region sharing of the cap unclear. Source: Blizzard forum threads, e.g. https://us.forums.blizzard.com/en/wow/t/can-you-have-more-than-2-accounts-on-one-battle-not-account/1565537 . likely (user-reported, no official support page found).
- Account sharing/selling forbidden (EULA). Via https://warcraftforever.games/guides/faq (fan site citing EULA). likely.
- Forever accounts: the game is bought and run on a Battle.net account. Regions: Americas, EU, Korea, Taiwan, ANZ listed in launch post. Whether a US-region and EU-region license of Forever cross-count toward 8 is unknown.

### 1.5 Group, raid, guild
- Raids unlock 2026-12-09: Barrow Deeps (10 players, 8 bosses, entrances at Mount Hyjal, Winterspring, Blackmaw Hold); Hyjal Summit (20 players, 13 bosses); Onyxia's Lair (40 players, requires Drakefire Amulet questline in inventory). Weekly reset planned. Source: https://news.blizzard.com/en-us/article/24303009/world-of-warcraft-forever-raid-overviewlocations-raid-sizes-and-attunement . confirmed. Boss counts for Hyjal (13) and Barrow (8) also in the Legacy post. confirmed.
- Design: every tier will have at least one 10-player and one 20-player raid; some tiers add 40-player; no flex raiding; Meeting Stones cannot summon; a Looking for Group listing tool exists; Warlocks still summon. Source: Kotaku interview https://kotaku.com/new-things-learned-world-of-warcraft-forever-2000734005 . likely (the fetched summary matches multiple secondary reports; interview is of named designers Tim Jones and Mike Nuthals via search summary).
- Party size: 5 (nine "five-player dungeons" in Blizzard launch post). confirmed. No Blizzard statement about raid-group UI max found; raid sizes above imply max 40.
- Group finder: a listing tool, no auto-queue. https://realmfirst.net/news/wow-forever-dungeon-finder-lfg/ via search summary. likely.
- GDKP: Blizzard said (Sept 17 dev Q&A, the architect Greenfield) GDKP will not be allowed; Clay Stone told 4Gamers (Oct 8) it applies only to NA and EU and stays permitted elsewhere, Korea included. Sources: https://www.icy-veins.com/wow-forever/news/blizzard-just-confirmed-gdkp-runs-wont-be-allowed-in-wow-forever/ and https://www.invenglobal.com/articles/27234/world-of-warcraft-forever-to-allow-gdkp-in-korea . likely (press reports of Blizzard statements).
- Guild size cap: not announced. Forum player proposal of 200; a booster-site guide says about 1,000 (player-reported). speculative. https://lfcarry.com/guides/wow-forever-guilds
- Guild charters: beta known-issues post (Oct 1) said players could not sign charters; temporary workaround to submit with no signatures. Quoted via lfcarry and cogm.app. likely.
- Guild bank: reportedly exists on beta (about 100 gold first tab) per players; Blizzard posts do not mention it. speculative. Cross-faction guilds: not addressed by Blizzard; factions cannot group so cross-faction guilds are unlikely but unconfirmed. Whether a guild is tied to a ruleset: unconfirmed (guides infer yes).
- No shared Warband bank (secondary). speculative.

### 1.6 Third-party tools and addons
- Forever shares the Mainline UI architecture: Blizzard (Sept 15 post to addon authors, relayed) said the vast majority of 12.1.5 APIs are available; interface version 16001. forevermeta.me https://forevermeta.me/en/guides/wow-forever-addons-interface . likely (secondary relaying Blizzard).
- Midnight "secret values" addon restrictions apply: Wowhead (2026-09-16) "WoW: Forever Will Have Addon Changes from Midnight" https://www.wowhead.com/news/wow-forever-will-have-addon-changes-from-midnight-382921 (headline and date confirmed; body not retrievable) plus https://warperia.com/wow-forever-inherits-midnights-addon-changes/ . likely.
- Consequences reported: combat log events do not reach addons; no addon messaging inside instances; cannot read other players' health or enemy cooldowns; Blizzard built-in damage meter (with C_DamageMeter API that Details! reads); WeakAuras has no official Forever build (forks exist); ElvUI none; DBM, BigWigs, Questie, Details!, Bartender4, TomTom have builds as of Oct 23. forevermeta.me . likely (secondary, single guide).
- Blizzard's UI Add-On Development Policy (2009, still the stated rule): add-ons free of charge, code visible, no advertising, no donation requests in-game, comply with ToU/EULA, Blizzard may disable add-on features. https://us.forums.blizzard.com/en/wow/t/24534 . confirmed (policy text via fetch). China notice of Sept 24 2026 targets paid addons. kami-labs.fr summary. likely.
- RestedXP style paid leveling-guide addon: tolerated, never ruled on. https://kami-labs.fr/en/wow-forever/restedxp-interdit-wow-forever/ . likely.
- Automation, bots: EULA bannable. fan FAQ citing EULA. likely.

## 2. Blizzard APIs

### 2.1 OAuth 2.0 (authorization code, scopes)
- Authorize URL https://oauth.battle.net/authorize and token URL https://oauth.battle.net/token (secondary: Guildbook README and apis.io listing https://apis.io/scopes/battle-net/battle-net-scopes/ ). likely. Portal config shows oauth host https://oauth.battle.net (confirmed from portal shell).
- Scopes for authorization-code: openid, wow.profile (and sc2.profile). apis.io listing and docs.allauth.org. likely.
- Token exchange: POST with HTTP Basic (client id/secret), grant_type, code, redirect_uri. Forum https://us.forums.blizzard.com/en/blizzard/t/issues-with-authorization-code-flow/4561 . likely.
- User access tokens last about 24 hours with no refresh token, so users must reconnect: Guildbook README https://github.com/Guildbook/guildbook . likely (single practitioner source; exact figure unverified in Blizzard docs).
- Client credentials flow gives an app token for public Game Data and public Profile data.

### 2.2 APIs and Forever coverage
- Game Data API (static/dynamic namespaces) and Profile API (profile-* namespace; `/profile/user/wow` requires a user token with wow.profile). Retail namespaces static-us/dynamic-us/profile-us; Classic Era `*-classic1x-{region}`; Progression Classic `*-classic-{region}`; Anniversary `*-classicann-{region}`. Source: https://www.npmjs.com/package/@blizzard-api/classic-wow (community package). likely.
- Namespaces for Cataclysm Classic / Mists Classic mapped inconsistently across sources (npm package vs others). speculative.
- Forever: NO published Blizzard namespace or documentation found. Guildbook (a Forever guild site) states Blizzard has not published a profile namespace for Forever and defaults to profile-classic1x-{region}, with the namespace configurable; it also states Battle.net does not expose Forever surnames and that verification cannot run before 2026-11-04. https://github.com/Guildbook/guildbook . likely.
- Guild roster in Classic: forum reports of 403 Forbidden for Classic Era guild/roster in classic1x; worked in classic namespace. Old (about two years): https://us.forums.blizzard.com/en/wow/t/era-guild-and-guild-roster-api-no-longer-works/1969144 . speculative today; must test.
- Raid progress profile endpoints (encounters) are not documented for Classic in anything I could read. unknown.
- Reference: a Drupal WoW module lists Retail endpoints (Protected Character Profile needs elevated scope). https://project.pages.drupalcode.org/wow/reference/apis/ . likely.

### 2.3 Terms of Use (last updated 2019-10-01)
Source: https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use (old mirror at .../abec-... also returned same terms). confirmed.
- No premium/paid versions of an application, no charging players to download or access it, no donation prompts, no required video ads; no marketing/promoting products with API data; no targeting ads; no selling/licensing/transferring data including aggregates to ad networks or data brokers.
- Max 30-day TTL on retained data; for WoW character data, check the character ID still exists and delete if not.
- 36,000 calls per hour "or any other limit Blizzard sets"; no third-party services making extra requests on your behalf. Forum (staff-like reply, April 2020) adds ~100 req/s burst and one credential pair per application/website: https://us.forums.blizzard.com/en/blizzard/t/api-access-clients-rate-limits/5602 . likely (poster role unverified).
- Privacy policy consistent with Blizzard's; do not collect Blizzard passwords; report unauthorized access within 24 hours; delete data on individual request; no apps aimed at under-13s; content within the game's ESRB rating.
- Attribute Blizzard as the source without implying endorsement; no Blizzard trademarks in app title or URL.
- Applications must be registered; Blizzard can change or terminate access without notice; after termination delete all data.
- Community reading: free use with ads nearby OK, premium features not OK, contact legal@blizzard.com for definitive answers (non-staff posters). https://us.forums.blizzard.com/en/blizzard/t/terms-of-use-monetization/10595 . speculative as to interpretation.
- Jan 2026 forum reply: each user creating own credentials breaks terms; open-source apps hedged. same rate-limit thread. speculative.
- Not found: any formal commercial-use application or paid tier. The terms describe registration only. A catalog file mentions a 500 req/s partner tier (not authoritative). speculative.

## 3. Data ecosystem

- Blizzard patch notes, blue posts, hotfix lists on worldofwarcraft.blizzard.com/en-us/news (e.g. hotfixes Oct 30: https://worldofwarcraft.blizzard.com/en-gb/news/24307310/hotfixes-october-30-2026 ; this list appears to mix Retail items, so scope per product is unclear). confirmed existence; scope likely mixed.
- Client data (DB2): wago.tools publishes tables as CSV but its robots.txt allows only the homepage ("Disallow: /" for everything else) https://wago.tools/robots.txt . confirmed. A Forever helper project instead uses the wago.tools /api/files and /api/casc/{fdid} endpoints plus WoWDBDefs column definitions and treats terms as unverified. https://github.com/alsh0083/wowforever-helper/issues/234 . likely. Forever build seen: 1.60.1.x (product wow_classic_beta during beta). No wago.tools terms page found. Data itself is Blizzard IP.
- Warcraft Wiki (warcraft.wiki.gg): text under CC BY-SA 4.0, media may differ; Blizzard owns the underlying IP. https://warcraft.wiki.gg/wiki/Warcraft_Wiki:Copyrights . confirmed. Raid buffs page there describes only Retail buffs, no Forever content found.
- Wowhead Forever: database built from player data via the Wowhead Client/Looter. robots.txt blocks AI agents per the Everloot review (checked 2026-10-18 by them). https://github.com/Everloot/everloot/pull/63 and https://www.wowhead.com/forever . likely.
- Other Forever databases (WoWDB, forever.warcraftdb.com, Warcraft Tavern): Everloot review marks them research-only; Tavern forbids copying; WarcraftDB reserves all rights. same PR. likely.
- Raider.IO: public API with a documented Classic site; 200 requests/minute unauthenticated, higher by registering an app. https://classic.raider.io/api via search summary. likely (page body itself did not load). Forever coverage: listed in the page blurb as "Classic and Forever" in a fetch summary (unverified). speculative.
- Warcraft Logs API v2 (GraphQL): client credentials (public data only), authorization code, PKCE; rate limit measured in points per hour. Docs https://www.warcraftlogs.com/api/docs (403 to me), https://articles.warcraftlogs.com/help/api-documentation (403). Rate-limit rework beta from 2026-10-20 (App points, DB points, User points; tiers e.g. unsubscribed 1000/250, Silver 1000/350, Gold 3000/1050, Platinum 9000/3200 per hour) from a third-party project issue citing an Archon article I could not open. https://github.com/katogaming88/WGA-Raid-Hub/issues/1592 . speculative until Archon's article is read. API terms of use for commercial use: not retrieved. UNKNOWN.
- Archon/Warcraft Logs Forever: Archon's September release notes said October work includes "preparing for WoW Forever support" (X post via search summary). https://x.com/WarcraftLogs/status/2105592829837738434 . likely that Forever support is pending, not shipped.
- Combat log under secret values: Blizzard said in the Midnight developer talk that the advanced combat log would keep its information so logs/parsing keep working (Warcraft Tavern recap https://www.warcrafttavern.com/wow/news/wow-midnight-developer-talk-new-secret-values-combat-info-cooldown-manager-combat-addons-nerfed/ ). likely for Midnight; not confirmed for Forever.
- WoWAnalyzer, WeakAuras, Details: no Forever support evidence found beyond Details! via C_DamageMeter (forevermeta, secondary). Guildbook mentions a "Vigil" companion for combat log review. speculative.

## 4. How players manage alts, parties and raids

- Alts: Legacy System is designed so alts are optional but encouraged; points shared account-wide, spent per character. confirmed.
- Raid composition conventions (Classic 40-man): informal guidelines of 3-4 tanks and 8-12 healers, healing weighted to Priests and Paladins; one buff per class suffices; benched/standby raiders; 45-55 committed rosters for a 40-man team. Sources: https://www.warcrafttavern.com/community/pve/classic-40-man-raid-composition/ , https://guildorder.com/games/wow_classic/guides/forty-man-raid-roster-management . speculative to likely (community advice, not Forever-specific).
- Forever changes: camp features can replace some class buffs (confirmed, launch post) so classic buff-slot rigidity is weaker. Hit and crit are combined across spell/melee/ranged (Deep Dive recap, confirmed).
- Loot systems used: DKP, loot council, soft-reserve, formerly GDKP. Tools: Gargul (loot master only needs it; soft reserve, TMB integration), RCLootCouncil (council voting), Thatsmybis (TMB) importing Raid-Helper signups, Softres.it. https://thatsmybis.com/ , https://www.curseforge.com/wow/addons/gargul . likely. A Forever raid-planning issue notes most soft-reserve addons are Classic-only while Gargul is reported to work on Forever (RCLootCouncil retail-only, LootReserve Classic-only): search summary of a GitHub issue. speculative.
- Existing Forever guild tools: Guildbook (Discord sign-in, optional Battle.net verification, roster, applications, raid nights, loot ledger, imports from Gargul/RCLootCouncil/TMB) https://github.com/Guildbook/guildbook ; CoGM (Discord DKP/events/roster; free to 30 members, $10/month Pro) https://cogm.app/blog/wow-forever-guild-guide . likely (vendor claims).
- Calendar/signup conventions: Discord bots (Raid-Helper) are the de facto signup surface. likely from TMB integrations.

## 5. Design-fact table

| Fact | Source | Confidence |
|---|---|---|
| Launch 2026-11-04 3 p.m. PST | https://news.blizzard.com/en-us/article/24315820/ | confirmed |
| Raids Dec 9: 10/20/40 players | https://news.blizzard.com/en-us/article/24303009/ | confirmed |
| Party size 5 | Blizzard launch post (5-player dungeons) | confirmed |
| No realms; 4 rulesets (Hardcore later); region + ruleset = world | https://worldofwarcraft.blizzard.com/en-us/news/24302070/ | confirmed |
| Grouping only same ruleset and same faction | same | confirmed |
| Names two-part, unique per region | launch post | confirmed |
| Legacy points account-wide, spend 16 per character | Legacy post | confirmed |
| Subscription/Game Time required; Forever included | pre-purchase post | confirmed |
| API ToU: no paid/premium, 30-day TTL, 36k calls/h, attribution | Blizzard ToU 2019 | confirmed |
| Add-on policy: addons free | Blizzard forum policy | confirmed |
| Midnight secret-values restrictions apply to Forever | Wowhead/Warperia/forevermeta | likely |
| No combat log for addons | forevermeta (secondary) | likely |
| Blizzard has no published Forever namespace | Guildbook README | likely |
| OAuth user token ~24h, no refresh | Guildbook README | likely |
| No flex raiding, 10 and 20 every tier | Kotaku | likely |
| GDKP banned in NA/EU, allowed elsewhere | Icy Veins, Inven | likely |
| Character cap per account | forum anecdotes | speculative |
| Guild size cap | none | unknown |
| Guild bank exists | player reports | speculative |
| 8 WoW licenses per Battle.net account | user forum replies | likely |
| WCL point rate limits, new beta tiers | third-party issue | speculative |
| wago.tools robots disallows everything but home | robots.txt | confirmed |

## Open questions I could not settle
1. Does the Battle.net Game Data/Profile API serve Forever characters at all, and under what namespace? No Blizzard documentation found; developer portal is JS-only.
2. Does the guild roster endpoint work for Forever (history of 403 for Classic Era guilds)? Requires a live test with credentials after launch.
3. Are surnames (two-part names) exposed by the API? Guildbook says not.
4. Characters per account/ruleset cap; guild member cap; whether guilds are per-ruleset or per-faction; guild bank presence.
5. Whether Warcraft Logs, Archon and Raider.IO support Forever at launch; WCL API terms on commercial use; the real rate limits under the new points system.
6. Whether an in-game raid group in Forever is capped at 40 and whether 10/20 raids use the same raid UI (no direct source).
7. Official OAuth token lifetime and refresh rules (docs not readable).
8. Whether Blizzard grants commercial permission or just prohibits monetization; no application process found, only "contact legal".
9. wago.tools data terms; whether Forever DB2s are on the public API for the live (non-beta) product code.
10. Blizzard's Forever-specific addon policy for companion apps reading logs or reading screens; the ToU API rule on "unfair advantage".
11. Layering behavior details and whether a guild or party is guaranteed one layer.

## Surprises versus what a team would assume
- Forever is realmless: there is no realm to key a guild or character on; identity is region + ruleset + two-part name. Any schema with realm slug breaks.
- Ruleset partitions the social graph (grouping, raids) but the Battle.net account and Legacy Points span rulesets; a user can have characters in several worlds and cannot group them.
- Horde and Alliance cannot group, so a mixed-faction friend group cannot raid together at all.
- No flex raiding and fixed 10, 20, 40 sizes; 10-man exists every tier, so 5-to-10-player friend groups are first-class raiders. Dec 9 is the first raid date, not launch.
- Addons are far weaker than in Classic: the combat log and many values are hidden, so classic-style companion data (parses, uploads, WeakAura-fed bots) may not exist at launch. Blizzard's own damage meter replaces much of it.
- Blizzard's API ToU forbids a paid or premium app and donation prompts; a commercial companion built on API data cannot gate features behind payment, and data must expire in 30 days.
- Blizzard API user tokens are reportedly 24 hours with no refresh, so "linked" state is brittle.
- wago.tools disallows crawling all subpages in robots.txt; Wowhead and WoWDB block AI agents; the Warcraft Wiki is the one reusable text source (CC BY-SA) and needs share-alike.
- Warcraft Logs is mid-change on API rate limits (beta from Oct 20), and only 1,000 points/hour for unsubscribed keys per a third-party report.
- GDKP is banned only in NA and EU per an associate production director; region matters for loot features.
