// A copy of sheetForDocMember and normName from party-source.js, kept apart because party-source imports config.js, which imports cards.js (an import cycle for cards.js).
// tests/unit/sheets-reconcile.test.mjs pins the two copies together. Pure, imports nothing but slugify.
import { slugify } from "./member-model.js";

export const normName = (n) => slugify(String(n || "").replace(/[(][^)]*[)]/g, " "));

export function sheetForDocMember(sheets, docMembers, m) {
  const list = sheets || [];
  const want = String(m && m.name || "").toLowerCase();
  const exact = list.find((s) => String(s.name || "").toLowerCase() === want);
  if (exact) return exact;
  const names = new Set((docMembers || []).map((d) => String(d && d.name || "").toLowerCase()));
  const n = normName(want);
  return list.find((s) => !names.has(String(s.name || "").toLowerCase()) && normName(s.name) === n);
}
