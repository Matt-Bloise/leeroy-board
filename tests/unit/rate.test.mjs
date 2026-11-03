// Unit tests for the blind rating page logic (rate/rate.js) and the privacy guard for the bake-off files.
// No DOM, no network, no AI. rate.js is a classic script; it is evaluated in a vm sandbox with a fake module object.
// Run: node --test tests/unit/rate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const sandbox = { module: { exports: {} }, URL, Math, Number, String, Object, Array, JSON };
vm.runInNewContext(read("rate/rate.js"), sandbox);
const R = sandbox.module.exports;

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// ---- Bradley-Terry ----
test("Bradley-Terry: two items, A beats B 2 of 3 -> strength ratio 2:1 (hand computed)", () => {
  // MLE fixed point: p_A = W_A / (n / (p_A + p_B)) = (2/3)(p_A + p_B), so p_A = 2 p_B. Normalised: 2/3 and 1/3.
  const comps = [{ a: "A", b: "B", score: 1 }, { a: "A", b: "B", score: 1 }, { a: "A", b: "B", score: 0 }];
  const { strengths } = R.bradleyTerry(comps);
  approx(strengths.A, 2 / 3);
  approx(strengths.B, 1 / 3);
});

test("Bradley-Terry: three items, hand computed 3:1:1", () => {
  // A beats B 3 times and loses once; B and C split 2-2. Wins: A 3, B 1+2 = 3, C 2. n_AB = 4, n_BC = 4.
  // p_A = 3/(4/(p_A+p_B)) -> p_A = 3 p_B. p_C = 2/(4/(p_B+p_C)) -> p_C = p_B.
  // Check item B: W_B = 3 = p_B (4/(3 p_B + p_B) + 4/(p_B + p_B)) = 1 + 2. Consistent.
  // Ratios 3:1:1 -> normalised 0.6, 0.2, 0.2.
  const comps = [
    ...Array(3).fill({ a: "A", b: "B", score: 1 }), { a: "A", b: "B", score: 0 },
    { a: "B", b: "C", score: 1 }, { a: "B", b: "C", score: 1 }, { a: "B", b: "C", score: 0 }, { a: "B", b: "C", score: 0 },
  ];
  const { strengths } = R.bradleyTerry(comps);
  approx(strengths.A, 0.6, 1e-7);
  approx(strengths.B, 0.2, 1e-7);
  approx(strengths.C, 0.2, 1e-7);
});

test("Bradley-Terry: a three-way cycle gives equal strengths; ties count half", () => {
  const cyc = R.bradleyTerry([{ a: "A", b: "B", score: 1 }, { a: "B", b: "C", score: 1 }, { a: "C", b: "A", score: 1 }]).strengths;
  approx(cyc.A, 1 / 3, 1e-7); approx(cyc.B, 1 / 3, 1e-7); approx(cyc.C, 1 / 3, 1e-7);
  const ties = R.bradleyTerry([{ a: "A", b: "B", score: 0.5 }, { a: "A", b: "B", score: 0.5 }]).strengths;
  approx(ties.A, 0.5); approx(ties.B, 0.5);
});

test("Bradley-Terry: prior keeps an unbeaten item finite and ordering intact", () => {
  const { strengths } = R.bradleyTerry([{ a: "A", b: "B", score: 1 }, { a: "A", b: "B", score: 1 }], { prior: 0.5 });
  assert.ok(strengths.A > strengths.B && strengths.B > 0 && strengths.A < 1);
  approx(strengths.A + strengths.B, 1);
});

test("summarize: wins, ties, both bad (kept out of the strength score)", () => {
  const s = R.summarize([
    { a: "X", b: "Y", choice: "a" }, { a: "Y", b: "X", choice: "a" }, { a: "X", b: "Y", choice: "a" },
    { a: "X", b: "Y", choice: "tie" }, { a: "X", b: "Y", choice: "bad" },
  ]);
  const x = s.rows.find((r) => r.label === "X"), y = s.rows.find((r) => r.label === "Y");
  assert.deepEqual([x.wins, x.losses, x.ties, x.bothBad, x.shown], [2, 1, 1, 1, 5]);
  assert.deepEqual([y.wins, y.losses, y.ties, y.bothBad], [1, 2, 1, 1]);
  assert.equal(s.comparisons, 4);
  assert.equal(s.rows[0].label, "X");
});

// ---- shuffle and pairing ----
test("seeded shuffle is deterministic, a permutation, and seed dependent", () => {
  const list = Array.from({ length: 20 }, (_, i) => i);
  const a = R.seededShuffle(list, "s1"), b = R.seededShuffle(list, "s1"), c = R.seededShuffle(list, "s2");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort((x, y) => x - y), list);
  assert.deepEqual(list, Array.from({ length: 20 }, (_, i) => i), "input untouched");
});

const cell = (q, c, answer = `**${c} answers ${q}.**`) => ({ questionId: q, question: `Question ${q}?`, candidate: c, ok: true, answer });

test("makePairs: one pair per question, balanced, deterministic, A/B order mixed, failed cells skipped", () => {
  const cells = [];
  for (let i = 1; i <= 12; i++) for (const c of ["m1", "m2", "m3"]) cells.push(cell(`q${i}`, c));
  cells.push({ questionId: "q1", candidate: "m4", ok: false, answer: "" });
  const pairs = R.makePairs(cells, "seed", 1);
  assert.equal(pairs.length, 12);
  assert.deepEqual(pairs, R.makePairs(cells, "seed", 1));
  const shown = {};
  for (const p of pairs) { shown[p.a.label] = (shown[p.a.label] || 0) + 1; shown[p.b.label] = (shown[p.b.label] || 0) + 1; assert.notEqual(p.a.label, p.b.label); }
  for (const n of Object.values(shown)) assert.equal(n, 8);
  assert.ok(pairs.some((p) => p.a.label < p.b.label) && pairs.some((p) => p.a.label > p.b.label), "A/B order is mixed");
  assert.equal(R.makePairs(cells, "seed", 3).length, 36);
});

test("makePairs: identical answers are not worth a rating; a lone answer makes no pair", () => {
  assert.equal(R.makePairs([cell("q", "a", "same"), cell("q", "b", "same")], "s", 1).length, 0);
  assert.equal(R.makePairs([cell("q", "a")], "s", 1).length, 0);
});

test("collectCells accepts a cell array, a response, or several responses, and dedupes", () => {
  const c1 = cell("q1", "a"), c2 = cell("q1", "b");
  assert.equal(R.collectCells([c1, c2]).length, 2);
  assert.equal(R.collectCells({ results: [c1, c2] }).length, 2);
  assert.equal(R.collectCells([{ results: [c1] }, { results: [c2, c1] }]).length, 2);
  assert.equal(R.collectCells("junk").length, 0);
});

// ---- Discord-style text ----
test("parser: bold, bullets, small text, masked links", () => {
  const blocks = R.parseBlocks("**Head.**\n\n• **Name** · value\n- second\n\n-# Sources: [Page](<https://leeroy.party/#library.a.b>) · [Two](https://example.com/x)");
  assert.equal(blocks[0].type, "p");
  assert.equal(blocks[0].lines[0][0].t, "bold");
  assert.equal(blocks[1].type, "ul");
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].type, "small");
  const links = blocks[2].nodes.filter((n) => n.t === "link");
  assert.deepEqual(Array.from(links, (l) => l.href), ["https://leeroy.party/#library.a.b", "https://example.com/x"]);
});

test("parser: everything is data, never markup; unsafe link targets stay text", () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(1)</script> [click](javascript:alert(1)) [ok](<data:text/html;base64,AAAA>) **<b>x</b>**';
  const nodes = R.parseBlocks(evil)[0].lines[0];
  assert.ok(!nodes.some((n) => n.t === "link"), "no link for javascript: or data:");
  const flat = JSON.stringify(nodes);
  assert.ok(flat.includes("<img src=x onerror=alert(1)>"), "html kept as literal text");
  // The only element kinds the renderer can produce are text, bold, code and link.
  const kinds = new Set();
  (function walk(ns) { for (const n of ns) { kinds.add(n.t); if (n.children) walk(n.children); } })(nodes);
  for (const k of kinds) assert.ok(["text", "bold", "code", "link"].includes(k));
  assert.equal(R.safeHref("https://a.example/x"), "https://a.example/x");
  assert.equal(R.safeHref("javascript:alert(1)"), null);
  assert.equal(R.safeHref("not a url"), null);
});

test("rate.js builds no markup from data: no innerHTML, no eval, no network APIs", () => {
  const src = read("rate/rate.js");
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /importScripts/]) {
    assert.equal(bad.test(src), false, String(bad));
  }
});

// ---- the page and fixture hold no private data ----
const DISCORD_ID = /(?<!\d)\d{17,20}(?!\d)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MENTION = /<@[!&]?\d+>/;

function riskyFiles() {
  const files = ["rate/index.html", "rate/rate.js", "rate/rate.css", "tests/fixtures/bake-off-sample.json", "docs/runbooks/model-bake-off.md"];
  return files.filter((f) => existsSync(new URL(f, root)));
}

test("the rating page, the fixture and the runbook carry no 17 to 20 digit ids, emails or mentions", () => {
  const files = riskyFiles();
  assert.ok(files.length >= 4);
  for (const f of files) {
    const text = read(f);
    assert.equal(DISCORD_ID.test(text), false, `${f}: a 17 to 20 digit number (Discord id shape)`);
    assert.equal(EMAIL.test(text), false, `${f}: an email address`);
    assert.equal(MENTION.test(text), false, `${f}: a Discord mention`);
  }
});

test("no long line is copied from the privacy documents into the bake-off files", () => {
  const docs = ["docs/privacy.md", "docs/data-inventory.md"].flatMap((f) => read(f).split(/\r?\n/)).map((l) => l.trim()).filter((l) => l.length >= 60);
  const set = new Set(docs);
  for (const f of riskyFiles()) {
    for (const line of read(f).split(/\r?\n/)) assert.equal(set.has(line.trim()), false, `${f}: copies a privacy document line`);
  }
});

test("the fixture is fictional and shaped like an eval request; real data stays out of the repo", () => {
  const fx = JSON.parse(read("tests/fixtures/bake-off-sample.json"));
  assert.equal(fx.questions.length, 8);
  assert.ok(/fictional/i.test(fx.note));
  for (const q of fx.questions) assert.ok(/^[A-Za-z0-9_.-]{1,40}$/.test(q.id) && q.text.length < 200);
  // The page picks a local file; it never names a results path or a URL to fetch.
  const html = read("rate/index.html");
  assert.ok(/type="file"/.test(html));
  assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<meta[^>]*>/g, "")), false, "no external URLs in the page");
  assert.ok(/noindex/.test(html));
  assert.ok(/Disallow: \/rate\//.test(read("robots.txt")));
});

test("the workflows copy the rate folder into the deploy", () => {
  for (const f of readdirSync(new URL(".github/workflows/", root)).filter((n) => /^(deploy-cloudflare|pr-preview-cloudflare)\.yml$/.test(n))) {
    assert.match(read(`.github/workflows/${f}`), /for item in [^;]*\blanding\b[^;]*\brate\b/, f);
  }
});
