// Last line of defence before a request body leaves the Worker for a model provider or a
// web search. Walks every string (and every key) of a JSON-able body, plus the stringified
// body, and reports any roster name, alias, first name, character name, guild name, Discord
// id, mention, invite, @everyone/@here or the canary. Matching uses the same normalisation
// as tokenise.js (case, possessive, glued, zero-width, NBSP, hyphen, width and lookalike
// variants).
//
// Reports never echo the leaked value (they carry kind, path and the member token only),
// so the error text is safe to log.

import { buildMatcher, matcherTest, normalise, tokenise, hasSpecialToken } from "./tokenise.js";
import { buildNameMap } from "./tokenise.js";

export const CANARY = "LEEROY-CANARY-7f3a91c2";

const MENTION_RE = /<(?:@[!&]?|#)\s*\d+\s*>/;
const RAW_ID_RE = /\d{17,}/;
const EVERYONE_RE = /@(?:everyone|here)\b/i;
const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;

const canaryMatchers = new Map();
function canaryMatcher(canary) {
  if (!canaryMatchers.has(canary)) {
    const words = normalise(canary).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    canaryMatchers.set(canary, buildMatcher([{ key: words.join(""), words, long: true }]));
  }
  return canaryMatchers.get(canary);
}

function scanString(str, map, canary, path, out) {
  if (!str) return;
  const s = normalise(str);
  const key = matcherTest(map.matcher ?? { long: null, short: null }, s);
  if (key !== null) out.push({ kind: "name", path, ref: map.names.get(key) ?? "?" });
  if (canary && matcherTest(canaryMatcher(canary), s) !== null) out.push({ kind: "canary", path });
  if (RAW_ID_RE.test(s)) out.push({ kind: "id", path });
  if (MENTION_RE.test(s)) out.push({ kind: "mention", path });
  if (EVERYONE_RE.test(s)) out.push({ kind: "everyone", path });
  if (INVITE_RE.test(s)) out.push({ kind: "invite", path });
}

function walk(value, path, state, map, canary, out) {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === "string") return scanString(value, map, canary, path, out);
  if (t === "number" || t === "bigint" || t === "boolean") return scanString(String(value), map, canary, path, out);
  if (t !== "object") return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, state, map, canary, out));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    scanString(k, map, canary, `${path}.<key>`, out);
    walk(v, path ? `${path}.${k}` : k, state, map, canary, out);
  }
}

export function findIdentifiers(body, map, canary = CANARY) {
  const m = map && map.names ? map : buildNameMap([]);
  const out = [];
  walk(body, "", { seen: new WeakSet() }, m, canary, out);
  let flat;
  try {
    flat = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    out.push({ kind: "unserialisable", path: "$" });
    return out;
  }
  if (typeof flat === "string") {
    // Undo JSON string escapes so a name next to an escaped newline still hits a word boundary.
    const plain = flat.replace(/\\[ntrbf"\\/]/g, " ");
    const extra = [];
    scanString(plain, m, canary, "$", extra);
    for (const e of extra) if (!out.some((o) => o.kind === e.kind)) out.push(e);
  }
  return out;
}

export function assertNoIdentifiers(body, map, canary = CANARY) {
  const leaks = findIdentifiers(body, map, canary);
  if (leaks.length) {
    const summary = leaks
      .slice(0, 8)
      .map((l) => `${l.kind}${l.ref ? `(${l.ref})` : ""}@${l.path || "$"}`)
      .join(", ");
    const err = new Error(`outbound guard: ${leaks.length} identifier leak(s): ${summary}`);
    err.code = "OUTBOUND_IDENTIFIER_LEAK";
    err.leaks = leaks;
    throw err;
  }
  return { ok: true, leaks: [] };
}

// A search query must carry no person at all: tokenise, and if anything tokenised (a name, an
// id, a pre-existing token) or still looks like an identifier, refuse (null).
export function scrubSearchQuery(q, map) {
  if (typeof q !== "string") return null;
  const t = tokenise(q, map);
  if (hasSpecialToken(t)) return null;
  if (findIdentifiers({ q: t }, map).length) return null;
  const clean = t.replace(/\s+/g, " ").trim();
  return clean || null;
}
