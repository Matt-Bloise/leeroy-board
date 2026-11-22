// Privacy scan shared by the unit tests that guard authored fixtures: golden set v2 (grade-answers.test.mjs) and the voice golden set (voice-golden.test.mjs).
// Moved here unchanged from grade-answers.test.mjs, whose evasion tests (case, plural, glued, zero-width, lookalikes, escapes, separators, short aliases, canary forms, ids) cover it.
// Not a test file itself (no .test.mjs), so `node --test "tests/unit/*.test.mjs"` only imports it.
import fs from "node:fs";
import path from "node:path";
import { normalizeText } from "../../tools/grade-answers.mjs";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { PARTY_MEMBERS } from "../../infrastructure/worker/party-source.js";
// ---- privacy scan (terms come from the code's own roster and party data at runtime; two further first names are assembled from fragments by J() so no real name is typed whole in this file) ----
export const J = (...p) => p.join("");
const CANARY_A = "LEEROY";
const CANARY_B = "CANARY";
const CANARY_C = "7f3a91c2";
export const CANARY = [CANARY_A, CANARY_B, CANARY_C].join("-");
export function nameTerms() {
  const out = new Set();
  const add = (t) => { const s = String(t || "").trim().toLowerCase(); if (s.length >= 3) out.add(s); };
  for (const r of ROSTER_DATA) { add(r.display); for (const a of r.aliases || []) add(a); }
  for (const m of PARTY_MEMBERS) { add(m.name); add(m.slug); }
  add(J("ma", "tt")); add(J("jo", "sh"));
  return [...out];
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function scanText(raw) {
  const hits = [];
  let t = String(raw).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = normalizeText(t).toLowerCase();
  const compact = t.replace(/[^a-z0-9]/g, "");
  for (const term of nameTerms()) {
    const parts = term.split(/[\s\-_]+/).filter(Boolean);
    const body = parts.map(esc).join("[\\s_\\-]*");
    const long = parts.join("").length >= 6;
    const re = long ? new RegExp(body) : new RegExp(`(?<![a-z0-9])${body}(?:'s|s|es)?(?![a-z0-9])`);
    if (re.test(t)) hits.push(`name:${term}`);
  }
  const canaryCompact = CANARY.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.includes(canaryCompact)) hits.push("canary");
  for (const v of [CANARY, CANARY.toLowerCase(), CANARY.toUpperCase()]) if (String(raw).includes(Buffer.from(v).toString("base64").replace(/=+$/, ""))) hits.push("canary-b64");
  for (const m of String(raw).match(/[A-Za-z0-9+/]{16,}={0,2}/g) || []) {
    try { if (Buffer.from(m, "base64").toString("utf8").toLowerCase().replace(/[^a-z0-9]/g, "").includes(canaryCompact)) hits.push("canary-b64"); } catch { /* not base64 */ }
  }
  if (/\d{17,}/.test(t)) hits.push("discord-id-shaped number");
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(t)) hits.push("email");
  if (new RegExp(["<@[!&]?\\d+>", "@every" + "one", "@he" + "re"].join("|")).test(t)) hits.push("mention");
  return [...new Set(hits)];
}
export function scanTree(dir) {
  const problems = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) { problems.push(...scanTree(full)); continue; }
    for (const h of scanText(fs.readFileSync(full, "utf8"))) problems.push(`${f}: ${h}`);
  }
  return problems;
}
