// ask-eval-picked.mjs: the /ask answer eval for ASK_PICKED, with a baseline run through the same harness. LOCAL ONLY: it calls the Antigravity CLI (Gemini)
// and reads the friends' gold questions from disk. Adapted from tests/local/ask-eval-composed.mjs. Nothing is written to a repo.
//
//   ASK_EVAL_GOLD=<gold.jsonl> ASK_EVAL_WORK=<dir outside every repo> ASK_EVAL_AGY=<agy.exe> node tests/local/ask-eval-picked.mjs --path picked --limit 60 [--cap-hour 20] [--wait]
//   ... --path production   (the same questions through the production prompt: the baseline)
//   ... --path composed --code-opener   (ASK_COMPOSED with the code opener: no model call)
//   ASK_EVAL_WORK=<same dir> node tests/local/ask-eval-picked-judge.mjs --path picked --wait      (Codex judge, with answers_question and off_target_facts)
//   ASK_EVAL_WORK=<same dir> node tests/local/ask-eval-picked.mjs --report --path picked --baseline production   (aggregates and Fisher's exact test; numbers only)
//
// Rows: the held-out questions first (sha1 order, as run.mjs), then, when --limit is larger than the held-out set, train questions in the same order; each answer
// records its split so the held-out subset can be reported on its own. Asker rotation as run.mjs (fictional Red Fox, Blue Owl, Green Elk).
// picked path: buildAnswerInputs with ASK_PICKED on; rows with an offer get ONE Gemini call whose prompt is pickerPrompts; the reply is parsed strictly
// (composePicked) and the answer passed through finishAnswerText and re-proved exactly as answerWithAi does. Abstain rows are the code refusal. Rows outside the
// picked path (skip kinds, coach) use the production prompt, as production would with the flag on.
// Files per path under WORK/<path>/ (prompts, answers, judgments); one agy/codex call ledger WORK/calls.jsonl shared by every path and the judge, so the hourly
// cap holds across them. ASK_EVAL_LEDGERS=<a.jsonl,b.jsonl> adds other ledgers (earlier runs) to the hourly count.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = process.env.ASK_EVAL_REPO || path.resolve(import.meta.dirname, "../..");
const GOLD = process.env.ASK_EVAL_GOLD;
const WORK = process.env.ASK_EVAL_WORK;
const AGY = process.env.ASK_EVAL_AGY || "agy";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const appendJsonl = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(o) + "\n"); };
const rowKey = (r) => `${r.id}|${r.asker}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!WORK) { console.error("ask-eval-picked: set ASK_EVAL_WORK to a folder outside every repo"); process.exit(2); }
const PATHS = ["picked", "production", "composed"];
const PATH = arg("--path", "picked");
if (!PATHS.includes(PATH)) { console.error(`ask-eval-picked: --path is one of ${PATHS.join(", ")}`); process.exit(2); }
const DIR = path.join(WORK, PATH);
const PROMPTS = path.join(DIR, "prompts.jsonl"), ANSWERS = path.join(DIR, "answers.jsonl"), CALLS = path.join(WORK, "calls.jsonl");

// ---- report: aggregates by mode, and Fisher's exact test against a baseline path (numbers only) -------------------------------
function lnFact(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
// two-sided Fisher's exact test for [[a, b], [c, d]]: sum of the probabilities of every table with the same margins that is no more likely than the observed one
function fisher(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const p = (x) => Math.exp(lnFact(r1) + lnFact(r2) + lnFact(c1) + lnFact(n - c1) - lnFact(n) - lnFact(x) - lnFact(r1 - x) - lnFact(c1 - x) - lnFact(r2 - c1 + x));
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1), obs = p(a);
  let s = 0;
  for (let x = lo; x <= hi; x++) { const q = p(x); if (q <= obs * (1 + 1e-7)) s += q; }
  return Math.min(1, s);
}
// exact McNemar (paired, same questions): two-sided binomial on the discordant pairs
function mcnemar(b, c) { const n = b + c; if (!n) return 1; const k = Math.min(b, c); let s = 0; for (let x = 0; x <= k; x++) s += Math.exp(lnFact(n) - lnFact(x) - lnFact(n - x) - n * Math.LN2); return Math.min(1, 2 * s); }
if (flag("--report")) {
  const load = (p) => {
    const A = readJsonl(path.join(WORK, p, "answers.jsonl")), J = readJsonl(path.join(WORK, p, "judgments.jsonl"));
    const jm = new Map(J.map((j) => [rowKey(j), j]));
    return A.map((a) => ({ ...a, j: jm.get(rowKey(a)) || null }));
  };
  const inv = (r) => r.j && ((Array.isArray(r.j.invented) ? r.j.invented.length : 0) > 0 || r.j.det_invented > 0);
  const stats = (rows) => {
    const judged = rows.filter((r) => r.j);
    const br = judged.filter((r) => r.j.build_relevant === 1);
    const ans = judged.filter((r) => r.j.answers_question === 1).length;
    const lacks0 = judged.filter((r) => r.j.library_lacks === 0);
    return {
      rows: rows.length, judged: judged.length,
      personalisation: [br.filter((r) => r.j.uses_build === 1).length, br.length],
      answers_question: [ans, judged.length],
      answers_question_when_library_has_it: [lacks0.filter((r) => r.j.answers_question === 1).length, lacks0.length],
      invented: [judged.filter(inv).length, judged.length],
      abstain_or_refusal: [rows.filter((r) => r.mode === "abstain" || r.refused).length, rows.length],
      off_target_facts_mean: judged.length ? +(judged.reduce((s, r) => s + (Number(r.j.off_target_facts) || 0), 0) / judged.length).toFixed(2) : null,
      honest_refusal: [judged.filter((r) => r.j.library_lacks === 1 && r.j.honest_refusal === 1).length, judged.filter((r) => r.j.library_lacks === 1).length],
      cites_source: [judged.filter((r) => r.j.cites_source === 1).length, judged.length],
    };
  };
  const group = (rows) => {
    const out = { all: stats(rows) };
    for (const m of [...new Set(rows.map((r) => (r.refused ? `${r.mode}-refused` : r.mode)))].sort()) out[m] = stats(rows.filter((r) => (r.refused ? `${r.mode}-refused` : r.mode) === m));
    out.heldout = stats(rows.filter((r) => r.split === "heldout"));
    return out;
  };
  const cur = load(PATH);
  const rep = { path: PATH, by: group(cur) };
  const pick = cur.filter((r) => r.parse);
  if (pick.length) rep.picker = { offered: pick.length, valid: pick.filter((r) => r.parse.ok).length, empty: pick.filter((r) => r.parse.ok && !r.picks.length).length, invalid_reasons: pick.filter((r) => !r.parse.ok).reduce((m, r) => ((m[r.parse.reason] = (m[r.parse.reason] || 0) + 1), m), {}), lenient_would_parse: pick.filter((r) => !r.parse.ok && r.lenientOk).length, proofFailed: pick.filter((r) => r.refused && r.parse.ok && r.picks.length).length, picksMean: +(pick.reduce((s, r) => s + (r.picks ? r.picks.length : 0), 0) / pick.length).toFixed(2) };
  const baseName = arg("--baseline", "");
  if (baseName) {
    const base = load(baseName);
    const a = stats(cur), b = stats(base);
    const test = (k) => { const [x1, n1] = a[k], [x2, n2] = b[k]; return { [PATH]: `${x1}/${n1}`, [baseName]: `${x2}/${n2}`, fisher_p: +fisher(x1, n1 - x1, x2, n2 - x2).toFixed(4) }; };
    rep.vs = { baseline: baseName, personalisation: test("personalisation"), answers_question: test("answers_question"), answers_question_when_library_has_it: test("answers_question_when_library_has_it"), invented: test("invented") };
    // paired on the same questions and askers
    const bm = new Map(base.filter((r) => r.j).map((r) => [rowKey(r), r]));
    let b10 = 0, b01 = 0, both = 0;
    for (const r of cur.filter((x) => x.j)) { const o = bm.get(rowKey(r)); if (!o) continue; both++; const x = r.j.answers_question === 1, y = o.j.answers_question === 1; if (x && !y) b10++; if (!x && y) b01++; }
    rep.vs.answers_question_paired = { pairs: both, [`${PATH}_only`]: b10, [`${baseName}_only`]: b01, mcnemar_exact_p: +mcnemar(b10, b01).toFixed(4) };
    const ah = stats(cur.filter((r) => r.split === "heldout")), bh = stats(base.filter((r) => r.split === "heldout"));
    rep.vs.heldout = Object.fromEntries(["personalisation", "answers_question", "invented"].map((k) => [k, { [PATH]: `${ah[k][0]}/${ah[k][1]}`, [baseName]: `${bh[k][0]}/${bh[k][1]}`, fisher_p: +fisher(ah[k][0], ah[k][1] - ah[k][0], bh[k][0], bh[k][1] - bh[k][0]).toFixed(4) }]));
  }
  console.log(JSON.stringify(rep, null, 1));
  process.exit(0);
}
if (!GOLD) { console.error("ask-eval-picked: set ASK_EVAL_GOLD (the local gold set)"); process.exit(2); }

const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href);
const { buildAnswerInputs, finishAnswerText, invalidatePagesCache } = await imp("infrastructure/worker/ai-models.js");
const { invalidatePersonaCache, loadPersona } = await imp("infrastructure/worker/persona.js");
const { invalidateConfigCache } = await imp("infrastructure/worker/config.js");
const { schemaDb } = await imp("tests/helpers/sqlite-d1.mjs");
const { composeAnswer, openerPrompts, verifyFinished, buildIsTopical, composeFactsBlock, factParts } = await imp("infrastructure/worker/ask-composed.js");
const { composePicked, pickerPrompts, parsePicks } = await imp("infrastructure/worker/ask-picked.js");
const { composeAbstain } = await imp("infrastructure/worker/self-rag.js");

const ASKERS = ["Red Fox", "Blue Owl", "Green Elk"];
const SLUG = { "Red Fox": "red-fox", "Blue Owl": "blue-owl", "Green Elk": "green-elk" };
const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection"), level: f(34), professions: f(["mining", "blacksmithing"]), goals: f("tank every dungeon for the party", false) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("gnome"), spec_path: f("frost"), level: f(28), professions: f(["tailoring", "enchanting"]), goals: f("quiet solo grinding", false) }, updated: "x" },
  { slug: "green-elk", name: "Green Elk", fields: { class: f("priest"), race: f("undead"), spec_path: f("holy"), level: f(31), professions: f(["herbalism", "alchemy"]), goals: f("heal without dying", false) }, updated: "x" },
];
const FLAGS = { picked: { ASK_PICKED: "on" }, production: {}, composed: { ASK_COMPOSED: "on" } };

function makeEnv() {
  invalidatePagesCache(); invalidatePersonaCache(); invalidateConfigCache();
  const DB = schemaDb();
  const dir = path.join(REPO, "data/library");
  const ins = DB.raw.prepare("INSERT OR REPLACE INTO lib_pages (id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json, related_json, history_json, snapshots_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { continue; }
    if (!Array.isArray(j.pages)) continue;
    for (const p of j.pages) {
      if (!p || !p.id || !p.title || !Array.isArray(p.facts)) continue;
      ins.run(p.id, p.category || j.category, p.title, p.confidence || "confirmed", p.status || "current", p.as_of || null, p.checked || null, p.recheck_days || 7, p.blurb || "",
        JSON.stringify(p.aliases || []), JSON.stringify(p.facts || []), JSON.stringify(p.open || []), JSON.stringify(p.related || []), JSON.stringify(p.history || []), JSON.stringify(p.snapshots || []), "2026-11-01T00:00:00Z");
    }
  }
  const put = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(k, JSON.stringify(v));
  put("party_sheets", SHEETS);
  put("signups", { roster: { "Red Fox": "yes", "Blue Owl": "yes", "Green Elk": "maybe" } });
  put("tonight", { title: "Deadmines run" });
  try { const idx = fs.readFileSync(path.join(dir, "index.json"), "utf8"); DB.raw.prepare("INSERT OR REPLACE INTO lib_blobs (name, stamp, json, updated_at) VALUES ('index.json', ?, ?, 'x')").run(JSON.parse(idx).generated || "v1", idx); } catch {}
  return { DB, BOARD_PUBLIC_URL: "https://leeroy.party", ...FLAGS[PATH] };
}

function evalRows(limit) {
  const all = readJsonl(GOLD);
  const order = (rows) => rows.sort((a, b) => crypto.createHash("sha1").update(a.id).digest("hex").localeCompare(crypto.createHash("sha1").update(b.id).digest("hex")));
  const held = order(all.filter((r) => r.split === "heldout")), train = order(all.filter((r) => r.split !== "heldout"));
  return [...held, ...train].slice(0, limit).map((r) => ({ ...r, split: r.split === "heldout" ? "heldout" : "train" }));
}

const ledgers = () => [CALLS, ...String(process.env.ASK_EVAL_LEDGERS || "").split(",").filter(Boolean)];
const usedLastHour = (model) => { const now = Date.now(); return ledgers().flatMap(readJsonl).filter((r) => r.model === model && now - Date.parse(r.at) < 3600e3).length; };
function callAgy(system, user) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-eval-picked-agy-"));
  fs.writeFileSync(path.join(dir, "brief.md"), `# Task\nYou are the answering model of a Discord bot. Below are the SYSTEM prompt and the USER message exactly as the bot sends them. Write the bot's reply to the user. Print ONLY the reply as plain text on stdout. Do not write or edit any file, do not run commands.\n\n## SYSTEM\n${system}\n\n## USER\n${user}\n`);
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = "", err = "";
    const child = spawn(AGY, ["-p", "Read brief.md in the current folder (reading files is allowed; NEVER write or edit any file and never run commands) and follow it exactly. Print only the bot's reply as plain text on stdout.", "--output-format", "text"], { cwd: dir });
    const timer = setTimeout(() => child.kill(), 240e3);
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: String(e.message), secs: 0 }); });
    child.on("close", (code) => { clearTimeout(timer); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} resolve({ code, out: out.trim(), err: err.slice(-300), secs: Math.round((Date.now() - t0) / 1000) }); });
  });
}
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 20);
// An existing-path row (skip kinds, coach) sends the production prompt on every path: a stored reply to the identical prompt from another path is reused.
function reusableReply(promptHash) {
  for (const p of PATHS) {
    if (p === PATH) continue;
    const hit = readJsonl(path.join(WORK, p, "answers.jsonl")).find((a) => a.promptHash === promptHash && a.generator === "agy" && a.mode === "existing");
    if (hit) return hit.modelOut;
  }
  return null;
}

const limit = Number(arg("--limit", "60")), capHour = Number(arg("--cap-hour", "20")), maxCalls = Number(arg("--max-calls", "80")), wait = flag("--wait");
const env = makeEnv();
const persona = await loadPersona(env);
const rows = evalRows(limit);
fs.mkdirSync(DIR, { recursive: true });
const done = new Set(readJsonl(ANSWERS).map(rowKey));
let calls = 0, fails = 0;
const dry = {};
const refusal = (inp) => composeAbstain({ categories: inp.parsedPages.map((p) => p.category) });

for (let i = 0; i < rows.length; i++) {
  const r = rows[i], asker = ASKERS[i % 3];
  const key = rowKey({ id: r.id, asker });
  const inp = await buildAnswerInputs(env, { question: r.question, by: asker, memberSlug: SLUG[asker], journey: r.journey || "curious", share: true });
  const pickedMode = PATH === "picked" && Boolean(inp.pickedCtx) && inp.retrieved && !inp.abstain && !inp.isCoach && inp.pickedCtx.offer.length > 0;
  const composedMode = PATH === "composed" && Boolean(inp.composedCtx) && inp.retrieved && !inp.abstain && !inp.isCoach && inp.composedCtx.facts.length > 0;
  const composedBuild = composedMode && buildIsTopical(inp.composedCtx.buildReason, inp.composedCtx.facts, inp.composedCtx.askerBuild, r.question) ? inp.composedCtx.askerBuild : null;
  const codeOpener = PATH === "composed" && flag("--code-opener") && composedMode;
  const mode = inp.abstain ? "abstain" : pickedMode ? "picked" : composedMode ? "composed" : "existing";
  if (flag("--dry")) { dry[mode] = (dry[mode] || 0) + 1; dry[r.split] = (dry[r.split] || 0) + 1; if (pickedMode) { dry.about = (dry.about || 0) + (inp.pickedCtx.about ? 1 : 0); dry.offerMean = (dry.offerMean || 0) + inp.pickedCtx.offer.length; } continue; }
  if (!readJsonl(PROMPTS).some((p) => rowKey(p) === key)) {
    // the judge reads the production prompt context; for picked and composed rows it also sees the facts the code offered or selected (library facts that may sit
    // outside the prompt's top 20 hits)
    const extra = pickedMode
      ? `\n\nOFFERED_FACTS (library facts the bot's code offered; the answer quotes the picked ones verbatim):\n${inp.pickedCtx.offer.map((o) => { const p = factParts(o.h); return `- **${p.title}** · ${p.label}: ${p.value}`; }).join("\n")}`
      : composedMode ? `\n\nCOMPOSED_FACTS (library facts the answer quotes verbatim, selected by code):\n${composeFactsBlock(inp.composedCtx.facts, { max: inp.composedCtx.facts.length, maxChars: Infinity }).text}` : "";
    appendJsonl(PROMPTS, { id: r.id, asker, question: r.question, journey: r.journey || "curious", split: r.split, systemPrompt: inp.systemPrompt, userPrompt: inp.userPrompt + extra, groundingText: inp.groundingText + extra, personalised: inp.personalised, isCoach: inp.isCoach, libraryPages: inp.parsedPages.map((p) => p.id), retrieved: inp.ranked.map((p) => p.id), mode });
  }
  if (done.has(key)) continue;
  const finish = (rawAnswer, extra = {}) => finishAnswerText(env, { rawAnswer, isCoach: inp.isCoach, parsedPages: inp.parsedPages, by: asker, askerIsMember: true, persona, intentId: String(r.id), groundingText: inp.groundingText, personalised: inp.personalised || extra.trusted === true, retrieval: inp.retrieval, trusted: extra.trusted === true, question: r.question, opener: inp.opener });
  const rec = { id: r.id, asker, split: r.split, mode, secs: 0, generator: "agy", refused: false };
  let fin;
  if (mode === "abstain") {
    rec.raw = inp.abstainAnswer; rec.generator = "code";
    fin = await finish(inp.abstainAnswer, { trusted: true });
  } else {
    const prompts = pickedMode ? pickerPrompts({ question: r.question, offer: inp.pickedCtx.offer, askerBuild: inp.pickedCtx.askerBuild })
      : composedMode ? openerPrompts({ question: r.question, askerName: asker, askerBuild: composedBuild, hasBuild: Boolean(composedBuild) })
      : { system: inp.systemPrompt, user: inp.userPrompt };
    rec.promptHash = hash(`${prompts.system}\n${prompts.user}`);
    let g = codeOpener ? { code: 0, out: "", secs: 0, err: "" } : null;
    if (!g && mode === "existing") { const reused = reusableReply(rec.promptHash); if (reused != null) { g = { code: 0, out: reused, secs: 0, err: "" }; rec.reused = true; } }
    if (!g) {
      if (calls >= maxCalls) { console.log(`ask-eval-picked: max-calls ${maxCalls} reached`); break; }
      while (usedLastHour("agy") >= capHour) { if (!wait) break; console.log(`ask-eval-picked: rate guard (${usedLastHour("agy")} agy calls in the last hour, cap ${capHour}); sleeping 5 min`); await sleep(300e3); }
      if (usedLastHour("agy") >= capHour) { console.log(`ask-eval-picked: rate guard stop (${usedLastHour("agy")}/${capHour}). Resume later or pass --wait.`); break; }
      g = await callAgy(prompts.system, prompts.user);
      calls++; appendJsonl(CALLS, { at: new Date().toISOString(), model: "agy", path: PATH, id: r.id, code: g.code, secs: g.secs, chars: g.out.length });
      if (g.code !== 0 || !g.out) { fails++; console.log(`ask-eval-picked: FAILED ${r.id} code=${g.code} err=${g.err.replace(/\s+/g, " ").slice(0, 160)}`); if (fails >= 3) { console.log("ask-eval-picked: 3 failures, stopping"); break; } continue; }
    }
    if (codeOpener) rec.generator = "code";
    rec.secs = g.secs; rec.modelOut = g.out;
    if (mode === "existing") {
      rec.raw = g.out; fin = await finish(g.out);
    } else if (pickedMode) {
      const ctx = inp.pickedCtx;
      const c = composePicked({ question: r.question, rawPicks: g.out, offer: ctx.offer, askerBuild: ctx.askerBuild, about: ctx.about, buildReason: ctx.buildReason, partyNames: ctx.partyNames, askerName: asker });
      rec.parse = c.parse ? { ok: c.parse.ok, reason: c.parse.reason } : null; rec.picks = c.picks || []; rec.pickReason = c.reason; rec.about = ctx.about;
      // diagnostic only (never used for the answer): would a reply wrapped in a code fence or with prose around one array have parsed?
      if (rec.parse && !rec.parse.ok) { const m = /\[[^\[\]]*\]/.exec(g.out); rec.lenientOk = Boolean(m && parsePicks(m[0], ctx.offer.map((o) => o.id)).ok); }
      if (c.ok) {
        rec.raw = c.text; fin = await finish(c.text, { trusted: true });
        const titles = inp.parsedPages.filter((p) => c.ids.includes(p.id)).map((p) => p.title);
        const v = fin.parts.more ? { ok: false } : verifyFinished(fin.parts.main, { used: c.used, sheet: c.build, askerBuild: c.build, partyNames: ctx.partyNames, askerName: asker, extraAllowed: titles, boardUrl: env.BOARD_PUBLIC_URL });
        rec.post = v.ok;
        if (!v.ok) { rec.refused = true; rec.raw = refusal(inp); fin = await finish(rec.raw, { trusted: true }); }
      } else { rec.refused = true; rec.raw = refusal(inp); fin = await finish(rec.raw, { trusted: true }); }
    } else {
      const ctx = inp.composedCtx;
      const c = composeAnswer({ question: r.question, rawOpener: g.out, retrievedFacts: ctx.facts, sheet: composedBuild, askerBuild: composedBuild, partyNames: ctx.partyNames, askerName: asker });
      rec.openerSource = c.ok ? c.openerSource : "none";
      if (c.ok) {
        rec.raw = c.text; fin = await finish(c.text, { trusted: true });
        const titles = inp.parsedPages.filter((p) => c.ids.includes(p.id)).map((p) => p.title);
        const v = fin.parts.more ? { ok: false } : verifyFinished(fin.parts.main, { used: c.used, sheet: composedBuild, askerBuild: composedBuild, partyNames: ctx.partyNames, askerName: asker, extraAllowed: titles, boardUrl: env.BOARD_PUBLIC_URL });
        rec.post = v.ok;
        if (!v.ok) { rec.refused = true; rec.raw = refusal(inp); fin = await finish(rec.raw, { trusted: true }); }
      } else { rec.refused = true; rec.raw = refusal(inp); fin = await finish(rec.raw, { trusted: true }); }
    }
  }
  appendJsonl(ANSWERS, { ...rec, answer: fin.answer, more: (fin.parts && fin.parts.more) || "", sources: (fin.parts && fin.parts.sources) || "", cites: fin.cites });
  console.log(`ask-eval-picked: ${PATH} ok ${i + 1}/${rows.length} mode=${mode}${rec.parse ? ` parse=${rec.parse.ok ? rec.picks.length : rec.parse.reason}` : ""}${rec.refused ? " REFUSED" : ""}${rec.reused ? " reused" : ""}`);
}
if (flag("--dry")) { console.log(JSON.stringify(dry)); process.exit(0); }
console.log(`ask-eval-picked: ${PATH} agy calls ${calls}, failures ${fails}, answers stored ${readJsonl(ANSWERS).length}`);
process.exit(0);
