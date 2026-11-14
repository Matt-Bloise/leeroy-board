// ask-eval-composed.mjs: the /ask answer eval for ASK_COMPOSED. LOCAL ONLY: it calls the Antigravity CLI (Gemini) and reads the friends' gold questions from disk.
// Adapted from leeroy-ops scripts/ask-eval (export-prompts + generate), which stays unchanged and supplies the judge (judge.mjs, Codex) and the report.
//
//   ASK_EVAL_GOLD=<gold.jsonl> ASK_EVAL_WORK=<dir outside every repo> node tests/local/ask-eval-composed.mjs --limit 30 [--cap-hour 20] [--wait] [--max-calls 60]
//   ASK_EVAL_REPO=<this worktree> ASK_EVAL_WORK=<same dir> node <leeroy-ops>/scripts/ask-eval/judge.mjs --limit 30 --wait
//   ASK_EVAL_WORK=<same dir> node tests/local/ask-eval-composed.mjs --stats      (guard and opener counts; numbers only)
//
// For each held-out question (same selection and asker rotation as run.mjs) the production buildAnswerInputs runs with ASK_COMPOSED on. Rows that the composed path
// covers (retrieved, not an abstain, not a coach turn) get ONE Gemini call whose prompt is the opener prompt (ask-composed.js openerPrompts); the answer is then
// composed by code, proved by verifyComposed, and passed through the production finishAnswerText exactly as answerWithAi does. Abstain rows are the code-written
// refusal (no model). Rows outside the composed path (skip kinds, coach) use the production prompt, as production would with the flag on.
// Nothing is written to a repo: question text and answers stay under ASK_EVAL_WORK. No secrets, no network except the agy CLI.
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
const COUNCIL_LEDGER = process.env.ASK_EVAL_COUNCIL_LEDGER || "";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const appendJsonl = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(o) + "\n"); };
const rowKey = (r) => `${r.id}|${r.asker}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!WORK) { console.error("ask-eval-composed: set ASK_EVAL_WORK to a folder outside every repo"); process.exit(2); }
const PROMPTS = path.join(WORK, "prompts.jsonl"), ANSWERS = path.join(WORK, "answers.jsonl"), CALLS = path.join(WORK, "calls.jsonl");

if (flag("--stats")) {
  const A = readJsonl(ANSWERS);
  const by = (k) => A.reduce((m, a) => ((m[a[k]] = (m[a[k]] || 0) + 1), m), {});
  console.log(JSON.stringify({ answers: A.length, mode: by("mode"), openerSource: by("openerSource"), guardRefused: A.filter((a) => a.refused).length, guardPreFailed: A.filter((a) => a.guard && a.guard.pre === false).length, guardPostFailed: A.filter((a) => a.guard && a.guard.post === false).length, secsMax: Math.max(0, ...A.map((a) => a.secs || 0)) }));
  process.exit(0);
}
if (!GOLD && !process.env.ASK_EVAL_EXTRA) { console.error("ask-eval-composed: set ASK_EVAL_GOLD (the local gold set)"); process.exit(2); }

const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href);
const { buildAnswerInputs, finishAnswerText, invalidatePagesCache } = await imp("infrastructure/worker/ai-models.js");
const { invalidatePersonaCache, loadPersona } = await imp("infrastructure/worker/persona.js");
const { invalidateConfigCache } = await imp("infrastructure/worker/config.js");
const { schemaDb } = await imp("tests/helpers/sqlite-d1.mjs");
const { composeAnswer, openerPrompts, verifyFinished, buildIsTopical } = await imp("infrastructure/worker/ask-composed.js");
const { composeAbstain } = await imp("infrastructure/worker/self-rag.js");

const ASKERS = ["Red Fox", "Blue Owl", "Green Elk"];
const SLUG = { "Red Fox": "red-fox", "Blue Owl": "blue-owl", "Green Elk": "green-elk" };
const f = (value, visible = true) => ({ value, visible, source: "board", at: "2026-11-01T00:00:00.000Z" });
const SHEETS = [
  { slug: "red-fox", name: "Red Fox", fields: { class: f("paladin"), race: f("human"), spec_path: f("protection"), level: f(34), professions: f(["mining", "blacksmithing"]), goals: f("tank every dungeon for the party", false) }, updated: "x" },
  { slug: "blue-owl", name: "Blue Owl", fields: { class: f("mage"), race: f("gnome"), spec_path: f("frost"), level: f(28), professions: f(["tailoring", "enchanting"]), goals: f("quiet solo grinding", false) }, updated: "x" },
  { slug: "green-elk", name: "Green Elk", fields: { class: f("priest"), race: f("undead"), spec_path: f("holy"), level: f(31), professions: f(["herbalism", "alchemy"]), goals: f("heal without dying", false) }, updated: "x" },
];

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
  return { DB, ASK_COMPOSED: "on", BOARD_PUBLIC_URL: "https://leeroy.party" };
}

function heldoutRows(limit) {
  if (process.env.ASK_EVAL_EXTRA) return readJsonl(process.env.ASK_EVAL_EXTRA).map((r) => ({ journey: "curious", ...r })).slice(0, limit);
  const rows = readJsonl(GOLD).filter((r) => r.split === "heldout");
  rows.sort((a, b) => crypto.createHash("sha1").update(a.id).digest("hex").localeCompare(crypto.createHash("sha1").update(b.id).digest("hex")));
  return rows.slice(0, limit);
}

const usedLastHour = () => {
  const now = Date.now();
  const own = readJsonl(CALLS).filter((r) => r.model === "agy" && now - Date.parse(r.at) < 3600e3).length;
  let council = 0;
  try { if (COUNCIL_LEDGER) council = readJsonl(COUNCIL_LEDGER).filter((r) => now - Date.parse(r.at) < 3600e3 && JSON.stringify(r).toLowerCase().includes("antigravity")).length; } catch {}
  return own + council;
};
function callAgy(system, user) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-eval-composed-agy-"));
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

const limit = Number(arg("--limit", "30")), capHour = Number(arg("--cap-hour", "20")), maxCalls = Number(arg("--max-calls", "60")), wait = flag("--wait");
const env = makeEnv();
const persona = await loadPersona(env);
const rows = heldoutRows(limit);
fs.mkdirSync(WORK, { recursive: true });
const done = new Set(readJsonl(ANSWERS).map(rowKey));
let calls = 0, fails = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i], asker = ASKERS[i % 3];
  const key = rowKey({ id: r.id, asker });
  const inp = await buildAnswerInputs(env, { question: r.question, by: asker, memberSlug: SLUG[asker], journey: r.journey || "curious", share: true });
  const composedMode = Boolean(inp.composedCtx) && inp.retrieved && !inp.abstain && !inp.isCoach && inp.hits.length > 0;
  const mode = inp.abstain ? "abstain" : composedMode ? "composed" : "existing";
  // the judge reads the production prompt context (library facts, builds): the same material the bot saw
  if (!readJsonl(PROMPTS).some((p) => rowKey(p) === key)) {
    appendJsonl(PROMPTS, { id: r.id, asker, question: r.question, journey: r.journey || "curious", systemPrompt: inp.systemPrompt, userPrompt: inp.userPrompt, groundingText: inp.groundingText, personalised: inp.personalised, isCoach: inp.isCoach, libraryPages: inp.parsedPages.map((p) => p.id), retrieved: inp.ranked.map((p) => p.id), mode });
  }
  if (done.has(key)) continue;
  const finish = (rawAnswer, extra = {}) => finishAnswerText(env, { rawAnswer, isCoach: inp.isCoach, parsedPages: inp.parsedPages, by: asker, askerIsMember: true, persona, intentId: String(r.id), groundingText: inp.groundingText, personalised: inp.personalised || extra.trusted === true, retrieval: inp.retrieval, trusted: extra.trusted === true, question: r.question, opener: inp.opener });
  let rawOut = "", secs = 0, openerSource = null, guard = null, refused = false, fin;
  if (mode === "abstain") {
    fin = await finish(inp.abstainAnswer, { trusted: true });
    rawOut = inp.abstainAnswer;
  } else {
    const prompts = composedMode ? openerPrompts({ question: r.question, askerName: asker, askerBuild: inp.composedCtx.askerBuild, hasBuild: Boolean(inp.composedCtx.askerBuild) && buildIsTopical(r.question, inp.hits) }) : { system: inp.systemPrompt, user: inp.userPrompt };
    if (calls >= maxCalls) { console.log(`ask-eval-composed: max-calls ${maxCalls} reached`); break; }
    while (usedLastHour() >= capHour) { if (!wait) break; console.log(`ask-eval-composed: rate guard (${usedLastHour()} agy calls in the last hour, cap ${capHour}); sleeping 5 min`); await sleep(300e3); }
    if (usedLastHour() >= capHour) { console.log(`ask-eval-composed: rate guard stop (${usedLastHour()}/${capHour}). Resume later or pass --wait.`); break; }
    const g = await callAgy(prompts.system, prompts.user); calls++;
    appendJsonl(CALLS, { at: new Date().toISOString(), model: "agy", id: r.id, code: g.code, secs: g.secs, chars: g.out.length });
    if (g.code !== 0 || !g.out) { fails++; console.log(`ask-eval-composed: FAILED ${r.id} code=${g.code} err=${g.err.replace(/\s+/g, " ").slice(0, 160)}`); if (fails >= 3) { console.log("ask-eval-composed: 3 failures, stopping"); break; } continue; }
    secs = g.secs;
    if (!composedMode) {
      fin = await finish(g.out);
      rawOut = g.out;
    } else {
      const ctx = inp.composedCtx;
      const c = composeAnswer({ question: r.question, rawOpener: g.out, retrievedFacts: inp.hits.slice(0, 20), sheet: ctx.askerBuild, askerBuild: ctx.askerBuild, partyNames: ctx.partyNames, askerName: asker });
      openerSource = c.ok ? c.openerSource : "none";
      guard = { pre: c.ok, post: null };
      if (c.ok) {
        rawOut = c.text;
        fin = await finish(c.text, { trusted: true });
        const titles = inp.parsedPages.filter((p) => c.ids.includes(p.id)).map((p) => p.title);
        const v = fin.parts.more ? { ok: false } : verifyFinished(fin.parts.main, { used: c.used, sheet: ctx.askerBuild, askerBuild: ctx.askerBuild, partyNames: ctx.partyNames, askerName: asker, extraAllowed: titles, boardUrl: env.BOARD_PUBLIC_URL });
        guard.post = v.ok;
        if (!v.ok) { refused = true; rawOut = composeAbstain({ categories: inp.parsedPages.map((p) => p.category) }); fin = await finish(rawOut, { trusted: true }); }
      } else {
        refused = true;
        rawOut = composeAbstain({ categories: inp.parsedPages.map((p) => p.category) });
        fin = await finish(rawOut, { trusted: true });
      }
      appendJsonl(path.join(WORK, "openers.jsonl"), { id: r.id, asker, openerSource, openerReason: c.openerReason || "", rawOpenerChars: g.out.length });
    }
  }
  appendJsonl(ANSWERS, { id: r.id, asker, raw: rawOut, answer: fin.answer, more: (fin.parts && fin.parts.more) || "", sources: (fin.parts && fin.parts.sources) || "", cites: fin.cites, secs, generator: mode === "abstain" ? "code" : "agy", mode, openerSource, guard, refused });
  console.log(`ask-eval-composed: ok ${i + 1}/${rows.length} mode=${mode}${openerSource ? " opener=" + openerSource : ""}${refused ? " REFUSED" : ""}`);
}
console.log(`ask-eval-composed: agy calls ${calls}, failures ${fails}, answers stored ${readJsonl(ANSWERS).length}`);
process.exit(0);
