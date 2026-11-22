// Fictional game_facts rows for the reader tests (no client data). loadFacts writes one finished load and its rows straight into an in-memory D1 built from schema.sql.
import { normName, baseName } from "../../infrastructure/worker/game-facts-name.js";

export const FACTS = [
  { id: "spelllevels:101", kind: "spell_level", subject: "Zorbo Bolt", claim: "Zorbo Bolt (Rank 4) requires level 18.", value: "18", unit: "level", source_table: "spelllevels", row_id: "101", note: "rank=4;class=Tinker" },
  { id: "spelllevels:102", kind: "spell_level", subject: "Zorbo Bolt", claim: "Zorbo Bolt (Rank 5) requires level 26.", value: "26", unit: "level", source_table: "spelllevels", row_id: "102", note: "rank=5;class=Tinker" },
  { id: "spellmana:101", kind: "spell_mana_cost", subject: "Zorbo Bolt", claim: "Zorbo Bolt costs 120 mana.", value: "120", unit: "mana", source_table: "spellpower", row_id: "101", note: "" },
  { id: "spelllevels:777", kind: "spell_level", subject: "Tonight", claim: "Tonight requires level 31.", value: "31", unit: "level", source_table: "spelllevels", row_id: "777", note: "" },
];

export function loadFacts(DB, rows = FACTS, { loadId = "load-1", build = "9.9.9.1" } = {}) {
  DB.raw.prepare("INSERT INTO game_fact_loads (id, build, manifest_sha256, files_json, kind, status, counts_json, started_at, finished_at) VALUES (?, ?, ?, '{}', 'client', 'done', '{}', '2026-11-18T09:00:00.000Z', '2026-11-18T09:01:00.000Z')").run(loadId, build, "a".repeat(64));
  const ins = DB.raw.prepare("INSERT INTO game_facts (id, load_id, kind, subject, subject_norm, subject_base, claim, value, unit, source_table, row_id, build, verdict, source_class, note, superseded, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client-db2', ?, 0, '2026-11-18T09:01:00.000Z')");
  for (const r of rows) { const n = normName(r.subject); ins.run(r.id, loadId, r.kind, r.subject, n, baseName(n), r.claim, r.value, r.unit || "", r.source_table || "", r.row_id || "", build, r.verdict || "holds", r.note || ""); }
}
