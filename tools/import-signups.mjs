#!/usr/bin/env node
// Import sign-ups from an export into the board's `signups` document. Dry run by default: it prints counts and exactly what it would write,
// and touches nothing, not even the network. Re-running an import changes nothing.
//
//   node tools/import-signups.mjs --in <export.json> [--party-file data/party.json] [--current-file <saved signups doc>] [--json]
//   BOARD_ADMIN_TOKEN=... node tools/import-signups.mjs --in <export.json> --apply [--api https://api.leeroy.party] [--backup <path>]
//
//   --in <file>           The export. Either the signups document itself (GET /api/data/signups, data/signups.json: { entries: [...] }) or the
//                         intents mailbox (GET /api/intents, or { intents: [...] }): every intent of kind "signup" carries { patch, entry }.
//   --party-file <path>   Who is allowed on the board: the party document (GET /api/data/party). Default data/party.json. A name that is not
//                         in it (case and punctuation ignored, so "=Name=" matches "Name") is REFUSED, and then nothing is written at all.
//   --current-file <path> Dry run: a saved copy of the live signups document, so the plan shows what really changes. Without it the dry run
//                         compares against an empty document. With --apply the live document is read from the Worker instead.
//   --apply               Send it. Needs BOARD_ADMIN_TOKEN in the environment (never an argument). Saves the live document to a backup file
//                         first, then PUT /api/data/signups. Nothing is sent when there is nothing to change.
//   --api <origin>        Worker origin for --apply. Default https://api.leeroy.party
//   --backup <path>       Where the previous document is saved. Default: a file in the system temp folder (mode 600).
//   --json                Print the plan as JSON.
//
// Merge rules (they are what make it idempotent):
//   - A person is matched to an existing entry by slug, then by name; the existing entry keeps its name. A new entry takes the party name and slug.
//   - A dated import entry (field `updated`) wins over an older stored one and sets `updated` to ITS date, not to now; an equal or older one
//     changes nothing. An undated import entry only fills fields that are empty in the stored entry. Applying the same file twice finds nothing to do.
//   - Several entries for one person in the file: the newest dated one wins (an undated one only fills gaps).
//   - Only the known fields are imported: pack (yes|no), meet, meet_other, rsvp (in|maybe|late|out), when (6pm|8pm|later), updated. Anything else is
//     dropped and reported. A bad value is an error and refuses the whole file. Tallies are recomputed with the Worker's own function.
//   - Entries already in the document for people not in the file are left alone. Nothing is ever deleted.
// Uses only routes that exist: GET and PUT /api/data/signups. It reads no key and no secret, and prints no token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { slugify } from "./add-member.mjs";
import { recomputeSignupTallies } from "../infrastructure/worker/discord.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIELDS = ["pack", "meet", "meet_other", "rsvp", "when", "updated"];
export const VALUES = { pack: ["yes", "no"], rsvp: ["in", "maybe", "late", "out"], when: ["6pm", "8pm", "later"] };
const MEET = { vos: "Valley of Strength", xroads: "The Crossroads" };
const TEXT_MAX = 80;

export const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s) && Number.isFinite(Date.parse(s));
const blank = (v) => v === null || v === undefined || v === "";

// The people allowed on the board: [{ name, slug, key }] from the party document.
export function rosterFromParty(party) {
  const members = party && Array.isArray(party.members) ? party.members : [];
  const roster = members.filter((m) => m && typeof m.name === "string" && m.name.trim()).map((m) => ({ name: m.name.trim(), slug: typeof m.slug === "string" && m.slug ? m.slug : slugify(m.name), key: norm(m.name) }));
  const seen = new Map();
  for (const r of roster) { if (!r.key) throw new Error(`party member "${r.name}" has no letters or digits`); if (seen.has(r.key)) throw new Error(`two party members normalise to the same name: ${seen.get(r.key)} and ${r.name}`); seen.set(r.key, r.name); }
  return roster;
}

// Flattens either accepted shape to [{ name, slug?, fields, order }].
export function readExport(json) {
  const out = [], errors = [], dropped = new Set();
  let list;
  if (json && Array.isArray(json.entries)) list = json.entries.map((e) => ({ entry: e, from: "entries" }));
  else {
    const src = Array.isArray(json) ? json : json && Array.isArray(json.intents) ? json.intents : null;
    if (!src) return { rows: [], errors: ["the file is neither a signups document ({ entries: [...] }) nor an intents list"], dropped: [] };
    list = src.filter((i) => i && i.kind === "signup").map((i) => {
      let body = i.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      const entry = body && body.entry && typeof body.entry === "object" ? body.entry : null;
      return { entry: entry ? { slug: i.slug, ...entry } : null, from: "intents", at: i.at };
    });
  }
  list.forEach(({ entry, from, at }, i) => {
    const where = `${from}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push(`${where}: not an entry`); return; }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (!name && !slug) { errors.push(`${where}: no name`); return; }
    const fields = {};
    for (const [k, raw] of Object.entries(entry)) {
      if (k === "name" || k === "slug") continue;
      if (!FIELDS.includes(k)) { dropped.add(k); continue; }
      let v = raw;
      if (k === "meet" && typeof v === "string" && MEET[v]) v = MEET[v];
      if (blank(v)) { fields[k] = null; continue; }
      if (VALUES[k] && !VALUES[k].includes(v)) { errors.push(`${where}: ${k} "${String(v).slice(0, 20)}" is not one of ${VALUES[k].join(", ")}`); continue; }
      if ((k === "meet" || k === "meet_other") && (typeof v !== "string" || v.length > TEXT_MAX || /[\u0000-\u001f<>]/.test(v))) { errors.push(`${where}: ${k} must be plain text of at most ${TEXT_MAX} characters`); continue; }
      if (k === "updated" && !isDate(v)) { errors.push(`${where}: updated must be an ISO date such as 2026-10-27T00:45:52.346Z`); continue; }
      fields[k] = v;
    }
    if (from === "intents" && !fields.updated && isDate(at)) fields.updated = at;
    out.push({ name, slug, fields, where });
  });
  return { rows: out, errors, dropped: [...dropped].sort() };
}

const when = (e) => (isDate(e.updated) ? Date.parse(e.updated) : null);

// Builds the plan. `current` is the live signups document (or null). Pure: no I/O.
export function buildPlan({ exported, party, current }) {
  const errors = [], warnings = [];
  let roster;
  try { roster = rosterFromParty(party); } catch (e) { return { ok: false, errors: [e.message] }; }
  const read = readExport(exported);
  errors.push(...read.errors);
  if (read.dropped.length) warnings.push(`fields not imported: ${read.dropped.join(", ")}`);
  if (!read.rows.length && !errors.length) warnings.push("the export holds no sign-up entries");
  const byKey = new Map(roster.map((r) => [r.key, r])), bySlug = new Map(roster.map((r) => [r.slug, r]));
  const unknown = [];
  const people = new Map(); // slug -> { person, rows }
  for (const r of read.rows) {
    const person = (r.slug && bySlug.get(r.slug)) || byKey.get(norm(r.name));
    if (!person) { unknown.push(r.name || r.slug); continue; }
    if (!people.has(person.slug)) people.set(person.slug, { person, rows: [] });
    people.get(person.slug).rows.push(r);
  }
  if (unknown.length) errors.push(`not on the board, refused: ${[...new Set(unknown)].map((n) => JSON.stringify(n)).join(", ")}`);
  if (errors.length) return { ok: false, errors, warnings };

  const doc = current && typeof current === "object" ? JSON.parse(JSON.stringify(current)) : { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] };
  doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
  const changes = [];
  for (const { person, rows } of people.values()) {
    // dated rows oldest to newest (stable), then undated rows last so they only fill gaps
    const dated = rows.filter((r) => when(r.fields) !== null).sort((a, b) => when(a.fields) - when(b.fields));
    const undated = rows.filter((r) => when(r.fields) === null);
    let entry = doc.entries.find((e) => e && ((e.slug && e.slug === person.slug) || (e.name && norm(e.name) === person.key)));
    const created = !entry;
    if (created) { entry = { slug: person.slug, name: person.name }; doc.entries.push(entry); }
    const before = JSON.stringify(entry), changed = [];
    for (const r of dated) {
      const stored = when(entry);
      if (stored !== null && stored >= when(r.fields)) continue; // the stored entry is as new or newer
      for (const [k, v] of Object.entries(r.fields)) if (JSON.stringify(entry[k] ?? null) !== JSON.stringify(v)) { entry[k] = v; changed.push(k); }
    }
    for (const r of undated) for (const [k, v] of Object.entries(r.fields)) if (blank(entry[k]) && !blank(v)) { entry[k] = v; changed.push(k); }
    if (created && !changed.length) { doc.entries.pop(); continue; } // nothing usable for this person: do not add an empty shell
    if (created || JSON.stringify(entry) !== before) changes.push({ name: entry.name, slug: person.slug, action: created ? "add" : "update", fields: [...new Set(changed)] });
  }
  return { ok: true, errors: [], warnings, changes, doc, counts: { in_file: read.rows.length, people: people.size, add: changes.filter((c) => c.action === "add").length, update: changes.filter((c) => c.action === "update").length, unchanged: people.size - changes.length } };
}

// Recomputes the tallies like the Worker does, but keeps `updated` as it was (the Worker stamps now, which would make a re-run look different).
export async function finalize(doc) {
  const keep = doc.updated;
  await recomputeSignupTallies(doc);
  if (keep !== undefined) doc.updated = keep;
  return doc;
}

export function formatPlan(plan, { apply = false } = {}) {
  const out = [apply ? "APPLY: sending the changes below" : "DRY RUN: nothing is sent. Add --apply to send."];
  if (!plan.ok) { out.push("REFUSED:"); for (const e of plan.errors) out.push(`  ${e}`); out.push("Nothing is written."); return out.join("\n"); }
  const c = plan.counts;
  out.push(`entries in the file: ${c.in_file}; people: ${c.people}; to add: ${c.add}; to update: ${c.update}; already up to date: ${c.unchanged}`);
  for (const ch of plan.changes) out.push(`  ${ch.action === "add" ? "add   " : "update"} ${ch.name} (${ch.slug}): ${ch.fields.join(", ") || "-"}`);
  for (const w of plan.warnings) out.push(`note: ${w}`);
  if (!plan.changes.length) out.push("Nothing to change: the board already has all of this.");
  else out.push("Request: PUT /api/data/signups (admin token). The live document is saved to a backup file first.");
  return out.join("\n");
}

export function parseArgv(argv) {
  const o = {}, flags = new Set(["apply", "json", "help"]), known = new Set(["in", "party-file", "current-file", "api", "backup", ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (!known.has(k)) throw new Error(`unknown option --${k}`);
    if (flags.has(k)) o[k] = true;
    else { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}

// Sends the plan. `fetchImpl` and `env` are injectable so the apply path is tested with a stub. Returns { ok, log, backup, changed }.
export async function applyImport({ exported, party, api, env, fetchImpl = fetch, backupPath }) {
  const token = env.BOARD_ADMIN_TOKEN;
  if (!token) return { ok: false, log: ["BOARD_ADMIN_TOKEN is not set; nothing was sent"] };
  const base = api.replace(/\/$/, ""), log = [];
  const g = await fetchImpl(`${base}/api/data/signups`, { headers: { accept: "application/json" } });
  if (!g.ok) return { ok: false, log: [`GET /api/data/signups answered ${g.status}; nothing was sent`] };
  const current = await g.json().catch(() => null);
  if (!current || !Array.isArray(current.entries)) return { ok: false, log: ["the live signups document has no entries list; nothing was sent"] };
  const plan = buildPlan({ exported, party, current });
  if (!plan.ok) return { ok: false, log: plan.errors, plan };
  if (!plan.changes.length) return { ok: true, log: ["nothing to change: no request was sent"], plan, changed: false };
  fs.writeFileSync(backupPath, JSON.stringify(current, null, 2), { mode: 0o600 });
  log.push(`previous signups document saved to ${backupPath}`);
  const doc = await finalize(plan.doc);
  const r = await fetchImpl(`${base}/api/data/signups`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(doc) });
  log.push(`PUT /api/data/signups -> ${r.status}`);
  return { ok: r.ok, log, plan, backup: backupPath, changed: true };
}

const readJson = (file, what) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`error: cannot read ${what}: ${e.message}`); process.exit(2); } };

async function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); return; }
  if (!o.in) { console.error("error: --in is required"); process.exit(2); }
  if (o.apply && o["current-file"]) { console.error("error: --current-file is for the dry run; --apply reads the live document"); process.exit(2); }
  const exported = readJson(o.in, "--in"), party = readJson(o["party-file"] || path.join(ROOT, "data/party.json"), "--party-file");
  if (!o.apply) {
    const plan = buildPlan({ exported, party, current: o["current-file"] ? readJson(o["current-file"], "--current-file") : null });
    console.log(o.json ? JSON.stringify({ ok: plan.ok, errors: plan.errors, warnings: plan.warnings, counts: plan.counts, changes: plan.changes }, null, 2) : formatPlan(plan));
    process.exit(plan.ok ? 0 : 1);
  }
  const pre = buildPlan({ exported, party, current: null });
  if (!pre.ok) { console.log(formatPlan(pre, { apply: true })); process.exit(1); }
  console.log("APPLY: reading the live document, then sending only what changed");
  const backupPath = o.backup || path.join(os.tmpdir(), `signups-backup-${Date.now()}.json`);
  const res = await applyImport({ exported, party, api: o.api || "https://api.leeroy.party", env: process.env, backupPath });
  if (res.plan && res.plan.ok) console.log(formatPlan(res.plan, { apply: true }));
  console.log("", ...res.log.map((l) => `  ${l}`));
  if (!res.ok) { console.error("stopped. See the Rollback section of docs/runbooks/import-signups.md."); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
