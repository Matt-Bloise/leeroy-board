// Safe read-modify-write of one JSON document in kv_state under concurrent requests (audit 2026-11-06 finding 2).
// The old pattern (SELECT, change in JS, UPDATE the whole document) lets two overlapping requests overwrite each other: both read the same
// version, the second UPDATE erases the first one's change. Here the UPDATE only succeeds while the stored text is still exactly what was read
// (compare-and-set on the json column, no schema change); otherwise the change is recomputed from the fresh document and tried again.
// D1 reports rows changed in meta.changes. No extra Worker request: it is all D1 work inside the same request.
export class KvConflictError extends Error {
  constructor(key) { super(`Write conflict on ${key}`); this.name = "KvConflictError"; this.key = key; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// mutate(doc | null, attempt) -> { doc: newDocument, result?: any }, or { skip: true, result? } to write nothing. doc is null when the row is missing.
// Returns { doc, result, at }. Throws KvConflictError after `tries` lost races (callers answer 409).
export async function updateKvJson(env, key, mutate, { tries = 25, now = () => new Date().toISOString() } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(key).first();
    const out = await mutate(row ? JSON.parse(row.json) : null, attempt);
    if (out.skip) return { doc: row ? JSON.parse(row.json) : null, result: out.result, at: null };
    const at = now(), text = JSON.stringify(out.doc);
    const res = row
      ? await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = ? AND json = ?").bind(text, at, key, row.json).run()
      : await env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(key, text, at).run();
    if (Number(res && res.meta && res.meta.changes) === 1) return { doc: out.doc, result: out.result, at };
    await pause(Math.floor(Math.random() * 15 * (attempt + 1)));
  }
  throw new KvConflictError(key);
}
