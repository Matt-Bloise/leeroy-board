# Golden set v2 fixtures

These are TEST FIXTURES, not game facts. Every place, item, NPC, number, date and URL in these files is invented
(urls point at example.test). Character names are fictional placeholders. A reference text is the authored ground
truth for grading one case; it is not a claim about any real game. Do not add real friend questions, real chat
content, real names or secrets.

- `<slice>.json`: 21 cases per slice (forever, false-premise, advice, group, action, boundary, injection).
  Schema: `{id, slice, question, expect: "ok"|"boundary", reference?: {text, url, asOf}, context?, tag?}`.
  `context` (group and action cases) is a fictional party or group state; the reference restates it as text for the grader.
  `tag: "forever-plausible"` marks a false premise that sounds like a real Forever feature (a Retail-style mechanic).
- `labelled-answers*.json`, `adversarial-answers.json`: hand-labelled candidate answers used to measure the tripwire.
  `labelled-answers-v2.json` is held out: the grader was not tuned to it.
- `golden.sha256`: freezes the seven case files plus `labelled-answers-v2.json`. Change the set on purpose, then run
  `GOLDEN_UPDATE=1 node --test tests/unit/golden-set-v2.test.mjs` and commit the new hash with the change.
