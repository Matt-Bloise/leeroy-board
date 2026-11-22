// Validator for the voice golden question set (tests/unit/fixtures/voice-golden/questions.json). No model, no network.
// Run: node --test tests/unit/voice-golden.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { scanSecrets } from "../../infrastructure/worker/research/real-names.js";
import { J, scanText } from "./real-name-scan.mjs";

const read =(rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const raw = read("./fixtures/voice-golden/questions.json");
const doc = JSON.parse(raw);
const qs = doc.questions;

const CATEGORIES = ["class_spec", "professions", "leveling", "raids", "pvp", "group_comp", "followup", "thanks_oneliner", "tease_bot", "library_gap", "injection", "private_sheet", "non_game"];
const MIN_PER_CATEGORY = 5;
const BANDS = { line: [20, 300], short: [150, 700], standard: [400, 1500] };
const TAGS = new Set(["other_member_sheet", "other_member_question", "asker_sheet", "system_prompt", "secrets", "skippy", "invented_names", "invented_numbers", "real_life_details", "ping_mention", "bare_url", "game_facts"]);
const EXPECT_KEYS = ["first_sentence_answers", "may_abstain", "must_not_name", "length_band", "needs_pick", "needs_citation"];

test("file has version, 80 questions", () => {
  assert.equal(doc.version, 1);
  assert.equal(qs.length, 80);
});

test("every question has the full schema", () => {
  for (const q of qs) {
    const where = q.id || JSON.stringify(q).slice(0, 40);
    assert.match(q.id, /^gs-\d{3}$/, where);
    assert.ok(CATEGORIES.includes(q.category), `${where}: category ${q.category}`);
    assert.ok(["visitor", "member"].includes(q.asker_role), `${where}: asker_role`);
    if (q.asker_role === "member") assert.match(q.asker_member, /^[A-E]$/, `${where}: member needs asker_member A-E`);
    else assert.equal(q.asker_member, null, `${where}: visitor has no asker_member`);
    assert.equal(typeof q.question, "string", where);
    assert.ok(q.question.trim().length >= 2 && q.question.length <= 300, `${where}: question length`);
    assert.equal(typeof q.rationale, "string", where);
    assert.ok(q.rationale.length >= 15 && q.rationale.length <= 200, `${where}: rationale should be short`);
    assert.deepEqual(Object.keys(q.expect).sort(), [...EXPECT_KEYS].sort(), `${where}: expect keys`);
    const e = q.expect;
    for (const k of ["first_sentence_answers", "may_abstain", "needs_pick", "needs_citation"]) assert.equal(typeof e[k], "boolean", `${where}: ${k}`);
    assert.ok(BANDS[e.length_band], `${where}: length_band`);
    assert.ok(Array.isArray(e.must_not_name), `${where}: must_not_name`);
    assert.equal(new Set(e.must_not_name).size, e.must_not_name.length, `${where}: duplicate must_not_name`);
    for (const t of e.must_not_name) assert.ok(TAGS.has(t) || /^member:[A-E]$/.test(t), `${where}: unknown tag ${t}`);
    assert.equal("previous" in q, q.category === "followup", `${where}: previous only on followup`);
    if (q.category === "followup") {
      if (q.asker_role === "member") assert.ok(typeof q.previous === "string" && q.previous.length > 5, `${where}: member follow-up needs previous`);
      else assert.equal(q.previous, null, `${where}: a visitor has no earlier turn`);
    }
  }
});

test("ids are unique and sequential; questions are unique", () => {
  assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
  qs.forEach((q, i) => assert.equal(q.id, `gs-${String(i + 1).padStart(3, "0")}`));
  const norm = qs.map((q) => `${q.asker_role}|${q.question.toLowerCase().replace(/\W+/g, " ").trim()}`);
  assert.equal(new Set(norm).size, qs.length, "duplicate question text");
});

test("every category has at least five questions and none is unknown", () => {
  const n = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const q of qs) n[q.category]++;
  for (const c of CATEGORIES) assert.ok(n[c] >= MIN_PER_CATEGORY, `${c} has ${n[c]}`);
  assert.ok(qs.filter((q) => q.asker_role === "visitor").length >= 20, "enough visitor questions");
  assert.ok(qs.filter((q) => q.asker_role === "member").length >= 20, "enough member questions");
});

test("category rules agree with the expected properties", () => {
  for (const q of qs) {
    const e = q.expect;
    const where = q.id;
    if (q.category === "thanks_oneliner") {
      assert.equal(e.length_band, "line", where);
      assert.equal(e.needs_citation, false, where);
      assert.equal(e.needs_pick, false, where);
      assert.ok(e.must_not_name.includes("game_facts"), where);
    }
    if (q.category === "library_gap") assert.equal(e.may_abstain, true, where);
    if (q.category === "library_gap" || q.category === "non_game") assert.equal(e.needs_citation, false, `${where}: nothing to cite`);
    if (q.category === "private_sheet") assert.ok(e.must_not_name.some((t) => t === "other_member_sheet"), where);
    if (q.category === "injection") assert.equal(e.needs_citation && e.must_not_name.length === 0, false, where);
    if (q.asker_role === "visitor" && q.category === "private_sheet" && q.question.includes("everyone")) assert.ok(e.must_not_name.includes("asker_sheet"), where);
    if (e.needs_pick) assert.equal(e.length_band === "line", false, `${where}: a pick needs room for trade-offs`);
    assert.equal(e.must_not_name.some((t) => /^member:/.test(t) && t === `member:${q.asker_member}`), false, `${where}: the asker's own sheet may be used`);
  }
});

// Privacy. The shared scan (tests/unit/real-name-scan.mjs, also used for golden set v2) reads the roster names, aliases and slugs from the code at runtime and catches
// case, plural, glued, zero-width, lookalike and escaped forms, long ids, emails and mentions; scanSecrets is the Worker's own token check. Nothing real is typed here.
// Allowed: the generic game-role words that are also roster aliases (the set talks about Mages and tanks), and the mention in gs-067, a deliberate ping attempt.
const ROLE_WORDS = new Set(ROSTER_DATA.flatMap((r) => r.aliases || []).filter((a) => new RegExp("^(?:" + J("ma", "ge") + "|" + J("ta", "nk") + ")$", "i").test(a)).map((a) => `name:${a.toLowerCase()}`));
const DELIBERATE_MENTION = new Set(["gs-067"]);
const privacyHits = (id, text) => [
  ...scanText(text).filter((h) => !ROLE_WORDS.has(h) && !(h === "mention" && DELIBERATE_MENTION.has(id))),
  ...scanSecrets(text, {}),
].map((h) => `${id}: ${h}`);

test("no roster name, alias, slug, id, email, mention or token appears (shared privacy scan)", () => {
  const problems = [...privacyHits("file", JSON.stringify({ ...doc, questions: [] })), ...qs.flatMap((q) => privacyHits(q.id, JSON.stringify(q)))];
  assert.deepEqual(problems, []);
  assert.ok(scanText(JSON.stringify({ ...qs[0], question: `ask ${ROSTER_DATA[1].display} about it` })).some((h) => h.startsWith("name:")), "the scan is live: a planted roster name is caught");
});

test("no name from data/party.json appears either", () => {
  const party = JSON.parse(read("../../data/party.json"));
  const names = (party.members || []).map((m) => (typeof m.name === "string" ? m.name.trim() : "")).filter(Boolean);
  assert.ok(names.length >= 1, "party.json should list members, or this check checks nothing");
  const hay = raw.toLowerCase();
  for (const n of names) {
    const re = new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    assert.equal(re.test(hay), false, "a real member name appears in the voice golden set");
  }
});

test("the only links are example.invalid ones", () => {
  const links = raw.match(/\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s"]*|www\.[^\s"]*|discord(?:app)?\.(?:gg|com)\/[^\s"]*)/gi) || [];
  for (const l of links) assert.match(l, /^https?:\/\/example\.invalid(?:[/:?#]|$)/i, "only example.invalid links are allowed");
});

// Every single letter after "member" or "members" (any case, also in lists like "Members A and B") is one of A to E, in the question, the earlier turn and the rationale.
const memberLetters = (s) => {
  const out = [], w = String(s).split(/[\s,]+/);
  for (let i = 0; i < w.length; i++) if (/^members?$/i.test(w[i])) for (let j = i + 1; j < w.length; j++) {
    const t = w[j].replace(/[.?!:;'")]+$/, "").replace(/'s$/i, "");
    if (/^(?:and|or|&)$/i.test(t)) continue;
    if (/^[A-Za-z]$/.test(t)) { out.push(t); continue; }
    break;
  }
  return out;
};

test("members are only ever the letters A to E", () => {
  assert.deepEqual(memberLetters("ask member f, Members A and g's sheet"), ["f", "A", "g"], "the letter reader itself");
  for (const q of qs) for (const l of memberLetters(`${q.question} ${q.previous || ""} ${q.rationale}`)) assert.match(l, /^[A-E]$/, q.id);
});
