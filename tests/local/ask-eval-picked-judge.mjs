// ask-eval-picked-judge.mjs: the Codex judge for ask-eval-picked.mjs. LOCAL ONLY. A copy of leeroy-ops scripts/ask-eval/judge.mjs (which stays unchanged) with two
// more judge fields: answers_question (0/1: the answer gives what was asked) and off_target_facts (how many facts in the answer do not bear on the question).
//
//   ASK_EVAL_WORK=<dir> node tests/local/ask-eval-picked-judge.mjs --path picked [--cap-hour 20] [--wait] [--max-calls 80]
//
// Input WORK/<path>/prompts.jsonl + answers.jsonl. Output WORK/<path>/judgments.jsonl. Resume: judged rows are skipped. One answer per Codex call (codex exec,
// read-only sandbox, prompt on stdin). The call ledger WORK/calls.jsonl is shared with the generator; ASK_EVAL_LEDGERS adds others, and the leeroy-ops council
// ledger (read only) counts too, as in the original. Friends' text goes only to Codex, never into a repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = process.env.ASK_EVAL_REPO || path.resolve(import.meta.dirname, "../..");
const WORK = process.env.ASK_EVAL_WORK;
const RUBRIC = process.env.ASK_EVAL_RUBRIC || "C:/projects/_scratch/gold/rubric.md";
const COUNCIL = process.env.ASK_EVAL_COUNCIL_LEDGER || "C:/projects/leeroy-ops/notes/ops-rooms/council.jsonl";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const appendJsonl = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(o) + "\n"); };
const rowKey = (r) => `${r.id}|${r.asker}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!WORK) { console.error("judge: set ASK_EVAL_WORK"); process.exit(2); }
const PATH = arg("--path", "picked");
const DIR = path.join(WORK, PATH);
const { unknownNames } = await import(pathToFileURL(path.join(REPO, "infrastructure/worker/ask-build.js")).href);

// codex exec, read-only, prompt on stdin (as leeroy-ops scripts/council-codex.mjs codexRun)
const PIPELINE_MODE = "PIPELINE MODE: The full brief is below. Do not read or write any file. Answer in your final message.\n\n";
const codexRun = (prompt, outFile, cwd) => new Promise((resolve) => {
  const child = spawn("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "-o", outFile, "-"], { cwd, shell: process.platform === "win32" });
  let err = ""; child.stderr.on("data", (d) => (err += d)); child.stdin.on("error", () => {}); child.stdin.write(PIPELINE_MODE + prompt); child.stdin.end();
  const timer = setTimeout(() => child.kill(), 10 * 60e3);
  child.on("error", () => { clearTimeout(timer); resolve({ code: -1, tokens: null, err: "spawn failed" }); });
  child.on("close", (code) => { clearTimeout(timer); const tm = /tokens used[:\s]*([\d,]+)/i.exec(err); resolve({ code, tokens: tm ? Number(tm[1].split(",").join("")) : null, err: err.slice(-200) }); });
});

const limit = Number(arg("--limit", "1000")), capHour = Number(arg("--cap-hour", "20")), maxCalls = Number(arg("--max-calls", "80")), wait = flag("--wait");
const CALLS = path.join(WORK, "calls.jsonl"), JUDG = path.join(DIR, "judgments.jsonl");
const used = () => {
  const now = Date.now();
  const own = [CALLS, ...String(process.env.ASK_EVAL_LEDGERS || "").split(",").filter(Boolean)].flatMap(readJsonl).filter((r) => r.model === "codex" && now - Date.parse(r.at) < 3600e3).length;
  let c = 0; try { c = readJsonl(COUNCIL).filter((r) => now - Date.parse(r.at) < 3600e3 && JSON.stringify(r).toLowerCase().includes("codex")).length; } catch {}
  return own + c;
};
const rubric = fs.readFileSync(RUBRIC, "utf8").slice(0, 9000);
const prompts = new Map(readJsonl(path.join(DIR, "prompts.jsonl")).map((p) => [rowKey(p), p]));
const seen = new Set();
const answers = readJsonl(path.join(DIR, "answers.jsonl")).filter((a) => !seen.has(rowKey(a)) && seen.add(rowKey(a))).slice(0, limit);
const done = new Set(readJsonl(JUDG).map(rowKey));

const judgePrompt = (p, a) => `You are a strict, independent judge of a Discord bot's answer. You did not write it. Score ONLY from the material below; do not read files.
The bot answers WoW Classic Forever questions from a LIBRARY. Its rules: answer only from LIBRARY, YOUR_BUILD and PARTY_BUILDS; never name a spell, talent, place, item or level they do not contain; if the library lacks it, say "The library does not have that yet."; personalise with the asker's own build when relevant; inform, never instruct; cite library page ids on a "-# Sources:" line.
## Rubric excerpt (voice and honesty dimensions apply)
${rubric}
## PROMPT CONTEXT THE BOT SAW
${p.userPrompt}
## THE BOT'S FINAL ANSWER
${a.answer}
## Output
Print ONLY one JSON object, no prose, no code fence, with exactly these keys:
{"build_relevant":0|1 (is the asker's own class/race/spec/level/professions relevant to this question),
 "uses_build":0|1 (answer uses the asker's build in a way that fits; 0 if relevant but ignored or if it states a build detail not in YOUR_BUILD),
 "invented":[strings: each spell, talent, place, item, number or level in the answer that is NOT in the LIBRARY, YOUR_BUILD, PARTY_BUILDS, OFFERED_FACTS, COMPOSED_FACTS or the question],
 "cites_source":0|1 (a Sources line naming library page ids that actually appear in the context),
 "voice":0|1|2 (rubric dimension 8),
 "library_lacks":0|1 (the LIBRARY block, OFFERED_FACTS and COMPOSED_FACTS together do not contain what is needed to answer),
 "honest_refusal":0|1|null (only when library_lacks is 1: 1 if the answer plainly says the library does not have it and invents nothing; else 0; null when library_lacks is 0),
 "answers_question":0|1 (1 only if the answer gives the information the question asks for, so the asker learns what they wanted; 0 for a refusal, a partial or a related-but-different answer),
 "off_target_facts":integer (how many distinct facts or bullets in the answer do not bear on the question; 0 when every fact helps),
 "note":"one short sentence, no quotes of the question"}`;

const parse = (t) => { const m = /\{[\s\S]*\}/.exec(t || ""); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };
let calls = 0, fails = 0;
for (const a of answers) {
  if (done.has(rowKey(a))) continue;
  const p = prompts.get(rowKey(a)); if (!p) continue;
  if (calls >= maxCalls) { console.log(`judge: max-calls ${maxCalls} reached`); break; }
  while (used() >= capHour) { if (!wait) break; console.log(`judge: rate guard (${used()} codex calls in the last hour, cap ${capHour}); sleeping 5 min`); await sleep(300e3); }
  if (used() >= capHour) { console.log(`judge: rate guard stop (${used()}/${capHour}). Resume later or pass --wait.`); break; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-eval-picked-codex-")), out = path.join(dir, "out.md");
  const r = await codexRun(judgePrompt(p, a), out, dir); calls++;
  appendJsonl(CALLS, { at: new Date().toISOString(), model: "codex", path: PATH, id: a.id, code: r.code, tokens: r.tokens });
  let text = ""; try { text = fs.readFileSync(out, "utf8"); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const j = parse(text);
  const okShape = j && (j.answers_question === 0 || j.answers_question === 1) && Number.isInteger(j.off_target_facts);
  if (r.code !== 0 || !okShape) { fails++; console.log(`judge: FAILED ${a.id} code=${r.code} parsed=${!!j} shape=${!!okShape} err=${(r.err || "").replace(/\s+/g, " ").slice(0, 140)}`); if (fails >= 3) { console.log("judge: 3 failures, stopping"); break; } continue; }
  const body = a.answer.split("\n").filter((l) => !l.startsWith("-#")).join("\n");
  const det = {
    length: body.length, length_ok: body.length <= 1200,
    det_invented: unknownNames(a.raw, p.groundingText).filter((n) => !/^(hey|hi|hello|yo|ahoy|howdy)\s/i.test(n)).length,
    bare_url: /(^|[^<(])https?:\/\//.test(a.answer),
    forbidden: /\b(skippy|honestly|@everyone)\b/i.test(a.answer),
  };
  appendJsonl(JUDG, { id: a.id, asker: a.asker, ...j, ...det, judge_tokens: r.tokens });
  console.log(`judge: ${PATH} ok ${calls}`);
}
console.log(`judge: ${PATH} calls ${calls}, failures ${fails}, judgments stored ${readJsonl(JUDG).length}`);
process.exit(0);
