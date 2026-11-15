// Builds the blind judge tasks for the voice evaluation. No model is called here; sessions run the judges.
//
// Inputs : prompts.json, one JSONL per arm ({id, answer}), rubric.md. prompts.json and rubric.md are checked against the stored
//          SHA-256 files (prompts.sha256, rubric.sha256) and the run is refused on a mismatch unless --allow-unfrozen is passed;
//          the mapping then records frozen:false and aggregate.mjs repeats the warning.
// Outputs: tasks.jsonl  - what judges see: {taskId, promptId, text}. No arm names, no labels, order randomised.
//          mapping.json - SECRET: taskId -> {armA, armB, ...}, sealed with a content hash. Judges never see it.
//
// Per prompt and arm pair there are two preference tasks with the A/B order swapped (seeded RNG). When a --reference arm is given, the
// "which is the reference" variant is added for the reference arm against every other arm, also in both orders.
//
// Usage:
//   node tools/voice-eval/make-tasks.mjs --arm release=release.jsonl --arm candidate=cand.jsonl [--arm original=orig.jsonl --reference original]
//        [--seed 7] [--sets core,4b] [--pairs candidate:release,release:release] [--out ./run1] [--allow-unfrozen]
//        [--normalise] [--variants full,voice,facts]
// --normalise strips what identifies an arm without reading it (sources lines, confidence and Classic tags, markdown, link syntax) from
// every arm the same way and records per-arm length stats; --variants adds the voice-only and facts-only preference questions.
// A pair "x:x" compares an arm with itself (the self-comparison check); it appears in the report as "x#1" vs "x#2".
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HERE, mulberry32, shuffled, hashPrompts, hashRubric, frozenHashes, sealMapping, unsupportedNumbers, readJsonl, findLeak, findInjection, VALID_ARM_NAME, normaliseAnswer,
} from "./lib.mjs";

function factsBlock(p) {
  if (!p.facts || !p.facts.length) return "LIBRARY FACTS: the library has nothing on this.\n\n";
  return `LIBRARY FACTS (the only numbers and names the library supports for this question):\n${p.facts.map((f) => `- ${f}`).join("\n")}\n\n`;
}

function prefText(p, rubric, a, b) {
  return (
    `You are judging two answers written by a game-guild assistant called Leeroy for a small gaming group. All names and content are fictional.\n\n` +
    (p.previous ? `EARLIER TURN FROM THE SAME ASKER:\n${p.previous}\n\n` : "") +
    `USER MESSAGE:\n${p.prompt}\n\n` +
    factsBlock(p) +
    `VOICE RUBRIC:\n${rubric.trim()}\n\n` +
    `ANSWER A:\n${a}\n\n` +
    `ANSWER B:\n${b}\n\n` +
    `Which answer better fits the rubric and the facts? Judge voice and faithfulness together; a funnier answer that states anything the facts do not support loses.\n` +
    `Reply with exactly one of: A, B or NONE (NONE means no meaningful difference). Output only that token.`
  );
}

// Voice-only question: the rubric's voice rules, ignoring facts and presentation.
function voiceText(p, rubric, a, b) {
  return (
    `You are judging two answers written by a game-guild assistant called Leeroy for a small gaming group. All names and content are fictional.\n\n` +
    (p.previous ? `EARLIER TURN FROM THE SAME ASKER:\n${p.previous}\n\n` : "") +
    `USER MESSAGE:\n${p.prompt}\n\n` +
    `VOICE RUBRIC:\n${rubric.trim()}\n\n` +
    `ANSWER A:\n${a}\n\n` +
    `ANSWER B:\n${b}\n\n` +
    `Judge ONLY the voice: apply the rules listed under "Voice rules" in the rubric. Ignore the facts, accuracy, formatting, length and any sources line, and ignore the rules about facts, format and length. Which answer sounds more like the voice the rubric describes?\n` +
    `Reply with exactly one of: A, B or NONE (NONE means no meaningful difference). Output only that token.`
  );
}

// Facts-only question: which answer states fewer unsupported specifics.
function factsOnlyText(p, a, b) {
  return (
    `You are checking two answers written by a game-guild assistant for a small gaming group against the library facts. All names and content are fictional.\n\n` +
    (p.previous ? `EARLIER TURN FROM THE SAME ASKER:\n${p.previous}\n\n` : "") +
    `USER MESSAGE:\n${p.prompt}\n\n` +
    factsBlock(p) +
    `ANSWER A:\n${a}\n\n` +
    `ANSWER B:\n${b}\n\n` +
    `Which answer states fewer unsupported specifics (numbers, names or claims the library facts above do not support)? Ignore voice, tone, formatting and length.\n` +
    `Reply with exactly one of: A, B or NONE (NONE means the same number of unsupported specifics). Output only that token.`
  );
}

const PREF_VARIANTS = { full: (p, rubric, a, b) => prefText(p, rubric, a, b), voice: voiceText, facts: (p, rubric, a, b) => factsOnlyText(p, a, b) };

function lengthStats(list) {
  const s = list.slice().sort((a, b) => a - b);
  const mean = list.reduce((a, b) => a + b, 0) / (list.length || 1);
  const mid = Math.floor(s.length / 2);
  return { mean: Math.round(mean * 10) / 10, median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, min: s[0], max: s[s.length - 1] };
}

function refText(p, a, b) {
  return (
    `Below is a message from a member of a small gaming group and two answers from the group's assistant, Leeroy. ` +
    `One of these two answers is a reference answer, written by the original author; the other is not. All names and content are fictional.\n\n` +
    (p.previous ? `EARLIER TURN FROM THE SAME ASKER:\n${p.previous}\n\n` : "") +
    `USER MESSAGE:\n${p.prompt}\n\n` +
    `ANSWER A:\n${a}\n\n` +
    `ANSWER B:\n${b}\n\n` +
    `Which one is the reference answer? You must choose.\n` +
    `Reply with exactly one letter: A or B. Output only that letter.`
  );
}

// arms: {armName: {promptId: answerText}}. pairs: optional [[armX, armY]]. Returns {tasks, mapping}.
export function buildTasks({ prompts, rubric, arms: rawArms, seed = 1, sets = ["core"], pairs, reference, allowUnfrozen = false, stored, variants = ["full"], normalise = false, tolerant = false }) {
  for (const v of variants) if (!PREF_VARIANTS[v]) throw new Error(`unknown variant "${v}" (full, voice, facts)`);
  if (!variants.length) throw new Error("at least one preference variant is needed");
  const have = { prompts: hashPrompts(prompts), rubric: hashRubric(rubric) };
  const want = stored || frozenHashes();
  const frozen = have.prompts === want.prompts && have.rubric === want.rubric;
  if (!frozen && !allowUnfrozen) {
    const which = [have.prompts !== want.prompts && "prompts.json", have.rubric !== want.rubric && "rubric.md"].filter(Boolean).join(" and ");
    throw new Error(`${which} no longer match the frozen hash (prompts.sha256 / rubric.sha256). Results would not be comparable with earlier runs. Re-freeze deliberately, or pass --allow-unfrozen.`);
  }
  let selected = prompts.filter((p) => sets.includes(p.set));
  if (!selected.length) throw new Error(`no prompts in sets ${sets.join(",")}`);
  const ids = prompts.map((p) => p.id);
  const armNames = Object.keys(rawArms);
  // --tolerant: a prompt where ANY arm has a missing, non-string or empty answer is dropped for ALL arms (so every pair stays balanced) and listed
  // in mapping.excluded and the report. Without it that case still throws. Nothing is defaulted or repaired.
  const excluded = [];
  if (tolerant) {
    const keep = [];
    for (const p of selected) {
      const bad = armNames.filter((arm) => { const r = Object.hasOwn(rawArms[arm], p.id) ? rawArms[arm][p.id] : undefined; return typeof r !== "string" || !(normalise ? normaliseAnswer(r) : r).trim(); });
      if (bad.length) excluded.push({ promptId: p.id, arms: bad }); else keep.push(p);
    }
    selected = keep;
    if (!selected.length) throw new Error("tolerant mode: every prompt has a missing or mistyped answer in some arm; nothing to judge");
  }
  for (const n of armNames) if (!VALID_ARM_NAME.test(n)) throw new Error(`arm name "${n}" is not allowed: 3 to 40 characters from letters, digits, dot, dash, underscore`);
  if (reference && !Object.hasOwn(rawArms, reference)) throw new Error(`reference arm "${reference}" has no answers`);
  // From here on `arms` holds what the judges will see: normalised when asked, the same way for every arm.
  const arms = Object.create(null); // keyed by external arm names and prompt ids: no prototype members
  const armStats = {};
  for (const arm of armNames) {
    arms[arm] = Object.create(null);
    const before = [], after = [];
    for (const p of selected) {
      const raw = Object.hasOwn(rawArms[arm], p.id) ? rawArms[arm][p.id] : undefined;
      if (typeof raw !== "string" || !raw.trim()) throw new Error(`arm "${arm}": missing answer for prompt "${p.id}"`);
      arms[arm][p.id] = normalise ? normaliseAnswer(raw) : raw;
      before.push(raw.length);
      after.push(arms[arm][p.id].length);
    }
    const b = lengthStats(before), a = lengthStats(after);
    armStats[arm] = { n: selected.length, meanCharsBefore: b.mean, meanCharsAfter: a.mean, medianCharsAfter: a.median, minCharsAfter: a.min, maxCharsAfter: a.max };
  }
  for (const arm of armNames) {
    for (const p of selected) {
      const ans = arms[arm][p.id];
      if (!ans.trim()) throw new Error(`arm "${arm}": missing answer for prompt "${p.id}" (empty after normalisation)`);
      const leak = findLeak(ans, armNames);
      if (leak) throw new Error(`arm "${arm}", prompt "${p.id}": answer leaks ${leak.kind} term "${leak.term}"; scrub it before judging`);
      const inj = findInjection(ans);
      if (inj) throw new Error(`arm "${arm}", prompt "${p.id}": answer contains judge-directed text (${inj}); scrub it before judging`);
    }
  }
  const compared = armNames.filter((n) => n !== reference);
  let prefPairs = pairs;
  if (!prefPairs) {
    prefPairs = [];
    for (let i = 0; i < compared.length; i++) for (let j = i + 1; j < compared.length; j++) prefPairs.push([compared[i], compared[j]]);
  }
  const seenPairs = new Set();
  for (const [x, y] of prefPairs) {
    if (!Object.hasOwn(arms, x) || !Object.hasOwn(arms, y)) throw new Error(`pair ${x}:${y} names an arm with no answers`);
    const key = [x, y].sort().join("\u0000");
    if (seenPairs.has(key)) throw new Error(`pair ${x}:${y} is listed twice (a pair and its reverse count as the same pair)`);
    seenPairs.add(key);
  }
  const refPairs = reference ? compared.map((x) => [reference, x]) : [];
  if (!prefPairs.length && !refPairs.length) throw new Error("nothing to judge: give at least two arms, or a pair such as x:x for a self-comparison");

  const rng = mulberry32(seed);
  const raw = [];
  const addPair = (kind, variant, p, [x, y]) => {
    const self = x === y;
    const labelX = self ? `${x}#1` : x;
    const labelY = self ? `${y}#2` : y;
    const ansX = arms[x][p.id];
    const ansY = arms[y][p.id];
    const flip = rng() < 0.5;
    const orders = flip ? [[labelY, ansY, labelX, ansX], [labelX, ansX, labelY, ansY]] : [[labelX, ansX, labelY, ansY], [labelY, ansY, labelX, ansX]];
    for (const [armA, ansA, armB, ansB] of orders) {
      const entry = { kind, variant, set: p.set, promptId: p.id, pair: [labelX, labelY], armA, armB };
      if (kind === "pref") {
        entry.unsupportedA = unsupportedNumbers(ansA, p, { ids });
        entry.unsupportedB = unsupportedNumbers(ansB, p, { ids });
      } else {
        entry.reference = reference;
      }
      raw.push({ promptId: p.id, entry, text: kind === "pref" ? PREF_VARIANTS[variant](p, rubric, ansA, ansB) : refText(p, ansA, ansB) });
    }
  };
  for (const p of selected) {
    for (const variant of variants) for (const pair of prefPairs) addPair("pref", variant, p, pair);
    for (const pair of refPairs) addPair("ref", "reference", p, pair);
  }

  const tasks = [];
  const mapping = { version: 3, seed, sets, variants, normalised: !!normalise, armStats, promptsSha256: have.prompts, rubricSha256: have.rubric, frozen, ...(tolerant ? { excluded } : {}), tasks: {} };
  shuffled(raw, rng).forEach((r, i) => {
    const taskId = `t${String(i + 1).padStart(5, "0")}`;
    tasks.push({ taskId, promptId: r.promptId, text: r.text });
    mapping.tasks[taskId] = r.entry;
  });
  sealMapping(mapping);
  return { tasks, mapping };
}

function parseArgs(argv) {
  const o = { arms: Object.create(null), sets: ["core"], seed: 1, out: ".", prompts: join(HERE, "prompts.json"), rubric: join(HERE, "rubric.md"), allowUnfrozen: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--arm") {
      const s = v();
      const eq = s.indexOf("=");
      if (eq < 1) throw new Error("--arm needs name=file.jsonl");
      const name = s.slice(0, eq);
      if (Object.hasOwn(o.arms, name)) throw new Error(`--arm ${name} given twice`);
      o.arms[name] = s.slice(eq + 1);
    } else if (k === "--seed") o.seed = Number(v());
    else if (k === "--sets") o.sets = v().split(",");
    else if (k === "--pairs") o.pairs = v().split(",").map((s) => {
      const parts = s.split(":");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`--pairs entry "${s}" must be a:b`);
      return parts;
    });
    else if (k === "--reference") o.reference = v();
    else if (k === "--out") o.out = v();
    else if (k === "--prompts") o.prompts = v();
    else if (k === "--rubric") o.rubric = v();
    else if (k === "--allow-unfrozen") o.allowUnfrozen = true;
    else if (k === "--tolerant") o.tolerant = true;
    else if (k === "--normalise" || k === "--normalize") o.normalise = true;
    else if (k === "--variants") o.variants = v().split(",");
    else throw new Error(`unknown argument ${k}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(o.seed)) throw new Error("--seed must be an integer");
  if (!Object.keys(o.arms).length) throw new Error("give at least one --arm name=file.jsonl");
  const prompts = JSON.parse(readFileSync(o.prompts, "utf8").replace(/^\uFEFF/, ""));
  const rubric = readFileSync(o.rubric, "utf8");
  const arms = Object.create(null);
  for (const [name, file] of Object.entries(o.arms)) {
    arms[name] = Object.create(null);
    for (const row of readJsonl(file)) {
      if (o.tolerant && (!row || typeof row !== "object" || typeof row.id !== "string")) { console.warn(`make-tasks: arm "${name}": skipped a row with no string id`); continue; }
      if (Object.hasOwn(arms[name], row.id)) throw new Error(`arm "${name}": duplicate id ${row.id}`);
      arms[name][row.id] = row.answer;
    }
  }
  const { tasks, mapping } = buildTasks({ prompts, rubric, arms, seed: o.seed, sets: o.sets, pairs: o.pairs, reference: o.reference, allowUnfrozen: o.allowUnfrozen, variants: o.variants, normalise: o.normalise, tolerant: o.tolerant });
  if (mapping.excluded && mapping.excluded.length) console.warn(`WARNING: ${mapping.excluded.length} prompt(s) excluded for every arm because an answer was missing or mistyped: ${mapping.excluded.map((e) => `${e.promptId} (${e.arms.join("+")})`).join(", ")}`);
  console.log(`answer lengths in characters (${mapping.normalised ? "normalised" : "as given: pass --normalise to strip tags, sources lines and markdown"}):`);
  for (const [arm, s] of Object.entries(mapping.armStats)) console.log(`  ${arm}: mean ${s.meanCharsAfter} (before ${s.meanCharsBefore}), median ${s.medianCharsAfter}, min ${s.minCharsAfter}, max ${s.maxCharsAfter}`);
  if (!mapping.frozen) console.warn("WARNING: UNFROZEN RUN. prompts.json or rubric.md differ from the frozen hashes; results are not comparable with earlier runs.");
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "tasks.jsonl"), tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  writeFileSync(join(o.out, "mapping.json"), JSON.stringify(mapping, null, 1) + "\n");
  console.log(`wrote ${tasks.length} tasks to ${join(o.out, "tasks.jsonl")} and the secret mapping to ${join(o.out, "mapping.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`make-tasks: ${e.message}`);
    process.exit(1);
  }
}
