// Admin decisions on AI-proposed library facts (wiki_proposals, status 'pending').
// The learner (scraper.js -> ai-models.js extractWikiFactsWithAi) only inserts pending rows. An admin approves or rejects them here:
//   approve: one D1 batch = lib_pages facts/history/checked/updated_at + status 'approved' + one audit_log row. All or nothing.
//   reject:  one D1 batch = status 'rejected' + one audit_log row (the optional reason lives in the audit row's detail_json).
// The caller (index.js) has already passed adminGate. After an approve it recomputes the category blob, search/open blobs and the
// index stamps, clears the in-isolate page cache, purges the edge cache and tells the room, exactly as PUT /wiki/page does.
// No AI, no network, no secrets in this file.
import { MAX_PROPOSED_KEY_CHARS, MAX_PROPOSED_VALUE_CHARS } from "./ai-models.js";

export const MAX_REJECT_REASON_CHARS = 200;

// Phrases that only appear when text is trying to steer a model or a reader, not when it states a game fact.
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instruction|prompt|rule|direction|context)s?\b/i,
  /\b(system|developer)\s*(prompt|message|instruction)s?\b/i,
  /\b(new|updated|real)\s+instructions?\b/i,
  /\byou\s+(are|must|should|will)\s+(now|always|never)\b/i,
  /\b(act|behave|respond|answer|reply)\s+(as|like)\s+(a|an|if)\b/i,
  /\bpretend\s+(to|you)\b/i,
  /\b(jailbreak|do anything now|DAN mode)\b/i,
  /(^|\n)\s*(system|assistant|user|human)\s*:/i,
  /<<<|>>>/,
  /<\s*\/?\s*(script|iframe|style|system|img|a|svg|object|embed)\b/i,
  /\bjavascript:/i,
  /\{\{|\}\}|\$\{/,
];

// http(s)/ftp/protocol-relative links, "www." hosts and bare domains on the common top-level names.
const URL_PATTERN = /(\b(?:https?|ftp):\/\/|(?:^|[\s(])\/\/[a-z0-9]|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|co|me|ly|tv|xyz|app|dev|gl|link|info|biz|ru|cn|tk|click|top)\b)/i;

export const looksLikeInjection = (text) => INJECTION_PATTERNS.some((re) => re.test(String(text ?? "")));
export const containsUrl = (text) => URL_PATTERN.test(String(text ?? ""));

// Checks a stored proposal. `hard` problems can never be overridden; `soft` ones can with force:true.
export function checkProposal(p) {
  const key = String(p.fact_key ?? "");
  const value = String(p.proposed_value ?? "");
  const hard = [];
  const soft = [];
  if (!key.trim()) hard.push("empty_key");
  if (!value.trim()) hard.push("empty_value");
  if (key.length > MAX_PROPOSED_KEY_CHARS) hard.push("key_too_long");
  if (value.length > MAX_PROPOSED_VALUE_CHARS) hard.push("value_too_long");
  if (looksLikeInjection(key) || looksLikeInjection(value)) soft.push("looks_like_prompt_injection");
  if (containsUrl(key) || containsUrl(value)) soft.push("contains_url");
  return { hard, soft };
}

const safeJson = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

const reply = (status, body) => ({ status, body });

// GET /wiki/proposals/:id -> the proposal next to the value the library holds right now, plus what approving would trip over.
export async function describeProposal(env, id) {
  const p = await env.DB.prepare("SELECT * FROM wiki_proposals WHERE id = ?").bind(id).first();
  if (!p) return reply(404, { error: "Proposal not found" });
  const page = await env.DB.prepare("SELECT id, category, title, facts_json FROM lib_pages WHERE id = ?").bind(p.page_id).first();
  const fact = page ? safeJson(page.facts_json, []).find((f) => f && f.key === p.fact_key) : null;
  const { hard, soft } = checkProposal(p);
  return reply(200, {
    proposal: p,
    page: page ? { id: page.id, category: page.category, title: page.title } : null,
    page_exists: !!page,
    current_value: fact ? fact.value : null, // what the library says now; old_value is what it said when the learner proposed
    changed_since_proposed: (fact ? fact.value : null) !== (p.old_value ?? null),
    problems: [...hard, ...soft],
    needs_force: soft.length > 0 && hard.length === 0,
  });
}

// POST /wiki/proposals/:id/approve. Returns { status, body, refresh? }; refresh is set only when the library changed.
export async function approveProposal(env, id, { force = false, now = new Date() } = {}) {
  const p = await env.DB.prepare("SELECT * FROM wiki_proposals WHERE id = ?").bind(id).first();
  if (!p) return reply(404, { error: "Proposal not found" });
  if (p.status === "approved") return reply(200, { ok: true, id, status: "approved", already: true });
  if (p.status !== "pending") return reply(409, { error: `Proposal is ${p.status}, not pending`, status: p.status });

  const { hard, soft } = checkProposal(p);
  if (hard.length) return reply(422, { error: "Proposal is not valid", problems: hard });
  if (soft.length && force !== true) {
    return reply(422, { error: "Proposal needs force:true to approve", problems: soft, needs_force: true });
  }

  const page = await env.DB.prepare("SELECT id, category, title, facts_json, history_json FROM lib_pages WHERE id = ?").bind(p.page_id).first();
  if (!page) return reply(409, { error: "The page no longer exists", code: "page_missing", page_id: p.page_id });

  const facts = safeJson(page.facts_json, []);
  const history = safeJson(page.history_json, []);
  const existing = facts.find((f) => f && f.key === p.fact_key);
  const oldValue = existing ? existing.value : null;
  if (existing) {
    existing.value = p.proposed_value;
  } else {
    const src = await env.DB.prepare("SELECT id, url, host, label, tier FROM lib_sources WHERE id = ?").bind(p.source_id).first();
    facts.push({ key: p.fact_key, value: p.proposed_value, refs: [src ? { id: src.id, url: src.url, host: src.host, label: src.label, tier: src.tier } : { id: p.source_id }] });
  }
  const iso = now.toISOString();
  const today = iso.slice(0, 10);
  history.unshift({ date: today, text: `${p.fact_key} updated from ${p.source_id} (approved)` });

  // The page write is guarded twice: the proposal must still be pending and the facts must be what we just read, so a concurrent
  // approve or an edit through PUT /wiki/page turns this into a no-op instead of overwriting. The two statements after it run
  // only if the one before changed a row (changes()), so nothing half-applies. The audit row is the last statement: if it fails
  // the whole batch rolls back and the proposal stays pending.
  const detail = JSON.stringify({ page: p.page_id, fact_key: p.fact_key, source: p.source_id, old: oldValue, force: force === true });
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE lib_pages SET facts_json = ?, history_json = ?, checked = ?, updated_at = ? WHERE id = ? AND facts_json = ? AND EXISTS (SELECT 1 FROM wiki_proposals WHERE id = ? AND status = 'pending')"
      ).bind(JSON.stringify(facts), JSON.stringify(history), today, iso, p.page_id, page.facts_json, id),
      env.DB.prepare("UPDATE wiki_proposals SET status = 'approved' WHERE id = ? AND status = 'pending' AND changes() > 0").bind(id),
      env.DB.prepare("INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) SELECT NULL, NULL, 'wiki.proposal.approve', ?, ?, ? WHERE changes() > 0")
        .bind(`wiki_proposals:${id}`, detail, iso),
    ]);
  } catch {
    return reply(500, { error: "Could not apply the proposal; nothing was changed", code: "apply_failed" });
  }
  const changed = (r) => Number(r && r.meta && r.meta.changes) || 0;
  if (!changed(results[1])) {
    const now2 = await env.DB.prepare("SELECT status FROM wiki_proposals WHERE id = ?").bind(id).first();
    if (now2 && now2.status === "approved") return reply(200, { ok: true, id, status: "approved", already: true });
    if (now2 && now2.status !== "pending") return reply(409, { error: `Proposal is ${now2.status}, not pending`, status: now2.status });
    return reply(409, { error: "The page changed while approving; look again and retry", code: "page_changed" });
  }
  return {
    status: 200,
    body: { ok: true, id, status: "approved", page_id: p.page_id, fact_key: p.fact_key, old_value: oldValue, new_value: p.proposed_value },
    refresh: { category: page.category, page: p.page_id, title: page.title, date: today, text: `${p.fact_key} updated on ${page.title} (approved proposal)` },
  };
}

// POST /wiki/proposals/:id/reject with an optional { reason } of at most 200 characters.
export async function rejectProposal(env, id, { reason, now = new Date() } = {}) {
  if (reason !== undefined && reason !== null && typeof reason !== "string") return reply(400, { error: "reason must be text" });
  const why = reason ? reason.trim() : "";
  if (why.length > MAX_REJECT_REASON_CHARS) return reply(400, { error: `reason is at most ${MAX_REJECT_REASON_CHARS} characters` });
  const p = await env.DB.prepare("SELECT id, page_id, fact_key, status FROM wiki_proposals WHERE id = ?").bind(id).first();
  if (!p) return reply(404, { error: "Proposal not found" });
  if (p.status === "rejected") return reply(200, { ok: true, id, status: "rejected", already: true });
  if (p.status !== "pending") return reply(409, { error: `Proposal is ${p.status}, not pending`, status: p.status });
  const iso = now.toISOString();
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare("UPDATE wiki_proposals SET status = 'rejected' WHERE id = ? AND status = 'pending'").bind(id),
      env.DB.prepare("INSERT INTO audit_log (tenant_id, actor_discord_user_id, action, target, detail_json, at) SELECT NULL, NULL, 'wiki.proposal.reject', ?, ?, ? WHERE changes() > 0")
        .bind(`wiki_proposals:${id}`, JSON.stringify({ page: p.page_id, fact_key: p.fact_key, reason: why || null }), iso),
    ]);
  } catch {
    return reply(500, { error: "Could not reject the proposal; nothing was changed", code: "apply_failed" });
  }
  if (!(Number(results[0] && results[0].meta && results[0].meta.changes) || 0)) {
    const now2 = await env.DB.prepare("SELECT status FROM wiki_proposals WHERE id = ?").bind(id).first();
    if (now2 && now2.status === "rejected") return reply(200, { ok: true, id, status: "rejected", already: true });
    return reply(409, { error: `Proposal is ${now2 ? now2.status : "gone"}, not pending` });
  }
  return reply(200, { ok: true, id, status: "rejected" });
}
