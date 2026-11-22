// Groups judge tasks into batches for fresh judge contexts: one batch, one fresh context. Within a batch no two tasks are about the same
// prompt, which also means the two order-swapped twins of a pair are never together (a judge that saw both orders could simply match them
// up). Batches are as full as the data allows; only the tail can be smaller. Output files hold {taskId, text} only.
//
// Usage: node tools/voice-eval/make-batches.mjs --tasks tasks.jsonl --mapping mapping.json [--size 6] [--seed 1] --out batches/
// Writes batch-001.jsonl, batch-002.jsonl ... and batches.json (the index: file and task ids per batch; no arm information).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mulberry32, shuffled, readJsonl } from "./lib.mjs";

export function makeBatches({ tasks, mapping, size = 6, seed = 1 }) {
  if (!Number.isInteger(size) || size < 1) throw new Error("--size must be a positive integer");
  const rng = mulberry32(seed);
  const queues = new Map();
  for (const t of shuffled(tasks, rng)) {
    if (mapping && mapping.tasks[t.taskId] && mapping.tasks[t.taskId].promptId !== t.promptId) throw new Error(`task ${t.taskId}: promptId disagrees with the mapping`);
    if (!queues.has(t.promptId)) queues.set(t.promptId, []);
    queues.get(t.promptId).push(t);
  }
  const batches = [];
  for (;;) {
    // The prompts with the most tasks left go first, so no prompt is left holding many tasks for the tail.
    const live = shuffled([...queues.values()].filter((q) => q.length), rng).sort((a, b) => b.length - a.length);
    if (!live.length) break;
    batches.push(live.slice(0, size).map((q) => q.pop()));
  }
  return batches;
}

export function writeBatches(batches, outDir) {
  mkdirSync(outDir, { recursive: true });
  const index = batches.map((b, i) => {
    const file = `batch-${String(i + 1).padStart(3, "0")}.jsonl`;
    writeFileSync(join(outDir, file), b.map((t) => JSON.stringify({ taskId: t.taskId, text: t.text })).join("\n") + "\n");
    return { file, taskIds: b.map((t) => t.taskId) };
  });
  writeFileSync(join(outDir, "batches.json"), JSON.stringify(index, null, 1) + "\n");
  return index;
}

function main() {
  const argv = process.argv.slice(2);
  const o = { size: 6, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    if (argv[i] === "--tasks") o.tasks = v();
    else if (argv[i] === "--mapping") o.mapping = v();
    else if (argv[i] === "--size") o.size = Number(v());
    else if (argv[i] === "--seed") o.seed = Number(v());
    else if (argv[i] === "--out") o.out = v();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!o.tasks || !o.mapping || !o.out) throw new Error("usage: make-batches.mjs --tasks tasks.jsonl --mapping mapping.json --out dir [--size 6] [--seed 1]");
  const tasks = readJsonl(o.tasks);
  const mapping = JSON.parse(readFileSync(o.mapping, "utf8").replace(/^﻿/, ""));
  const batches = makeBatches({ tasks, mapping, size: o.size, seed: o.seed });
  const index = writeBatches(batches, o.out);
  console.log(`wrote ${index.length} batches of at most ${o.size} to ${o.out}: give each batch to a fresh judge context`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`make-batches: ${e.message}`);
    process.exit(1);
  }
}
