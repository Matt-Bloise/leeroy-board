# Voice golden question set for /ask (Leeroy)

`questions.json` holds 80 fictional questions used to measure the voice and behaviour of the `/ask` answer path. Tests and fixtures only: nothing here calls a model, and no Worker code reads it.

This is not the answer-grading golden set. That one is `tests/unit/fixtures/golden/` (golden set v2: slices, reference texts, read by `tools/grade-answers.mjs`). This set labels voice properties per question, against the rules in `tools/voice-eval/rubric.md`. The ranker CPU benchmark copied its 80 question texts as the first 80 of `tests/fixtures/ask-cpu/questions.json`; that copy is not kept in sync.

- Members are `A` to `E`, placeholders in no particular order (not positions in the real roster). No real member name, handle or Discord id appears: `tests/unit/voice-golden.test.mjs` runs the shared privacy scan (`tests/unit/real-name-scan.mjs`: roster names, aliases and slugs read from the code at runtime, ids, emails, mentions) and the Worker's token check, and fails on a name from `data/party.json` or a web address other than `example.invalid` (one with a scheme, `www.` or a Discord invite). The file must stay canonical JSON (`JSON.stringify(doc, null, 1)` plus a newline), so a duplicate key cannot hide text from the scans.
- `asker_role` is `visitor` (no sheet, no earlier turns) or `member` (`asker_member` is `A` to `E`).
- `followup` questions carry `previous`, the asker's earlier question. A visitor has none (`null`), so the expected answer asks which question is meant.

## Expected properties (`expect`)

| field | meaning |
| --- | --- |
| `first_sentence_answers` | the first sentence answers the question (voice rubric rule 1). `false` for bait, bare chatter and refusals where nothing is being answered |
| `may_abstain` | the honest "the library does not have that yet" line is an acceptable answer |
| `must_not_name` | things the answer must not contain; tags below, or `member:A` to `member:E` |
| `length_band` | `line` 20-300 chars, `short` 150-700, `standard` 400-1500 (rubric rule 9: 600 to 900 targeted, never over 1,500) |
| `needs_pick` | the asker wants a recommendation; options with trade-offs first, then one clear pick |
| `needs_citation` | a Sources line is expected (a library page backs the answer) |

`must_not_name` tags: `other_member_sheet` (a field another member keeps private; fields they show on the board may be used, as in gs-074), `other_member_question`, `asker_sheet` (a visitor has none), `system_prompt`, `secrets`, `skippy`, `invented_names`, `invented_numbers`, `real_life_details`, `ping_mention`, `bare_url`, `game_facts`.

These are labels for a scorer to apply; the file does not say how. Library coverage can drift: a `library_gap` question may become answerable when the library grows, and then it should be replaced.
