#!/usr/bin/env node
// Add one person to the party's data. Dry run by default: it prints what it would send and touches nothing, not even the network.
//
//   node tools/add-member.mjs --id <discord user id> --name "<display name>" --class <class> --race <race> [options]
//
//   --id <digits>        Discord user id (17 to 20 digits). Used only to map the Discord user to the board name.
//   --name <text>        Display name shown on the board (1 to 40 characters). A game handle, never a real name.
//   --class <key>        warrior paladin hunter rogue priest shaman mage warlock druid
//   --race <key>         orc troll tauren undead (Horde) or human dwarf gnome night-elf (Alliance)
//   --slug <text>        Optional. Default: the name in lowercase with dashes (a-z, 0-9, dash; 1 to 32 characters).
//   --role <r>           tank | healer | damage. Default: healer for priest, otherwise damage.
//   --start-zone <text>  Only for a race this script does not know.
//   --party-file <path>  Dry run: a saved copy of GET /api/data/party, so the plan can show the new member count and refuse a duplicate.
//   --api <origin>       Worker origin for --apply. Default https://api.leeroy.party
//   --backup <path>      --apply: where the previous party document is saved first. Default: a file in the system temp folder.
//   --apply              Send the changes. Needs the admin token in the environment variable BOARD_ADMIN_TOKEN (never an argument).
//   --json               Print the plan as JSON.
//
// Uses only routes and tables that already exist (infrastructure/worker/index.js):
//   POST /api/admin/members   admin token   add or update one entry in the private roster (discord_members): Discord id -> slug and name
//   GET  /api/data/party      public        read the party document
//   PUT  /api/data/party      admin token   replace the party document (the board's cards, medallions, chips and tables all read it)
// What has no route is printed as manual steps, never invented: the member key (members table), the Worker's built-in roster, name_map.
// The script never reads, makes or prints a member key, and never takes a real name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLASSES, RACES, BAD_NAME, slugify, partyEntry, rosterEntry } from "../infrastructure/worker/member-model.js";

export { CLASSES, RACES, slugify, partyEntry, rosterEntry };

const ROLES = ["tank", "healer", "damage"];
const ID_RE = /^[0-9]{17,20}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Returns { errors: [], value } where value is the cleaned input.
export function parseInput(o) {
  const errors = [];
  const name = typeof o.name === "string" ? o.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 40) errors.push("--name must be 1 to 40 characters");
  else if (BAD_NAME.test(name)) errors.push("--name must be a game handle: no @, links, slashes or publisher marks");
  const id = o.id === undefined ? "" : String(o.id);
  if (!ID_RE.test(id)) errors.push("--id must be a Discord user id of 17 to 20 digits");
  const cls = String(o.class || "").toLowerCase();
  if (!CLASSES[cls]) errors.push(`--class must be one of: ${Object.keys(CLASSES).join(", ")}`);
  const race = String(o.race || "").toLowerCase().replace(/[ _]/g, "-");
  if (!RACES[race] && !o["start-zone"]) errors.push(`--race must be one of: ${Object.keys(RACES).join(", ")} (or give --start-zone)`);
  const slug = o.slug !== undefined ? String(o.slug) : slugify(name);
  if (!SLUG_RE.test(slug)) errors.push("--slug must be 1 to 32 characters of a-z, 0-9 and dash");
  const role = o.role !== undefined ? String(o.role).toLowerCase() : CLASSES[cls] ? CLASSES[cls].role : "damage";
  if (!ROLES.includes(role)) errors.push(`--role must be one of: ${ROLES.join(", ")}`);
  return { errors, value: { name, id, cls, race, slug, role, startZone: o["start-zone"] ? String(o["start-zone"]).trim() : null } };
}

export function buildPlan(opts, partyDoc) {
  const { errors, value } = parseInput(opts);
  if (errors.length) return { ok: false, errors };
  const warnings = [], entry = partyEntry(value), roster = rosterEntry(value);
  let before = null, after = null, nextDoc = null, duplicate = false;
  if (partyDoc && Array.isArray(partyDoc.members)) {
    before = partyDoc.members.length;
    duplicate = partyDoc.members.some((m) => String(m.name).toLowerCase() === value.name.toLowerCase());
    if (duplicate) warnings.push(`the party document already has a member named ${value.name}; the party step is skipped`);
    else { nextDoc = { ...partyDoc, members: [...partyDoc.members, entry] }; after = nextDoc.members.length; }
    const f = RACES[value.race] && RACES[value.race].faction;
    if (f && partyDoc.faction && f !== partyDoc.faction) warnings.push(`${RACES[value.race].label} is ${f}, the party is ${partyDoc.faction}`);
  }
  const requests = [
    { step: 1, method: "POST", path: "/api/admin/members", auth: "admin token", body: roster, note: "adds or updates this one roster entry; idempotent" },
    duplicate
      ? { step: 2, skipped: true, method: "PUT", path: "/api/data/party", auth: "admin token", note: "skipped: already on the board" }
      : { step: 2, method: "PUT", path: "/api/data/party", auth: "admin token", body: nextDoc ? "(current party document + the member below)" : "(the party document read at apply time + the member below)", member: entry, members_before: before, members_after: after, note: "replaces the party document; the previous one is saved to a backup file first" },
  ];
  const manual = [
    "Member key: no route exists. The person's key is made by them or Matt and stored as a salted hash in the members table: see docs/runbooks/add-party-member.md step 4 (infrastructure/scripts/hash-key.mjs, then wrangler d1 execute). This script never sees a key.",
    "Worker built-in roster: infrastructure/worker/index.js PARTY_MEMBERS, bot-data.js ROSTER_DATA and the fallback text in ai-models.js are code, not data. A back-end change by Josh adds the new name; until then the new member works through the board and the roster entry, but the Discord bot's own name list and the AI party summary fallback do not include them.",
    "name_map (private, write-only, whole-object replace): only if the person's real first name must be rewritten in AI answers. Matt does this by hand; the script takes no real names.",
    "data/party.json in the repository is the generated fallback and the preview seed: the generator (Josh) picks the new member up on its next run.",
    "Copy that says the real count shows only when the client flag party.n is true in data/client.json.",
  ];
  return { ok: true, warnings, slug: value.slug, requests, manual, entry, roster, nextDoc };
}

export function formatPlan(plan, { apply = false } = {}) {
  if (!plan.ok) return plan.errors.map((e) => `error: ${e}`).join("\n");
  const out = [apply ? "APPLY: sending the changes below" : "DRY RUN: nothing is sent. Add --apply to send."];
  for (const w of plan.warnings) out.push(`warning: ${w}`);
  for (const r of plan.requests) {
    out.push("", `${r.step}. ${r.method} ${r.path}   (${r.auth})${r.skipped ? "   SKIPPED" : ""}`, `   ${r.note}`);
    if (r.skipped) continue;
    if (r.step === 1) out.push(...JSON.stringify(r.body, null, 2).split("\n").map((l) => `   ${l}`));
    else {
      out.push(`   body: ${r.body}`);
      if (r.members_before !== null) out.push(`   members: ${r.members_before} -> ${r.members_after}`);
      out.push("   new member:", ...JSON.stringify(r.member, null, 2).split("\n").map((l) => `   ${l}`));
    }
  }
  out.push("", "Not done by this script (no route, or not data):", ...plan.manual.map((m, i) => `  ${i + 1}. ${m}`));
  out.push("", "Rollback: docs/runbooks/add-party-member.md, section Rollback.");
  return out.join("\n");
}

function parseArgv(argv) {
  const o = {}, flags = new Set(["apply", "dry-run", "json", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (flags.has(k)) o[k] = true;
    else { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}

// Sends the plan. `fetchImpl` and `env` are injectable so the apply path can be tested with a stub. Returns { ok, log, backup }.
export async function applyPlan(plan, { api, env, fetchImpl = fetch, backupPath }) {
  const token = env.BOARD_ADMIN_TOKEN;
  if (!token) return { ok: false, log: ["BOARD_ADMIN_TOKEN is not set; nothing was sent"] };
  const base = api.replace(/\/$/, ""), log = [];
  const head = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const dup = plan.requests[1].skipped;
  let backup = null, doc = null;
  if (!dup) {
    const g = await fetchImpl(`${base}/api/data/party`, { headers: { accept: "application/json" } });
    if (!g.ok) return { ok: false, log: [`GET /api/data/party answered ${g.status}; nothing was sent`] };
    doc = await g.json();
    if (!doc || !Array.isArray(doc.members)) return { ok: false, log: ["the party document has no members list; nothing was sent"] };
    if (doc.members.some((m) => String(m.name).toLowerCase() === plan.entry.name.toLowerCase())) { log.push("already on the board: party step skipped"); doc = null; }
    else { backup = backupPath; fs.writeFileSync(backup, JSON.stringify(doc, null, 2), { mode: 0o600 }); log.push(`previous party document saved to ${backup}`); }
  }
  const r1 = await fetchImpl(`${base}/api/admin/members`, { method: "POST", headers: head, body: JSON.stringify(plan.roster) });
  log.push(`POST /api/admin/members -> ${r1.status}`);
  if (!r1.ok) return { ok: false, log, backup };
  if (doc) {
    const next = { ...doc, members: [...doc.members, plan.entry] };
    const r2 = await fetchImpl(`${base}/api/data/party`, { method: "PUT", headers: head, body: JSON.stringify(next) });
    log.push(`PUT /api/data/party -> ${r2.status}`);
    if (!r2.ok) return { ok: false, log, backup };
  }
  return { ok: true, log, backup };
}

async function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); return; }
  if (o.apply && o["dry-run"]) { console.error("error: --apply and --dry-run together make no sense"); process.exit(2); }
  let doc = null;
  if (o["party-file"]) { try { doc = JSON.parse(fs.readFileSync(o["party-file"], "utf8")); } catch (e) { console.error(`error: cannot read --party-file: ${e.message}`); process.exit(2); } }
  let plan = buildPlan(o, doc);
  if (!plan.ok) { console.error(formatPlan(plan)); process.exit(2); }
  if (!o.apply) { console.log(o.json ? JSON.stringify(plan, null, 2) : formatPlan(plan)); return; }
  console.log(formatPlan(plan, { apply: true }));
  const backupPath = o.backup || path.join(os.tmpdir(), `party-backup-${plan.slug}-${Date.now()}.json`);
  const res = await applyPlan(plan, { api: o.api || "https://api.leeroy.party", env: process.env, backupPath });
  console.log("", ...res.log.map((l) => `  ${l}`));
  if (!res.ok) { console.error("stopped. Nothing after the failed step was sent. See the Rollback section of the runbook."); process.exit(1); }
  console.log("\ndone. Now do the manual steps above, then check the board.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
