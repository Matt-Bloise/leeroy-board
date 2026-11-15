# Voice evaluation: blind pairwise harness

This tool measures whether Leeroy's voice is restored, offline. It never calls a model. Sessions generate the answers and run the judges; this tool builds the blind tasks and scores the verdicts. Every prompt and answer is fictional (Testbard, Examplemage and friends): never put real friend names, real chat content or real questions in any file here. A unit test scans every file in this folder for roster names.

## What the arms measure

The arms are answers written by whatever model and prompt the session uses (for example Claude subagents given the new persona and the rewritten deleters). The result tells you whether that prompt and post-processing produce the voice. It does not measure the production model, which is a different model on a different prompt path: a pass here is evidence about the persona and the deleters on the writing model, not about what the Worker will post.

How arms receive the facts: every arm must be given exactly what the judge sees, the prompt's `facts` array rendered as the bullet list under "LIBRARY FACTS", plus the `previous` turn for follow-ups. A prompt with no facts is given an empty library ("the library has nothing on this"). An arm that sees different facts than the judge makes the number check and the facts-only question meaningless.

## Files

| File | Role |
|---|---|
| `prompts.json` | 30 core fictional prompts (12 information, 8 casual, 5 library-lacks-it, 5 follow-ups with `previous`) plus the 8 from archaeology 4b tagged `set:"4b"`. Fields: `id, kind, set, prompt, previous?, facts?`. |
| `prompts.sha256`, `rubric.sha256` | Frozen hashes of `prompts.json` (canonical JSON) and `rubric.md` (BOM and CRLF removed). A test fails on drift, and `make-tasks` and `aggregate` refuse to run on a mismatch unless `--allow-unfrozen` is given. Changing either is a deliberate re-freeze: earlier results stop being comparable. |
| `rubric.md` | The 13 voice rules, grouped (voice, fact, format and length). Rules 5 and 6 need group knowledge a blind judge lacks and are excluded. |
| `make-tasks.mjs` | Builds `tasks.jsonl` (for judges) and `mapping.json` (secret, sealed with a content hash). |
| `make-batches.mjs` | Splits `tasks.jsonl` into batches, one per fresh judge context. |
| `aggregate.mjs` | Scores `verdicts.jsonl` against `mapping.json`. |
| `owner-sample.mjs` | Picks 10 random pairs and writes an unlabelled sheet for the owner's spot check; `--compare` scores agreement. |
| `lib.mjs` | Seeded RNG, hashes, Wilson bounds, number and leak checks. |
| `run-arms.mjs`, `arms.mjs` | Generates the three arm outputs for the 38 prompts (see "Generating the arms"). The only part of this folder that can call a provider, and only with `--yes` and keys from the environment. |

## Generating the arms

`run-arms.mjs` runs the Worker's own prompt building (`buildAnswerInputs`) and finishing (`finishAnswerText`) in Node against a fake D1 and fictional party sheets, then calls the providers. Arms: `prod-prompt-llama` (research off, Workers AI Llama 3.3 70B, 350 tokens), `restored-llama` (research on: research rules, tokenised prompt, labellers, Llama, 700 tokens), `restored-claude` (the same research prompt, tokenised and guarded as `research/claude.js` does, answered by Claude). Files for the judge side are `arm1.jsonl` to `arm3.jsonl`; `mapping.json` (private) holds the real names; `usage.json` holds counts, ids, latency and error codes, never prompt or answer text.

Exactly one mode is required. `--emit-prompts` and `--ingest-answers` are the default flow: no keys, no network, the environment is never read. `--dry-run` uses canned fake replies. `--live` calls the providers, reads keys only then, and needs `--yes`.

### Offline flow (no keys): emit, answer elsewhere, ingest

The offline arms are `prod-prompt` (the production prompt, research off), `restored-haiku` and `restored-sonnet` (the same research-mode prompt, tokenised and guard-checked, for a Haiku-class and a Sonnet-class model). Directory and file names use arm1 to arm3; `mapping.json` holds the real names.

1. Emit the prompts: `node tools/voice-eval/run-arms.mjs --emit-prompts --out runs/arms1 --seed 7`. This writes `runs/arms1/<arm>/<promptId>.json` (`{system, user}`, exactly what a provider would be sent) and `mapping.json` (private). Prompts the code answers itself (research off, nothing in the library) and prompts a guard blocks get no file; `mapping.json` lists both.
2. Answer them with any model: give each answerer one prompt file, the system text as the system prompt and the user text as the message, and have it write its raw reply, unedited, to `runs/arms1/<arm>/<promptId>.answer.txt`. Match the model class to the arm only if you know the mapping; the answerer must not see `mapping.json`. One fresh context per prompt, no memory of other prompts. Subagents or any model work.
3. Ingest: `node tools/voice-eval/run-arms.mjs --ingest-answers runs/arms1 --out runs/arms1-out`. It re-derives each prompt from the seed in `mapping.json`, refuses a reply whose prompt changed since emit (`prompt:drift`), detokenises research replies, flags replies that leak a name or carry a foreign token (`reply:flagged`), runs the Worker's own finishing for the arm (flag-off deleters for `prod-prompt`; labeller and length handling for the research arms) and writes `arm1.jsonl` to `arm3.jsonl` plus `ingest-report.json` (ids and codes only). A missing answer is reported and left out; nothing is defaulted. Exit 1 means something is missing or flagged.
4. Build the blind tasks: `node tools/voice-eval/make-tasks.mjs --arm arm1=runs/arms1-out/arm1.jsonl --arm arm2=... --arm arm3=... --pairs arm2:arm3 --seed 7 --out runs/r1` (any pairs you want to compare).
5. Judge each task in a fresh context with a different model family from the answerers (for example Codex when the answers came from Claude), two judges, as in "Running it" above. Judges see only each task's `text`.
6. Aggregate with `aggregate.mjs`, naming the candidate arm, then open `runs/arms1/mapping.json` to see which arm was which.

### Live flow (keys)

```
# dry run with canned replies, no network
node tools/voice-eval/run-arms.mjs --dry-run --out runs/dry --seed 7

# live: keys from the environment only; prints the token estimate, then needs --yes
CF_ACCOUNT_ID=... CF_API_TOKEN=... ANTHROPIC_API_KEY=... node tools/voice-eval/run-arms.mjs --live --yes --out runs/arms1 --seed 7
# optional second Claude pass: --arms restored-claude --claude-model claude-sonnet-5-5 --out runs/arms2
```

The live and dry-run arms are `prod-prompt-llama`, `restored-llama` and `restored-claude`.

Options: `--max-spend N` (estimated tokens, default 400000, refused above), `--claude-model ID` (else env `CLAUDE_VOICE_MODEL`, else `claude-haiku-5-5`), `--arms a,b`, `--dry-run`. Keys are never accepted as arguments. Every prompt carries fictional names only: the Worker's hardcoded real display names are replaced with fictional ones before tokenising (`fictionaliseRoster`). With research off, an abstaining prompt (all casual and "library lacks it" prompts) is answered by code and makes no model call, exactly as in production.
| `lib.mjs` | Seeded RNG, hashes, Wilson bounds, number, leak and normalisation rules. |

Rubric changelog: 2026-11-15, `rubric.md` gained a "Rule groups" paragraph (voice rules 2, 3, 4, 7; fact rules 11, 13; format and length rules 8, 9; mixed 1, 10, 12; not judged blind 5, 6) so the voice-only and facts-only questions can point at rule numbers; `rubric.sha256` was re-frozen deliberately. No rule text changed. 2026-11-14 (c4755249): rule 12 gained "last 2 to 3 turns", rules 5 and 6 were excluded from the blind question, and the preamble was made neutral.

## Running it

1. Generate answers for each arm on the 30 core prompts (and optionally the 4b set), as described above. One JSONL per arm, one line per prompt: `{"id":"info-01","answer":"..."}`. Include the release arm, the candidate arm, and optionally an `original` arm of reference answers (tokenised, giveaway dates removed, paraphrased prompts only). Arm names are 3 to 40 characters of letters, digits, dot, dash or underscore.
2. Build the tasks. Keep `mapping.json` away from the judges.

   ```
   node tools/voice-eval/make-tasks.mjs --arm release=release.jsonl --arm candidate=cand.jsonl --arm original=orig.jsonl --reference original --normalise --variants full,voice,facts --seed 7 --out runs/r1
   node tools/voice-eval/make-tasks.mjs --arm release=release.jsonl --pairs release:release --normalise --seed 8 --out runs/self
   ```

   - `--normalise` is strongly recommended: it strips, identically for every arm, the `-#` lines and plain "Sources:" lines, parenthetical or bracketed confidence and Classic or Forever tags, markdown bold, italic, code, headings and bullet markers, and turns links into their label. A judge can otherwise tell the arms apart by those artefacts alone. The run prints per-arm length stats; normalisation does not equalise real length differences, so read them. A run built without it is flagged NOT NORMALISED in the report.
   - `--tolerant` makes a missing, non-string or empty arm answer (and an arm row with no string id) non-fatal: that prompt is dropped for every arm, so pairs stay balanced, and is listed in `mapping.excluded`, on the make-tasks console and in the aggregate report. Without it the same input still fails. Nothing is defaulted or repaired.
   - `--variants` adds preference questions besides `full` (voice and facts together): `voice` (judge only the rubric's voice rules, ignoring facts, formatting, length and sources) and `facts` (which answer states fewer unsupported specifics given the facts). Each is order-swapped and reported apart.
   - The second command is the self-comparison: the same answers on both sides, reported as `release#1` against `release#2`.
   - Add `--sets core,4b` for the 8 extra prompts. The build aborts on a leak: an arm name (a plain-word arm name such as "release" only in a label context like "the release version", so "release notes" is fine), a model or vendor name as a whole word (claude, llama, gemini, gpt, codex, sonnet, opus, haiku, openai, anthropic, google, chatgpt, llm, "language model", "as an ai"), or judge-directed text (`ANSWER A:` also inside `**` or `>`, `SYSTEM:`, "Judge: reply A", "this is the reference answer", "disregard the rubric", "ignore previous instructions"). Duplicate pairs (a:b with b:a counts) and a build with nothing to compare are refused.
3. Batch the tasks: `node tools/voice-eval/make-batches.mjs --tasks runs/r1/tasks.jsonl --mapping runs/r1/mapping.json --size 6 --out runs/r1/batches`. No batch holds two tasks about the same prompt, so the two order-swapped twins of a pair are never together. One batch per fresh judge context: give a judge session one `batch-NNN.jsonl`, never two, so it cannot learn the arms from earlier tasks.
4. Run at least two judges from different vendors, never the model that wrote the answers. A judge sees only each task's `text`, never `mapping.json` or file names, and replies with exactly one token per task: `A`, `B` or `NONE` (the reference variant takes `A` or `B` only).
5. Collect one line per task: `{"taskId":"t00017","verdict":"A","judge":"judge-1"}`. Give every row a judge id or none; ids are trimmed and lower-cased. Each judge must cover every task, or the run is refused (`--allow-incomplete` overrides with a warning).
6. Owner spot check: `node tools/voice-eval/owner-sample.mjs --tasks runs/r1/tasks.jsonl --mapping runs/r1/mapping.json --out sheet.txt` writes 10 random pairs with no arm labels. The owner writes A, B or NONE for each (about five minutes) into a JSONL of `{taskId, verdict}`; `owner-sample.mjs --compare owner.jsonl verdicts.jsonl --judge judge-1` counts agreement (`--judge` is required when the file holds several judges; duplicate owner rows are refused). Fewer than 8 of 10 and that judge is replaced.
7. Score, naming the candidate: `node tools/voice-eval/aggregate.mjs --mapping runs/r1/mapping.json --verdicts runs/r1/verdicts.jsonl --candidate candidate --cluster-size 6` (add `--json` for the full report, `--strict-numbers` to enforce the number check).

## What the report says

- A pair is the two order-swapped tasks for one prompt and question. Only order-consistent pairs count as a preference. Two `NONE` verdicts are a consistent tie; one `NONE` is inconsistent.
- Both arms are always reported. The pass line is for the named `--candidate` only, for the `full` question on the 30 core prompts, against each other arm. The voice and facts questions are reported with the same numbers but carry no pass criterion.
- Preference rate is preferred pairs over all complete pairs, so ties and inconsistent pairs stay in the denominator. The lower bound is the one-sided 95% Wilson lower bound on that rate.
- The number check (below) is advisory: the report shows a flag count per arm, the pairs it would change and the adjusted result, but PASS rests on the judge's verdicts. `--strict-numbers` makes PASS also need 24 of 30 in the adjusted result.
- Judge reliability: order-swap consistency of at least 85% over non-self preference pairs, and no position bias (the share of `A` verdicts has a 95% Wilson interval that contains 50%; a judge that says A to everything is flagged). Reference pairs do not count in the consistency gate; they have their own report. An unreliable judge never produces PASS, and its numbers should be discarded.
- Self-comparison: the first copy's share of decided judgements with a 95% Wilson interval; the check is that the interval contains 50%. All NONE passes. Self pairs are exempt from the consistency gate. Do not use a 45 to 55% single-run gate: for 60 independent coin-flip judgements the exact chance of landing inside 45 to 55% is 63.4%, so 36.6% of honest runs fall outside. In the unit test's 50 simulated random-judge runs, 39 landed inside 45 to 55% and 49 had an interval containing 50%.
- Which-is-the-reference: accuracy over all judgements (two per prompt, 60 for 30 prompts) with a 95% Wilson interval. "Cannot tell" needs the interval inside 35 to 65%; at exactly 50% accuracy that holds from about 40 judgements, so 60 suffice (interval 37.7 to 62.3%), but with 60 judgements only an accuracy of exactly 50% fits: a sweep of 0 to 30 prompts found correct in both orders gave "cannot tell" only at 15. "Can tell" needs an interval that excludes 50% (above it; "can-tell-inverted" when the judge systematically picks the non-reference answer). Everything else is "inconclusive", and an unreliable judge gets no verdict. The two judgements of one prompt are not independent, so the interval is optimistic; accuracy over consistent pairs only is printed beside it.
- The 4b set is reported separately and has no pass criterion.
- Clusters: when the arms were written by separate agents each covering a batch of prompts (for example one agent per 6 prompts), prompts within a batch share a writer, so the intervals are optimistic. Pass `--cluster-size N` and the report prints the cluster count (30 prompts at 6 per agent is 5 clusters). With only a handful of clusters, treat even a clean pass as indicative.

## Number rule (advisory flag)

An answer may state only numbers its prompt supports: the prompt's `facts`, the prompt text, the `previous` turn, or the count of listed facts (when there are 2 or more).

- Ignored: the `-# Sources:` line, URLs, bracket cites like `[page~key]`, hyphenated ids with a zero-padded suffix (`dungeons-03`) and exact prompt ids; ordinals (`2nd`, `3rd`); fractions and ratios (`24/7`, `10/10`); `100%` and `0%`; the number zero; and a count that matches the items the answer lists right after it ("two trees: Frostline or Emberlash", or "three options:" followed by three bullets).
- Normalised: `8.0` and `08` are 8, `1,200` is 1200, `.95` is 0.95, `18,24` is two numbers (18 and 24, never 1824), `lvl35` and `x95` hold 35 and 95, `5-player` holds 5, `95%` equals `95`; `0.95` does not equal `95`.
- Number words count, both ways: `four` and `4` support each other, `ninety-five`, `thirty five` and `one hundred` are numbers. The bare word "one" is never a number, and "a" or "an" never is.
- List markers (`1.`, `2)`) at a line start are ignored only while they run 1, 2, 3 in order, so `- 95. Bring gold.` is still counted.
- The hour rule: in the facts or prompt, "an hour", "one hour" or "a day" supports the digit 1. There is no unit conversion: "1 hour" is not supported by "60 minutes".
- Names are not checked. Ordinary prose such as "one of two options" can still raise a flag, which is why the rule is advisory: the report lists every flagged prompt so a person can look.

## Pass criteria

| Check | Pass |
|---|---|
| Candidate against the release, `full` question, 30 core prompts | preferred in at least 24 of 30 (and, with `--strict-numbers`, also after the number check) |
| Release against itself | the first-copy share's 95% interval contains 50% (all NONE counts) |
| Order-swap consistency and position bias, per judge | at least 85% over preference pairs, and an A-share interval containing 50% |
| Can-it-tell against the originals | "cannot tell": all-judgement accuracy with the whole 95% interval inside 35 to 65% |

A pass needs each criterion to hold for both judges.

## Limits

- Thirty prompts is low power. Report the interval with every number, not a verdict. For 24 of 30 the one-sided 95% Wilson lower bound is 0.657. The advice file's "about 0.63" is closer to the exact Clopper-Pearson bound, 0.643 for 24 of 30 (both solved by bisection). Wilson gives about 0.66.
- Clustered writers (see above) make every interval optimistic.
- The judges are models. They share blind spots: they may reward length or a particular flourish, and the rubric cannot fully remove that. The owner spot check is the human anchor.
- The fictional prompts and facts are not the library. They test voice and number discipline, not retrieval.
- The number check catches invented numbers only. An invented name, a wrong fact that reuses a supported number, or a leaked real name in a reference answer is not caught.
- Leak, injection and normalisation rules are pattern-based. Real length differences, vocabulary and rhythm can still identify an arm; that is part of the voice being measured, but a judge may reward it for the wrong reason.
- The mapping hash catches accidental edits, not a deliberate forger who recomputes it.
- The which-is-the-reference judge is not shown the facts or the rubric, by design.
