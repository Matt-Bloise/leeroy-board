# Replay harness: score the Worker's /ask answers on real game facts and against Leeroy

The harness drives the signed shadow route (`POST /api/shadow/ask`, flag `SHADOW_ASK`, `docs/runbooks/shadow-ask.md`), which runs the Worker's real `/ask` research compose with a record-only sink. It is the Worker's answer path; nothing in `tools/replay/` touches the Worker. Everything is a file on the owner's machine: no table, question set, result or packet is ever committed.

```
tools/replay/truth-gen.mjs   build a seeded question set from the client's data tables
tools/replay/run.mjs         send items to the shadow route, score, summarize
tools/replay/score.mjs       pure scoring functions
tools/replay/pass-bar.mjs    the pass numbers (constants; tests/unit/replay-harness.test.mjs pins them)
tools/replay/grade-pack.mjs  blind grading packets and the unblinding merge
```

## Pass numbers (fixed before any run)

On truth-gen questions, per kind and overall:

- exact_rate >= 0.90
- unsupported_rate <= 0.02
- degraded_rate <= 0.05
- within_budget_rate >= 0.95 (compose `latency_ms` under 22000, the ask's hard end)
- at least 30 scored items per kind (sample size); kinds `spell_level` and `item_level_req` are required

All four are fractions of SCORED items. Definitions (the constants are in `tools/replay/pass-bar.mjs`):

| unit | definition |
|---|---|
| scored item | the Worker returned a composed record: HTTP 200 (or 500 `store-failed`, which still carries the answer) with a `status` of answered, degraded, error, refused or store-failed. A 400, 429, 503, transport failure or a call that was not sent is UNSCORED: counted apart, not in any denominator, and it cannot make a kind reach the sample size. |
| exact | `exact_match` is true and `contradiction` is false (below). Denominator: scored items that carry an expected value. |
| unsupported | the answer holds at least one number nothing supports (below). Same denominator as exact. |
| degraded | `reason` present and not `ok`, or `model` contains `+degraded`, or `status` is not `answered`. Denominator: all scored items. A degraded item has no usable answer, so it also counts against exact_rate. |
| within_budget | `latency_ms` is a number under 22000. Denominator: all scored items. |

Honest baseline note: today the Worker answers game-fact questions from the model and the static library, without a `game_facts` table. A FIRST run is expected to FAIL this bar, and that result is the baseline. The bar must be met after the `game_facts` PR; a run that passes before it means the questions are too easy, not that the Worker is ready.

For private pair corpora (Leeroy versus the Worker) there is no truth value. The run records the Worker answer's metrics (status, model, latency, degraded, length, hash) and the comparison is a blind rubric grade (below).

## Truth set

```
node tools/replay/truth-gen.mjs --tables <dir> [--out <file.jsonl>] [--seed 1] [--per-kind 40] [--manifest-sha256 <hex>] [--traits <traits.json>]
```

`<dir>` holds the CSV exports and `MANIFEST.json` (`{build, files:{name:{sha256, bytes, rows}}}`). On the owner's machine it is `C:\projects\leeroy-ops\notes\private\truth\db2-1.60.1.70959\`. Every table used is checked against the manifest (sha256, bytes, rows) before it is parsed; any mismatch refuses the whole run. (`rows` is the data row count. A physical-line count is accepted instead only when the table really has a quoted field with an embedded newline, which makes one record span two lines; on any other table a mismatch refuses.) The manifest is the trust root: a table and a manifest edited together pass every check. `--manifest-sha256 <hex>` pins `MANIFEST.json` itself; keep that hash somewhere the tables are not. The header records `manifest_sha256` and whether it was pinned. The output path must be outside the repo checkout (default: the OS temp directory under `leeroy-replay`); a path inside the checkout is refused (see Write guard below), and an existing file is never overwritten. The tool prints candidate and selected counts only, never row data.

`--traits <file>` adds the trait kinds below (on the owner's machine the file is in the private truth folder, `traits.json`). There is no default path: without `--traits` no trait kinds are generated and nothing outside `--tables` is read (`--no-traits` is accepted as an explicit spelling of the same; both together are refused). A `--traits` path that does not exist is refused. The traits file is derived and has no MANIFEST, so the header records its `build`, `sha256`, `bytes` and the number of class trees used (`header.traits`), never its path. The DB2 tables are still verified through MANIFEST. The file stays outside the repo like the tables.

Output: line 1 is a header (`build`, `seed`, `per_kind`, table hashes and bytes, the column chosen per kind, counts); each next line is `{id, kind, question, expected:{value, unit}, rows:[{table,id}], entity_name, allowed_numbers:[...]}`. Same tables, seed and per-kind give byte-identical output. `allowed_numbers` is every numeric cell of every row the question rests on (so an answer may state the item level or a spell id without being called invented), plus the expected value, plus the millisecond or minute form of a seconds value.

| kind | fact (column) | filters |
|---|---|---|
| `spell_level` | `spelllevels.BaseLevel` | spell name unique in `spellname.Name_lang`; exactly one `spelllevels` row; BaseLevel > 0 |
| `item_level_req` | `itemsparse.RequiredLevel` | item name (`Display_lang`) unique in `itemsparse`; RequiredLevel > 0 |
| `spell_cooldown` | `spellcooldowns.RecoveryTime` / 1000 | unique name; exactly one row; whole seconds; `CategoryRecoveryTime` = 0 and `StartRecoveryTime` = 0 |
| `spell_cast_time` | `spellcasttimes.Base` / 1000 via `spellmisc.CastingTimeIndex` | unique name; exactly one `spellmisc` row; the index exists once; Base > 0 (instant casts skipped) |
| `spell_mana_cost` | `spellpower.ManaCost` | unique name; exactly one row; `PowerType` 0; `ManaCostPerLevel`, `PowerCostPct`, `OptionalCost` all 0; ManaCost > 0 |

Why BaseLevel and not SpellLevel: `BaseLevel` is the minimum level the client requires to use the spell (the level a player is told). `SpellLevel` is the level the spell's own scaling is computed at; on the 1.60.1.70959 export it is 0 on 1557 of 13006 rows, and where BaseLevel is above 0 the two agree on 2509 of 2517 rows. BaseLevel is the one with a single meaning.

No questions from the legacy `talent` table: it is the vanilla layout and lacks the talents Forever added. Forever's real talent trees are the client Trait* tables, exported to `traits.json`; the trait kinds read only that. A kind the data cannot support unambiguously is skipped rather than guessed.

Trait kinds (only the eight class trees: 1112 Mage, 1100 Paladin, 1114 Priest, 1116 Warlock, 1083 Druid, 1111 Rogue, 1117 Warrior, 1091 Hunter; every other tree id is ignored). A node is eligible only if its `nodeId` occurs once in its tree (a node with several entries is skipped), its name is well-formed, not the `?` fallback and unique (case-insensitive) in that class tree, and `maxRanks` is an integer > 0. The question names the class, so the same talent name in two class trees is fine.

| kind | fact | extra filters |
|---|---|---|
| `trait_max_ranks` (unit `ranks`) | node `maxRanks` | eligible node |
| `trait_points_required` (unit `points`) | `conds[0].spentAmountRequired`: points that must be spent in the tree before the talent can be learned | exactly one cond, `condType` 0, currency id > 0, requirement an integer > 0 (no cond, several conds or a currency-0 cond: skipped) |
| `trait_prereq` (unit `name`) | the prerequisite talent's name, from the node's `requires` list (TraitEdge type 2: the left node is the prerequisite of the right node; types 0 and 3 have no direction and raw `edgesTo` is never used) | `requires` holds exactly one distinct entry (zero or several: skipped); that source node is in the tree and eligible; neither name contains the other. LIKELY, not sure: 21 of 23 edges comparable with the legacy table agree, the two that differ are in the redesigned Hunter and Warlock trees. INFORMATIONAL |

Records carry `class_name`, rows `traittree` (tree id) and `traitnode` (node id, plus the prerequisite's node id for `trait_prereq`) and `allowed_numbers` from the ids, ranks and requirement of those nodes. `trait_prereq` expects a name, not a number: `expected = {value: "<name>", unit: "name"}`.

Sample size and the bar: on build 1.60.1.70959 `trait_max_ranks` and `trait_points_required` have 397 and 293 candidates, above the 30 scored items the bar needs, so they sit under the same per-kind bar as every other kind (`required_kinds` is unchanged: they are not required, but a run that includes them must meet the bar on them). `trait_prereq` has 52 candidates but is INFORMATIONAL (`INFORMATIONAL_KINDS` in `pass-bar.mjs`): the run summary reports it as its own kind marked `*` with the label "likely, not counted toward the bar", and it is never part of the pass/fail decision, the sample-size rule or the required-kinds rule. If a future build leaves another kind under 30 candidates, treat that kind as informational too and say so in the run report.

## Running

```
node tools/replay/run.mjs <token-file> --in <items.jsonl> --max-items 6 [--out results.jsonl | --resume results.jsonl] [--delay-s 660] [--max-wait-s 900] [--keep-answers] [--base https://api.leeroy.party] [--allow-host host]
node tools/replay/run.mjs --summarize <results.jsonl>
```

- The token file holds the Discord bot token. It is read, used to derive the shadow key (`shadowKey` in `infrastructure/worker/listener-config.js`, the derivation `tools/shadow-ask.mjs` uses) and never printed. Owner's machine only. The base URL must be https (http only for localhost or 127.0.0.1), no credentials; redirects are refused (`redirect: "error"`). The host must be `api.leeroy.party`, `localhost` or `127.0.0.1`; any other host needs `--allow-host <host>` (the flag never relaxes https). The host, never the path, is printed before the first call.
- `--max-items` is required (1 to 20). The run sends at most that many calls and stops cleanly. The route allows 6 an hour and 20 a day: calls are spaced `--delay-s` (default 660 s), the rolling windows are tracked from the `sent_at` stamps in the results file (so a resumed run counts earlier calls), and a run that would have to wait longer than `--max-wait-s` stops instead (exit 0, resumable). A 429 stops the run and the item is not recorded, so `--resume` retries it. 401, 404 and 409 stop with exit 1 (key, flag or `ASK_RESEARCH` problem). Other callers share the same limiter: leave room.
- `--resume <results.jsonl>` appends to that file and skips every id that has a result row. Together with `--max-items` this gives one hour's batch (6 items) per resume. The results file starts with a header line holding the input file's sha256: resuming against a different input is refused, as is a results file with no header or with a duplicate id; a duplicate id in the input is refused too.
- Results file lines: the header, then per attempt a `{type:"sent"}` marker written BEFORE the POST, then the result row (or `{type:"aborted"}` when the run stopped on that call: 401, 404, 409, 429, 503, a dropped connection). An attempt counts toward `--max-items` and the rate windows even when the response body cannot be read. A marker with no result row is retried on resume (reported as `unresolved`); its time stays in the rate windows. An exclusive lock file (`<results>.lock`) keeps two runs off one results file; it is removed when the run ends, and a leftover one (a dead run) is reported, never taken over.
- Results (outside the repo by default, inside it refused): per item `id, kind, question_sha256, fictional, ok, status, model, latency_ms, reason, within_budget, degraded, answer_length, answer_sha256, http_status, scored, sent_at, scores`. `status`, `kind`, `model` and `reason` are fixed vocabulary: status from the Worker's known list, kind from the generator's kinds (or `pair`), model and reason through the same pattern as `safeReason` in `shadow-ask.js` (model also allows `+`, `[` and `]`, which its label uses); anything else is stored and printed as `other`, so a response cannot put text into stdout or the file. The answer text is stored ONLY with `--keep-answers`; without it the file holds a hash and a length. Questions and answers are never printed; progress lines carry counts, kind, HTTP status and latency.
- The summary table prints counts, p50/p95 latency and the rates per kind, and the pass-bar verdict when truth items are present.

## Scoring

Numbers are read as integers, decimals (2.5), thousands commas (1,200) and ordinals (20th). A digit run glued to letters is not a number. A number has a unit context from the words beside it: level (`level 20`, `lvl 20`, `20th level`), seconds (`30 seconds`, `30s`, `5 minutes` = 300, `1.5 sec`), mana (`120 mana`, `mana cost of 120`), or other (gold, %, yards, damage, stacks ...). Number words (twenty, thirty-five) count only next to a level or seconds unit.

- `ranks` and `points` (trait kinds only, read only when the item's unit asks for them, so other kinds score unchanged): `3 ranks`, `three ranks`, `max rank 3`, `ranks: 3`, `a single rank` (= 1) count as ranks; `5 points`, `5 talent points` count as points. For a ranks item a number of points is another fact and the reverse. For ranks the word "rank" does not mark a clause as another fact; for points, max, cap, total, rank and upgrade do.
- `name` (trait_prereq): exact when the expected name appears in the answer as whole words (case, apostrophe style and spacing folded), not negated, after every occurrence of the asked talent's own name is removed from the answer. There is no contradiction check for names, and an answer that lists many talents passes if the right one is among them: spot-check failures and passes with `--keep-answers`.
- `exact_match`: the expected number is stated in the question's unit (words and minute conversions included), or, when the answer states no number in that unit at all, as a bare standalone number that is not an id (`spell id 20`, `#20`) and carries no other unit. `level 120` or `2.05` never match 20 or 2.0.
- `unsupported_numbers`: digit numbers in the answer that are not the expected value, not in `allowed_numbers`, not in the question (the question's own numbers are allowed), and not the same after unit conversion. Exempt by decision: integers 0 to 10 with no unit context (small counters: "3 tips", step numbers) and list markers (`1.` at the start of a line). A small number WITH a unit ("level 5", "5 seconds", "3 stacks") is checked like any other, because that is exactly where an invented fact hides.
- `contradiction`: the answer states a DIFFERENT number in the question's unit than the expected one ("level 30" when the fact is level 20), unless that number is in the question or sits in a sentence about another fact (max, cap, until, rank, next, previous, then, later, upgrade, improved). Conservative by design: it can miss a contradiction phrased inside such a sentence, and can flag a second spell's level mentioned in passing. It is a reported flag and part of `exact`, not a separate bar line.
- Negation: a number inside a negation ("not level 20", "isn't 20", "no longer level 20", "never level 20", up to three words between) does not count as stating the value, and a negated different number is not a contradiction.
- Per clause: `contradiction` splits at sentence ends, commas (not thousands commas), semicolons and but/though/however/while, so "level 30 until the next update, then level 20" is a contradiction. Only max, cap, rank, upgrade and improved mark a clause as another fact.
- `degraded`: see the table above. A degraded response is never exact, whatever number its text holds.

## Write guard

Every writer goes through `assertOutsideRepo`: the target's real path (symlinks and junctions resolved through the nearest existing ancestor) must not be the checkout or inside it (compared with a path-separator boundary, so a child named `..replay` is inside), and an existing target with more than one hard link is refused. New files are opened exclusive-create (`wx`), results are opened append-only, and nothing existing is truncated. Residual TOCTOU: the check and the open are two steps, so a directory swapped for a link into the repo between them is not caught; keep the output directory writable only by the owner.

## Blind grading (private pair corpora)

The real Leeroy-versus-Worker comparison has no ground truth, so it is graded blind on a rubric, by a separate step.

```
node tools/replay/grade-pack.mjs build --corpus <pairs.jsonl> --results <results.jsonl> --grader claude|external --out <packet.jsonl> [--seed N]
node tools/replay/grade-pack.mjs merge --key <packet.jsonl.key.jsonl> --grades <grades.jsonl> [--out merged.jsonl]
```

- Corpus records: `{id, question, local_answer, asker_slug?, sources?, fictional?}`; the results file is the run with `--keep-answers`. Nothing is sent anywhere: packets are files you hand to a grader yourself.
- The join is bound. `run.mjs` stores a hash of each question (`question_sha256`) and the input file's hash in the results header. The packet builder refuses a results file whose header hash is not the corpus file's, and refuses any id whose stored question hash differs from the corpus question; duplicate ids in either file refuse.
- A packet is `{packet_id, question, A, B}`: A/B order randomised per item, no labels, no ids. The key (`<packet>.key.jsonl`) maps packet ids to ids and sources and never goes to a grader. The header carries the rubric text.
- An input is PRIVATE unless EVERY corpus record and EVERY results row has `"fictional": true` (`run.mjs` copies the flag from the corpus record into its row). A private corpus is refused unless `--grader claude` (the paid Claude API may see group data); its packet header is marked `private: true` (never commit it, never send it to Codex or Gemini). `--grader external` (Codex, Gemini) is allowed only when every record is flagged fictional (or scrubbed to fictional) and the flag is the boolean `true`.
- Writer-family rule: the grader should be a different model family than the answer writer. The Worker's answers are written by Claude (`model` starts with `claude:`), so a Claude grader is the SAME family: the header records `writer_families` and sets `same_family_warning`. Private group text may go only to Claude, so for a private corpus this is the accepted trade. Mitigations: blinding and randomised order; also grade a fictional or scrubbed subset with an external grader and compare the two verdicts; treat a private-corpus result that the external subset contradicts as unproven.
- Grades file: one line per packet `{packet_id, A:{tone, helpfulness, groundedness}, B:{...}}`, integers 1 to 5. Rubric: tone (in-voice, friendly, not stiff or padded), helpfulness (answers what was asked, directly), groundedness (game facts correct or hedged, nothing invented; an invented number caps it at 2). 1 bad, 3 acceptable, 5 excellent.
- Decision rule (`PAIR_RULE` in `pass-bar.mjs`), over at least 30 graded items: the Worker passes only if all hold: each dimension mean >= Leeroy's mean minus 0.25; Worker groundedness mean >= 4.0; no more than 5% of items with Worker groundedness <= 2; Worker total (sum of the three) >= Leeroy total on at least 70% of items. `merge` prints the aggregate and the verdict and writes per-item unblinded scores to `--out` (outside the repo).

## After the load and the flag (GAME_FACTS_READ)

The honest baseline above was measured on a Worker without table facts (production, 48 truth questions: spell level, item level, cooldown, cast time, mana cost, trait ranks and points; exact 3 of 48, and 19 of the 20 answers kept were honest abstentions followed by nearby figures that pushed the unsupported rate to 95.8 percent). Once the `game_facts` table is loaded (`GAME_FACTS_LOAD`, `docs/runbooks/game-facts.md`) and `GAME_FACTS_READ` is `"on"`, **re-run the baseline**: a fresh truth set with at least 30 scored items per kind (`--per-kind 30` or more, the same `--traits` file, the same seed or a new one that is logged), through the shadow route, which runs the real `answerWithAi` and therefore the reader unchanged. Read it like this:

- A pass is the bar above on the table kinds: `exact_rate >= 0.90`, `unsupported_rate <= 0.02`, `degraded_rate <= 0.05`, `within_budget_rate >= 0.95`, at least 30 scored items per kind. It is not a comparison with the old baseline: the old numbers only show the direction.
- Expect the **kind of failure** to change. Before: abstain plus nearby figures (unsupported). After, a failure is one of: the row is missing from the table (the answer is the one-sentence abstention: low exact and low unsupported, so it points at the load, not the model); the lookup did not find the name (read the question against `questionWindows`); the model stated a figure without a row id (unsupported: look for a number with no `[kind:id]`); the name is shared and the answer listed rows (exact if the right row is among them and the question named no rank).
- `degraded_rate` and `within_budget_rate` should not move: the reader adds three D1 reads beside the persona load and about 540 input tokens (measured offline, `docs/runbooks/game-facts.md`). If they move, look for `game-facts:lookup-failed` first.
- Keep the flag-off baseline file: the same run with the flag off is the control. A run that passes with the flag off means the questions are not about table facts.
- Not proven here: that the table's rows are the client's real rows (the loader's counts and manifest check that), and anything about questions the truth kinds do not cover.

## Not proven by this harness

- It calls the Worker's answer path through the shadow route, so it inherits the shadow route's limits: no delivery, no concurrency, and a run without an asker slug has no build or member memory (pair records with `asker_slug` use it).
- Scores are lexical. A correct number in a wrong sentence passes `exact_match`; a right answer in an unusual phrasing ("twenty-first level up") can miss. Spot-check by reading failures with `--keep-answers` on a truth set (the truth set is not private; a pair corpus is).
