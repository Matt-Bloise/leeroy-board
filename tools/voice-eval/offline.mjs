// Offline flow for the arm runner: no keys, no network, no environment reads.
//   --emit-prompts --out DIR : writes DIR/<arm>/<promptId>.json = { system, user } (exactly what a provider adapter would send) and DIR/mapping.json (private).
//   --ingest-answers DIR     : reads DIR/<arm>/<promptId>.answer.txt (the raw model reply), runs the Worker's own finishing for that arm, writes arm1..arm3.jsonl.
// Arms: A production prompt (research off), B and C the research-mode prompt for a Haiku-class and a Sonnet-class model. Directory names are neutral (arm1..arm3).
// A prompt that the code answers itself (flag-off abstain) or that the guard blocks (research arms) gets no file; mapping.json lists them. Missing answers are reported, never defaulted.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mulberry32, shuffled, sha256Hex } from "./lib.mjs";
import { OFFLINE_ARMS, seedDb, makeEnv, planItem, finishItem, estimateIn, estimateOut, resetCaches } from "./arms.mjs";

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const stripBom = (s) => String(s).replace(/^﻿/, "");
const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;

function neutralNames(seed) {
  const order = shuffled(OFFLINE_ARMS.map((a) => a.name), mulberry32(`${seed}:arms`));
  return Object.fromEntries(order.map((n, i) => [n, `arm${i + 1}`]));
}

async function buildPlan(arms, promptList, seed) {
  resetCaches();
  const wenv = makeEnv(seedDb(promptList));
  const plan = [];
  for (const arm of arms) for (const p of promptList) plan.push(await planItem(wenv, arm, p, seed));
  return { wenv, plan };
}

const bodyHash = (it) => sha256Hex(JSON.stringify({ system: it.system, user: it.user }));

export async function emitPrompts({ o, promptList, log, err }) {
  let arms = OFFLINE_ARMS;
  if (o.arms) {
    arms = OFFLINE_ARMS.filter((a) => o.arms.includes(a.name));
    if (arms.length !== o.arms.length || !arms.length) { err(`run-arms: --arms takes names from: ${OFFLINE_ARMS.map((a) => a.name).join(", ")}`); return 2; }
  }
  const neutral = neutralNames(o.seed);
  const { plan } = await buildPlan(arms, promptList, o.seed);
  const codeWritten = {};
  const blocked = {};
  const sha = {};
  let written = 0, inTok = 0, outTok = 0;
  for (const arm of arms) mkdirSync(join(o.out, neutral[arm.name]), { recursive: true });
  for (const it of plan) {
    const n = neutral[it.arm.name];
    if (it.composed) { (codeWritten[n] ||= []).push(it.p.id); continue; }
    if (it.blocked) { (blocked[n] ||= {})[it.p.id] = it.blocked; continue; }
    writeFileSync(join(o.out, n, `${it.p.id}.json`), JSON.stringify({ system: it.system, user: it.user }, null, 2) + "\n", "utf8");
    (sha[n] ||= {})[it.p.id] = bodyHash(it);
    written++; inTok += estimateIn(it); outTok += estimateOut(it);
  }
  writeFileSync(join(o.out, "mapping.json"), JSON.stringify({
    private: true, note: "arm names for the judge-facing files; keep away from answerers and judges", mode: "emit", seed: o.seed,
    arms: Object.fromEntries(arms.map((a) => [neutral[a.name], a.name])), codeWritten, blocked, promptSha256: sha,
  }, null, 2) + "\n", "utf8");
  for (const arm of arms) log(`run-arms: ${neutral[arm.name]}: ${Object.keys(sha[neutral[arm.name]] || {}).length} prompt files, ${(codeWritten[neutral[arm.name]] || []).length} code-written, ${Object.keys(blocked[neutral[arm.name]] || {}).length} blocked`);
  log(`run-arms: wrote ${written} prompt files and mapping.json to ${o.out}; estimated tokens ${inTok} in + ${outTok} out (max) if every one is answered; no network`);
  return 0;
}

export async function ingestAnswers({ o, promptList, log, err }) {
  const dir = o.ingest;
  const mapPath = join(dir, "mapping.json");
  if (!existsSync(mapPath)) { err("run-arms: mapping.json not found in the answers directory (run --emit-prompts first)"); return 2; }
  let mapping;
  try { mapping = JSON.parse(stripBom(readFileSync(mapPath, "utf8"))); } catch { err("run-arms: mapping.json is not valid JSON"); return 2; }
  const seed = Number(mapping.seed);
  const entries = Object.entries(mapping.arms || {});
  const arms = entries.map(([, name]) => OFFLINE_ARMS.find((a) => a.name === name));
  if (!Number.isInteger(seed) || !entries.length || arms.some((a) => !a)) { err("run-arms: mapping.json does not describe offline arms"); return 2; }
  const neutral = Object.fromEntries(entries.map(([n, name]) => [name, n]));

  const { wenv, plan } = await buildPlan(arms, promptList, seed);
  const rows = Object.fromEntries(entries.map(([n]) => [n, []]));
  const missing = [], errors = [];
  const counts = Object.fromEntries(entries.map(([n]) => [n, { rows: 0, missing: 0, errors: 0, codeWritten: 0 }]));
  for (const it of plan) {
    const n = neutral[it.arm.name], id = it.p.id;
    if (!ID_RE.test(id)) continue;
    const fail = (error) => { errors.push({ arm: n, id, error }); counts[n].errors++; };
    let r;
    if (it.composed) { r = await finishItem(wenv, it, ""); counts[n].codeWritten++; }
    else if (it.blocked) { fail(it.blocked); continue; }
    else {
      const file = join(dir, n, `${id}.answer.txt`);
      if (!existsSync(file)) { missing.push({ arm: n, id }); counts[n].missing++; continue; }
      const expected = mapping.promptSha256 && mapping.promptSha256[n] && mapping.promptSha256[n][id];
      if (expected && expected !== bodyHash(it)) { fail("prompt:drift"); continue; } // the code or fixtures changed since the prompts were emitted: the reply answers a different prompt
      r = await finishItem(wenv, it, stripBom(readFileSync(file, "utf8")));
    }
    if (r.answer) { rows[n].push({ id, answer: r.answer }); counts[n].rows++; } else fail(r.error);
  }
  mkdirSync(o.out, { recursive: true });
  for (const [n] of entries) writeFileSync(join(o.out, `${n}.jsonl`), jsonl(rows[n]), "utf8");
  writeFileSync(join(o.out, "ingest-report.json"), JSON.stringify({ private: true, seed, expectedPerArm: promptList.length, counts, missing, errors }, null, 2) + "\n", "utf8");
  for (const [n] of entries) log(`run-arms: ${n}: ${counts[n].rows}/${promptList.length} rows (${counts[n].codeWritten} code-written, ${counts[n].missing} missing, ${counts[n].errors} flagged or failed)`);
  log(`run-arms: wrote ${entries.length} arm files and ingest-report.json to ${o.out}`);
  if (missing.length || errors.length) { err(`run-arms: incomplete: ${missing.length} missing answers, ${errors.length} flagged or failed (see ingest-report.json); nothing was defaulted`); return 1; }
  return 0;
}
