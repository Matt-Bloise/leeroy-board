# Library audit

Audit of the ranked fact library that feeds `/ask`: `data/library/*.json` at master `714cbf0` (library build `1.60.1.70532`, `index.json` generated 2026-11-14), read the way the Worker reads it. Audit date 2026-11-15, 11 days after launch (Wed 2026-11-04, 18:00 EST, `data/launch.json`).

**How the Worker reads it.** `infrastructure/scripts/seed-d1.mjs` loads each shelf file into D1 `lib_pages` (`facts_json` keeps each fact's `key`, `value`, `depth`, `refs`) and into `lib_sources`. `ai-models.js` `getParsedLibraryData` reads `id, category, title, as_of, blurb, aliases_json, facts_json, open_json`, `rank-core.js` ranks the facts, and `buildAnswerInputs` shows the model only `  - [<page>~<key>] (score n): <value>`. Tier, ref date, depth and page confidence are not in the prompt (see F-01). Scope: 71 pages, 1,521 facts, 11 shelves. I did not use the network and did not check any fact against its source: every number below is a consistency finding, never a claim that a value is right or wrong.

Severity: **High** can make an answer wrong or a stored row wrong; **Medium** weakens trust or traceability; **Low** is hygiene; **Info** is recorded, no action.

## Counts per finding class

| Class | Findings | Highest severity |
| --- | --- | --- |
| Citation-format breakers | 0 | none |
| Imperatives aimed at the model | 0 real, 2 false positives | none |
| Internal contradictions between pages | 0 found by the checks run; 3 conflicts the data already states in-fact (listed) | Info |
| Facts without a source (no `refs`) | 296 facts on 47 pages | Medium |
| Facts without a tier or ref date | 0 (every ref has tier and `accessed`); see F-01 for the prompt never showing them | n/a |
| Source-id collision (code + data) | 1 (31 of 34 ids point at more than one URL) | High |
| Stale-looking given launch state | 29 candidate facts, 6 confident (F-04), 42 pages dated before launch | High |
| Confidence label overstates support | 23 pages (core facts with no tier-1 ref on a `confirmed` page) + 6 facts where a "datamine" statement carries a tier-1 ref | Medium |
| Duplicated facts | 6 same-value pairs across pages, 2 repeated keys, all identical meaning; 0 different values | Info |
| Numbers that look invented or inconsistent | 0 provably wrong; 4 items needing a primary-source check | Medium |
| Page title versus content | 0 mismatches; 1 slug/title naming difference | Low |
| Derived-file drift (`index`, `schema`, `diff`, `raids`, `refresh`) | 5 | Low |

## Findings

### F-01 (Medium) The prompt never shows a fact's tier, date or confidence
`ai-models.js` builds the fact line from `h.page`, `h.key`, `h.score`, `h.value` only. A tier-3 forum post and a Blizzard article read the same to the model, and the model cannot say "per a datamine" unless the sentence is already in the value. Many values do carry the origin in prose, which is why F-05 and F-06 matter. Proposed: include the best ref tier and `as_of` in the line (a code change with prompt-cache and test impact, so not made here). Related: `seed-d1.mjs` defaults a missing tier to 2 and a missing page `confidence` to `"confirmed"`; today nothing is missing, but a future gap would be upgraded silently. Proposed: fail the seed on a missing tier or confidence.

### F-02 (High, code and data) Source ids are page-local but stored as global
Ref ids are `S1` to `S34`, reused on every page (`S1` appears on 54 pages). 31 of the 34 ids point at different URLs on different pages (330 distinct URLs in all). `seed-d1.mjs` fills `lib_sources` with `if (!sourcesMap.has(r.id))`, so the first page's URL wins and 296 of 330 URLs never reach `lib_sources`; `scraper.js` then checks those rows, and any consumer that joins a fact's ref id to `lib_sources` gets another page's source. Within one page ids are consistent (no clash). Proposed: key `lib_sources` by URL (or `page + id`). Not applied: it changes the seed and D1 contract.

### F-03 (Medium) 296 facts have no `refs`
All 296 are `open`-style facts the library keeps without a machine-readable source. 88 name an origin in prose ("client 70450", "datamine", "tooltip", "table build"); the rest name none. Pages with the most: `classes/mage-talents` 27, `systems/merchants-favor` 19, `systems/books-and-secrets` 18, `professions/tailoring` 17, `systems/legacy-perks` 16, `ui/addons` 18, `systems/reputations` 15, `professions/enchanting` 14. Examples: `leveling/xp~xp.total_to_60` ("4,084,700, the Classic curve"), `leveling/xp~xp.step_29_to_30` ("about 47,400"), `dungeons/overview~group_finder.tabs`, every `gf_entry_level` key on the two returning-dungeon pages, `leveling/zones~wetlands.level_range` ("beta Group Finder data"). Proposed: add a ref or an explicit origin phrase to each; **needs primary-source check** for every number in this list. Not auto-fixable: the source is unknown to me.

### F-04 (High) Stale-looking items after launch (Nov 4)
Confident cases (the wording is a future or "not live yet" state that the page's own date cannot support on Nov 15):
- `classes/hunter~hunter.tuning.nov10_planned`, `classes/shaman~shaman.enhancement.tuning.nov10_planned`, `classes/warlock~warlock.tuning.nov10_planned`: "Planned for a Tuesday, Nov 10 hotfix and not live yet". Nov 10 is five days past. Proposed: re-check whether the hotfix shipped; replace with the outcome or mark the date as past. **Needs primary-source check** (Blizzard hotfix notes). Warlock page is `as_of` 2026-11-10, hunter 2026-10-26, shaman 2026-10-18.
- `systems/rulesets~rulesets.rp_pvp`: "arrives with launch on Nov 4 and is planned for Early Name Reservation from Oct 27" (future tense for events that are over).
- `ui/macros-and-settings~macros.system`: "expected to match Mainline ... untested in the live client"; the client has been live 11 days. **Needs a live check.**
- `raids/barrow-deeps~barrow_deeps.lockout`, `raids/hyjal-summit~hyjal_summit.lockout`: "weekly reset, currently planned"; raids open Dec 9, still correctly future, so keep, but re-check on Dec 9.

Page-level: 42 of 71 pages have `as_of` before launch and 33 have `checked` before launch (10 pages are still dated 2026-10-18). Pages and blurbs written in beta tense, for example `dungeons/new-dungeons-35-plus` ("none has been played outside Blizzard"), `dungeons/city-of-dalaran` ("opened for beta testing"), `systems/books-and-secrets`, `professions/overview~professions.untested_range` ("the beta capped at level 30"). Beta-history facts (`history/*`, `events/beta-and-stress-test`) are correctly past-tense and are fine. The other 20 or so candidates in the stale scan (stress test, Name Reservation, "at launch") are accurate history and need no change. Proposed: a re-check pass on the 33 pre-launch-checked pages; no `recheck_days` field is enforced (values 7, 14, 90).

### F-05 (Medium) Page confidence overstates support
23 pages are `confirmed` while one or more of their `core` facts carries no tier-1 (Blizzard) ref: `classes/druid`, `hunter`, `mage`, `paladin`, `priest`, `rogue`, `shaman`, `warlock`, `warrior` (all on `<class>.difficulty`), `dungeons/city-of-dalaran`, `excavation-site-wetlands`, `hall-of-thanes`, `ruins-of-lordaeron`, `dungeons/overview`, `leveling/xp`, `leveling/zones`, `professions/overview`, `races/horde-racials`, `raids/level-60-gear`, `systems/gold-and-riding`, `ui/addons`, `ui/macros-and-settings`. Proposed: downgrade the page to `likely`, or mark the page's core facts individually. **Needs a decision on what `confirmed` means** (the `index.json` label says "Blizzard or the game files say it directly"; game-file facts may be legitimate here without a tier-1 ref).

### F-06 (Medium) Datamine wording on a tier-1 ref
Six facts say "datamine" or "unconfirmed" in the value but carry only tier-1 refs, so tier and text disagree: `classes/mage-talents~mage.talents.arcane_meditation_prereq` ("Arcane Concentration (datamine, Oct 18)", ref `worldofwarcraft.blizzard.com`), `classes/warlock~warlock.demonology.demonic_brand`, `dungeons/new-dungeons-35-plus~alcaz_prison.description`, `races/horde-racials~racial.orc.blood_fury`, `raids/barrow-deeps~barrow_deeps.boss_names_vs_blizzard`, `raids/hyjal-summit~hyjal_summit.boss_names_vs_blizzard`. In the last two and the Orc one the tier-1 ref supports the Blizzard half of a mixed statement; split the fact or add a tier-3 ref. **Needs primary-source check** for the first.

### F-07 (Info) Conflicts the library already states
Recorded so nobody re-reports them as hidden: `classes/hunter~hunter.trueshot_aura` (21-point medal per Blizzard, 16 per client data); `systems/legacy~legacy.reward_thresholds` (toy 15 per one site, 10 per another); the Mage spellbook `top_rank` facts, where the "at 60" client value and the Wowhead "rank max level N" tooltip value differ by design and both are labelled. Proposed: **needs primary-source check** before either side is promoted.

### F-08 (Info) Duplicates
Identical-meaning repeats, none with different values: `events/raids-dec-9~hyjal_summit.extras` and `raids/hyjal-summit~hyjal_summit.loot_headline` ("new tier sets and a legendary"); `barrow_deeps.lockout` and `hyjal_summit.lockout`; `barrow_deeps.legacy` and `onyxia.legacy_challenge`; `hall_of_thanes.status` and `ruins_of_lordaeron.status`; the Alliance warrior/rogue and Horde hunter/shaman race lists on `races/overview`; keys `onyxia.size` (40) and `onyxia.opens` (2026-12-09) on both `events/raids-dec-9` and `raids/onyxias-lair`. These are per-topic restatements that serve retrieval on each page and are not removed: deleting one side changes which page answers. No safe mechanical merge exists.

### F-09 (Medium) Numbers that need a primary-source check (none provably wrong)
Cross-page checks that agreed: launch 18:00 EST = 23:00 UTC = 3 PM PST and every regional time in `launch.regional_times`; raid sizes 10 / 20 / 40 and boss counts across `events/raids-dec-9` and the raid pages; level cap 60 and riding 40 / 60 on every page that states them; Legacy 65 challenges, 3 raid points, spend cap 16, books 40 = 26 + 14; Mage tree totals 54 = 19 + 17 + 18; Mage layouts 10/0/41 and 2/36/13 each sum to 51. Items I could not settle: `leveling/xp` totals (4,084,700 total, 47,400 step, no ref); `classes/mage-spellbook~mage.arcane_blast.hotfix_70425` (ambiguous "364 to 424 and 71.4% to 218 to 254 and 42.9%" reads as two ranges and two coefficients, source not named); the `~` of per-spell client numbers (all "client table build 70532", datamine, not re-read); `professions/tailoring~tailoring.route_225_300` (a third-party whole-run estimate stored as a fact). Also `index.json` totals `news: 124` and `blizzard: 696` do not match `news.json` (17 items) or the count of tier-1 facts (681) or tier-1 refs (813); the definitions are not documented. **Needs primary-source check / owner confirmation.**

### F-10 (Low) Derived files lag the shelves
`raids.json`, `professions.json`, `races.json`, `history.json`, `tooltips.json`, `glossary.json`, `plainwords.json`, `diff.json` and `schema.json` say `generated` 2026-11-01 while `index.json`, `search.json` and `open.json` say 2026-11-14 and the raid pages are dated Nov 14 (the file stamp is older than its own content). `schema.json` lists `classes.json` as 278,089 bytes, the file is 243,727. `refresh.json` has no `generated`. Proposed: regenerate and stamp from one script. The `search.json` idf table is built from the shelf text, so a regenerate also refreshes ranking.

### F-11 (Low) Naming
No page title contradicts its content or blurb. `dungeons/new-dungeons-35-plus` is titled "New dungeons 35 to 60" (slug says 35-plus). 778 fact keys use a different prefix from the page slug (for example the three Mage pages all use `mage.*`); keys are unique per page and the format holds, so this is convention only. Facts are mostly full sentences; about 22 are bare values (`13`, `40`, `none`, `8`) that read correctly only next to their key, which the prompt does show.

### F-12 (Info) Citation format and imperatives
`[page~key]: value` holds for all 1,521 facts: no `[`, `]`, `~`, newline, control or zero-width character in any key or value; keys match `[a-z0-9_.-]+`; page ids match `shelf/slug`. Five values contain `>` (menu paths such as "Options > System > Preset"), harmless. No value opens with or contains an instruction to the model. Two matches of an "always" or "never" scan are descriptions of game rules: `classes/mage-talents~mage.arcane.improved_counterspell` ("always silences for 2/4 s") and `pvp/progression~rank_points.spent` ("never spent: ..."). No fix needed.

## What was changed

No data was edited: the audit found no mechanical, provably safe correction (no format breaker, no duplicate with a safe side to remove). Everything with a content or code consequence is listed above for an owner to decide.

Added `tests/unit/library-audit.test.mjs`, one guard per class of mechanical check, passing on the data as audited and failing on a regression: citation format, key and page-id uniqueness, ref shape (https, host match, tier 1 to 3, past ISO date), page metadata (as_of, checked not before as_of, core keys exist), `index.json` counts, and no instruction-shaped values. A first test proves the checkers fire on bad input.

## Could not verify

- Any fact against its source (no network use, no primary-source reads).
- Whether the Nov 10 hotfixes, RP-PvP, macro behaviour or the pre-launch numbers are true now (F-04).
- What `confirmed` is meant to promise (F-05) and the definitions of `index.json` totals (F-09).
- Whether any consumer other than `scraper.js` reads `lib_sources` by ref id (F-02).
- Real-model behaviour with these facts: the only checks were on the stored data.
