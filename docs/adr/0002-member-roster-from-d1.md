# ADR 0002: The member roster lives in D1, not in code

Status: PROPOSED, revised after an outside review (see "Council review"). Step 1 is implemented behind the flag `ROSTER_FROM_D1` (default off everywhere) and behind a code interlock: while the constant `ROSTER_STEP2_READY` (`worker/roster-source.js`) is `false`, the flag on is refused and behaves as off, for auth and redaction alike. The later steps are not started. Only the step 2 PR flips the constant.
Date: 2026-11-15
Work item: w-20261115-09
Scope: where the names and builds of the real party members come from, who the default admin is, and what the redaction layer uses to hide the names.

Citations are `file:line` on `master` at 714cbf09 unless marked "after step 1". Nothing in this ADR names a real member: members are called "member #N" by their position in the built-in list (1 to 5). Unknowns are labelled **(unverified)**.

## Context

This repository is public. The real members' names, their race, class, spec, professions and the builds derived from them are committed in code, data files, tests, docs and the addon packaging. A name that is in a public repository cannot be taken back, and the privacy layer (`worker/privacy/*`) promises that real names never reach an outside model. Today that promise rests on a list that is itself in the public repository (`privacy/roster-config.js:5-7` already says first names "do not exist in the repo (policy: never stored here)" and injects them at runtime; the display names have no such protection).

Partial work already exists. The roster is half-dynamic:

- `party-source.js:8-14` `PARTY_MEMBERS`: five hard-coded sheet entries. `mergePartyMembers` (`:29`) puts them first, then adds members from the party document (`kv_state 'party'`). `loadPartyMembers` (`:42`) is the D1 reader.
- `bot-data.js:568` `ROSTER_DATA`: five `{ display, aliases }` entries. `mergeRoster` (`party-source.js:52`) puts them first, then adds `kv_state 'discord_members'` (`config.js`, admin-only config row). `loadRoster` (`:63`).
- Built-ins win for the five people they describe. Everyone else already comes from D1, so adding a sixth person needs no code change.

What is still in code is the five real ones, and three behaviours that depend on them:

1. **Auth.** A signed-in member is matched against the built-in list first (`index.js:70`). The admin token resolves to `PARTY_MEMBERS[3]` (`index.js:81`), member #4, by array position. Reordering or editing the array silently changes who the admin acts as.
2. **Redaction.** The tokeniser and the outbound guard take their keys from `ROSTER_DATA` through `researchMembers()` (`privacy/roster-config.js:21-27`). Names from the party sheets are added at request time (`researchMembersFor`, `:52`), but the base list is code.
3. **Everything else that spells a name:** voice and format lints, prompt text, ask-build, data files, tests, docs, packaging.

## Decision

1. **The roster lives in D1, never in code.** One new admin-only config row, `kv_state 'party_roster'`, written by `PUT /api/config/party_roster` with the admin token and never readable through a public route (`config.js` `PRIVATE_EXACT`, no GET route). D1 is the choice: it is already the store for `discord_members` and the party document, and editable without a deploy. A Worker secret as a second source is NOT part of this decision (no precedence, freshness or rollback semantics are defined); see Open questions.
2. **Shape** (`worker/roster-shape.js`):

   ```json
   { "version": 1,
     "default_admin": "<slug of one member>",
     "members": [ { "slug": "...", "name": "...", "race": "...", "class": "...",
                    "spec_path": "...", "spec_at_40": "...", "professions": ["..."], "plan_zone": "...",
                    "aliases": ["lowercase", "..."], "first_names": ["..."] } ] }
   ```
   `aliases` default to the lowercase name. `first_names` feed the privacy layer only and never reach a sheet. Validated on write (`validateRosterConfig`): 1 to 50 members, unique slugs, lowercase aliases, `default_admin` must be one of the slugs.
3. **The default admin comes from config, not array position.** `default_admin` names a slug. With a valid row the admin token resolves to that member. Two policies, deliberately different by phase:
   - **Step 1 (built-ins still exist):** a missing, unreadable or invalid row means "no D1 roster": the code behaves exactly as with the flag off, built-in default admin included. This is a transitional compatibility choice, not the end state.
   - **From the step that removes the built-ins (step 6):** fail closed. No valid roster means the admin token resolves to no member (401 on member routes) and no outside model call is made. The admin-only routes use `adminGate`, which does not use the roster, so the row can always be repaired with the admin token.
4. **Code ships only a fictional sample roster**, used by previews, local dev and tests. It contains no real person. Until the migration finishes the real built-ins stay as the fallback, which is why the flag falls back to them (see Rollback).
5. **The redaction source follows the same roster.** While built-ins exist, the redaction roster is the union **per redaction key** of the D1 roster and the built-ins: display name, aliases, first names, character names and the D1 slug. A key is covered if any source covers it. A D1 member whose display name has the same skeleton as a built-in gets that built-in's aliases and first names merged into it (so a D1 row that omits or changes aliases never uncovers a built-in alias); a built-in with no such D1 member is kept whole; D1 members come first; keys are deduplicated by skeleton. The first-name source (a runtime injection keyed by built-in position) applies to built-ins only. Union can only add coverage; switching the flag on can never uncover a key the built-ins covered. The union exists only while built-ins exist; step 6 ends it.

## Consumers

Verified by reading each (`git grep` over the tree at 714cbf09) and by counting hits. Real-name hits outside tests: 33 files.

### Worker: roster and auth (code that decides who someone is)

| Consumer | Where | What it does with the built-ins | Step |
|---|---|---|---|
| `PARTY_MEMBERS` | `worker/party-source.js:8` | the five sheet entries, base of `mergePartyMembers` (`:29`) and the fallback in `loadPartyMembers` (`:47`) | 1 (read side), 6 (remove) |
| Auth member match | `worker/index.js:70` | built-in list searched before D1 | 1 |
| Default admin | `worker/index.js:81` | `PARTY_MEMBERS[3]` | 1 |
| `ROSTER_DATA` | `worker/bot-data.js:568` | base of `mergeRoster` (`party-source.js:52`, `:67`); `discord.js:748` finds the asker's display by it | 1 (read side), 6 |
| Project reserved slugs | `worker/project-build.js:14`, `:61` | `reservedSlugs` are the built-in slugs | 2 |

### Worker: redaction (privacy)

| Consumer | Where | Step |
|---|---|---|
| `researchMembers()` | `worker/privacy/roster-config.js:21-27`, `:38`, `:52` | 1 (override added) |
| Tokeniser and name map | `worker/research/claude.js:112-120`, `:165`, `:202` (all through `researchMembers*`) | follows `researchMembers()` |
| Outbound guard | `worker/privacy/outbound-guard.js` (self-contained; takes the roster passed in) | follows `researchMembers()` |

### Worker: text that spells names (prompt, voice, lint, build)

| Consumer | Where | Step |
|---|---|---|
| `ROSTER_DATA` for voice aliases and the ask name strip | `worker/ai-models.js:25`, `:48`, `:908` | 2 |
| Literal party sentence in the prompt | `worker/ai-models.js:1013` | 2 |
| `MEMBER_NAMES` | `worker/answer-format.js:19`, `:30`; `worker/answer-lint.js:9`, `:209` | 2 |
| `ROSTER_DATA` for build lookups and `HOUSE` | `worker/ask-build.js:4`, `:43`, `:188` | 2 |
| Names in comments or fixtures | `worker/eval.js:183`, `:220`; `worker/limits.js:38`; `worker/self-rag.js:68` | 2 |
| `member-model.js`, `sheet-values.js`, `tonight-copy.js` | no real name found in them (0 hits each): not consumers of the real roster by name. **(unverified)** that they do not take a name from a caller | none |

### Data files and the front end

| Consumer | Where | Step |
|---|---|---|
| Party document | `data/party.json` (7 hits) | 6 |
| Sign-ups | `data/signups.json` (10 hits) | 6 |
| Builds that must match the party document | `data/decide.json`, `data/tonight.json`, `data/client.json`, `data/guided-atlas.json` (builds and names, matched on content, not on a name string, so the `git grep` count under-reports them) | 6 |
| Other data and docs | `data/actions.json:989`, `docs/cinematic/intent.json:42` | 6 |
| Front end | `js/roads-buffs-core.js:15-16`, `scenes/probe.js:158,183,186,216`, `privacy/index.html:39` | 6 |

### Seed, preview, local dev

| Consumer | Where | Risk |
|---|---|---|
| D1 seed | `infrastructure/scripts/seed-d1.mjs:70` seeds `signups` (and the other data docs) from `data/` | the deploy seeds only when `kv_state` has 0 rows (`.github/workflows/deploy-cloudflare.yml:293-302`); a populated production D1 never re-seeds, so a data file changed later does not reach production |
| PR preview seed | `.github/workflows/pr-preview-cloudflare.yml:337-` same guard | a preview seeds from whatever `data/` holds |
| Local check and browser runs | `tools/local-check.sh:38`, `tools/local-browser.sh:53` run `seed-d1.mjs --local` | a developer's local D1 gets the data files |

### Tools

| Tool | Where | Note |
|---|---|---|
| `tools/add-member.mjs` | `:76` (text that tells the operator to edit the built-ins) | must stop telling people to edit code; step 8 |
| `tools/import-signups.mjs` | `:33` imports `slugify` from `add-member.mjs`; takes `--party-file` | reads names from a file, no built-in list: low risk |
| `tools/first-paint-measure.mjs` | **(unverified)** it carries no real-name hits; it may load pages that show them | measure against the fictional seed in step 5 |
| `infrastructure/scripts/test-endpoints-parity.mjs` | `:15`, `:64` asserts `ROSTER_DATA.length === 5` | pins the count to the built-ins; step 6 |
| `tools/check-secret-scope.sh` | `:6` | comment or example text |

### Tests

- 25 unit test files and 8 browser test files contain a real name (counted with `git grep -l`; the earlier audit estimated 20 and 17, this count is the file count in the tree today). Plus `tests/fixtures/api-snapshot/snapshot.json`.
- A5 party-source tests and the sign-up seed tests pin the data files to the built-ins (`tests/unit/join-flow.test.mjs`, `tests/unit/sheets-reconcile.test.mjs`, signups-seed tests). They fail by design when a data file and a built-in drift, which is the safety net for steps 5 and 6 and the reason those steps change tests and data together.

### Elsewhere

`LICENSE.md` (3), `CONTRIBUTING.md` (1), `addon/LeeroyBuild/LeeroyBuild.toc:4`, `addon/LeeroyBuild/LeeroyBuild_Forever.toc:4`, `addon/LeeroySpike/LeeroySpike.toc:4`, `landing/addon/LeeroyBuild-0.1.0.zip` (a binary: the `.toc` inside it carries the author line), `docs/privacy.md`, `docs/answer-claims.md`, `docs/runbooks/ci-secrets.md`, `docs/runbooks/rotate-salts.md`, `docs/roadmap/*` (5 files). `wrangler.toml` has no name hit; the flag lives there. Author attribution in LICENSE, CONTRIBUTING and the addon is a separate question (a copyright holder is not a roster entry); this ADR does not decide it, see Open questions.

## Migration order

Small steps. Each is one PR and reversible on its own. Only step 3 writes production data, and it writes one additive row.

1. **Flag and read side (this PR).** `ROSTER_FROM_D1`, default off. With it on, `party_roster` supplies the auth member match, the default admin, the base of `loadPartyMembers` and `loadRoster`, and the redaction roster (union with built-ins). Off: byte-identical. No data file touched. Known limitation, held back by the interlock: the redaction override is module state, set by `primeRosterPrivacy` where research privacy is about to run (`ai-models.js`), which concurrent requests can race (see Risks). With `ROSTER_STEP2_READY = false` the override is never set and the flag on is refused.
2. **Gates before the flag may be turned on in production.** One PR, still flag-gated:
   - Flip `ROSTER_STEP2_READY` to `true` in this PR and only in this PR; the step 1 interlock test (`ROSTER_STEP2_READY` is `false`, flag on changes neither auth nor redaction) is replaced by the snapshot tests.
   - Keep the per-key union of Decision 5 (F1): with the module override gone, the snapshot's privacy members are still the union per key of D1 and the built-ins, tested with a D1 row that names a built-in with no or different aliases.
   - Evaluate the flag and resolve the roster **once per operation** and pass that snapshot down through auth, membership, prompts, tokenisation and the outbound guard. Remove the module-level override (`setRosterOverride`).
   - Move the text consumers (prompt party line, `MEMBER_NAMES`, `ROSTER_DATA` uses in `ai-models.js` and `ask-build.js`, `project-build.js` reserved slugs) to read that snapshot, so flag on means one roster everywhere and there is no split state.
   - Privacy fails closed with the flag on: no resolved roster means no outside model call, on every entry point including cron and `waitUntil` work.
   - Write validation rejects alias and name collisions across the roster, the party document and `discord_members`, with a stated normalisation (the case and Unicode skeleton the tokeniser uses).
   - Measurable gates, with privacy-safe counters (revision, source, initialisation failures, blocked calls), not a one-day smoke test.
   - PR 333 interplay (sheet bootstrap). The bootstrap path (`infrastructure/worker/index.js` ~374-381) turns every base roster field into a `visible: true`, `source: "board"` sheet field. With D1 as the base, admin-only row data (race, class, spec, professions) would become public sheet values. Step 2 must prove, with tests, that: hidden fields stay hidden through that path; composites are withheld when any member hides any field; `first_names` and `aliases` never reach a sheet or a public route.
   - Reviewer-derived gates, each with a test:
     - A per-operation roster snapshot replaces `setRosterOverride`, with a concurrency test (interleaved flag-on and flag-off requests, plus `waitUntil` work).
     - Privacy fails closed on every entry point: no resolved roster means no outside model call.
     - Text consumers read the same snapshot.
     - A revision-checked fresh roster read.
     - An auth policy for a built-in member absent from the D1 row (today this falls through to the party document or a 401, `index.js` ~77-80).
     - `/admin/export` handling of `party_roster`.
     - Cross-source collision validation (roster, party document, `discord_members`).
   - Step 1 caveat: `PUT /api/config/party_roster` is live at step 1 (`config.js:13`). "Only step 3 writes production data" is procedural, not enforced by code; the flag-off default and the interlock are what keep a stray row inert.
3. **Write the real row to D1** by hand with the admin token (`PUT /api/config/party_roster`), in the owner's shell, not in a repository. Turn the flag on. Verify every member and the default admin, an `/ask` privacy run on a warm and on a cold isolate, a cron-first run, and that `/admin/export` carries the row (it does; see Risks). Rollback: flag off, then delete the row. There is no DELETE config route, so deleting is `wrangler d1 execute <db> --remote --command "DELETE FROM kv_state WHERE key = 'party_roster'"` in the owner's shell (or overwrite it with `PUT /api/config/party_roster`).
4. **Fictional end-to-end seed (additive).** Add `worker/sample-roster.js` and a fictional copy of the data documents and test fixtures, new files only, nothing deleted. Previews and local dev seed the sample roster into `party_roster` and the fictional documents, and run with the flag on, so they contain no real name end to end.
5. **Switch tests, previews and local dev to the fictional seed**, one area per PR (unit tests, browser tests, the API snapshot, front-end fixtures). The A5 tests that pin data to the built-ins are changed in the same PR as the data they pin.
6. **Remove the real built-ins and the real data** in one PR so the A5 safety net is never disabled: `PARTY_MEMBERS` and `ROSTER_DATA` become the sample, `data/*` and the packaged files carry the fictional documents, the parity script and the A5 tests move with them, and the fail-closed policy of Decision 3 takes effect. The flag stays as an emergency switch until step 7. Merge only after step 3 has run clean in production for at least a week. Production D1 is not re-seeded (the seed guard: only on 0 rows), so the live data is unchanged by these commits; the owner updates the live party document through the normal admin path.
7. **Delete the flag** after a further clean week, with explicit acceptance: the fail-closed behaviour is tested, the roster row is in the last backup, and the rollback below for step 6 has been rehearsed.
8. **Tools and docs.** `add-member.mjs` writes `party_roster` and the party document instead of telling the operator to edit code; docs and runbooks lose the names.
9. **History.** Decide separately whether to rewrite or accept history (see Risks). Not part of this ADR.

## Rollback, per step

Rollback is a supported security state, not only a code state: after the flag has been on, flag off removes D1-only redaction coverage and rejects members that exist only in D1. So rollback of steps 3 onward is "flag off, and do not enrol a member who is not also in the built-ins until the flag is back on".

- **Step 1:** set `ROSTER_FROM_D1` to off in Flagship (or `"off"` in `wrangler.toml [vars]` for a Worker with no binding). The behaviour is today's: the flag is checked first and the `party_roster` key is never read (the differential test records every SQL statement and asserts none touches `party_roster` while off). Leaving the row in D1 is harmless. Full revert: revert the PR.
- **Step 2:** the flag stays off; revert the PR.
- **Step 3:** flag off; delete the row if wanted. D1-only members lose coverage and login until the flag is back on (list which members they are before the first run).
- **Step 4:** revert; previews seed the data files as before.
- **Step 5:** `git revert` per area. No production data touched.
- **Step 6:** the first step that cannot be undone by the flag. Rollback is `git revert` of the PR, which puts the real names back into public artifacts and restores positional admin behaviour, so prefer fixing forward. The D1 row must stay. If an outside-model path is uncertain, disable the outside call rather than revert.
- **Step 7:** `git revert`; the flag returns, defaulting off.
- **Step 8:** `git revert`.

## Risks

| Risk | Detail | Mitigation |
|---|---|---|
| **Default admin** | Auth must not fail open or pick the wrong person. With the flag on and a valid row, the admin token resolves to `default_admin`. A `default_admin` that is not in the roster is refused on write. In step 1 a row that is missing or invalid falls back to the built-in default (today's behaviour); from step 6 it fails closed (Decision 3). The two policies differ on purpose, and the step-1 one is what the flag-off identity proof requires. | Validation on PUT and again on read; tests for configured admin, invalid row, missing row. The admin-only routes use `adminGate`, which does not use the roster. |
| **Redaction coverage** | The commit that moves names out of code must not uncover them for the model. In step 1 the privacy roster is a module-level override set by `primeRosterPrivacy` just before research privacy runs. Concurrent handlers in one isolate can interleave: a request that sees the flag off (or a Flagship timeout, which reads as off) clears the override while another request is mid-flight, and `waitUntil` work can outlive its handler. While the built-ins exist the union keeps their names covered, but a name that exists only in D1 is exposed to that race. | **Gate, step 2:** replace the module override with a per-operation snapshot and make privacy fail closed. **Step 1 interlock:** `ROSTER_FROM_D1` on is refused (behaves as off, for auth and redaction) while `ROSTER_STEP2_READY` is `false`, so the race cannot occur; a test pins the constant to `false` and checks that the flag on changes nothing. In step 1: union with the built-ins, override cleared when the flag is off or the row is invalid (flag off equals the built-in roster exactly), tests tokenise and guard a prompt containing a name, an alias and a first name from a fictional D1 roster. The union is per redaction key (Decision 5): a D1 member that names a built-in keeps the built-in's aliases and first names, and a built-in with no D1 match is kept whole. Test renamed and overlapping members in step 2. |
| **Cache staleness** | `loadConfigKeyStrict` caches 60 seconds per isolate; `PUT /api/config` invalidates only the isolate that served the write. A name added to the roster is unredacted in other isolates for up to 60 seconds, and "add the name first" is not an enforceable boundary. | Step 2 gate: a fresh authoritative read of the roster (or a revision check against the sheet content) before any outside call, with stated stale-on-error behaviour (fail closed). A shorter TTL alone is not accepted as the fix. |
| **Backups and export** | `GET /admin/export` exports every `kv_state` row except `secret%` and `feed_cache:%` (`worker/export.js:36`), so `party_roster`, including `first_names`, enters backup files. A private config key is not private in a backup. | Treat export files as holding real names: owner-only storage, no repository, no shared drive. Step 2 decides whether `party_roster` joins the excluded rows and is backed up by a separate controlled path. **(unverified)** where the owner's backups are stored. |
| **Rollout evidence** | A one-day smoke test shows neither concurrency nor failure safety. | Step 2 gates: checks for every member and the default admin, warm and cold isolates, cron-first execution, a D1 outage and a roster update, with privacy-safe counters (revision, source, initialisation failures, blocked calls; never a value). |
| **Identity integrity** | Unique slugs are not enough: an alias can collide across the roster, the party document and `discord_members`, and two concurrent roster edits can lose an update. Rename and delete have no defined effect on history. | Step 2: collision rejection with a stated normalisation, a revision field checked on PUT, a rename and delete policy. The authenticated binding is the member key or Discord session, not a name (`worker/auth.js`, `worker/members.js`); roster names are display and matching data. |
| **Seed guard** | The deploy seeds only when `kv_state` has 0 rows. A fresh database, a restore drill or a `--allow-create` run seeds from `data/`, which holds real names until step 6. Conversely a populated database never picks up a changed data file. | Step 4 seeds the sample roster for previews and local; step 6 changes the data files; the owner never relies on the seed to carry the real roster. Restore drills use `/admin/export`, which includes `kv_state` and so the roster row. |
| **Previews and local dev** | They have no Flagship binding, so they read the `[vars]` value. Left off, they use the built-ins and still show real names; turned on, they need a fictional `party_roster` row. | Step 4. Until then previews are unchanged. |
| **Tests** | 33 test files carry real names and the A5 tests pin data to the built-ins. Changing one side alone fails CI by design. | Steps 5 and 6 change both sides together, per area. New tests for this ADR use fictional names only. |
| **Public history** | Names already committed stay in git history, forks and clones, and in the shipped addon zip. This ADR does not make them private. | Out of scope: step 9 is a separate decision (history rewrite versus acceptance). Do not describe step 6 as "removed from the internet". |
| **Hot path cost** | Measured with a counting Flagship binding on the first version of this branch: `ROSTER_FROM_D1` was evaluated 1 time on an OPTIONS request, 2 on an admin-authenticated `GET /api/me`, 1 on `GET /health` and 2 on a cron tick; each is a binding call with a 100 ms timeout. | Fixed: the decision is memoised per request (`rosterScope` in `fetch` and `scheduled`), priming moved to the ask path, and the interlock is checked before the flag. Now: 0 evaluations on OPTIONS and on routes that never use the roster, at most 1 on routes that do (tests count them with the interlock open; with it closed, which is the shipped state, 0 everywhere). The config row is already cached 60 s. |
| **Flag disagreement** | Several evaluations in one request (privacy priming, auth, `loadPartyMembers`, `loadRoster`) can see different values, and each can add up to the 100 ms Flagship timeout. | Within one request there is now one evaluation, so auth, loaders and priming agree. Across concurrent requests the module-state override can still disagree; the interlock holds that back and step 2 replaces the module state with a per-operation snapshot. |

## Open questions

1. A Worker secret instead of, or as well as, a D1 row, for stricter separation from `/admin/export` backups? Not decided here: a second source needs precedence, validation, freshness and rollback rules, and a stale secret could resurrect removed identities.
2. Should `first_names` be mandatory? The privacy layer works without them but is weaker for people who are addressed by first name.
3. Author attribution (`LICENSE.md`, `CONTRIBUTING.md`, addon `.toc`) names the author, who may or may not be a roster member. Decide separately from the roster.
4. Where do character names on party sheets (not the roster) belong? They are already picked up by `researchMembersFor` from the sheets at request time; no change proposed.

## Step 1 as implemented

- `worker/roster-shape.js` (shape, validation, converters), `worker/roster-source.js` (`activeRoster`, `primeRosterPrivacy`).
- `config.js`: `party_roster` added to `CONFIG_KEYS`, the validator and the private key list.
- `party-source.js`: `loadPartyMembers` and `loadRoster` take the D1 roster as the base when `activeRoster` returns one.
- `index.js`: `resolveMemberAuth` (member match, configured default admin); `fetch` and `scheduled` run on a request-scoped env.
- `privacy/roster-config.js`: `setRosterOverride`; `researchMembers()` returns the per-key union of the override and the built-ins, or the built-ins exactly when no override is set.
- `roster-source.js`: `ROSTER_STEP2_READY` interlock, `rosterScope` per-request memo; `ai-models.js` primes the privacy roster where research privacy is used.
- `roster-shape.js` validation: version required, name, alias, first-name and slug collisions on the tokeniser skeleton, reserved words, `P<digits>`, one-letter names, regex or markup characters, object-prototype words, empty alias and first-name arrays.
- Flag plumbing: `wrangler.toml` (`ROSTER_FROM_D1 = "off"`), `flagship-flags.txt`, `docs/runbooks/flags.md`, `tests/unit/flags.test.mjs`.
- Tests: `tests/unit/roster-from-d1.test.mjs` (flag-off differential over auth, admin default, membership, redaction roster and the SQL issued; flag-on behaviour; fallbacks; redaction with a fictional roster including aliases and first names; flag plumbing).

## Council review

An outside review (two independent model seats, one round; sent only this ADR text and the public file list) accepted D1 as the source of truth and found the problems below. All are applied above except where noted. The raw answer is kept by the owner outside the repository.

- The module-level redaction override races with concurrent handlers and `waitUntil` work. Step 2 replaces it with a per-operation snapshot. Repeated flag evaluation and flag disagreement: same step.
- The admin policy was contradictory (fail closed versus fall back). Decision 3 now states the two policies by phase.
- Step 2 originally turned the flag on before the text consumers moved, a split state, and steps 5 and 6 deadlocked on the A5 tests. The steps are reordered: gates and consumers first, the real row and the flag only afterwards, and the fictional seed built before the built-ins and the data are removed together.
- The claim that no step touched production data before step 6 was wrong. Corrected.
- Rollback as a security state, export of `first_names`, the undefined secret fallback, identity collisions and a stronger flag-off proof: applied as Risks, Rollback and Open questions. The stronger proof is partly in step 1 (a flag-on-then-off sequence in one isolate); cron, concurrent handlers and Flagship timeouts are a step 2 gate.
- Not applied in step 1: request-scoped snapshots, fail-closed privacy and alias-collision validation. They are step 2 gates. Step 1 is flag-off and must not be enabled in production before them.
