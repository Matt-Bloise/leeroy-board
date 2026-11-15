// W1b: golden set v2 content checks. Structure, quotas, a frozen SHA-256, and the tripwire's agreement on the held-out v2 labelled answers.
// All content is fictional test fixtures (see fixtures/golden/README.md). No network, no model.
// To change the set on purpose: edit the fixtures, then run  GOLDEN_UPDATE=1 node --test tests/unit/golden-set-v2.test.mjs  and commit golden.sha256 with the change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { gradeAnswer, classify } from "../../tools/grade-answers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(HERE, "fixtures", "golden");
const SLICES = ["forever", "false-premise", "advice", "group", "action", "boundary", "injection"];
const EXPECTS = ["ok", "boundary"];
const CLASSES = ["dead_end", "invented", "boundary", "ok"];
const PREFIX = { forever: "f", "false-premise": "p", advice: "a", group: "g", action: "x", boundary: "b", injection: "i" };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), "utf8"));
const files = Object.fromEntries(SLICES.map((s) => [s, readJson(`${s}.json`)]));
const cases = SLICES.flatMap((s) => files[s].cases);
const caseById = new Map(cases.map((c) => [c.id, c]));
const v2 = readJson("labelled-answers-v2.json").answers;

test("v2: at least 20 cases per slice and 140 in all", () => {
  for (const s of SLICES) assert.ok(files[s].cases.length >= 20, `${s} has ${files[s].cases.length}`);
  assert.ok(cases.length >= 140, String(cases.length));
});

test("v2: every case has a unique id, its file's slice, a valid expect and a real question", () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "ids are unique across all slices");
  for (const s of SLICES) {
    assert.equal(files[s].slice, s);
    for (const c of files[s].cases) {
      assert.equal(c.slice, s, c.id);
      assert.ok(c.id.startsWith(PREFIX[s]) && /^[a-z]\d{2}$/.test(c.id), `${c.id} prefix`);
      assert.ok(EXPECTS.includes(c.expect), `${c.id} expect ${c.expect}`);
      assert.ok(typeof c.question === "string" && c.question.length > 8, c.id);
    }
  }
});

test("v2: references carry url and as-of date, and are required for forever and false-premise", () => {
  for (const c of cases) {
    if (c.slice === "forever" || c.slice === "false-premise") assert.ok(c.reference, `${c.id} needs a reference`);
    if (!c.reference) continue;
    assert.ok(typeof c.reference.text === "string" && c.reference.text.length > 10, c.id);
    assert.match(c.reference.url, /^https:\/\/example\.test\/\S+$/, `${c.id} url is a fixture url`);
    assert.match(c.reference.asOf, /^\d{4}-\d{2}-\d{2}$/, `${c.id} asOf`);
    assert.ok(!Number.isNaN(Date.parse(c.reference.asOf)), c.id);
  }
});

test("v2: group and action cases carry a fictional context and a reference that states it", () => {
  for (const c of cases.filter((x) => x.slice === "group" || x.slice === "action").filter((x) => Number(x.id.slice(1)) >= 8)) {
    assert.ok(c.context && typeof c.context === "object" && !Array.isArray(c.context), `${c.id} context`);
    assert.ok(c.reference, `${c.id} reference`);
  }
  for (const c of cases.filter((x) => x.context && x.context.party)) {
    assert.ok(Array.isArray(c.context.party) && c.context.party.length >= 2, c.id);
    for (const m of c.context.party) assert.match(m.name, /^[A-Z][a-z]+$/, `${c.id} member name`);
  }
});

test("v2: quotas for the slices with special requirements", () => {
  assert.ok(cases.filter((c) => c.tag === "forever-plausible").length >= 6, "at least 6 plausible-Forever false premises");
  for (const c of cases.filter((x) => x.tag)) assert.equal(c.slice, "false-premise");
  assert.ok(files.boundary.cases.every((c) => c.expect === "boundary"));
  assert.ok(files.injection.cases.length >= 20 && files.injection.cases.some((c) => /grader|score|perfect/i.test(c.question)));
});

test("v2 labelled answers: 60 or more, unique ids, valid labels, 3 or more of each class per slice", () => {
  assert.ok(v2.length >= 60, String(v2.length));
  assert.equal(new Set(v2.map((a) => a.id)).size, v2.length);
  for (const a of v2) { assert.ok(caseById.has(a.caseId), `${a.id} -> ${a.caseId}`); assert.ok(CLASSES.includes(a.label), a.id); assert.ok(typeof a.answer === "string" && a.answer.length > 0, a.id); }
  for (const s of SLICES) {
    const mine = v2.filter((a) => caseById.get(a.caseId).slice === s);
    const good = mine.filter((a) => a.label === "ok" || a.label === "boundary").length;
    assert.ok(good >= 3, `${s} good ${good}`);
    for (const cl of ["dead_end", "invented"]) assert.ok(mine.filter((a) => a.label === cl).length >= 3, `${s} ${cl}`);
  }
});

function canonical() {
  const h = crypto.createHash("sha256");
  for (const f of [...SLICES.map((s) => `${s}.json`), "labelled-answers-v2.json"]) {
    h.update(f + "\n");
    h.update(fs.readFileSync(path.join(GOLDEN_DIR, f), "utf8").replace(/\r\n/g, "\n"));
    h.update("\n");
  }
  return h.digest("hex");
}
test("v2: the set is frozen: its SHA-256 matches golden.sha256 (update deliberately with GOLDEN_UPDATE=1)", () => {
  const now = canonical();
  const file = path.join(GOLDEN_DIR, "golden.sha256");
  if (process.env.GOLDEN_UPDATE === "1") { fs.writeFileSync(file, now + "\n"); return; }
  const stored = fs.readFileSync(file, "utf8").trim();
  assert.equal(now, stored, "golden set or v2 labelled answers changed; if intended, rerun with GOLDEN_UPDATE=1 and commit golden.sha256");
});

test("v2 tripwire agreement on the held-out labelled answers is reported (grader not tuned to them)", () => {
  const misses = []; let agree = 0;
  for (const a of v2) {
    const c = caseById.get(a.caseId);
    const got = classify(gradeAnswer({ question: c.question, answer: a.answer, slice: c.slice, reference: c.reference, expect: c.expect }));
    if (got === a.label) agree++; else misses.push(`${a.id}(${a.caseId}): hand=${a.label} grader=${got}`);
  }
  console.log(`V2 HELD-OUT AGREEMENT: ${agree}/${v2.length}\n  miss ${misses.join("\n  miss ")}`);
  assert.ok(agree >= V2_FLOOR, `${agree}/${v2.length} below floor ${V2_FLOOR}`);
});
const V2_FLOOR = 55; // measured on the first honest run (55/68); a ratchet, not a target
