// Owner spot check: picks 10 random preference pairs and writes a human-readable sheet with no arm labels, so the owner can judge
// them once (about five minutes). Afterwards --compare counts how often a judge agrees with the owner; fewer than 8 of 10 means the
// judge is not trusted and is replaced.
//
// Usage:
//   node tools/voice-eval/owner-sample.mjs --tasks tasks.jsonl --mapping mapping.json [--count 10] [--seed 1] [--out sheet.txt]
//   node tools/voice-eval/owner-sample.mjs --compare owner.jsonl verdicts.jsonl [--judge ID]   (--judge is required when the file has several judges)
// The sheet shows only task text, never the mapping. Keep mapping.json away from the owner and the judges.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mulberry32, shuffled, readJsonl } from "./lib.mjs";

// One preference task per distinct (prompt, arm pair), chosen at random; either order may be picked.
export function buildSheet({ tasks, mapping, count = 10, seed = 1 }) {
  const rng = mulberry32(seed);
  const byPair = new Map();
  for (const t of tasks) {
    const e = mapping.tasks[t.taskId];
    if (!e || e.kind !== "pref" || (e.pair[0].endsWith("#1") && e.pair[1].endsWith("#2") && e.pair[0].slice(0, -2) === e.pair[1].slice(0, -2))) continue;
    const key = `${e.promptId}\u0000${e.pair.join("\u0000")}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(t);
  }
  const pairs = shuffled([...byPair.keys()].sort(), rng);
  if (pairs.length < count) throw new Error(`only ${pairs.length} pairs available, asked for ${count}`);
  const picked = pairs.slice(0, count).map((k) => {
    const two = byPair.get(k);
    return two[Math.floor(rng() * two.length)];
  });
  const rubricMatch = picked[0].text.match(/VOICE RUBRIC:\n([\s\S]*?)\n\nANSWER A:/);
  const lines = [
    `OWNER SPOT CHECK: ${count} pairs. For each, read the two answers and write A, B or NONE (no meaningful difference) on the verdict line.`,
    `All content is fictional. The answers are not labelled. Judge voice and faithfulness together using the rubric below.`,
    "",
    "RUBRIC", rubricMatch ? rubricMatch[1] : "(see rubric.md)", "",
  ];
  picked.forEach((t, i) => {
    const body = t.text
      .replace(/^[\s\S]*?(?=(?:EARLIER TURN FROM THE SAME ASKER:|USER MESSAGE:))/, "")
      .replace(/VOICE RUBRIC:[\s\S]*?\n\n(?=ANSWER A:)/, "")
      .replace(/\n\nWhich answer better fits[\s\S]*$/, "");
    lines.push("=".repeat(60), `PAIR ${i + 1}   (task ${t.taskId})`, "", body, "", `VERDICT (A, B or NONE): ________`, "");
  });
  return { text: lines.join("\n"), taskIds: picked.map((t) => t.taskId) };
}

// Agreement between the owner's verdicts and ONE judge's. Duplicate owner rows are refused; a verdict file with several judges needs
// an explicit judge id (ids are trimmed and lower-cased), so one judge's rows are never silently overwritten by another's.
export function compareVerdicts(ownerRows, judgeRows, { judge } = {}) {
  const norm = (v) => String(v).trim().toUpperCase();
  const owner = new Map();
  for (const r of ownerRows) {
    if (owner.has(r.taskId)) throw new Error(`duplicate owner row for ${r.taskId}`);
    owner.set(r.taskId, norm(r.verdict));
  }
  const id = (r) => (r.judge === undefined || r.judge === null || String(r.judge).trim() === "" ? null : String(r.judge).trim().toLowerCase());
  const judges = new Set(judgeRows.map(id));
  let rows = judgeRows;
  if (judge !== undefined) {
    const want = String(judge).trim().toLowerCase();
    rows = judgeRows.filter((r) => id(r) === want);
    if (!rows.length) throw new Error(`no rows for judge "${judge}" (judges in the file: ${[...judges].map((j) => j ?? "(none)").join(", ")})`);
  } else if (judges.size > 1) {
    throw new Error(`the verdict file has several judges (${[...judges].map((j) => j ?? "(none)").join(", ")}): pass --judge ID`);
  }
  const j = new Map();
  for (const r of rows) {
    if (j.has(r.taskId)) throw new Error(`duplicate judge row for ${r.taskId}`);
    j.set(r.taskId, norm(r.verdict));
  }
  let agree = 0, compared = 0;
  for (const [taskId, v] of owner) {
    if (!j.has(taskId)) continue;
    compared++;
    if (j.get(taskId) === v) agree++;
  }
  return { compared, agree, trusted: compared >= 10 ? agree >= 8 : null };
}

function main() {
  const argv = process.argv.slice(2);
  const o = { count: 10, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    if (argv[i] === "--tasks") o.tasks = v();
    else if (argv[i] === "--mapping") o.mapping = v();
    else if (argv[i] === "--count") o.count = Number(v());
    else if (argv[i] === "--seed") o.seed = Number(v());
    else if (argv[i] === "--out") o.out = v();
    else if (argv[i] === "--compare") { o.compare = [v(), v()]; }
    else if (argv[i] === "--judge") o.judge = v();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (o.compare) {
    const r = compareVerdicts(readJsonl(o.compare[0]), readJsonl(o.compare[1]), { judge: o.judge });
    console.log(`compared ${r.compared} tasks, agreed on ${r.agree}${r.trusted === null ? " (fewer than 10 compared: no verdict)" : r.trusted ? ": judge trusted (8 or more of 10)" : ": judge NOT trusted (fewer than 8 of 10): replace it"}`);
    return;
  }
  if (!o.tasks || !o.mapping) throw new Error("usage: owner-sample.mjs --tasks tasks.jsonl --mapping mapping.json [--count 10] [--seed 1] [--out sheet.txt]");
  const { text, taskIds } = buildSheet({ tasks: readJsonl(o.tasks), mapping: JSON.parse(readFileSync(o.mapping, "utf8").replace(/^\uFEFF/, "")), count: o.count, seed: o.seed });
  if (o.out) {
    writeFileSync(o.out, text + "\n");
    console.log(`wrote ${o.out} (tasks ${taskIds.join(", ")})`);
  } else console.log(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`owner-sample: ${e.message}`);
    process.exit(1);
  }
}
