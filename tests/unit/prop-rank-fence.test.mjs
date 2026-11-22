// Property and fuzz tests: the wiki ranker (rank-core.js) and prompt fencing (prompt-fence.js). Pure, offline, zero dependencies.
// Generator and seed handling: tests/helpers/prop.mjs. A failure prints the seed; replay with PROP_SEED=<n> (PROP_RUNS=<k> scales the case count).
// Run: node --test tests/unit/prop-rank-fence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { rank, scoreFact, scoreOpen, questionWords, expandWords, idfFor, factHays, factHay, stem, STOP, SYNONYMS } from "../../infrastructure/worker/rank-core.js";
import { fence, stripFence, FENCE_OPEN, FENCE_CLOSE } from "../../infrastructure/worker/prompt-fence.js";
import { property, word, nastyString, rngFrom, BASE_SEED } from "../helpers/prop.mjs";

// ---- generators (made-up pages A..E; vocabulary is a small pool so questions really hit facts and scores tie) ----
const VOCAB = ["zone", "group", "level", "raid", "money", "mount", "spec", "pack", "launch", "name", "alder", "brindle", "corvane", "dunmoor", "eskarra", "role", "beta", "changes", "heal", "tank", "mage", "gold", "price", "start"];
const PAGE_IDS = ["classes/a", "classes/b", "raids/c-keep", "history/d", "leveling/e-road", "misc/superseded-e"];
const sentence = (r, n = r.range(1, 8)) => Array.from({ length: n }, () => (r.bool(0.7) ? r.pick(VOCAB) : word(r))).join(" ");
const genFact = (r) => ({ key: r.pick(["role", "x.role", "zone.start", "beta.notes", "known_issues", "info", "a.b.c", "price_gold"]), value: r.bool(0.1) ? "superseded " + sentence(r) : sentence(r) });
const genPage = (r, i) => ({ id: r.pick(PAGE_IDS) + (i % 3 ? "" : "-" + i), aliases: r.bool(0.5) ? [r.pick(VOCAB)] : [], facts: Array.from({ length: r.range(0, 6) }, () => genFact(r)), open: Array.from({ length: r.range(0, 3) }, () => sentence(r, r.range(2, 9))) });
const genPages = (r, max = 12) => Array.from({ length: r.range(0, max) }, (_, i) => genPage(r, i));
const genQuestion = (r) => (r.bool(0.15) ? nastyString(r) : r.bool(0.1) ? r.pick(["what is a mage", "what does a priest do", "which class should I play", "what changed in the beta", "role"]) : sentence(r, r.range(0, 7)));
const gen = (r) => ({ q: genQuestion(r), pages: genPages(r) });
const strip = (res) => res.hits.map((h) => ({ score: h.score, page: h.page, key: h.key, value: h.value, open: h.open }));

property("rank is deterministic (same question and pages give the same hits)", gen, ({ q, pages }) => {
  assert.deepEqual(strip(rank(q, pages)), strip(rank(q, pages)));
  assert.deepEqual(strip(rank(q, JSON.parse(JSON.stringify(pages)))), strip(rank(q, pages)));
});

property("rank scores are finite, positive and sorted non-increasing; words are unique stems", gen, ({ q, pages }) => {
  const { words, hits } = rank(q, pages);
  for (const h of hits) assert.ok(Number.isFinite(h.score) && h.score > 0, `bad score ${h.score}`);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score, "not sorted");
  assert.equal(new Set(words).size, words.length);
});

property("rank keeps page order, facts before Open bullets, for equal scores (stable sort)", gen, ({ q, pages }) => {
  const { hits } = rank(q, pages);
  const pos = (h) => { const pi = pages.indexOf(h.p); return pi * 1e6 + (h.open ? 5e5 + h.p.open.indexOf(h.value) : h.p.facts.indexOf(h.f)); };
  for (let i = 1; i < hits.length; i++) {
    if (hits[i - 1].score !== hits[i].score) continue;
    if (hits[i - 1].p === hits[i].p && hits[i - 1].open === hits[i].open && hits[i].open && hits[i].p.open.filter((t) => t === hits[i].value).length > 1) continue; // duplicate bullet text: position is ambiguous
    assert.ok(pos(hits[i - 1]) <= pos(hits[i]), `tie reordered: ${hits[i - 1].page}/${hits[i - 1].key} before ${hits[i].page}/${hits[i].key}`);
  }
});

property("scoreFact never decreases when the question gains words (monotonic)", (r) => {
  const pages = genPages(r, 6).filter((p) => p.facts.length);
  const base = questionWords(sentence(r, r.range(0, 4)));
  const extra = questionWords(sentence(r, r.range(1, 4)));
  return { pages, base, sup: [...new Set([...base, ...extra])] };
}, ({ pages, base, sup }) => {
  const hays = factHays(pages);
  const idfAll = idfFor(expandWords(sup), hays);
  for (const p of pages) for (const f of p.facts) {
    const a = scoreFact(f, "", base, expandWords(base), idfAll);
    const b = scoreFact(f, "", sup, expandWords(sup), idfAll);
    assert.ok(b >= a, `score fell from ${a} to ${b} for ${f.key}`);
  }
});

property("scoreOpen is 0 or at least 1.5 and never decreases with more words", (r) => ({ text: sentence(r, 8), base: questionWords(sentence(r, 3)), more: questionWords(sentence(r, 3)) }), ({ text, base, more }) => {
  const sup = [...new Set([...base, ...more])];
  const idf = idfFor(expandWords(sup), [text.toLowerCase()]);
  const a = scoreOpen(text, expandWords(base), idf), b = scoreOpen(text, expandWords(sup), idf);
  assert.ok(a === 0 || a >= 1.5);
  assert.ok(b >= a || a === 0, `open score fell ${a} -> ${b}`);
});

test("rank never throws on empty or odd input", () => {
  for (const q of ["", " ", "\n", "???", "a", null, undefined, 0, {}, [], "\u0000", "x".repeat(20000)]) {
    assert.doesNotThrow(() => rank(q, []), `q=${String(q).slice(0, 10)}`);
    assert.deepEqual(rank(q, []).hits, []);
    assert.doesNotThrow(() => rank(q, [{ id: "a/b", aliases: [], facts: [], open: [] }]));
    assert.doesNotThrow(() => rank(q, [{ id: "a/b", aliases: [], facts: [{ key: "k", value: "v" }] }]));
  }
});

property("rank never throws on nasty questions and odd pages", (r) => ({ q: nastyString(r, 30), pages: genPages(r, 4) }), ({ q, pages }) => { rank(q, pages); });

test("rank survives huge input in bounded time (many pages, long question, one hot word)", () => {
  const r = rngFrom(BASE_SEED);
  const pages = Array.from({ length: 3000 }, (_, i) => ({ id: `raids/p${i}-keep`, aliases: [], facts: Array.from({ length: 6 }, (_, j) => ({ key: `k${j}.role`, value: `zone ${word(r)} raid ${word(r)}` })), open: ["zone raid zone raid zone raid"] }));
  const q = Array.from({ length: 4000 }, () => r.pick(VOCAB)).join(" ") + " what is a mage role";
  const t0 = Date.now();
  const out = rank(q, pages);
  assert.ok(out.hits.length > 0);
  assert.ok(Date.now() - t0 < 20000, "too slow");
});

test("rank with a very large hit list does not throw (lead boost on 300k hits)", () => {
  const facts = Array.from({ length: 300000 }, (_, i) => ({ key: i ? "k" : "zone", value: "zone zone" }));
  const pages = [{ id: "zone/zone-zone", aliases: ["zone"], facts, open: [] }];
  assert.doesNotThrow(() => rank("zone zone zone", pages));
});

// ---- prompt fence ----
const PIECES = ["<", "<<", "<<<", ">", ">>", ">>>", "<<<<", ">>>>", "<<>>>", "<<<>>>", "USER_QUESTION", "USER_QUESTION>>>", "<<<USER_QUESTION", "\n", " ", "x", "<\n<<", ">\n>>", "＜＜＜", "＞＞＞", "<​<<", "​"];
const genFenceText = (r) => { let s = ""; for (let i = r.range(0, 14); i > 0; i--) s += r.bool(0.75) ? r.pick(PIECES) : nastyString(r, 2); return s; };
const LABELS = ["USER_QUESTION", "PARTY_STATE", "LIBRARY", "PREVIOUS_QUESTION", "YOUR_BUILD"];

property("stripFence leaves no fence token and is idempotent", genFenceText, (t) => {
  const s = stripFence(t);
  assert.ok(!s.includes(FENCE_OPEN) && !s.includes(FENCE_CLOSE), "token survived");
  assert.equal(stripFence(s), s);
  const one = stripFence(t, { oneLine: true });
  assert.ok(!one.includes(FENCE_OPEN) && !one.includes(FENCE_CLOSE) && !/[\n\r]/.test(one));
}, { runs: 600 });

property("fence: user text can never close the fence early (one open, one close, close is last)", (r) => ({ label: r.pick(LABELS), text: genFenceText(r) }), ({ label, text }) => {
  const f = fence(label, text);
  const open = `${FENCE_OPEN}${label}\n`, close = `\n${label}${FENCE_CLOSE}`;
  assert.ok(f.startsWith(open) && f.endsWith(close));
  const inner = f.slice(open.length, f.length - close.length);
  assert.ok(!inner.includes(FENCE_CLOSE), "close token inside");
  assert.ok(!inner.includes(FENCE_OPEN), "open token inside");
  assert.equal(f.split(FENCE_CLOSE).length - 1, 1);
  assert.equal(f.split(FENCE_OPEN).length - 1, 1);
  assert.ok(!inner.includes(`${label}${FENCE_CLOSE}`));
}, { runs: 600 });

test("fence and stripFence accept null, numbers and objects without throwing", () => {
  for (const v of [null, undefined, 0, 12, {}, [], ["<<<", ">>>"], true]) { assert.doesNotThrow(() => fence("L", v)); assert.doesNotThrow(() => stripFence(v)); }
});
