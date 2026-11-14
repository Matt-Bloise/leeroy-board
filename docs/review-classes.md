# Review defect classes (2026-11-14)

Built from the full final report of every independent reviewer that ran on 2026-11-14 (raw reports, not summaries). Fictional names only.
The shared checklist that comes out of this is `tests/review-brief.md`. Evidence for every row: the reviewer's own repro, quoted from its report.

## Reviews read, and the tags used below

| Tag | Review | Subject |
|---|---|---|
| WP-A | weekly post, first review | PR 313, first build |
| WP-B | weekly post, second review (12 fixes) | PR 313 |
| WP-1 | weekly post round 1 | PR 313 at `bfc6d70e` |
| WP-2 | weekly post round 2 | PR 313 at `6321bf2a` |
| WP-3 | weekly post round 3, with the PR 316 blast radius | PR 313 at `62c8f17d`, PR 316 at `f4888635` |
| WP-4 | weekly post round 4 | PR 313 at `1bb28944` |
| WP-5 | weekly post round 5 | PR 313 at `1a871803` |
| S316 | client settle review | PR 316, `js/brain.js` at `f4888635` |
| S318a, S318b | PR 318 review and re-review | PR 318 at `b193b973`, then `031e7f1d` |
| AC-A | ask-composed review A | `claude/ask-composed` at `a5693b86` |
| AC-B | ask-composed quality and measurement | same branch |
| AP-A, AP-B | ask-picked reviews A and B | PR 317 |
| AB | ask bound to the asker | PR 311 |
| CT1, CT2 | public-read contract test, two reviews | PR 312 |
| PD | public data docs | PR 306 |

PR 305 and the socket and private-error reviews (PR 308, 309) have no final report in the session's transcript folder; their fixes are visible as
guards in `room.js` and `live-socket-privacy.test.mjs`. "Not found" is stated here rather than reconstructed.

"Lives now" means on `origin/master` at `11afb34d` unless it says PR NNN (open, not merged) or "added here".
Files marked "added here" are in this PR: `tests/unit/hostile-rows.test.mjs`, `discord-text-limits.test.mjs`, `room-redaction-new-fields.test.mjs`, `flag-off-values.test.mjs`.

## Summary

| # | Class | Real examples | Test lives now |
|---|---|---|---|
| 1 | A stale or cached document wins | 9 | partly (PR 318 branch; purge only by hand) |
| 2 | Event ordering assumed | 5 | partly (`brain-rsvp-restamp`) |
| 3 | Null or non-object rows crash a handler | 6 | partly (added here); crashes listed as follow-ups |
| 4 | An identifier used as a credential | 7 | yes (master) |
| 5 | A private field reaches a public path | 14 | yes (master), gaps remain |
| 6 | A regex inverts or deletes correct text | 9 | PR 313 branch only |
| 7 | The normaliser invents tokens | 3 | PR 317 branch only; missing on master |
| 8 | Content for the wrong audience (jargon, trivia, patch history, other race, spec, form, role) | 11 | PR 313 branch only |
| 9 | Flag-off output not identical to master | 4 checks, 0 defects | added here (the flag is off); differential per feature is manual |
| 10 | A same-value re-stamp, or a missing one | 6 | yes (`cards.test`, `brain-rsvp-restamp`) |
| 11 | Timestamps: no zone, future, malformed | 9 | partly |
| 12 | Length limits | 8 | partly (added here for cards); post path on PR 313 |
| 13 | Mention, link or markup injection | 10 | partly (added here); gaps listed |
| 14 | A test that encodes an impossible sequence | 2 | missing (by nature: a review habit, see brief) |
| 15 | CI flakes versus real failures | 4 | partly |
| 16 | A guard test that cannot fail | 3 | missing |
| 17 | Fail-closed that refuses the valid | 4 | PR 317 branch only |
| 18 | Fail-open on a read or parse error | 5 | yes (master) |
| 19 | Loose identity keys (name, slug, spec word) | 8 | partly |
| 20 | A claimed week, budget or window that never releases or never opens | 5 | PR 313 branch only |
| 21 | Copy asserts what the data does not say | 7 | missing |
| 22 | Object-property words as data (`constructor`, `__proto__`) | 5 | partly (added here); crashes listed |

## 1. A stale or cached document wins

- **What goes wrong:** an older copy of a document (an isolate cache, an edge cache, a slow bootstrap, an equal-`ver` `/state`, an out-of-order socket message) replaces a newer one, or is refused when it should win.
- **Real examples:**
  1. S318a HIGH 1: a stale `/state` overwrites a newer socket document; `purgeWorkerCache` cleared `caches.default` but not the isolate copy (30 s). PR 318.
  2. S318a HIGH 2: the same stale document rolls the journey back and persists it to local storage. PR 318.
  3. S318b F3: `/bootstrap` still writes `B.signups` unchecked; a slow bootstrap lands after a newer socket document. PR 318, left open.
  4. S318b F1: a journey write sets no stamp, so old and new documents have equal age and both are accepted; it flips back.
  5. S316 finding 2: `/state` hardcodes `ver: 1` and the brain rejects an equal `ver`, so the changed branch is nearly unreachable in production.
  6. S318b informational: a state with a greater `ver` and an older document locks out every later `ver` 1 `/state`.
  7. PD finding 4: the post-answer purge lists `/api/data/stats.json` but the site fetches `/api/data/stats`; the old body lives up to 60 s. Same shape at the party purges.
  8. CT2 K1: `get()` purged the cache before every read, so a privileged body cached by URL could not be observed. Fixed in the contract test (`warm`).
  9. WP-5/S318b F7: `putIsolateCache` stores asynchronously; a `/state` built before a write can land after the purge and live 30 s.
- **Test that catches it:** drive two documents in both orders (old then new, new then old, equal age, no stamp) through each ingress (`/state`, bootstrap, socket) and assert the newest wins and a refused document is reported. For caches: read with the admin token, write, then read anonymously without purging.
- **Lives now:** PR 318 `tests/unit/brain-state-ver.test.mjs` (6 tests, on the branch). Master: `public-read-contract.test.mjs:129-133` (warm read) and `ask-bound-to-asker.test.mjs:179` (GET /ask never cached). Missing on master: the `/bootstrap` ordering, the equal-`ver` gate, the `purgeWorkerCache` path list against the URLs the site fetches. **Missing.**

## 2. Event ordering assumed

- **What goes wrong:** code or a test assumes the web edit lands before the Discord card click (or the reverse), or that two writes commit in stamp order.
- **Real examples:**
  1. S316 finding 1 (HIGH): the exemption `e[f] === p.base` hides a real newer answer; the PR's own test had a card click arrive after a web edit that the Worker had already applied. Reverted in `e06a41fe`.
  2. S316 finding 4: a restored edit has no `base` and no 30 s timer; a pending RSVP restored after reload shows "newer" falsely or stays "waiting".
  3. S318b F4: a Discord click stamped 50 ms after a web POST commits first; the final document has the lower stamp and is refused on both paths.
  4. S318b F5: a pending RSVP sticks when the document in hand carries a future stamp that is later corrected.
  5. WP-3 LOW-H and WP-4 MEDIUM-5: an "In" clicked three hours into last week's play night counts for this week (the cutoff is a fixed window).
- **Test that catches it:** enumerate the interleavings of {web POST accepted, card click, snapshot} using the sequence the Worker actually produces (the POST applies the edit and returns its stamp as `at` in the same request), assert the final state for each.
- **Lives now:** `brain-rsvp-restamp.test.mjs:50, 58, 65` (after the revert it tests the Worker's real sequence). Restored-edit and out-of-order commit cases: **missing**.

## 3. Null or non-object rows crash a handler

- **What goes wrong:** `entries: [null, {...}]`, a number, a string or an array where an object is expected throws, and the throw takes a render or a request with it.
- **Real examples:**
  1. S318a MEDIUM 3: `mine()` throws on a null row, so `emit("data")` never runs. PR 318 fixed.
  2. S318b F3: a bootstrap document with a null row makes `mine()` throw; `setRsvp` reports `failed` though the POST returned 200.
  3. Probed on master for this catalogue: `applySignupChange` throws `Cannot read properties of null (reading 'name')` on a null row (`cards.js:90`).
  4. Probed on master: `diffRsvp` in `board-lines.js` throws on a null row in `before` or `after`.
  5. WP-A: a `null` entry among sign-ups is ignored (held), a non-string name is ignored (held).
  6. AC-A and WP-A fuzzes: null and non-object rows in weekly-post and the composed path held.
- **Test that catches it:** every function that reads `doc.entries` runs once with each of `null, undefined, 5, "x", true, [], [1]` as a row and as the whole array.
- **Lives now:** added here, `hostile-rows.test.mjs:14, 23, 32, 43` (the helpers that already hold). The two throws (3, 4) are follow-ups: a test would fail on master.

## 4. An identifier used as a credential

- **What goes wrong:** a value that looks like an id (an ask UUID, a slug, a name) is accepted as proof of ownership, or leaks to someone who could then use it.
- **Real examples:**
  1. CT2 A (HIGH): the private error item carried `id`; a UUID id is the credential for `GET /ask?id=`. PR 309.
  2. CT2 B (HIGH): a shared ask's `intent.id` reached anonymous sockets and unlocked the question and answer. PR 308.
  3. CT2 C: `by` and `slug` sent for a private ask; the room's allow list now has neither.
  4. AB finding 2 (HIGH): `{"type":"auth","ask":"<id>"}` took no secret, so the id alone owned a guest turn on the socket. PR 311.
  5. AB finding 1 (HIGH): `route === "/ask"` is an exact match, so `/ask?id=` carried no `Authorization` and a member's private ask never showed. PR 311.
  6. AB finding 4: a member named "Visitor" read guests' private turns; a web session whose display name equals a member's name read a hash-less member turn.
  7. AB finding 3: "no asker row" was treated as "legacy", so a new guest turn with no hash row was readable by id.
- **Test that catches it:** for every credential-bearing route and socket frame, send the id alone, another member's key, a same-name session, and a missing hash row; assert only the secret or the asker's own key reads.
- **Lives now:** `ask-bound-to-asker.test.mjs:62, 76, 129, 143, 151, 159, 169`; `private-ask-ids.test.mjs:85`; `socket-ask-ids.test.mjs:43, 52`; `live-socket-privacy.test.mjs:63, 72`. Covered.

## 5. A private field reaches a public path

- **What goes wrong:** a hidden sheet field, a private question, an asker name, a Discord id, a secret or a salt leaves through an anonymous read, a socket message, a broadcast or a response header.
- **Real examples:**
  1. PD: `stats.recent` (question text) left through `/data/stats`, `/state`, `/bootstrap`. PR 306.
  2. PD finding 2: admin `PUT /data/stats` broadcast the body unfiltered. Fixed after the review (`public-data-doc.test.mjs:136`).
  3. PD finding 1: `/data/:name` served the raw row when the JSON would not parse. Fixed (`public-data-doc.test.mjs:127`).
  4. CT1 F1 to F4: 32 of 61 leak mutations passed the first contract test (see class 16).
  5. CT2 R5 to R10, D1 to D11: socket authority and fields inside `data`, `party`, `page`, `key` pass the room unfiltered.
  6. CT2 X1: `/votes?roster=1` returning the roster passed the test (no query string). Fixed (`QUERY` at `public-read-contract.test.mjs:66, 177`).
  7. CT1 F7: `/state?full=1`. Same fix.
  8. CT1 F10 and CT2 G1: one environment variable regenerated the allow list and blessed a new `discord_id`. Fixed (`:273-274` refuses it in CI).
  9. AC-A (c): hidden sheet fields, 1120 runs, 0 leaks (held).
  10. WP-3 and WP-A: private fields in weekly post, 0 leaks (held).
  11. AP-A, AP-B: hidden spec only in the asker's own private ask (held).
  12. S318a INFO 8: anonymous sockets receive the whole sign-up document. It is the document `/state` already serves; no assertion pins its shape.
  13. WP-A F12: a channel value from a direct D1 write not re-validated (admin-only path).
  14. PD finding 5: an `updated_at` with no zone parsed in the runtime's zone (class 11).
- **Test that catches it:** canaries (each with its own marker) in every private store; read every public surface with and without a query string and warm admin cache; send every broadcast shape plus one with a new key through the room; allow-list key paths.
- **Lives now:** `public-read-contract.test.mjs:66, 129-133, 177, 237-254, 273-274`; `live-socket-privacy.test.mjs:39, 51, 63, 72, 82, 92`; `socket-ask-ids.test.mjs`; `public-data-doc.test.mjs:127, 136`. Added here: `room-redaction-new-fields.test.mjs:20, 29, 39, 48, 57`. Still open: values inside an allowed `data` payload (CT2 D1 to D5) have no assertion; the allow list does not bind transforms (base64, reversed, truncated) of a canary.

## 6. A regex inverts or deletes correct text

- **What goes wrong:** a pattern meant to strip provenance or jargon removes a caveat, keeps the wrong half, or inverts the meaning.
- **Real examples (all PR 313):**
  1. WP-3 MEDIUM-B: the new `", "` split turned "(Oct 7 deep dive; Classic 5 min, exclusive)" into "(exclusive)", inverting a tip.
  2. WP-3 MEDIUM-B: the same split garbled a list into "(Red Helm; Blue Belt)".
  3. WP-3 LOW-C: the split kept the half with no provenance word, leaving "(Forever-confirmed)", "(one guide)".
  4. WP-3 LOW-D: a part that starts with a date or "Classic" was dropped even when it carried the warning.
  5. WP-1 F4: `PROVENANCE_RE` matched ordinary words (may, method, guide, note, client); "(may miss; never on a boss)" lost its warning.
  6. WP-1 F2: `JARGON_RE` ran on the raw value, so a citation disqualified the fact (19 facts lost).
  7. WP-4 LOW-3: a short aside naming a source is dropped even when it carries a dissent ("the deep dive said 6%").
  8. WP-5 finding 7: "(Wowhead says so)" and "(confirmed)" widen the kept residue; "(client 70532 shows it)" stays and then disqualifies the fact.
  9. WP-A F5: `plain()` deleted `<` and `>`, changing "damage > 110%" to "damage 110%".
- **Test that catches it:** a table of fictional values with a trailing aside in every shape (date only, source only, date plus caveat, caveat plus source, nested, comma list, semicolon list, a caveat that contains a source word) and the exact expected text; plus a property check that every shown clause is a substring of the raw value.
- **Lives now:** PR 313 `tests/unit/weekly-post.test.mjs` (37 tests at `1a871803`). Missing on master only because the module is not on master. **Missing** for the property check ("no shown piece absent from the raw value", WP-4's 8000-post fuzz was a one-off probe).

## 7. The normaliser invents tokens

- **What goes wrong:** NFKC, a deleted zero-width character or a deleted control character rewrites a fact into a different one, and the verifier uses the same normaliser so it cannot see the change.
- **Real examples (AC-A, `claude/ask-composed`):**
  1. `60<ZWSP>30 gold` became `6030 gold`.
  2. `level 60` plus a superscript one became `level 601`; `10` plus a superscript two became `102 yards`.
  3. A vulgar-fraction half became `51⁄2 hours`; a line separator between two numbers became `6030`.
- **Test that catches it:** for every digit-bearing token, the normaliser must not change it or the answer must refuse. Property: output tokens that contain a digit are a subset of the input tokens.
- **Lives now:** the module is on the ask-composed branch, not master. Master has `nameKey` (NFKC) with a width-form test added here (`hostile-rows.test.mjs:52`), which only covers names. **Missing** for facts.

## 8. Content for the wrong audience

- **What goes wrong:** a post meant for friends shows jargon ("21-point medal"), trivia, patch history ("since Oct 1"), a patch-tester's comment, another race's racial, another spec's or form's tip, or a threat tip to a damage dealer.
- **Real examples (all PR 313):**
  1. WP-1 F3: a feral-druid bear tank got a Cat-only tip; "Shifting power" matched on the spec word.
  2. WP-1 F3: "one tester called it a design conflict" slipped past the trivia filter.
  3. WP-2 MEDIUM-2: hunter spec facts (`hunter.bm.*`) reached every hunter spec.
  4. WP-2 MEDIUM-3: three-letter spec segments (`ret`, `enh`, `ele`) excluded the build's own facts.
  5. WP-2 MEDIUM-4: "usable only in Cat Form", "requires Cat Form", "Balance druids only" reached a bear tank.
  6. WP-2 LOW-9: patch history reached tips ("Oct 1", "notes cut it to 60%").
  7. WP-3 LOW-F: a damage dealer got "causes a large amount of threat", "forces the target to attack you".
  8. WP-4 MEDIUM-1: a Troll warlock got "Undead racial (Touch of the Grave)" (another race's racial; 2 of 10 repo weeks).
  9. WP-4 LOW-6: a tip with a build number as its subject ("Mounts, 70532") and a dangling "the same read".
  10. WP-5 findings 1, 3, 4, 6: race words inside a spell name exclude a fact; "Dwarf priest racial" and "forces all nearby enemies to attack you" still pass.
  11. WP-A F9: "Frost, ice block: 16-point medal" reads as a fragment of library notes.
- **Test that catches it:** every build in the roster, every spec spelling, every form, every race, against a fictional library whose keys and values contain each wrong-audience shape; assert pools exclude them and include the build's own.
- **Lives now:** PR 313 only. **Missing** for the general rule that a friend-facing text builder is checked against a banned-shape table.

## 9. Flag-off output not identical to master

- **What goes wrong:** a feature that ships off changes a byte, a prompt, a stored row, a stats row or a broadcast when its flag is unset, "off", odd-cased, or a non-string.
- **Real examples:** none found defective. AC-A (d): 700 scenarios, identical hash for 15 off-like values. AP-A: 408 comparisons, 0 differences. AP-B: 2640 runs, 0 differences. WP-A: flag off reads nothing and sends nothing. The class is in the catalogue because the differential is expensive and done by hand each time; AP-B note 9 found that the repo's own ask harness passes no asker hash, so a flag-off differential through it would not exercise follow-ups or reused answers.
- **Test that catches it:** a flag-off sweep over every helper (cheap), plus per feature a differential of the full return value, stored rows, prompts and broadcasts against `git archive origin/master`.
- **Lives now:** added here, `flag-off-values.test.mjs:27, 54` (every `*Enabled` and `*Shadow` helper is off for 21 off-like values; found by scanning the folder). `flags.test.mjs:24, 29` covers the Flagship binding. The per-feature byte-identical differential is **missing** as an automated test (it needs master's tree to compare with; it stays a reviewer task, listed in the brief).

## 10. A same-value re-stamp, or a missing re-stamp

- **What goes wrong:** the same answer clicked again either does not move the entry's stamp (so "this week" never counts it) or moves it when it should not (so the web page says "newer").
- **Real examples:**
  1. WP-2 HIGH-1 and WP-3 HIGH-A: a friend already "in" clicks In again; `applySignupChange` does not re-stamp; the weekly post says "not counted". PR 316 fixed.
  2. S316 finding 1: the fix made the client say "newer" for the same value; the exemption was wrong; reverted.
  3. WP-3 MEDIUM-5 (pack): a pack-only change re-stamps and makes a stale In count. Left by choice.
  4. WP-1 F1: a card-level stamp moves on any click, so a fresh card lists old sign-ups. Replaced by per-entry stamps.
  5. WP-3 PR 316 blast radius: a same-value RSVP produces identical side effects, only `entry.updated` differs (held).
  6. WP-2 LOW-10: an Out this week under one spelling and an old In under another both print.
- **Test that catches it:** apply the same change twice at two times; assert stamp, `changed`, tallies, broadcasts and Discord edits for each field (rsvp restamps, pack does not).
- **Lives now:** `cards.test.mjs:118` (rsvp restamps, pack does not). Client side: `brain-rsvp-restamp.test.mjs:50-65`. Covered.

## 11. Timestamps: no zone, future, malformed

- **What goes wrong:** `Date.parse` reads a zone-less stamp in local time, a future stamp is "fresh forever", a malformed stamp compares as a string, a missing stamp is read as "earlier".
- **Real examples:**
  1. PD finding 5: `2026-11-12T00:36:29` served as `...05:36:29.000Z` on a UTC-5 machine.
  2. S318b F6: epoch numbers, epoch strings, junk and a zone-less stamp count as age 0.
  3. S318b F5: a future stamp pins a pending RSVP at "waiting".
  4. WP-1 F6: any future date is fresh, with no upper bound; `11/18/2026` and a zone-less stamp parse as fresh.
  5. WP-3 LOW-11: "from an earlier week" is asserted for any entry with no valid stamp.
  6. Probed on master for this catalogue: `upsertSignupEntry` merges duplicate rows with a string compare, so `updated: "yesterday"` beats `2026-11-01T10:00:00.000Z` and a zone-less stamp beats an ISO one.
  7. Probed on master: the card footer prints `Updated ... UTC` for a zone-less stamp that was read in local time.
  8. PD: a future-dated `updated_at` is served as is.
  9. WP-A F3: a header time printed from a config row drifted across a DST change.
- **Test that catches it:** one table of stamps (ISO Z, ISO offset, no zone, date only, epoch number, epoch string, future by 1 h and 1 year, empty, junk, wrong type) fed to every function that compares or prints a stamp, with the expected ordering stated.
- **Lives now:** `discord-safety.test.mjs:29, 35` (future and malformed request timestamps); `public-data-doc.test.mjs` (nonce and non-ISO `updated_at`); added here `discord-text-limits.test.mjs:72` (footer prints only valid stamps). The merge ordering and the zone-less footer (6, 7) are follow-ups: a test would fail on master.

## 12. Length limits

- **What goes wrong:** a post, card, line or field exceeds a Discord limit (2000, 1900 budget, 1024, 6000, 120) with a long roster, long names or many sources; or a cut leaves an orphan heading or drops everything silently.
- **Real examples:**
  1. WP-A F7: 90 sign-ups with 28-character names made a 2593-character post; Discord answered 400 every tick. PR 313 fixed.
  2. WP-B R4: the shortened name list dropped "(tentative)" and "(running late)".
  3. WP-B R5: one oversized first tip removed every tip with no "(and N more)".
  4. WP-4 LOW-5: all tips dropped, no "(and N more)" line; one source kept even with room.
  5. WP-3 LOW-E and WP-2 LOW-7: minimum judged on shown text, maximum on raw.
  6. WP-2 headroom: week 47 was 1894 of 1900; any longer fact starts dropping tips.
  7. AP-A, AP-B: a fact over about 950 characters, or three of about 290, refuses as "too long".
  8. AC-A: 15 real library facts exceed 600 characters and were not run individually.
- **Test that catches it:** a sweep from 0 to N (past any realistic roster) with names at the cap, with the limit asserted at every size, and every "dropped" path asserted to say so.
- **Lives now:** `cards.test.mjs:53` (80 short names); added here `discord-text-limits.test.mjs:20, 33, 61` (300 long entries; total 6000, field 1024, line 120); `board-lines.test.mjs:46`. The weekly post sweep is PR 313's. Over-length facts through the ask path: **missing**.

## 13. Mention, link or markup injection

- **What goes wrong:** a name, a free-text field, a fact or a source label carries `@everyone`, `<@&id>`, a masked link, a bare URL or invite, a heading, or a direction override, and it prints live.
- **Real examples:**
  1. WP-A F10: a bare URL, a direction override and a zero-width character pass through build lines and facts.
  2. AC-A: foreign masked links survive the stripper and the verifier (label 300, target 600 limits).
  3. AP-B finding 6 and AP-A: `[text](url "title")` passes both proofs and is stored verbatim.
  4. AC-A (b): free-text sheet values reach a public opener ("your free epic mount").
  5. WP-3 LOW-C-style and WP-A: source labels carrying a masked link came out escaped (held).
  6. Probed on master for this catalogue: `cleanName` keeps a bare `discord.gg/abcdef`, and a free-text `when` is printed as stored on the sign-up card (`<#id>` and `[x](https://e.test)` render live; `meet` is sanitised, `when` is not).
  7. AP-B: an `@everyone` key is stored with `ANSWER_UX=off`; `allowed_mentions` is the only guard.
  8. WP-3 and WP-5: ten hostile names in earlier sign-ups, 0 raw (held).
  9. WP-A: `@here`, `<@&id>`, `<#id>` in a name, line, fact or label (held).
  10. Discord invite in a library value: sent verbatim by design (AC-A).
- **Test that catches it:** one hostile-string table (mention, role, channel, here, masked link, titled link, bare URL, invite, heading, quote, code, spoiler, direction override, zero-width, newline) through every builder that prints a name, a free-text field or a fact, asserting no live syntax and `allowed_mentions: {parse: []}`.
- **Lives now:** `cards.test.mjs:64, 89`; added here `discord-text-limits.test.mjs:46` (names and `meet` on both cards, the board line, `cleanName`); `hostile-rows.test.mjs:43`. Follow-ups: bare `discord.gg/` in a name; free-text `when`.

## 14. A test that encodes an impossible sequence

- **What goes wrong:** a test passes because it builds a state the system cannot reach; the fix looks verified and is not.
- **Real examples:**
  1. S316 finding 1: `brain-rsvp-restamp.test.mjs` had Ada "already In" after the web Maybe was accepted. On this Worker the entry is Maybe by then, and the snapshot the test waits for never arrives.
  2. CT1 F1: the ask-completion messages in the contract test were hand-built copies, not what `ai-models.js` sends.
- **Test that catches it:** none by itself; the control is to derive the sequence from the producer (the Worker's response, the real call site) and to run the new test against the unfixed code to see it fail for the stated reason.
- **Lives now:** after the revert `brain-rsvp-restamp.test.mjs:50-65` uses the Worker's sequence. A general guard is **missing** (see the brief, item 14).

## 15. CI flakes versus real failures

- **What goes wrong:** a red run is read as a flake (or a flake as real) without a reproduction; a suite scans the wrong tree.
- **Real examples:**
  1. WP-5: 12 full runs, 11 at 1874, the first at 1873 with one failure never captured. Cause unknown.
  2. PD and CT1 and CT2: 6 unit failures in a nested checkout (`no-eval`, `motion-literals`, `restore-drill` x2, `stamps`, `import-signups` CRLF), the output naming `.claude/worktrees` 774 times; environmental, not product.
  3. WP-3: five failures on an export without dependencies, `ERR_MODULE_NOT_FOUND 'yaml'`.
  4. PR 295, 298, 300, 304, 310: layout and browser flakes handled by reruns and a stub (`flake-auto-rerun`).
- **Test that catches it:** record the failing test name on first failure (the reviewer did not); a scan test must exclude `.claude/worktrees`, `node_modules` and `_scratch`.
- **Lives now:** `no-eval.test.mjs`, `stamps.test.mjs:83` run in CI. A rule that a failure is captured by name before a rerun is in the brief.

## 16. A guard test that cannot fail

- **What goes wrong:** a contract or regression test passes against a leak it claims to prevent, because the match is a substring of a fixed list, only some call sites are driven, or the allow list can be regenerated.
- **Real examples:**
  1. CT1: 32 of 61 leak mutations passed.
  2. CT2: 45 of 50 new leak mutations passed (base64, reversed, truncated, homoglyph, rot13 of a canary; secrets in headers; POST bodies).
  3. CT2 R5 to R10: the socket upgrade, `authSocket` and the greeting were never exercised; only `broadcast()` with hand-built sockets.
- **Test that catches it:** a mutation run of the guard itself (each mutation applied to the Worker, the guard run, the mutation reverted) with a recorded kill count in the PR. The reviewers' `mutate.mjs` and `mutate2.mjs` are the pattern.
- **Lives now:** the contract test was strengthened after these reviews (`public-read-contract.test.mjs`, query string, warm cache, CI refusal). No committed mutation harness. **Missing.**

## 17. Fail-closed that refuses the valid

- **What goes wrong:** a second proof after formatting refuses a correct answer, so a valid question gets "The Library does not cover that yet".
- **Real examples (PR 317 and the composed path):**
  1. AP-A 1, AP-B 1: with `ANSWER_UX=on`, every answer with two or more picked facts is refused (`limitBold` strips the second bold span; the re-proof fails).
  2. AP-A 2: a page title with " - " or a dot, a value with a space before a comma, an empty key: always refused, 74 pairs.
  3. AP-B 4: provider down gives "does not cover that yet", untrue during an outage.
  4. AP-A 3: a provider that returns a parsed array defeats the feature.
- **Test that catches it:** property: for any one retrieved fact, composing and formatting then verifying must accept it (round trip), with titles and values containing each formatter trigger.
- **Lives now:** PR 317 only. **Missing** on master.

## 18. Fail-open on a read or parse error

- **What goes wrong:** an error path serves the raw value, or "no row" is read as "legacy, allow".
- **Real examples:**
  1. PD finding 1: an empty `catch {}` served the raw stats row. Fixed (`public-data-doc.test.mjs:127`).
  2. AB finding 3: swallowed read error and no asker row meant "ok" for a new guest turn. PR 311 fixed (`ask-bound-to-asker.test.mjs:151, 159`).
  3. PD finding 2: admin PUT broadcast the unfiltered body. Fixed (`:136`).
  4. CT1: an unreachable fixture row hides a leak under an allowed key (never read).
  5. WP-A F1: a thrown Discord call left the week claimed (a fail-stuck variant; see class 20).
- **Test that catches it:** corrupt, missing and throwing variants of every row a public route reads; assert refusal, never the raw value.
- **Lives now:** `public-data-doc.test.mjs:127, 136`; `ask-bound-to-asker.test.mjs:113, 143, 151`. Covered for those routes.

## 19. Loose identity keys

- **What goes wrong:** a person or a build is matched by a loose key (lower-case name, letters-only key, any word of a slug, a spec word), so two people collapse or a stranger matches a member.
- **Real examples:**
  1. WP-A F6: members "Red Fox" and "Redfox" collide; the last wins even over an exact match.
  2. WP-B R2: names sharing a letters-and-digits key collapse into one row; the first row wins.
  3. WP-B R3: combining marks stripped, so a different name matches a member (two scripts shown).
  4. WP-A F6: an entry with a slug and a different name is shown as the name's member.
  5. AP-B 2: `keyedToBuild` matches any build word against any slug or key segment ("ember" opens a vault page).
  6. AP-B 8: any "i" token makes `aboutAsker` true.
  7. WP-3 LOW-I: aliases apply to any class (`warrior.sub.x` read as Subtlety).
  8. AB 4b: a roster name "Visitor" is the guest label.
- **Test that catches it:** a name table (decoration, width, combining marks, collisions, same name different slug, slug and name disagree) through the matcher; assert one row per person and no stranger matched.
- **Lives now:** `signup-seed-merge.test.mjs:81, 96`; added here `hostile-rows.test.mjs:32, 52`. Weekly post matching: PR 313. The ask-side loose keys (5, 6): PR 317 only.

## 20. A claimed week, budget or window that never releases or never opens

- **What goes wrong:** a claim is taken and an exception keeps it, a lead time can never fit the cron ticks and the quiet hours, a budget holds a post to the next day.
- **Real examples (PR 313):**
  1. WP-A F1: a thrown fetch left the week claimed; ticks at +6, +12, +18 h all `not_due`; 0 posts.
  2. WP-A F2: `lead_hours` 1 to 17 accepted but could never post for 7 to 154 of 168 schedules.
  3. WP-B R9: a custom quiet window missed 6 of 8731 play nights on the clock-change day; a throw after Discord accepted released the week (a duplicate is possible).
  4. WP-4 LOW-5: after a tip is dropped, sources are not restored.
  5. WP-A F4: the dry run could not read the config, so it printed a different week than the run.
- **Test that catches it:** a tick simulation over every weekday, hour and lead for two years with the real cron and quiet hours; a failure injected after each step of claim, post and ledger write.
- **Lives now:** PR 313 only. **Missing** on master.

## 21. Copy asserts what the data does not say

- **What goes wrong:** the post or answer states a rule, a count or a fact its data does not support.
- **Real examples:**
  1. WP-A F9: "No healer and damage dealer among them yet" (and for "or"); a tentative tank suppresses "nobody as tank"; the role line implies a requirement the post never sources.
  2. WP-A F9: two unmatched sign-ups printed as "Nobody has signed up as tank, healer and damage yet".
  3. WP-1 F5: the stale post says nobody signed up this week while the card in the same channel still shows names.
  4. WP-4 LOW-5: the one source kept is always the first ref, though the headline figure is from the third.
  5. WP-5: a tip ends "makes no threat (the deep dive said 6%)" where the 6% refers to mana.
  6. AC-B: the composed answer shows an off-target fact in 16 of 29 selections (retrieval, not selection, is the cause).
  7. AP-A minor: an opener names the asker's build above a fact about something else.
- **Test that catches it:** state each sentence template's truth condition and generate boards that violate it (all tentative, unmatched, none, many); assert the sentence is absent.
- **Lives now:** PR 313 covers some of its own. **Missing** as a general rule.

## 22. Object-property words as data

- **What goes wrong:** a value that is also a property name (`constructor`, `__proto__`, `toString`) is used as a lookup key, so `table[value]` returns a function or the prototype.
- **Real examples:**
  1. WP-A F11: `role: "constructor"` threw in weekly post.
  2. AP-A 5: a race or class of "constructor" crashed the ranker (`synonyms[w] || []`), also on master with `__proto__ constructor wardens`.
  3. Probed on master for this catalogue: `renderSignupCard` throws on an entry with `rsvp: "constructor"` (`out.rsvp[e.rsvp].push is not a function`).
  4. Probed on master: `composeLine` prints "function Object() { [native code] }" for a change whose `to` is `"constructor"` (`RSVP_PHRASE[c.to]`).
  5. Probed on master: `partyEntry` throws on `class: "constructor"`, and `cardMembers` accepts `class_key: "constructor"` as a class key.
- **Test that catches it:** each lookup-table function called with `constructor`, `__proto__`, `toString`, `hasOwnProperty` as the key.
- **Lives now:** added here, `hostile-rows.test.mjs:80` (a name of that kind makes an ordinary row). The throws (2, 3, 4, 5) are follow-ups.

## Follow-ups (a test would fail on master; product change needed, not done here)

| # | Where | What a test would assert | Evidence |
|---|---|---|---|
| F-1 | `cards.js` `applySignupChange` | a null row in `entries` does not throw | probed: `Cannot read properties of null (reading 'name')` |
| F-2 | `board-lines.js` `diffRsvp` | a null row in either document does not throw | probed: throws on `e.name` and `e.rsvp` |
| F-3 | `cards.js` `tallyEntries` / `renderSignupCard` | an `rsvp` of `constructor` is ignored | probed: `out.rsvp[e.rsvp].push is not a function` |
| F-4 | `board-lines.js` `composeLine` | a `to` of `constructor` prints nothing | probed: prints "function Object() { [native code] }" |
| F-5 | `member-model.js` `partyEntry`; `card-members.js` `cardMembers` | a `class` or `class_key` of `constructor` is not a class | probed: throws; accepted |
| F-6 | `rank-core.js:15` | a sheet word of `constructor` does not crash retrieval | AP-A 5, reproduced on master by the reviewer |
| F-7 | `limits.js` `upsertSignupEntry` | a malformed or zone-less `updated` never beats a valid ISO stamp in a duplicate-row merge | probed: `"yesterday"` wins |
| F-8 | `cards.js` `fmtUpdated` | a zone-less `updated` prints no footer (or is read as UTC) | probed in code: `Date.parse` reads local time, label says UTC |
| F-9 | `cards.js` sign-up card | a free-text `when` is sanitised like `meet` | probed: `<#123456789012345678> # x` prints raw |
| F-10 | `cards.js` `cleanName` | a bare `discord.gg/` invite is removed | probed: survives in the In list |
| F-11 | `brain.js` (PR 318) | `/bootstrap` goes through the same age check as `/state` | S318b F3 |
| F-12 | `index.js` `purgeWorkerCache` | the paths purged equal the URLs the site fetches (`/api/data/stats`) | PD finding 4 |
| F-13 | `ask-composed.js` (PR 317 base) | `norm` refuses or keeps a token it would change (ZWSP, superscript, fraction) | AC-A (a) |

Branches that are open (PR 313, 317, 318) carry their own tests; items for them belong in those PRs, not here.
