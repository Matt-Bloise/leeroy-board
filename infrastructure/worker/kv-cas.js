// Safe read-modify-write of one JSON document in kv_state under concurrent requests (audit 2026-11-06 finding 2).
// The old pattern (SELECT, change in JS, UPDATE the whole document) lets two overlapping requests overwrite each other: both read the same
// version, the second UPDATE erases the first one's change. Here the UPDATE only succeeds while the stored text is still exactly what was read
// (compare-and-set on the json column, no schema change); otherwise the change is recomputed from the fresh document and tried again.
// Success is read from RETURNING rows. No extra Worker request: it is all D1 work inside the same request.
export class KvConflictError extends Error {
  constructor(key) { super(`Write conflict on ${key}`); this.name = "KvConflictError"; this.key = key; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// mutate(doc | null, attempt) -> { doc: newDocument, result?: any }, or { skip: true, result? } to write nothing. doc is null when the row is missing.
// Returns { doc, result, at }. Throws KvConflictError after `tries` lost races (callers answer 409).
export async function updateKvJson(env, key, mutate, { tries = 8, now = () => new Date().toISOString() } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(key).first();
    const out = await mutate(row ? JSON.parse(row.json) : null, attempt);
    if (out.skip) return { doc: row ? JSON.parse(row.json) : null, result: out.result, at: null };
    const at = now(), text = JSON.stringify(out.doc);
    // RETURNING read through .all(): a row comes back only if this statement changed one (does not depend on meta.changes).
    const res = row
      ? await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ? RETURNING key").bind(text, at, key, row.json).all()
      : await env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?) RETURNING key").bind(key, text, at).all();
    if (res && Array.isArray(res.results) && res.results.length === 1) return { doc: out.doc, result: out.result, at };
    await pause(Math.floor(Math.random() * 15 * (attempt + 1)));
  }
  throw new KvConflictError(key);
}

// One atomic commit of three things that must never disagree: the sheet event, the materialised sheets (kv_state 'party_sheets') and the PUBLIC
// projection of them (kv_state 'party'). All are written in a single D1 batch (one transaction). Each statement is guarded by the versions
// that were read, and chained: the sheets UPDATE needs both old texts to still be current, and only when it took effect (a per-attempt nonce on
// the row) do the party UPDATE and the event INSERT run. If any version moved, nothing is written and the whole operation is recomputed from
// the fresh documents. A hidden field therefore cannot stay public after a later hide, and a failed write cannot leave a ghost event.
// compute(sheets | null, party | null, attempt) -> { sheets, party | undefined (leave unchanged) }. Throws KvConflictError after `tries` lost races.
export async function commitSheetWrite(env, { event, compute }, { tries = 8, now = () => new Date().toISOString() } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    // One read for both rows (D1 calls count against the Worker's subrequest limit: 8 tries x 2 calls stays well under 50).
    const { results: rows } = await env.DB.prepare("SELECT key, json FROM kv_state WHERE key IN ('party_sheets', 'party')").all();
    const sRow = (rows || []).find((r) => r.key === "party_sheets") || null;
    const pRow = (rows || []).find((r) => r.key === "party") || null;
    const out = await compute(sRow ? JSON.parse(sRow.json) : null, pRow ? JSON.parse(pRow.json) : null, attempt);
    const at = now();
    const nonce = `${at}~${Math.random().toString(36).slice(2)}`;
    const sText = JSON.stringify(out.sheets);
    const pText = pRow ? JSON.stringify(out.party === undefined ? JSON.parse(pRow.json) : out.party) : null;
    const partyIs = "(SELECT json FROM kv_state WHERE key = 'party')";
    const partyGuard = pRow ? `AND ${partyIs} = ?` : `AND ${partyIs} IS NULL`;
    const partyArgs = pRow ? [pRow.json] : [];
    // 1. sheets: only if sheets and party are both still what was read. If this statement matches, 2 and 3 below cannot fail (same transaction).
    const sheetsStmt = sRow
      ? env.DB.prepare(`UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party_sheets' AND json = ? ${partyGuard}`).bind(sText, nonce, sRow.json, ...partyArgs)
      : env.DB.prepare(`INSERT OR IGNORE INTO kv_state (key, json, updated_at) SELECT 'party_sheets', ?, ? WHERE ${partyIs} ${pRow ? "= ?" : "IS NULL"}`).bind(sText, nonce, ...partyArgs);
    const marker = "(SELECT updated_at FROM kv_state WHERE key = 'party_sheets') = ?";
    const list = [sheetsStmt];
    // 2. public projection, only if step 1 took effect (this attempt's timestamp is on the sheets row).
    if (pRow) list.push(env.DB.prepare(`UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party' AND json = ? AND ${marker}`).bind(pText, at, pRow.json, nonce));
    // 3. the event, only if step 1 took effect.
    list.push(env.DB.prepare(
      "INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE " + marker
    ).bind(event.slug, event.name, event.field, event.valJson, event.visible ? 1 : 0, event.source, event.at, nonce));
    // Final statement: the nonce is on the sheets row only if step 1 took effect. Its row, not meta.changes, is the success signal.
    list.push(env.DB.prepare("SELECT 1 AS ok FROM kv_state WHERE key = 'party_sheets' AND updated_at = ?").bind(nonce));
    const res = await env.DB.batch(list);
    const verdict = res[res.length - 1];
    if (verdict && Array.isArray(verdict.results) && verdict.results.length === 1) return { sheets: out.sheets, party: pRow ? JSON.parse(pText) : null, at };
    await pause(Math.floor(Math.random() * 15 * (attempt + 1)));
  }
  throw new KvConflictError("party_sheets");
}
