// Differential test for the /ask ranking path's CPU optimisations (rank-core.js, self-rag.js selectRelevant).
// Oracle: tests/fixtures/ask-cpu/reference/ holds the verbatim pre-optimisation rank-core.js and self-rag.js (master before PR 364).
// For every query, the optimised code and the reference must return the same words, the same hits (score, page, key, value, open) and the
// same selectRelevant verdict (kept hits, abstain, best, kept, dropped, absent). A failure prints the question and the two outputs.
// The reference runs on the live Library too, so a Library edit never breaks this test: both sides see the same data.
// A small synthetic corpus with stated expectations covers the cache rules without relying on the Library.
import test from "node:test";
import assert from "node:assert/strict";
import * as fast from "../../infrastructure/worker/rank-core.js";
import * as fastRag from "../../infrastructure/worker/self-rag.js";
import * as ref from "../fixtures/ask-cpu/reference/rank-core.js";
import * as refRag from "../fixtures/ask-cpu/reference/self-rag.js";
import { loadLibrary, loadQuestions } from "../../tools/bench-ask-cpu.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));
function outcome(core, rag, q, pages, hays) {
  const r = core.rank(rag.cleanQuestion(q, []), pages, { hays });
  const rel = rag.selectRelevant(r.hits, r.words, hays);
  return {
    words: r.words,
    hits: r.hits.map((x) => ({ score: x.score, page: x.page, key: x.key, value: x.value, open: x.open })),
    relevant: { hits: rel.hits.map((x) => ({ page: x.page, key: x.key, score: x.score })), abstain: rel.abstain, best: rel.best, kept: rel.kept, dropped: rel.dropped, absent: rel.absent },
  };
}
const same = (pages, queries, label) => {
  const hFast = fast.factHays(pages), hRef = ref.factHays(pages);
  assert.deepEqual(hFast, hRef, `${label}: factHays differ`);
  for (const q of queries) assert.deepEqual(outcome(fast, fastRag, q, pages, hFast), outcome(ref, refRag, q, pages, hRef), `${label}: output changed for question: ${q}`);
};

const pages = await loadLibrary();
const keyQueries = [...new Set(pages.flatMap((p) => [String(p.title || p.id), ...p.facts.map((f) => `${p.title} ${f.key.replace(/[._]/g, " ")}`)]))];

test("live Library, 200 fixture questions: same output as the pre-optimisation code", () => {
  const qs = loadQuestions();
  assert.equal(qs.length, 200);
  same(pages, qs, "questions");
});
test("live Library, one query per page title and fact key: same output as the pre-optimisation code", () => {
  assert.ok(keyQueries.length > 1000, "the Library is large enough to be a real corpus");
  same(pages, keyQueries, "keys");
});

// Synthetic corpus: every expectation below is stated, not derived from either implementation.
const corpus = () => [
  { id: "air", title: "Air travel", facts: [{ key: "zeppelin.route", value: "The zeppelin flies from Orgrimmar to Undercity." }, { key: "flight.cost", value: "A flight costs 4 silver." }] },
  { id: "mounts", title: "Mounts", facts: [{ key: "riding.level", value: "Riding needs level 20." }, { key: "mount.price", value: "The first mount costs 90 gold." }] },
];
test("synthetic corpus: a zeppelin question ranks the zeppelin fact first, and reference and optimised code agree", () => {
  const p = corpus();
  const out = outcome(fast, fastRag, "which zeppelin goes to Undercity?", p, fast.factHays(p));
  assert.deepEqual(out.words, ["zeppelin", "undercity"]);
  assert.deepEqual({ page: out.hits[0].page, key: out.hits[0].key, open: out.hits[0].open }, { page: "air", key: "zeppelin.route", open: false });
  assert.equal(out.relevant.abstain, false);
  assert.deepEqual(out.relevant.hits.map((h) => h.key), ["zeppelin.route"]);
  assert.equal(out.relevant.absent, 0);
  same(p, ["which zeppelin goes to Undercity?", "how much is the first mount", "riding level", "something about nothing zzzqx"], "synthetic");
});
test("synthetic corpus: a question about a word no fact uses counts that word as absent", () => {
  const p = corpus();
  const out = outcome(fast, fastRag, "zeppelin pizzeria", p, fast.factHays(p));
  assert.equal(out.relevant.absent, 1);
});
test("fresh page objects and a fresh hays array give the same answers (caches do not leak between corpora)", () => {
  const a = corpus(), b = clone(a);
  const qs = ["which zeppelin goes to Undercity?", "mount price in gold", "riding level"];
  const fromA = qs.map((q) => outcome(fast, fastRag, q, a, fast.factHays(a)));
  const fromB = qs.map((q) => outcome(fast, fastRag, q, b, fast.factHays(b)));
  assert.deepEqual(fromB, fromA);
  assert.deepEqual(fromA, qs.map((q) => outcome(ref, refRag, q, a, ref.factHays(a))));
});
test("a fact edited in place is ranked as edited: the old text stops matching, the new text matches", () => {
  const p = corpus();
  const q = "zeppelin route";
  const top = () => { const o = outcome(fast, fastRag, q, p, fast.factHays(p)); return o.hits.filter((h) => h.score > 0).map((h) => `${h.page}/${h.key}`); };
  assert.equal(top()[0], "air/zeppelin.route");
  p[0].facts[0] = { key: "boat.route", value: "The boat sails from Ratchet to Booty Bay." };
  assert.ok(!top().includes("air/zeppelin.route"), "the replaced fact is gone from the results");
  assert.ok(!top().includes("air/flight.cost"), "before the value edit, flight.cost does not match");
  p[0].facts[1].value = "A zeppelin costs 4 silver.";
  assert.ok(top().includes("air/flight.cost"), "a value edited in place now matches the question (it did not before)");
  same(p, [q, "boat route", "flight cost"], "edited");
});
test("the caches are visible in neither the words nor the idf: stem and idfOf equal the reference for every Library word", () => {
  const h = fast.factHays(pages), hr = ref.factHays(pages);
  const words = [...new Set(keyQueries.flatMap((q) => q.toLowerCase().split(/\W+/).filter(Boolean)))].slice(0, 400);
  for (const w of words) {
    assert.equal(fast.stem(w), ref.stem(w), `stem(${w})`);
    assert.equal(fast.idfOf(w, h), ref.idfOf(w, hr), `idfOf(${w})`);
  }
});
