// Differential test for the /ask ranking path's CPU optimisations (rank-core.js, self-rag.js selectRelevant): the ranked output of the
// 200 fictional questions of tests/fixtures/ask-cpu/questions.json, and of one query per Library fact key and per page title, must be
// byte-identical to the snapshot taken from master BEFORE the optimisations (tests/fixtures/ask-cpu/ranked.sha256.json).
// Each digest covers rank() (words, every hit's score, page, key, value, open flag) and selectRelevant() (kept hits and all counters).
// To regenerate after an intentional ranking change (never for a speed change): UPDATE_ASK_CPU_SNAPSHOT=1 node --test tests/unit/ask-cpu-differential.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { rank, factHays } from "../../infrastructure/worker/rank-core.js";
import { selectRelevant, cleanQuestion } from "../../infrastructure/worker/self-rag.js";
import { loadLibrary, loadQuestions } from "../../tools/bench-ask-cpu.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapPath = path.join(here, "..", "fixtures", "ask-cpu", "ranked.sha256.json");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const pages = await loadLibrary();
const hays = factHays(pages);
const keyQueries = [...new Set(pages.flatMap((p) => [String(p.title || p.id), ...p.facts.map((f) => `${p.title} ${f.key.replace(/[._]/g, " ")}`)]))];
const sets = { questions: loadQuestions(), keys: keyQueries };

function fingerprint(q, h = hays) {
  const r = rank(cleanQuestion(q, []), pages, { hays: h });
  const rel = selectRelevant(r.hits, r.words, h);
  const out = JSON.stringify({
    words: r.words,
    hits: r.hits.map((x) => [x.score, x.page, x.key, x.value, x.open]),
    rel: { hits: rel.hits.map((x) => [x.page, x.key, x.score]), abstain: rel.abstain, best: rel.best, kept: rel.kept, dropped: rel.dropped, absent: rel.absent },
  });
  for (const x of r.hits) { assert.ok(!x.f || pages.find((p) => p.id === x.page).facts.includes(x.f), "hit.f is the page's own fact object"); }
  return sha(out);
}
const digestsOf = (list, h) => list.map((q) => fingerprint(q, h));

if (process.env.UPDATE_ASK_CPU_SNAPSHOT) {
  fs.writeFileSync(snapPath, JSON.stringify({ note: "sha256 of the ranked output per query, taken from master before the ask-cpu optimisations. See tests/unit/ask-cpu-differential.test.mjs.", questions: digestsOf(sets.questions), keys: digestsOf(sets.keys) }, null, 1) + "\n");
}
const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));

test("200 questions: ranked output is byte-identical to the pre-optimisation snapshot", () => {
  assert.equal(sets.questions.length, 200);
  const got = digestsOf(sets.questions);
  sets.questions.forEach((q, i) => assert.equal(got[i], snap.questions[i], `question ${i}: ${q}`));
});
test("one query per fact key and page title: ranked output is byte-identical", () => {
  const got = digestsOf(sets.keys);
  assert.equal(got.length, snap.keys.length);
  sets.keys.forEach((q, i) => assert.equal(got[i], snap.keys[i], `query ${i}: ${q}`));
});
test("same answers with a fresh hays array and fresh page objects (caches never leak between corpora)", () => {
  const pagesCopy = JSON.parse(JSON.stringify(pages));
  const h2 = factHays(pagesCopy);
  for (const q of sets.questions.slice(0, 40)) {
    const a = rank(cleanQuestion(q, []), pagesCopy, { hays: h2 });
    const b = rank(cleanQuestion(q, []), pages, { hays });
    assert.deepEqual(a.hits.map((x) => [x.score, x.page, x.key, x.open]), b.hits.map((x) => [x.score, x.page, x.key, x.open]));
  }
});
test("a corpus edited in place is ranked as edited (the caches do not serve stale text)", () => {
  const p = JSON.parse(JSON.stringify(pages));
  const h = factHays(p);
  const before = rank("zeppelin travel", p, { hays: h }).hits.length;
  p[0].facts[0] = { key: "zeppelin.travel", value: "zeppelin travel route" };
  const h2 = factHays(p);
  assert.ok(rank("zeppelin travel", p, { hays: h2 }).hits.length >= 1);
  p[0].facts[0].value = "something else entirely";
  assert.equal(rank("zeppelin travel", p, { hays: factHays(p) }).hits.some((x) => x.page === p[0].id && x.key === "zeppelin.travel" && /zeppelin/.test(x.value)), false);
  assert.ok(before >= 0);
});
