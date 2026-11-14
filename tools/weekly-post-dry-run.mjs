// Prints the exact weekly board post (infrastructure/worker/weekly-post.js) for review. It never posts, never writes and needs no secret.
//   node tools/weekly-post-dry-run.mjs                      the repo's own data/*.json and data/library/classes.json
//   node tools/weekly-post-dry-run.mjs --live               the public documents production serves (3 anonymous GETs to api.leeroy.party)
//   options: --config '{"weekday":5,"hour":23}'  the same schedule row the Worker reads (default: Friday 23:00 UTC); the post that schedule
//                                               makes at its next play night is printed, choosing the same weekly fact the Worker would
//            --now 2026-11-19T23:30:00Z         the clock to plan from (default: now)
//            --api https://api.example          --json
// Output: the post as Discord would receive it, then the library facts it quotes (page, key, sources) and anyone left without a fact.
import { readFileSync } from "node:fs";
import { composeWeeklyPost, planWeeklyPost, validateWeeklyConfig, POST_MAX } from "../infrastructure/worker/weekly-post.js";

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const fail = (m) => { console.error(m); process.exit(2); };
const live = argv.includes("--live");
const api = (arg("--api") || "https://api.leeroy.party").replace(/\/+$/, "");
if (!/^https:\/\//.test(api)) fail("--api must start with https://");
let config;
try { config = JSON.parse(arg("--config", '{"weekday":5,"hour":23}')); } catch { fail("--config must be JSON, for example {\"weekday\":5,\"hour\":23}"); }
const bad = validateWeeklyConfig(config);
if (bad) fail(`--config: ${bad}`);
const now = arg("--now") ? Date.parse(arg("--now")) : Date.now();
if (!Number.isFinite(now)) fail("--now must be an ISO time such as 2026-11-19T23:30:00Z");
const plan = planWeeklyPost({ config, state: null, now });

const local = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));
async function remote(path) {
  const r = await fetch(`${api}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}
const docs = live
  ? { signups: await remote("/api/data/signups"), party: await remote("/api/data/party"), classes: await remote("/api/library/classes.json") }
  : { signups: local("data/signups.json"), party: local("data/party.json"), classes: local("data/library/classes.json") };

const post = composeWeeklyPost({ ...docs, playAt: plan.playAt });
const meta = { source: live ? api : "repo", week: plan.week, playAt: new Date(plan.playAt).toISOString(), postAt: new Date(plan.postAt).toISOString(), characters: post.text.length, max: POST_MAX };
if (argv.includes("--json")) { console.log(JSON.stringify({ ...meta, ...post }, null, 1)); process.exit(0); }
console.log(`weekly post dry run: ${meta.source}, play week ${meta.week} (play night ${meta.playAt}, posts from ${meta.postAt}), ${meta.characters} of ${POST_MAX} characters. Nothing is posted.\n`);
if (post.text.length > POST_MAX) console.log(`WARNING: ${post.text.length} characters is over ${POST_MAX}\n`);
console.log("----- post -----");
console.log(post.text);
console.log("----- facts quoted -----");
for (const f of post.facts) console.log(`${f.page} ${f.key} ${f.sources.map((s) => `[${s.id || "-"}] ${s.label} ${s.url}`).join(" | ")}`);
if (post.skipped.length) { console.log("----- no fact -----"); for (const s of post.skipped) console.log(`${s.name}: ${s.why}`); }
