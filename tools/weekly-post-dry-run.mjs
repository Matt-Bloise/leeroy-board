// Prints the exact weekly board post (infrastructure/worker/weekly-post.js) for review. It never posts, never writes and needs no secret.
//   node tools/weekly-post-dry-run.mjs                      the repo's own data/*.json and data/library/*.json
//   node tools/weekly-post-dry-run.mjs --live               the public documents production serves (4 anonymous GETs to api.leeroy.party)
//   options: --play 2026-11-20T23:00:00Z (play night; default: next Friday 23:00 UTC = 6 PM ET)   --api https://api.example   --json
// Output: the post as Discord would show it, then the library facts it quotes (page, key, source) and anyone left without a fact, and why.
import { readFileSync } from "node:fs";
import { composeWeeklyPost, planWeeklyPost } from "../infrastructure/worker/weekly-post.js";

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const live = argv.includes("--live");
const api = (arg("--api") || "https://api.leeroy.party").replace(/\/+$/, "");
if (!/^https:\/\//.test(api)) { console.error("--api must start with https://"); process.exit(2); }

let playAt = arg("--play") ? Date.parse(arg("--play")) : planWeeklyPost({ config: { weekday: 5, hour: 23 }, state: null, now: Date.now() }).playAt;
if (!Number.isFinite(playAt)) { console.error("--play must be an ISO time such as 2026-11-20T23:00:00Z"); process.exit(2); }

const local = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));
async function remote(path) {
  const r = await fetch(`${api}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}
const docs = live
  ? { signups: await remote("/api/data/signups"), party: await remote("/api/data/party"), classes: await remote("/api/library/classes.json"), dungeons: await remote("/api/library/dungeons.json") }
  : { signups: local("data/signups.json"), party: local("data/party.json"), classes: local("data/library/classes.json"), dungeons: local("data/library/dungeons.json") };

const post = composeWeeklyPost({ ...docs, playAt });
if (argv.includes("--json")) { console.log(JSON.stringify({ source: live ? api : "repo", playAt: new Date(playAt).toISOString(), ...post }, null, 1)); process.exit(0); }
console.log(`weekly post dry run: ${live ? api : "repo data"}, play night ${new Date(playAt).toISOString()}, ${post.text.length} characters. Nothing is posted.\n`);
console.log("----- post -----");
console.log(post.text);
console.log("----- facts quoted -----");
for (const f of post.facts) console.log(`${f.page} ${f.key} [${f.source.id || "-"}] ${f.source.label} ${f.source.url}`);
if (post.skipped.length) { console.log("----- no fact -----"); for (const s of post.skipped) console.log(`${s.name}: ${s.why}`); }
