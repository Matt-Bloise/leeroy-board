# R5: IP, commercial, data licensing, AI terms, payments, platform risk
Research date: 2026-11-02 (all "accessed" dates). Not legal advice. Labels: **confirmed** = read in the primary document this session; **likely** = secondary source or reasonable inference; **speculative** = unverified or my inference.
Method note: WebFetch returns a model summary of the page, not raw text. Items marked confirmed were read from the vendor's own page via that tool; where a page returned 403/404 it is listed under Open questions.

---

## 0. Headline

The single biggest finding: the **Blizzard Developer API Terms of Use (last updated 2019-10-01)** forbid paid "premium" versions of applications that use the API and forbid charging players to access such an application. A paid WoW Forever companion that pulls Battle.net API data is on its face outside those terms. Roughly everything else (Discord, AI vendors, payments, entity) is solvable with money and paperwork. This one is a design constraint. Blizzard has no published commercial-use route for API data, and no Forever API namespace existed in the sources found.

---

## 1. Blizzard intellectual property

### 1.1 Documents that exist (and one that does not)

| Document | Finding | Label | Source |
|---|---|---|---|
| "Blizzard Fan Content Policy" | I could not find a document by that name. Blizzard's legal pages reference an "Activity Policy" system (fan site policy, community esports, custom maps) that grants limited trademark use. The current fan site policy text could not be located; only a legacy 2004-era Fan Site Program page and the trademark guidelines mention it. | confirmed (not found); text of current fan site policy unresolved | https://www.blizzard.com/en-us/legal/8bcb0794-6641-4ce3-a573-8eb243bab342/blizzard-entertainment-logo-and-trademark-guidelines ; http://classic.battle.net/fsp.shtml (2026-11-02) |
| Developer API Terms of Use | Last updated Oct 1, 2019. Details in 1.2. | confirmed | https://www.blizzard.com/en-gb/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use (2026-11-02) |
| Blizzard EULA | Most recent revision March 21, 2024. Details in 1.3. | confirmed | https://www.blizzard.com/en-us/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement (2026-11-02) |
| Terms of Use for Blizzard websites | License is personal use only; excludes "any commercial use" of the Site or Materials; users grant Blizzard a perpetual irrevocable sublicensable license over posted content. | confirmed | https://www.blizzard.com/tou (2026-11-02) |
| Logo and Trademark Guidelines | Details in 1.4. | confirmed | URL above (2026-11-02) |
| Blizzard Legal FAQ (undated, older) | Fan use of images/text/sound allowed "within certain limits"; license is home, noncommercial and personal use only; revocable any time for any reason; no merchandise; domain names containing product names (e.g. star-craft.com) not allowed. Page does not address ads or APIs. | confirmed (page undated, likely stale) | https://www.blizzard.com/en-us/legal/c1ae32ac-7ff9-4ac3-a03b-fc04b8697010/blizzard-legal-faq (2026-11-02) |
| Blizzard Video Policy | Blizzard Content use limited to non-commercial purposes; viewers cannot be required to pay; sponsor mentions capped at 10 seconds. Shows Blizzard's default posture on game assets. | confirmed | https://www.blizzard.com/en-us/legal/dd76b654-f2c4-4aaa-ba49-ca3122de2376/blizzard-video-policy (2026-11-02) |
| UI Add-On Development Policy | Posted March 2009. 8 rules: free of charge (no premium versions, no charging to download or for related services); visible source; no negative impact; no advertising; donation requests only off-game; ESRB T content; follow ToU/EULA; Blizzard may disable addons. | confirmed (forum copy; Blizzard-hosted policy page not located) | https://us.forums.blizzard.com/en/wow/t/ui-add-on-development-policy/24534 (2026-11-02) |

### 1.2 Developer API Terms of Use: clause-level (the load-bearing document)
All confirmed from https://www.blizzard.com/en-gb/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use (2026-11-02), summarized, not quoted at length:
- 2: license is limited, revocable, non-transferable; free "for now", Blizzard may charge a fee later. Data may be distributed to end users only for their personal use through your Application.
- 2(b): paid "Premium" versions of Applications are not permitted; players cannot be charged to download or access an Application that uses the APIs; no donation interstitials before features unlock; no required video ads.
- 2(e): Data use restricted to Applications that "benefit the Blizzard player community".
- 2(h): no use of Data in advertising or promotion, no targeting ads with Data, no selling/licensing/transferring Data (including derived/aggregate) to ad networks or brokers.
- 2(i): no selling or licensing Data to any third party.
- 2(m): clearly identify Blizzard as source; **no Blizzard trademark in the Application's title or URL**.
- 2(p): privacy policy required; never store players' Blizzard passwords.
- 2(q): no scraping/crawling outside authorized API use.
- 2(r): 36,000 calls/hour cap; no third-party services making extra requests for you.
- 2(s): **maximum 30-day TTL on all API Data**, and delete character data that no longer exists.
- 3: you grant Blizzard a perpetual, royalty-free license to use your Application.
- 5(d)-(e), 6: you warrant non-infringement and legal compliance (CCPA, GDPR); you indemnify Blizzard.
- 1, 2(k), 10: Blizzard can change terms, suspend or end the APIs without notice.

Interpretation (likely, not Blizzard-confirmed):
- Community readings (forum, not Blizzard staff): features using API data must be free; ads placed near them are fine; API data must not feed ad targeting. https://us.forums.blizzard.com/en/blizzard/t/terms-of-use-monetization/10595 (2026-11-02). One replier said an app can have premium features or original content that is not API data (Warcraft Logs given as example). Neither reply is identified as Blizzard staff.
- A developer asked in Feb 2024 whether the premium ban covers static data extracted from the API; no answer visible. https://us.forums.blizzard.com/en/blizzard/t/query-on-api-terms-of-use/49428 (2026-11-02)
- A developer asked in Apr 2026 whether datamined API data may be posted to GitHub; no Blizzard reply visible. https://us.forums.blizzard.com/en/blizzard/t/questions-about-blizzard-developer-api-terms-of-use/57897 (2026-11-02)
- Consequence for us (likely): a product that charges for anything whose function depends on Battle.net API data (character sync, armory-linked features, roster import) is exposed. Safer architecture: keep API-dependent features in the free tier, charge only for features that use no Blizzard API data (guild scheduling, polls, custom content, team tools, AI over your own library).
- Forever API: no documented Forever namespace as of the sources found. Forum thread Sept 29, 2026 got only a community reply that the namespace would not be known until release; a GitHub issue dated 2026-10-28 reported guessed namespaces returning 403. https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-forever-api-namespace/59774 (2026-11-02) ; https://github.com/jkc-be/goldbook/issues/67 (2026-11-02, secondary). Label: confirmed that no official namespace was visible to me; speculative whether one will appear on Nov 4.

### 1.3 EULA and third-party tools
Confirmed (https://www.blizzard.com/en-us/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement, 2026-11-02): no connecting through unauthorized third-party programs (1.C.ix); no unauthorized bots or code that automates gameplay (1.C.ii); no code that changes or facilitates gameplay (1.C.ii(4)); no reverse engineering or derivative works of the Platform (1.C.i, 2.A.ix); no commercial exploitation incl. account boosting, selling in-game currency/items, advertising through the Platform (1.C.iii); personal use is non-commercial. Add-ons are not mentioned by name. Client may scan memory for unauthorized programs (Sec. 4).
Implication: an off-game Discord/Cloudflare companion that never touches the client is outside the EULA's reach; anything that reads or automates the game client is inside it (likely).

Third-party tools and addons in Forever (secondary, likely):
- Forever shares Mainline UI architecture and the Midnight addon API restrictions; combat data automation is blocked; no official approved addon list. https://www.icy-veins.com/wow-forever/news/addons-in-wow-forever-blizzard-devs-just-addressed-the-big-question/ (2026-11-02, via search snippet; page itself returned 403). Source is a news site quoting a Blizzard rep; not verified against Blizzard.
- Blizzard said it would change how the Advanced Combat Log is populated to stop live-DPS tools, citing EULA 1-C, and a community manager said Blizzard would not change ToS over the Archon addon dispute (forum snippet, secondary). https://us.forums.blizzard.com/en/wow/t/archon-add-on-violates-terms-of-service/1849062/2 (2026-11-02). Likely.

### 1.4 Trademark rules ("World of Warcraft", "Warcraft", "Forever")
Confirmed from the Logo and Trademark Guidelines (https://www.blizzard.com/en-us/legal/8bcb0794-6641-4ce3-a573-8eb243bab342/blizzard-entertainment-logo-and-trademark-guidelines, 2026-11-02):
- Marks usable only for activities covered by a specific Activity Policy (fan sites, community esports, custom maps are named); default is non-commercial unless that policy allows commercial use; Blizzard can withdraw consent any time.
- Marks may not appear in a domain name or URL.
- Marks may not be combined with your own name or brand ("Acme Warcraft" style), and you may not apply to register a name containing a Blizzard mark or variation.
- No use implying relationship, sponsorship or endorsement without written authorization.
- Covered marks include World of Warcraft and Warcraft (with expansions). The page does not list "Forever" separately; whether "World of Warcraft: Forever" is covered by the "World of Warcraft (including its expansions)" wording is my inference (likely).
- Dev API ToU 2(m) separately bans Blizzard trademarks in the Application title or URL.
- No page I found allows commercial use of the marks except through a written license.
Practical: product name, domain, bot name, Discord app name, store listing: none should contain WoW, Warcraft, Blizzard, or Forever-as-a-WoW-signifier. Use nominative description only ("for players of World of Warcraft: Forever") with the credit line, in body text, not in the name (likely safe-ish; lawyer to confirm).

### 1.5 Blizzard art, icons, names, item and spell data
- Art/screenshots/text/sound: fan use is "home, noncommercial and personal" only and revocable (Legal FAQ, confirmed, possibly stale). Blizzard-owned icons, portraits, logos, screenshots in a paid product: no license found. Treat as not allowed (likely).
- Item and spell names, tooltips text, quest text, lore: Blizzard-owned creative content (copyright) plus facts. Facts (stat values, drop rates) are less protectable than creative text, but no Blizzard document grants a license to republish. Datamined client data is exactly the thing Dev API ToU 2(q) and EULA 1.C.i target when obtained outside the API (likely).
- Warcraft Wiki itself states "Warcraft content and materials are the intellectual property of Blizzard Entertainment", which means CC BY-SA on the wiki covers the wiki's own contributions, not Blizzard's underlying IP. https://warcraft.wiki.gg/wiki/Warcraft_Wiki:Copyrights (2026-11-02). Confirmed.
- Customer-made content: Blizzard EULA 1.D.i says Custom Games made with Game Editors belong to Blizzard; Custom Game AUP bars for-profit custom games without written authorization. Not directly applicable to an off-game bot, but shows posture. https://www.blizzard.com/en-us/legal/2749df07-2b53-4990-b75e-a7cb3610318b/custom-game-acceptable-use-policy (search snippet, 2026-11-02; likely).

### 1.6 Enforcement history
- Confirmed pattern: Blizzard's recorded actions are overwhelmingly against private servers: Turtle WoW (court ruling April 15, 2026; shutdown May 15, 2026), Stormforge (agreed to cease by May 14, 2026), Project Epoch (C&D Sept 2025), Project Ascension (lawsuit, reported June 2026; outcome not verified). Sources: https://www.pcgamesn.com/world-of-warcraft/turtle-wow-cease-and-desist ; https://massivelyop.com/2026/04/21/world-of-warcraft-rogue-server-stormforge-is-also-closing-down-following-a-blizzard-cd/ ; https://massivelyop.com/2025/09/09/another-world-of-warcraft-rogue-server-project-epoch-has-been-smacked-with-a-blizzard-cease-and-desist/ ; https://massivelyop.com/2026/06/14/blizzard-files-lawsuit-to-take-down-world-of-warcraft-rogue-server-project-ascension/ (all 2026-11-02, via search summaries). Likely (secondary).
- I found no reported Blizzard C&D against Wowhead, Raider.IO, Warcraft Logs, or similar data/tool sites. Absence of evidence only (speculative that none exists).
- Paid-addon tolerance: forum posters note Blizzard has not acted against Zygor, TSM, or Archon-style addons; Icy Veins reports the free-addon rule is loosely enforced in US/EU but China started enforcing it against paid addons and paywalled profiles. https://www.icy-veins.com/wow/news/wow-china-cracks-down-on-paid-addons-and-paywalled-profiles/ (search snippet, 2026-11-02). Likely. Tolerance is not a license; Blizzard can enforce at will (UI policy rule 8; Dev ToU Sec. 1).
- I found no reported case of Blizzard revoking API access for a monetization violation (search result gap).

### 1.7 What a commercial companion may use, must not, and should ask Blizzard for

May use (likely safe; lowest risk):
- Your own original content, tools and code: scheduling, roster, polls, signups, loot rules, calendar, voice features, generic guild admin.
- Facts you author or paraphrase yourselves (guides in your own words), with the mandatory Blizzard credit/disclaimer; no Blizzard art.
- Data obtained under the Dev API ToU (free features only, 30-day TTL, Blizzard attribution, privacy policy).
- Warcraft Wiki text under CC BY-SA with attribution and share-alike (see 3.1), for text only, not Blizzard images.
- Original art (commissioned or properly produced) that does not depict Blizzard characters, logos or distinctive designs.

Must not (likely):
- Charge for, or paywall, features that use Battle.net API data (2(b)).
- Put WoW/Warcraft/Blizzard in product name, domain, bot name or logo; imply endorsement.
- Use Blizzard icons, art, screenshots, logos or music in the paid product.
- Retain API Data over 30 days; sell or pass API data to third parties, including AI vendors as a data-transfer for their benefit (2(h),(i); ambiguity on sending to an AI processor, see Open questions).
- Scrape Blizzard or Wowhead for bulk content; datamine the client to republish.
- Show ads that use API data; display ads targeted with it.
- Automate or read the live game client.

Ask Blizzard for (written, via legal@blizzard.com, the address suggested in a community thread; also the API forums):
1. Written confirmation whether a subscription product that does not itself use API data, but sits alongside free API-driven features in the same bot, is compliant under 2(b).
2. A commercial/partner license or exception for paid tiers using API data (none is published).
3. Whether "World of Warcraft: Forever" and "Forever" are covered by the Warcraft/World of Warcraft mark grants, and the approved nominative-use wording.
4. A fan-site or community-tool license permitting limited game imagery in a monetized context.
5. The Forever Battle.net API namespace plan and whether the Dev API ToU will be revised for it.
6. Whether sending API data to an AI processor (Gemini, Workers AI) for summarization counts as a "transfer" under 2(h)/(i).
Source for the contact suggestion: https://us.forums.blizzard.com/en/blizzard/t/terms-of-use-monetization/10595 (community post, 2026-11-02). Label the address as likely, not verified.

---

## 2. How successful commercial tools handle IP

| Tool | Model | What it shows | Source / label |
|---|---|---|---|
| Raider.IO | Free site plus Patreon tiers (reported to speed up character updates). Own ToU says the site may not be used for commercial endeavors unless endorsed; API is for community/personal use, commercial use needs separate license (dated 2025-07-01 per search). | Monetizes its own ranking layer and update speed, not raw Blizzard data; also forbids the same thing against others. No Blizzard statement found endorsing or disputing it. | https://raider.io/de/terms-of-use ; https://classic.raider.io/api (2026-11-02, search snippets). Likely. |
| Warcraft Logs / Archon | Site free; Patreon "no ads, permanent log storage" (2015); Archon addon tiers/extras behind Patreon; companion uses Overwolf libraries for hotkeys, video, ads. | Monetizes its own uploaded-log data and tools. Forum users debate addon-policy compliance; no Blizzard ruling. | https://blizzardwatch.com/2015/04/22/warcraft-logs-patreon-created/ ; https://us.forums.blizzard.com/en/wow/t/how-does-warcraftlogs-archons-new-addon-not-violate-blizzards-addon-development-policy/2086434 (read, no staff reply) ; https://www.archon.gg/wow/articles/help/archon-and-external-partners (snippet). Confirmed for forum content; likely for model. |
| Wowhead | Ads plus Wowhead Premium (ad removal, forum privileges) since 2009; gets data via its own addon (Looter) and client. Reportedly has no public API and tries to prevent parsing. | Largest commercial player; no Blizzard document approving it; Blizzard tolerates. | https://www.wowhead.com/premium (search snippet, 2026-11-02). Likely. |
| Paid leveling-guide addons (Zygor, RestedXP, Journey) | Paid guides loaded into free addons; Forever tournament promoted Journey. | Gray area tolerated; the "addon is free, guide data is paid" workaround. | https://wowsod.pro/articles/wow-forever-paid-leveling-guide-addon-tos ; https://foreverupgrades.com/news-article.html?a=wow-forever-duel-tournament-paid-addon-journey-blizzard-tos (search snippets). Secondary, likely. |
| Discord guild bots | Raid-Helper: one-time server packages 3 mo EUR10, 6 mo EUR15, 12 mo EUR25, lifetime EUR55 (official site). Sesh and Apollo cited at ~$4.89 and ~$5.83 per month on annual plans, from Raid-Helper's own marketing table. | Price anchor: roughly $1 to $6 per server per month, with lifetime options. They sell generic scheduling, not Blizzard data. | https://raid-helper.dev/premium/ (2026-11-02). Raid-Helper prices confirmed from vendor page; competitors' prices likely (competitor-authored table). |

Patterns for a game-agnostic platform with per-game content packs (likely/speculative, my synthesis):
- Core platform (accounts, billing, Discord integration, AI layer, scheduling) is game-neutral and owned by you; the paid product is the platform, never "WoW data".
- Per-game packs are separately named, separately licensed objects: content you wrote, community content under CC BY-SA, and optionally official API integration kept free. Each pack carries its own rights record (source, license, attribution, date).
- The pack for WoW carries the Blizzard disclaimer and is never in the paid SKU name. Product brand is neutral ("Guild Companion" style, no game marks).
- Easy to drop or geo-fence one pack if its publisher objects, without taking down the platform.
- Posture to adopt: no claim of affiliation; "unofficial"; takedown contact; remove-on-request process.

---

## 3. Data and content licensing of the knowledge library

### 3.1 Warcraft Wiki (warcraft.wiki.gg)
- Confirmed: textual content the wiki can lawfully license is CC BY-SA 4.0; images and audio are licensed per file page; pages before October 2023 were adapted from Fandom's Wowpedia under CC BY-SA 4.0 unless noted; Blizzard IP stays Blizzard's. https://warcraft.wiki.gg/wiki/Warcraft_Wiki:Copyrights (2026-11-02). The page does not address commercial reuse or spell out attribution mechanics.
- CC BY-SA 4.0 on its face allows commercial reuse, but requires attribution (author credit, license link, change notice) and ShareAlike for adaptations (likely; based on the standard license, which I did not re-read this session). ShareAlike means any adapted text you publish must carry CC BY-SA. A database or AI answer that mixes wiki text with your proprietary text creates a share-alike question. Lawyer item.
- Underlying Blizzard material in the wiki (quest text, item flavor text, lore quotes) is not Blizzard-licensed by CC BY-SA; CC licensing does not clean Blizzard's rights (likely).
- Risk when storing page text: wiki images are the highest risk (Blizzard-owned screenshots/icons under various per-file tags). Do not mirror images.

### 3.2 Wowhead
- Terms page not retrieved (https://www.wowhead.com/terms returned 404; /terms-of-use 404). Searched; no Wowhead terms text found. Open question.
- Secondary: a developer on the Blizzard forums states Wowhead has no API and tries to prevent site parsing (April 2026 thread). https://us.forums.blizzard.com/en/blizzard/t/questions-about-blizzard-developer-api-terms-of-use/57897 (read 2026-11-02). Likely.
- Wowhead tooltip embedding exists as a product feature; terms for commercial embeds not verified. Speculative.
- Rule of thumb: do not scrape or store Wowhead page text; link out, or use tooltip embeds only after reading their terms.

### 3.3 wago.tools and client data
- robots.txt (fetched): `User-agent: *  Allow: /$  Disallow: /` which blocks crawling of the whole site except the root. https://wago.tools/robots.txt (2026-11-02). Confirmed.
- Secondary: a GitHub issue says wago.tools exposes an API serving raw game files (/api/casc/{fdid}, list at /api/files) and that the /db2/ CSV downloads are disallowed by robots.txt; no terms text quoted. https://github.com/alsh0083/wowforever-helper/issues/234 (2026-11-02). Likely.
- No wago.tools terms of use, license or commercial-use statement found. Column definitions from WoWDBDefs; license not verified. Open question.
- The underlying client data is Blizzard's. Datamined DB2 tables are Blizzard copyrighted game data distributed without a Blizzard license (likely). Using wago.tools data in a paid product repeats the 1.5 risk and is stronger exposure than API data because Dev ToU 2(q) and EULA 1.C.i apply to datamining.

### 3.4 Icy Veins and other guide sites
- Icy Veins FAQ (search snippet): copying a guide requires clear statement that it comes from Icy Veins plus a visible link to the URL; translations authorised with credit and link; older page says copying/reprinting needs express written approval; Terms last updated Nov 19, 2025 (issued by VEDATIS SAS). Direct fetch of the terms returned 403. https://icy-veins.com/faq ; https://www.icy-veins.com/terms (2026-11-02). Conflicting; likely.
- Method (Blizzard-adjacent) and other guide sites: not fetched. Open question.
- Rule: never store or serve third-party guide text as your product's content. Keep short factual extracts with citation at most, and only with the owner's licence in writing for anything paid. Write guides yourselves.
- Specifically Raider.IO ToU says its content cannot be exploited commercially without written permission (https://raider.io/terms-of-use, via fetch summary; item 9 and IP section; 2026-11-02, confirmed for the summary). Blizzard's own site terms likewise.

### 3.5 AI-generated art licensing
- US Copyright Office Part 2 report (Jan 29, 2025): prompts alone do not make the user the author; purely AI-generated material is not copyrightable; protection may exist for human-created inputs perceptible in the output and for creative selection/arrangement/modification. https://ipwatchdog.com/2025/01/29/part-two-copyright-office-ai-report-says-creative-prompting-doesnt-constitute-authorship/ (2026-11-02). Secondary summary; primary PDF not parseable in my tools. Likely. Original: https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf
- Supreme Court denied certiorari in Thaler v. Perlmutter on March 2, 2026, leaving the D.C. Circuit human-authorship ruling in place. https://www.mayerbrown.com/en/insights/publications/2026/03/supreme-court-denies-review-in-ai-authorship-case (2026-11-02, summary). Likely. It did not decide how much human input suffices.
- OpenAI: consumer terms assign output to the user "to the extent permitted by applicable law"; other users may receive similar output; contractual ownership does not create copyright. https://www.terms.law/ai-output-rights/chatgpt/ (2026-11-02, attorney blog; OpenAI terms page itself returned 403). Likely. API data is not used for training by default per same source (secondary).
- Midjourney: ownership for paid subscribers only; free-trial output has no commercial rights; companies with > $1M annual gross revenue need Pro or Mega; terms summaries from third parties. https://terms.law/ai-output-rights/midjourney/ (2026-11-02). Likely.
- Consequences for the painted assets (likely):
  1. Little or no copyright in the raw AI images, so competitors can copy them and you could not stop it; you can claim copyright only in what humans add (editing, compositing, selection).
  2. Bigger risk than copyrightability: if an image depicts or imitates Warcraft characters, races, logos or distinctive designs, it is an unauthorized derivative of Blizzard IP, and the AI vendor's ownership clause does not cure that. Vendor terms say outputs may contain third-party material and the user bears liability.
  3. Keep a generation log (prompt, date, plan tier, model) per asset; commission human artists for brand art and logos.
  4. Verify the account tier for each image: e.g. Midjourney requires paid plan; ChatGPT consumer account used by one person means the provenance sits in that person's account, not the company's (speculative on exact legal effect; flag to lawyer).
- Memory note from workspace says board art is painted in the owner's ChatGPT. That is a company-ownership and account-ownership issue (see 6.3).

---

## 4. AI provider commercial terms

| Provider | Training on your/users' content | Retention | DPA | Notable restrictions | Source / label |
|---|---|---|---|---|---|
| Google Gemini API, free tier ("Unpaid Services") | Yes: Google uses submitted content and responses to improve products; human reviewers may read them (disconnected from account/key). Page warns not to submit sensitive, confidential or personal information. | General period not stated for unpaid. | Not stated for unpaid. | 18+ only; API clients must not be directed at or likely used by under-18s. EEA/UK/Switzerland users get Paid Services data terms even on free tier; developers there must use only Paid Services when making API clients available to users. | https://ai.google.dev/gemini-api/terms (effective Mar 23, 2026, updated Apr 28, 2026; fetched 2026-11-02). Confirmed. |
| Google Gemini API, paid (billing-linked Cloud project) | Google says it does not use prompts/responses to improve its products. | Logged "for a limited period of time" for abuse monitoring; length not stated; may be stored in any country Google operates. Grounding with Search/Maps stores 30 days. | Yes, Data Processing Addendum (processor terms). | same 18+ rule | same. Confirmed. |
| Anthropic (Commercial Terms) | Anthropic may not train on Customer Content from the Services. | Docs say conversation content not retained by default (third-party summary notes privacy center says deleted within 30 days); ZDR available on request; certain "Covered Models" require 30-day retention. | Yes, incorporated by reference. | Cannot resell the Services without approval; can power your own product (A.1); must tell users outputs may be inaccurate (D.3); Anthropic indemnifies for third-party IP claims over paid use of Services/Outputs (K.1) with exclusions; Anthropic may use your name as a customer unless you opt out. Terms fetched were dated Jun 17, 2025 and may have been superseded. | https://www.anthropic.com/legal/commercial-terms (2026-11-02) ; https://platform.claude.com/docs/en/manage-claude/api-and-data-retention (search summary). Terms: confirmed; retention detail: likely (secondary conflict). |
| Cloudflare Workers AI | Cloudflare states it does not use Workers AI Customer Content to train models. | Standard inference: "zero data retention"; stored when you use R2/KV/DO/Vectorize, AI Gateway logging/caching, app logs, batch/async. Operational metadata (model ID, timestamps, token counts) kept. | Cloudflare ToS 6.1 incorporates DPA for personal data (controller/processor). | Third-party models carry their own licenses; AI Gateway to another provider falls under that provider's terms. | https://developers.cloudflare.com/workers-ai/platform/data-usage/ (2026-11-02) ; https://www.cloudflare.com/terms/ (updated Sep 12, 2025). Confirmed. |
| OpenAI | Per attorney summary: API data not used for training by default; consumer data may be. Output assigned to user. | Not verified. | Not verified. | Primary terms returned 403. | https://www.terms.law/ai-output-rights/chatgpt/ (secondary, 2026-11-02). Likely. |

Cross-cutting (likely):
- Discord Developer Policy prohibits training ML/AI models on message content obtained through the API without Discord's permission; Discord's Aug 2025 policy FAQ states AI companies may not train on users' messages. Sending message content to a vendor that does not train on it is a different thing from training, but the vendor must be no-train: so Gemini free tier is the wrong tier for anything derived from Discord messages. https://discord.com/safety/important-policy-updates (search snippet, 2026-11-02). Developer Policy page itself returned 403; claim comes from search summary. Likely.
- Blizzard Dev ToU 2(h)/(i) bar transferring Data; whether processing by an AI vendor under a DPA counts as "transfer" is unsettled. Prefer to keep Blizzard API data out of prompts, or get Blizzard's answer.
- Under-18s: Gemini API forbids clients likely to be accessed by under-18s. A WoW guild bot in public Discord servers may reach teens (Discord minimum age is 13 in general; not re-verified). Practical: use paid tier of a vendor without the 18+ clause, or age-gate, or document the risk.
- Privacy policy must name AI processors and whether content is retained or used for training (Discord and Dev ToU 2(p) both require a privacy policy; Discord monetization requires the policy to describe data collected, use and sharing).

---

## 5. Payments and money

### 5.1 Discord Premium Apps
- Confirmed requirements (https://docs.discord.com/developers/monetization/enabling-monetization, 2026-11-02): app verified; owned by a developer team; team owner 18+; verified emails and 2FA on the team; app uses slash commands or has Message Content intent approval; ToS link; Privacy Policy link describing data collected/used/shared; payout method; team agrees to Monetization Terms and Developer Policy; only the owner can enable payouts; first $100 earned before payout eligibility; Discord reviews the team before payouts; payouts via Stripe; **teams based in the US, EU or UK only**.
- SKU types (confirmed): durable one-time, consumable one-time, user subscription, guild subscription. https://docs.discord.com/developers/monetization/overview (2026-11-02).
- Fees: Discord blog (2024): platform fee 30% reduced to 15% on the first $1M cumulative gross sales per team; developers must use Premium Apps features for supported offerings and not price higher than other payment options (deadline Oct 7, 2024); available in US, UK, EU. https://discord.com/blog/feast-your-moniteyes-on-todays-exciting-developer-updates (2026-11-02). Confirmed. Payout threshold and payout details ($25 minimum, payout after first $100, Stripe, processing fees deducted) come from search snippets of the Discord support article (support pages returned 403 to my fetches): likely.
- Tax: Discord's Monetization Terms (search snippet) say Discord assesses and remits transaction taxes (sales, VAT, GST) where required and collects tax ID info; income tax is the developer's. https://support.discord.com/hc/en-us/articles/5330075836311-Monetization-Terms (2026-11-02). Likely; page itself 403.
- Pricing parity rule means a cheaper off-Discord checkout is not allowed for supported offerings (confirmed for the rule via blog; scope of "supported offerings" unclear).
- Required support obligations article exists; content not retrieved (403). Open question.
- Net: simplest, tax-handled path for the Discord-delivered product, but 15-30% fee and Discord controls the customer relationship. For a web-based tier (dashboard), use a separate merchant of record.

### 5.2 Merchant-of-record options
- Paddle: 5% + $0.50 per Checkout transaction, no monthly fee; merchant of record collects and remits sales tax/VAT, handles fraud and chargebacks; low-value (<$10) products need custom pricing. https://www.paddle.com/pricing (2026-11-02). Confirmed. Guild subscriptions at $2-6 are near or under the threshold where the $0.50 fee is 10-25% of the sale: bad fit (likely, my arithmetic).
- Stripe Managed Payments (merchant of record): handles sales tax, VAT, GST in 80+ countries, fraud, disputes, customer support; seller must be based in a supported location (includes US, GB, most EU, CA, AU, SG, JP, HK, CH, NO); sells automated digital products (SaaS, software, digital media); **requires that "you hold all necessary rights and licenses to distribute the product"**; no human-service products; no Connect; subscriptions only via Checkout/Payment Links with Billing; disputes monitored; customers in China, Russia, etc. restricted. https://docs.stripe.com/payments/managed-payments/eligibility (2026-11-02). Confirmed. The rights-and-licenses clause matters if the product is seen as using Blizzard IP.
- Managed Payments fee level: secondary sources say 3.5% on top of Stripe processing; unverified from Stripe. https://www.turbostarter.dev/blog/stripe-vs-lemonsqueezy-vs-polar-vs-creem-choosing-the-right-saas-payment-provider (search summary, 2026-11-02). Likely.
- Lemon Squeezy: reported as 5% + $0.50 plus surcharges; owned by Stripe and reportedly being folded into Managed Payments (secondary). Lemon Squeezy's own blog URL returned 404. Likely; treat as unstable.
- Polar: reports conflict on tiers (older 4% + $0.40; newer 5% + $0.50 starter). Likely/unverified.
- Plain Stripe or Stripe + Tax: you are the seller of record and must register for VAT/sales tax yourself (confirmed by Stripe comparison table: merchant of record "Your business" for other Stripe products).
- Paddle AUP page returned 404; Paddle help center states products that let non-Paddle sellers sell via them (marketplaces) are prohibited (search snippet): a bot that resells others' items would be affected; a subscription is not. Gaming/IP-specific Paddle rules unverified.

### 5.3 Tax thresholds (general; verify with accountant)
- UK VAT registration threshold GBP 90,000 (since April 2024); deregistration GBP 88,000 (secondary, multiple accountants' sites). Non-UK sellers supplying taxable services in the UK: a single blog says threshold is zero (register from first sale). Likely; needs HMRC check.
- EU: non-EU digital service sellers to consumers have no threshold; register via non-Union OSS in one member state, VAT due from first sale at the customer's country rate; the EUR 10,000 threshold applies only to EU-established sellers; some states may require a fiscal representative. All from consultancy/vendor guides, no Commission page retrieved. Likely.
- US: economic-nexus sales-tax rules by state (commonly cited $100k or 200 transactions) and SaaS taxability vary: not researched this session. Speculative until checked; merchant of record sidesteps it.
- Discord remits transaction tax on Premium Apps sales (see 5.1); a merchant of record covers off-Discord sales.

### 5.4 Entity needs (largely general knowledge; not verified this session; speculative/likely)
- Discord monetization needs a team-owned app, team owner 18+, and a team in US/EU/UK for payouts: practically an LLC/Ltd, or the owner individually as sole proprietor, plus a business bank account for Stripe payouts.
- A legal entity separates personal liability from the product. Blizzard Dev ToU requires an indemnity from the app owner, and Discord/Stripe terms bind the team owner. No limited liability if sole proprietor. Recommended: LLC (US) or UK Ltd before first paid sale (my recommendation, likely).
- Ownership: IP assignment agreements from every contributor (including the outside partner) and a shareholder/operating agreement covering departures, accounts, domain, and the Discord team.
- Contracts to publish: Terms of Service, Privacy Policy (required by Discord and Blizzard Dev ToU), Acceptable Use, Refund Policy, AI-processing disclosure (Anthropic D.3 requires telling users outputs may be inaccurate), DMCA/takedown contact, "not affiliated with Blizzard" notice.
- Refunds: Stripe notes regional cooling-off periods and may refund within 60 days to reduce chargebacks; consumer-protection law in UK/EU gives cooling-off rights for digital services unless waived properly (likely; not verified this session). Discord Premium Apps has "required support" obligations (not read).
- Support obligations: Discord Premium Apps requires developers to provide support (article not retrieved); MoR providers handle billing queries only.

### 5.5 Pricing benchmarks
- Raid-Helper: EUR 10/3mo, EUR 15/6mo, EUR 25/12mo, EUR 55 lifetime per server (official). Sesh ~ $58.68/yr, lifetime $149.99; Apollo ~ $69.99/yr (competitor-authored table). WoW-specific analytics (WoWAudit, Raider.IO tiers, Archon) pricing not retrieved. Implication: per-server price pressure around $2-6 per month; margin after 5-15% platform/processor fees is thin, and AI inference costs must be bounded per server (likely).

---

## 6. Platform risk and dependence

### 6.1 Cloudflare
- Cloudflare's Self-Serve terms (updated Sep 12, 2025) do not contain a clause forbidding commercial use on Free plans; Free Services come with no liability, can be ended or limited, and "free" lasts until termination by Cloudflare or start of paid term; Cloudflare may suspend or terminate "at any time, with or without notice for any reason". https://www.cloudflare.com/terms/ (2026-11-02). Confirmed.
- Section 2.2.1(h) bars processing or collecting credit card information on web properties receiving Free Services: do not take card numbers through a Free-plan property (use Stripe/Paddle hosted checkout). Confirmed (from summary).
- No SLA in the agreement; services "as is". Confirmed.
- Workers Free limits: 100,000 requests/day (Error 1027 when exceeded), 10 ms CPU per request, 50 subrequests; Workers Paid removes the daily cap, 30 s default CPU (5 min max), 10,000 subrequests; $5/month minimum reported by third parties. https://developers.cloudflare.com/workers/platform/limits/ (2026-11-02, confirmed for table); $5 figure from search snippets (likely).
- Conclusion: running a commercial product on Workers Free is **allowed by the terms I read** but operationally unfit (daily cap, 10 ms CPU, no SLA, discretionary suspension). Treat Paid as the minimum for paying users (likely).
- Account ownership: ToS Sec. 16 says no assigning or transferring the agreement without Cloudflare's consent; Cloudflare may assign freely. The account being the partner's personal account means: the contract party is a person; if they leave, die or fall out, the production Worker, D1/KV data, Zero Trust and DNS are theirs. Fix: create a company Cloudflare account, add partner as member with scoped role, migrate resources, and keep a break-glass owner in the entity. Confirmed (terms); the personal-account fact is from the brief, not verified by me.
- Workers AI under Cloudflare's DPA is a vendor option that avoids a separate AI contract (4 above).

### 6.2 Discord app and team ownership
- Monetization requires the app to be owned by a team and only the team owner can enable payouts; owner must be 18+, 2FA, verified email. Confirmed (docs link in 5.1).
- Consequence: the team owner is a single human; their identity, tax profile and Stripe payout relationship sit on the product. Transfer of team ownership/payout to a new entity was not researched (open).
- Verification of the app (needed for monetization and for privileged intents) is tied to the owner/team identity (likely).
- Message Content intent changes: a third-party blog says a June 2026 change moved review to user-reach thresholds with annual reapplication. Not verified against Discord. Speculative.

### 6.3 Bus factor, domains, accounts
- Single points of failure found in the brief and workspace: partner's personal Cloudflare; owner's ChatGPT account for art; private GitHub repos under one user; secrets in one local folder (workspace rule). Not verified by me beyond workspace notes.
- Domain: must not contain Blizzard marks (Trademark Guidelines; Dev ToU 2(m)); registrar account should be the company's, with WHOIS/registrant the entity; 2FA with shared recovery.
- Anthropic and Gemini API keys must be billing-linked company accounts, not personal.

### 6.4 Before the first paying user (checklist, my synthesis)
1. Incorporate; sign IP assignments; operating agreement.
2. Company-owned: Cloudflare (Workers Paid), domain, Discord team, Stripe/MoR, Google Cloud billing for Gemini, Anthropic org, GitHub org.
3. Written Blizzard inquiry (section 1.7) and strip Blizzard marks from names, domains and listings.
4. Remove Blizzard art; use only original/commissioned/CC BY-SA text with attribution.
5. Separate free (API-driven) vs paid (no Blizzard API data) features in architecture and in the ToS.
6. 30-day TTL job on all Battle.net API data.
7. Privacy Policy, ToS, AUP, refund policy, AI-processing disclosure, DMCA contact, "unofficial" notice.
8. Paid-tier AI vendor with no-training and DPA; no free-tier Gemini for user data.
9. Pick payment rail; confirm tax handling; test refund and chargeback flow.
10. Backup, key rotation, break-glass access, incident contact.

---

## 7. The ten things most likely to block or kill a sellable version (ranked)

1. **Dev API ToU 2(b): no premium versions or charging to access apps using the API.** Any paid feature that depends on Battle.net API data breaches it; Blizzard can revoke without notice. (confirmed text; enforcement likelihood speculative)
2. **No Blizzard license for commercial use of WoW IP.** Trademark guidelines default to non-commercial and bar marks in names, domains and combined brands; no fan-content grant for monetization found. (confirmed)
3. **Product naming/domain/Discord app name containing WoW, Warcraft, Blizzard** (and likely Forever). Risks C&D, store removal, payment rail closure. (confirmed rule; Forever coverage likely)
4. **Blizzard art, screenshots, icons or AI-generated imagery resembling Warcraft designs in the paid product.** Fan-use license is personal, noncommercial and revocable; AI vendor ownership clauses do not clear third-party IP. (confirmed/likely)
5. **Datamined or scraped content (wago.tools CSVs, Wowhead, Icy Veins text) stored in the library.** wago.tools robots.txt blocks crawling; Wowhead/Icy Veins terms restrict copying; Blizzard terms bar datamining. (confirmed for robots; likely for the rest)
6. **Single-person ownership of critical accounts** (partner's personal Cloudflare account, personal ChatGPT for art, one Discord team owner). Loss or dispute kills the product, and a sale would not transfer. (confirmed from ToS 16; the account facts are from the brief)
7. **Discord Premium Apps gating:** US/EU/UK team, owner 18+, verified app, ToS and privacy policy, review before payout; 15-30% fee; parity pricing rule. (confirmed)
8. **AI data handling:** Gemini free tier trains on and human-reviews content and prohibits under-18-accessible clients; Discord forbids AI training on message content; Dev ToU 2(h)/(i) on transferring Data. (confirmed/likely)
9. **Cloudflare Workers Free in production:** 100k requests/day cap, 10 ms CPU, no SLA, suspension at will; account not company-owned. (confirmed)
10. **Tax, entity and consumer-law gaps:** VAT/sales tax registration (non-EU sellers owe EU VAT from the first sale), MoR eligibility (Stripe requires rights/licenses), refund and cooling-off rules, no entity limiting liability while indemnifying Blizzard (Dev ToU 6). (confirmed for Stripe/Dev ToU; likely for VAT)

## 8. What to ask a lawyer

1. Is a subscription tier compliant if it uses no Battle.net API data but shares a bot and database with free API features? Where is the safe line under Dev ToU 2(b), 2(e), 2(h)? Should we seek a written Blizzard confirmation or license?
2. Does "World of Warcraft: Forever" fall under Blizzard's registered marks; what is the safest nominative-use wording for descriptions, store listings and the privacy policy; is "Guild Companion for WoW Forever" in a Discord bot description acceptable?
3. Can we host a knowledge library mixing our own text, CC BY-SA Warcraft Wiki text, and facts about items/spells, and what do ShareAlike obligations mean for derived records, search indexes and AI answers?
4. Are game facts (stats, drop rates, item names, spell effects) protectable; what is our exposure for storing them even when extracted by hand?
5. AI art: ownership of the painted assets; whether prior images generated on a personal ChatGPT account can be assigned to the company; risk assessment of art that evokes Warcraft; fair use of fan art in a commercial product.
6. Does passing API data or Discord messages to Gemini/Anthropic/Workers AI breach Blizzard Dev ToU 2(h)/(i) or the Discord Developer Policy? Required disclosures and DPAs.
7. Entity form and jurisdiction (US LLC vs UK Ltd), IP assignment from contributors including the outside partner, deadlock and exit terms, who owns the Discord team and payout account.
8. VAT and sales tax registration path for a non-EU/UK entity; choose Discord Premium Apps vs Stripe Managed Payments vs Paddle; consumer cooling-off and refund policy for digital subscriptions; COPPA/GDPR-K for teens in Discord communities.
9. Terms of Service, Privacy Policy and AUP drafts including limitation of liability, DMCA agent registration, takedown process.
10. Whether to approach Blizzard proactively (partnership/licensing) or operate quietly under tolerance, given revocability and the cost of a C&D after revenue exists.

## 9. Open questions I could not settle

- Whether a current Blizzard "fan site policy" or "fan content policy" with monetization rules exists; not found (page 404s and search gaps).
- Whether Blizzard has said anything about premium tiers for Forever apps or revised the Dev API ToU since Oct 2019 beyond the page's date.
- Forever API namespace, availability and whether Forever characters are visible to Profile API (realmless?). Unverified until Nov 4 launch.
- Wowhead's terms of service (all fetch attempts 404); Wowhead tooltip embed commercial rules.
- wago.tools terms and the license on WoWDBDefs.
- Icy Veins current Terms text (403), Method and other guide sites' terms.
- Discord support-center articles (Premium Apps Payout, Required Support, Monetization Terms, Developer Policy): fetches 403; fee, tax and support obligations rely on search snippets and the docs/blog pages.
- Exact Stripe Managed Payments fee, Lemon Squeezy's future, Polar's current tiers (secondary sources conflict).
- Paddle AUP on gaming/IP products (404).
- OpenAI business terms, retention, DPA (403).
- Anthropic terms version in force (fetched copy dated Jun 17, 2025).
- Midjourney primary terms (stub only).
- US state sales-tax nexus for SaaS; UK/EU consumer cooling-off specifics; entity costs and filing requirements.
- Whether Blizzard treats "premium features that share a bot with free API features" as a violation. No Blizzard statement found.
- Wowhead/Warcraft Logs/Raider.IO private arrangements with Blizzard (if any) cannot be known from public pages.

## 10. Surprises versus what a team would assume

1. The Dev API ToU, not the EULA, is the hard monetization wall, and it is explicitly anti-premium for any app using the API. The ToU is from 2019 and is silent on Forever.
2. There is no "Blizzard Fan Content Policy" like Wizards of the Coast's or Riot's; Blizzard uses scattered activity policies, and the trademark rules say non-commercial by default.
3. "Free addon, paid companion/guide" is the actual industry workaround, tolerated but never approved. Its legal basis is silence, not permission.
4. The Dev ToU requires deleting API Data after 30 days. A "knowledge library" cache of API data is itself non-compliant after a month.
5. Blizzard's trademark rule bans marks in the product name and URL, so "WoW Forever Companion" as a brand is out; even "Forever" may be affected.
6. The Cloudflare Free plan is not contractually non-commercial; the limits are technical (100k requests/day, 10 ms CPU) and the account holder's identity is the real exposure.
7. Gemini's free tier is legally unusable for EU/UK users in the sense that those users get paid-tier terms and developers there must use Paid Services when exposing an API client to users.
8. CC BY-SA from the Warcraft Wiki does not clean Blizzard's underlying text and images; and ShareAlike can "infect" adapted text.
9. AI-generated art has weak or no copyright, but the bigger risk is derivation from Blizzard IP, which vendor ownership clauses do not address.
10. Discord's Premium Apps are available only to US/UK/EU teams, require pricing parity with any other checkout, and charge 30% after the first $1M of lifetime gross sales per team.
11. Stripe's merchant-of-record product explicitly requires that you "hold all necessary rights and licenses" to the product, which ties payments eligibility back to the Blizzard IP question.
12. Blizzard's visible legal enforcement targets private servers, not data or tool sites; but nothing in Blizzard's terms commits it to that.
