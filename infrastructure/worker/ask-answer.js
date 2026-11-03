// Manual answers to an ask turn (Discord /answer and the admin POST /answer). One implementation so both agree:
//   - real columns only: ask_turns has no `sources` column, sources live in answer_details
//   - status 'answered' (what GET /ask and the feed read), or 'error' when the answer failed; never 'done'/'failed'
//   - a provider error is stored and sent only as shortProviderError (secret-free, 60 characters)
//   - a private ask (share = 0) puts no question or answer on the sockets, only a nudge to re-read
//   - a non-admin may only answer an ask that carries their own name
import { shortProviderError } from "./ai-models.js";

const MAX_SOURCES_CHARS = 1000;

export function sourcesText(sources) {
  if (sources === undefined || sources === null || sources === "") return null;
  const parts = Array.isArray(sources) ? sources : [sources];
  const text = parts.map((s) => String(s ?? "").trim()).filter(Boolean).join(", ").slice(0, MAX_SOURCES_CHARS);
  return text || null;
}

// Returns { ok: false, code: "not_found" | "forbidden" } or { ok: true, status, share, broadcast } where broadcast is the payload for the room.
export async function applyManualAnswer(env, { id, answer, sources, failed, byName, isAdmin, now = new Date().toISOString() }) {
  const row = await env.DB.prepare("SELECT id, by_name, share FROM ask_turns WHERE id = ?").bind(String(id)).first();
  if (!row) return { ok: false, code: "not_found" };
  if (!isAdmin && String(row.by_name) !== String(byName || "")) return { ok: false, code: "forbidden" };

  const reason = failed ? shortProviderError(failed) : "";
  const status = failed ? "error" : "answered";
  const model = failed ? `manual (failed: ${reason})`.slice(0, 120) : "manual";
  await env.DB.prepare("UPDATE ask_turns SET answer = COALESCE(?, answer), model = ?, status = ?, answered_at = ? WHERE id = ?")
    .bind(answer || null, model, status, now, String(id))
    .run();

  const src = sourcesText(sources);
  if (src) {
    await env.DB.prepare(
      "INSERT INTO answer_details (intent_id, more, sources, asker_hash, message_id, created_at) VALUES (?, NULL, ?, NULL, NULL, ?) " +
        "ON CONFLICT(intent_id) DO UPDATE SET sources = excluded.sources"
    )
      .bind(String(id), src, now)
      .run();
  }

  const isShared = Number(row.share) !== 0;
  const broadcast = isShared
    ? { type: "ask", ask: { id: String(id), status, answer: answer || null, sources: src ? [src] : [], answered_at: now, failed: failed ? reason : null } }
    : { type: "ask", slug: String(byName || row.by_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-") };
  return { ok: true, status, share: isShared, broadcast };
}
