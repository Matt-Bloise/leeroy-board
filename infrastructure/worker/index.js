// =============================================================================
// Cloudflare Worker Entry Point (`leeroy-brain`)
// Full parity with `wow-mage`:
//   - Edge-cached D1 state (`kv_state`), library blobs (`lib_blobs`), & source snapshots
//   - Event-sourced Party Character Sheets (`GET/POST /api/sheet`, `PUT /api/vocab`)
//   - Chamber Letter Dispatches (`POST /api/dispatch`)
//   - Flat & nested Intents (`signup`, `journey`, `launch`, `ask`, `fix`, `refresh`)
//   - Multi-Provider AI Q&A (`ai-models.js`) & Discord HTTP Interactions (`discord.js`)
// =============================================================================

import { BoardRoom } from "./room.js";
import {
  answerWithAi,
  resolveAiProvider,
  isProviderConfigured,
  isPrPreviewEnv,
  invalidatePagesCache,
  AI_PROVIDER_LABELS,
  webBoardLinks,
  webBoardLinksDeep,
} from "./ai-models.js";
import { runScheduledSourceSweep, recomputeCategoryAndIndex } from "./scraper.js";
import { feedbackReport, cleanupAnswerUx } from "./answer-ux.js";
import { clampContent, ALLOWED_MENTIONS_NONE } from "./discord-safety.js";
import { handleDiscordInteraction, recomputeSignupTallies, DISCORD_SLASH_COMMANDS_MANIFEST } from "./discord.js";
import { manifestFor } from "./setup-command.js";
import { buildAnnounceBody, lookupRosterId } from "./announce.js";
import { handleAccount } from "./account.js";
import { handleWebAuth, webSessionFrom } from "./web-auth.js";
import { handleDataRights } from "./data-rights.js";
import { charsOn, handleCharacters, listFor } from "./characters-api.js";
import { handleExport } from "./export.js";
import { authenticate } from "./auth.js";
import { invalidatePersonaCache } from "./persona.js";
import { evalEnabled, validateEvalRequest, runEval } from "./eval.js";
import { loadBudget, dailyCap, utcDayKey, askBudgetKeys, hashId } from "./budget.js";
import { upsertMember } from "./members.js";
import { isPublicAtlasDoc, isPublicDataDoc } from "./public-docs.js";
import { feedEnabled, serveFeedDoc } from "./feed.js";
import { CONFIG_KEYS, CONFIG_MAX_BYTES, invalidateConfigCache, isPrivateKvKey, validateConfigValue } from "./config.js";
import { timingSafeEqualStr, sha256Hex } from "./crypto.js";
import { extractKey } from "./request-key.js";
import { guestIpKey } from "./guest-key.js";
import { saltProblems, saltErrorBody } from "./salts.js";
import { loadPublicVotes } from "./votes.js";
import { eventsEnabled, runSync } from "./scheduled-events.js";
import { runMoments, momentsStatus, momentsEnabled, momentsDryRun, momentsShadow, d1Store, MOMENTS_CRON, MOMENTS_SHADOW_STATE_KEY, MOMENTS_LEDGER_KEY } from "./moments.js";
import { originVerdict, corsHeaders as buildCorsHeaders } from "./cors.js";
import { PARTY_MEMBERS, loadPartyMembers } from "./party-source.js";

export { BoardRoom };

const SHEET_FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "level", "launch_state", "plan_zone", "goals"];

async function resolveMemberAuth(req, url, env) {
  // 1. Try cryptographic salted hash lookup in `members` table
  const authWho = await authenticate(req, env);
  if (authWho && authWho.slug) {
    const found = PARTY_MEMBERS.find((m) => m.slug === authWho.slug);
    if (found) return { ok: true, member: found };
    // Not one of the built-in five: the party document in D1 may know them (read only on this miss, so the five cost no extra query).
    const fromDoc = (await loadPartyMembers(env)).find((m) => m.slug === authWho.slug);
    if (fromDoc) return { ok: true, member: fromDoc };
    return { ok: true, member: { slug: authWho.slug, name: authWho.name || authWho.slug } };
  }

  // 2. Verified BOARD_ADMIN_TOKEN via constant-time comparison
  const k = extractKey(req);
  if (env.BOARD_ADMIN_TOKEN && k && timingSafeEqualStr(k, env.BOARD_ADMIN_TOKEN)) {
    return { ok: true, member: PARTY_MEMBERS[3] }; // Default admin to Bloise
  }

  return { ok: false, member: null };
}

// Admin-token-only gate (same pattern as PUT /persona): 503 if unset, 401 if missing or wrong. Returns a Response to send, or null to continue.
function adminGate(req, url, env, cors) {
  if (!env.BOARD_ADMIN_TOKEN) {
    return jsonResp({ error: "Admin token not configured" }, 503, cors);
  }
  const adminKey = extractKey(req);
  if (!adminKey || !timingSafeEqualStr(adminKey, env.BOARD_ADMIN_TOKEN)) {
    return jsonResp({ error: "Unauthorized" }, 401, cors);
  }
  return null;
}

function corsHeaders(req, env) {
  const verdict = originVerdict(req, env);
  if (verdict.ok && verdict.origin) {
    return buildCorsHeaders(verdict.origin);
  }
  return {};
}

function jsonResp(body, status = 200, extraHeaders = {}) {
  const txt = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(txt, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

// In-memory isolate L1 cache for sub-millisecond edge responses on *.workers.dev and custom domains
const ISOLATE_CACHE = new Map();
const ISOLATE_CACHE_MAX = 150;
const ISOLATE_CACHE_TTL_MS = 60 * 1000; // 60 seconds default TTL

function getIsolateCache(path) {
  const hit = ISOLATE_CACHE.get(path);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    ISOLATE_CACHE.delete(path);
    return null;
  }
  return new Response(hit.body, {
    status: hit.status,
    headers: { ...hit.headers, "X-Isolate-Cache": "HIT" },
  });
}

function putIsolateCache(path, resp, ttlMs = ISOLATE_CACHE_TTL_MS) {
  if (ISOLATE_CACHE.size >= ISOLATE_CACHE_MAX) {
    const firstKey = ISOLATE_CACHE.keys().next().value;
    if (firstKey) ISOLATE_CACHE.delete(firstKey);
  }
  const cloned = resp.clone();
  cloned.text().then((body) => {
    const headers = {};
    for (const [k, v] of cloned.headers.entries()) {
      headers[k] = v;
    }
    ISOLATE_CACHE.set(path, {
      body,
      status: cloned.status,
      headers,
      expiresAt: Date.now() + ttlMs,
    });
  }).catch(() => {});
}

function clearIsolateCache(paths = []) {
  if (!paths || paths.length === 0) {
    ISOLATE_CACHE.clear();
    return;
  }
  for (const path of paths) {
    for (const key of ISOLATE_CACHE.keys()) {
      if (key.includes(path)) {
        ISOLATE_CACHE.delete(key);
      }
    }
  }
}

async function getCachedResponse(origin, path) {
  const local = getIsolateCache(path);
  if (local) return local;
  try {
    const cacheKey = new Request(`${origin}${path}`, { method: "GET" });
    return await caches.default.match(cacheKey);
  } catch {
    return null;
  }
}

function setCachedResponse(ctx, origin, path, resp, ttlMs = ISOLATE_CACHE_TTL_MS) {
  putIsolateCache(path, resp, ttlMs);
  try {
    const cacheKey = new Request(`${origin}${path}`, { method: "GET" });
    ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  } catch {}
}

export async function purgeWorkerCache(origin, paths = []) {
  clearIsolateCache(paths);
  invalidatePagesCache();
  try {
    const cache = caches.default;
    const allPaths = new Set(paths);
    allPaths.add("/api/state");
    allPaths.add("/api/bootstrap");
    await Promise.all(
      [...allPaths].map((p) => cache.delete(new Request(`${origin}${p}`, { method: "GET" })).catch(() => false))
    );
  } catch {}
}

export async function broadcastToRoom(env, payload) {
  try {
    const id = env.BOARD_ROOM.idFromName("global");
    const stub = env.BOARD_ROOM.get(id);
    await stub.fetch("https://room.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webBoardLinksDeep(payload)),
    });
  } catch (err) {
    console.error("Failed to broadcast to BoardRoom:", err);
  }
}

export async function buildPartySheetsFromD1(env) {
  const now = new Date().toISOString();

  // 1. Fast path: Read pre-materialized party sheets from kv_state (single point lookup)
  try {
    const cachedRow = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party_sheets'").first();
    if (cachedRow && cachedRow.json) {
      const parsed = JSON.parse(cachedRow.json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { party: parsed, seq: Date.now() };
      }
    }
  } catch {}

  // 2. Slow path / bootstrap fallback: Reconstruct from base + sheet_events
  const bySlug = new Map();

  for (const m of await loadPartyMembers(env)) {
    const fields = {};
    for (const f of SHEET_FIELDS) {
      if (m[f] !== undefined) {
        fields[f] = { value: m[f], visible: true, source: "board", at: "2026-10-30T00:00:00.000Z" };
      }
    }
    bySlug.set(m.slug, { slug: m.slug, name: m.name, fields, updated: "2026-10-30T00:00:00.000Z" });
  }

  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, name, field, value_json, visible, source, created_at FROM sheet_events ORDER BY id ASC"
    ).all();
    for (const r of results || []) {
      let row = bySlug.get(r.slug);
      if (!row) {
        row = { slug: r.slug, name: r.name || r.slug, fields: {}, updated: r.created_at || now };
        bySlug.set(r.slug, row);
      }
      let val = null;
      try {
        val = r.value_json !== null && r.value_json !== undefined ? JSON.parse(r.value_json) : null;
      } catch {
        val = r.value_json;
      }
      row.fields[r.field] = {
        value: val,
        visible: Boolean(r.visible),
        source: r.source || "board",
        at: r.created_at || now,
      };
      row.updated = r.created_at || now;
    }
  } catch {}

  const party = [...bySlug.values()];
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, ?)"
    )
      .bind(JSON.stringify(party), now)
      .run();
  } catch {}

  return { party, seq: Date.now() };
}

export async function recordSheetEventInD1(env, origin, { slug, name, field, value, visible = true, source = "board", at }) {
  const now = at || new Date().toISOString();
  const valJson = value === undefined || value === null ? null : JSON.stringify(value);

  // 1. Rebuild updated party sheets
  const { party: currentParty } = await buildPartySheetsFromD1(env);
  let memberSheet = currentParty.find((m) => m.slug === slug);
  if (!memberSheet) {
    memberSheet = { slug, name: name || slug, fields: {}, updated: now };
    currentParty.push(memberSheet);
  }
  memberSheet.fields = memberSheet.fields || {};
  memberSheet.fields[field] = {
    value,
    visible: Boolean(visible),
    source: source || "board",
    at: now,
  };
  memberSheet.updated = now;

  // 2. Prepare batch updates (insert event + materialize party_sheets + sync party doc if needed)
  const batchStatements = [
    env.DB.prepare(
      "INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(slug, name, field, valJson, visible ? 1 : 0, source, now),
    env.DB.prepare(
      "INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('party_sheets', ?, ?)"
    ).bind(JSON.stringify(currentParty), now),
  ];

  // Also sync common fields back into kv_state['party']
  try {
    const partyRow = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first();
    if (partyRow) {
      const partyDoc = JSON.parse(partyRow.json);
      const m = (partyDoc.members || []).find(
        (x) => (x.name || "").toLowerCase() === name.toLowerCase()
      );
      if (m && value !== undefined && value !== null) {
        if (field === "race") m.race = String(value);
        if (field === "class") m.class = String(value);
        if (field === "spec_path") m.spec = String(value);
        batchStatements.push(
          env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party'")
            .bind(JSON.stringify(partyDoc), now)
        );
      }
    }
  } catch {}

  await env.DB.batch(batchStatements);
  await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/party.json", "/api/state"]);
  await broadcastToRoom(env, { type: "state", party: currentParty });
  return { party: currentParty, at: now };
}

export async function insertIntent(env, { slug, kind, body, ver = 1, at }) {
  const now = at || new Date().toISOString();
  const bodyJson = typeof body === "string" ? body : JSON.stringify(body || {});
  const res = await env.DB.prepare(
    "INSERT INTO intents (at, slug, kind, body, ver) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(now, slug || "unknown", kind || "unknown", bodyJson, ver)
    .run();
  const seq = res.meta && res.meta.last_row_id ? res.meta.last_row_id : Date.now();
  return { seq, at: now };
}

// Every route this Worker answers, as "METHOD pattern" (":name" is one path segment, a trailing "*" is a prefix, ANY is every
// method). A description only: dispatch below does not read it. tests/unit/authz.test.mjs checks it against the handlers in
// this file and account.js and against a hand-written table of who may call each route, so a new route must be added here.
export const ROUTES = [
  "POST /discord", "GET /discord/commands", "GET /votes", "GET /me", "POST /probe", "ANY /sheet",
  "POST /announce", "PUT /vocab", "PUT /config/:key", "POST /admin/members", "GET /admin/feedback", "GET /admin/export", "PUT /persona", "POST /dispatch", "POST /admin/events/sync", "GET /admin/moments", "POST /admin/eval",
  "GET /intents", "POST /ack", "POST /answer", "GET /signups", "POST /signups", "ANY /live", "GET /state",
  "POST /token", "POST /auth/discord", "GET /auth/discord/start", "GET /auth/discord/callback", "POST /auth/logout", "ANY /me", "GET /me/export", "POST /me/erase", "POST /me/characters", "ANY /state/:doc", "GET /ask", "GET /wiki/snapshots",
  "GET /wiki/proposals", "PUT /wiki/page", "GET /bootstrap", "GET /library/*", "GET /data/*", "PUT /data/*",
  "GET /atlas/*", "PUT /atlas/*", "POST /intent", "POST /refresh", "GET /", "GET /health",
];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const verdict = originVerdict(req, env);
    if (!verdict.ok) {
      return new Response("Forbidden Origin", { status: 403 });
    }
    const cors = buildCorsHeaders(verdict.origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Normalize optional /api prefix so both direct Worker calls and proxied /api/* calls match
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";

    try {
      // 0. Discord Serverless HTTP Interactions Endpoint (`POST /api/discord`) & Command Manifest (`GET /api/discord/commands`)
      if (req.method === "POST" && path === "/discord") {
        return await handleDiscordInteraction(req, env, ctx, url.origin);
      }
      if (req.method === "GET" && path === "/discord/commands") {
        return jsonResp({ commands: manifestFor(env, DISCORD_SLASH_COMMANDS_MANIFEST) }, 200, cors);
      }

      // 0a. GET /votes -> public, read-only: id, title, choice counts, closes_at, open. Never voter ids or hashes.
      if (req.method === "GET" && path === "/votes") {
        const votes = await loadPublicVotes(env.DB, Date.now());
        return jsonResp({ votes }, 200, { ...cors, "Cache-Control": "public, max-age=10, s-maxage=10" });
      }

      // 0b. GET /me -> Resolves board key to party member identity for `js/brain.js`
      if (req.method === "GET" && path === "/me") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          // Q18: a web session cookie is accepted too, only when WEB_LOGIN is on. The legacy board key path is unchanged.
          const ws = await webSessionFrom(req, env, Date.now());
          if (ws) {
            const credCors = cors["Access-Control-Allow-Origin"] ? { ...cors, "Access-Control-Allow-Credentials": "true" } : cors;
            const me = { name: ws.name, discord_user_id: ws.discord_user_id, expires_at: ws.expires_at, via: "web-session", pending: [] };
            if (charsOn(env)) Object.assign(me, await listFor(env, ws.discord_user_id)); // CHARS_V1: { characters, selected }
            return jsonResp(me, 200, { ...credCors, "Cache-Control": "no-store" });
          }
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = auth.member;
        return jsonResp({ slug: m.slug, name: m.name, pending: [] }, 200, cors);
      }

      // Admin only: NDJSON backup, one table page per request (see export.js for the exact exclusions).
      if (req.method === "GET" && path === "/admin/export") {
        const res = await handleExport(req, env, url);
        for (const [k, v] of Object.entries(cors)) if (!res.headers.has(k)) res.headers.set(k, v);
        return res;
      }

      // 0c. POST /probe -> Capability probe from `js/brain.js`
      if (req.method === "POST" && path === "/probe") {
        return jsonResp({ ok: true, at: new Date().toISOString() }, 200, cors);
      }

      // 0d. GET /sheet & POST /sheet & PUT /vocab & POST /dispatch -> Party Sheet & Chamber Dispatches (`wow-mage` Phase 0 parity)
      if (path === "/sheet") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = auth.member;
        if (req.method === "GET") {
          const { party, seq } = await buildPartySheetsFromD1(env);
          const mine = party.find((p) => p.slug === m.slug) || { slug: m.slug, name: m.name, fields: {}, updated: null };
          return jsonResp(
            {
              slug: m.slug,
              name: m.name,
              sheet: { fields: mine.fields, updated: mine.updated },
              party,
              seq,
            },
            200,
            cors
          );
        }
        if (req.method === "POST") {
          const body = await req.json();
          const field = String(body.field || "").trim();
          if (!SHEET_FIELDS.includes(field)) {
            return jsonResp({ error: `Unknown sheet field: ${field}` }, 400, cors);
          }
          const visible = body.visible !== false;
          const value = body.value === undefined ? null : body.value;
          const now = new Date().toISOString();
          await recordSheetEventInD1(env, url.origin, {
            slug: m.slug,
            name: m.name,
            field,
            value,
            visible,
            source: "board",
            at: now,
          });
          const { seq } = await insertIntent(env, {
            slug: m.slug,
            kind: "sheet",
            body: { field, value, visible, source: "board" },
            ver: 1,
            at: now,
          });
          return jsonResp({ ok: true, id: seq, seq, at: now, field, value, visible }, 200, cors);
        }
      }

      // Admin only: post one message to a channel named in discord_roster.channels. Ids come from config, never the request.
      if (req.method === "POST" && path === "/announce") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!env.DISCORD_BOT_TOKEN) return jsonResp({ error: "Discord bot token not configured" }, 503, cors);
        let input;
        try {
          input = await req.json();
        } catch {
          return jsonResp({ error: "Body must be JSON" }, 400, cors);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) return jsonResp({ error: "Body must be a JSON object" }, 400, cors);
        const roster = await loadConfigKey(env, "discord_roster");
        const channelId = lookupRosterId(roster, "channels", input.channel_key);
        if (!channelId) return jsonResp({ error: "Unknown channel_key" }, 400, cors);
        let roleId = null;
        if (input.mention_role !== undefined && input.mention_role !== null) {
          roleId = lookupRosterId(roster, "roles", input.mention_role);
          if (!roleId) return jsonResp({ error: "Unknown mention_role" }, 400, cors);
        }
        const built = buildAnnounceBody({ text: input.text, roleId, buttonLabel: input.button_label, buttonUrl: input.button_url });
        if (!built.ok) return jsonResp({ error: built.error }, 400, cors);
        let res;
        try {
          res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(built.body),
          });
        } catch {
          return jsonResp({ error: "Discord request failed" }, 502, cors);
        }
        if (!res.ok) {
          await res.arrayBuffer().catch(() => {});
          return jsonResp({ ok: false, status: res.status, error: "Discord refused the post" }, 502, cors);
        }
        await res.arrayBuffer().catch(() => {});
        return jsonResp({ ok: true, status: res.status }, 200, cors);
      }

      // Admin token only: a friend's member key must not rewrite the shared vocabulary.
      if (req.method === "PUT" && path === "/vocab") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const body = await req.json();
        const vocab = (body && body.vocab) || {};
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('vocab', ?, ?)")
          .bind(JSON.stringify(vocab), now)
          .run();
        return jsonResp({ ok: true, fields: Object.keys(vocab).length }, 200, cors);
      }

      // Admin-only config rows (name_map, discord_members) that live only in D1. Write-only: there is no GET route.
      const configMatch = path.match(/^\/config\/([^/]+)$/);
      if (req.method === "PUT" && configMatch) {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const key = configMatch[1];
        if (!CONFIG_KEYS.includes(key)) {
          return jsonResp({ error: "Unknown config key" }, 400, cors);
        }
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > CONFIG_MAX_BYTES) {
          return jsonResp({ error: "Config too large" }, 413, cors);
        }
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          return jsonResp({ error: "Body must be valid JSON" }, 400, cors);
        }
        const problem = validateConfigValue(key, value);
        if (problem) return jsonResp({ error: problem }, 400, cors);
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
          .bind(key, JSON.stringify(value), now)
          .run();
        invalidateConfigCache(key);
        return jsonResp({ ok: true, key, entries: Array.isArray(value) ? value.length : Object.keys(value).length }, 200, cors);
      }

      // Admin only, flag EVENTS_ENABLED=on: plan (default, no Discord call) or with ?dry=0 apply Discord scheduled events from the events_schedule row.
      if (req.method === "POST" && path === "/admin/events/sync") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!eventsEnabled(env)) return jsonResp({ error: "Not found" }, 404, cors);
        const dry = url.searchParams.get("dry") !== "0";
        const roster = dry ? null : await loadConfigKey(env, "discord_roster");
        const { status, body } = await runSync({ env, dry, guildId: roster && /^[0-9]{5,25}$/.test(roster.guildId || "") ? roster.guildId : null });
        return jsonResp(body, status, cors);
      }

      // Admin only: timed-post schedule status for mission control. No channel ids, user ids, message ids or content.
      if (req.method === "GET" && path === "/admin/moments") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const schedule = await loadConfigKey(env, "moments");
        const shadow = momentsShadow(env);
        const { state } = await d1Store(env, shadow ? MOMENTS_SHADOW_STATE_KEY : undefined).read();
        const { state: led } = await d1Store(env, MOMENTS_LEDGER_KEY, "entries").read();
        return jsonResp(momentsStatus({ schedule, state, now: Date.now(), enabled: momentsEnabled(env), shadow, dryRun: momentsDryRun(env), ledger: led.entries }), 200, cors);
      }

      // Admin only: add or update one roster entry in discord_members. The reply never echoes other members.
      if (req.method === "POST" && path === "/admin/members") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > 2000) return jsonResp({ error: "Body too large" }, 413, cors);
        let entry;
        try {
          entry = JSON.parse(raw);
        } catch {
          return jsonResp({ error: "Body must be valid JSON" }, 400, cors);
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return jsonResp({ error: "member must be an object" }, 400, cors);
        let current = [];
        try {
          const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'discord_members'").first();
          if (row && row.json) current = JSON.parse(row.json);
        } catch {
          return jsonResp({ error: "Could not read the roster" }, 500, cors);
        }
        const result = upsertMember(Array.isArray(current) ? current : [], entry);
        if (result.error) return jsonResp({ error: result.error }, 400, cors);
        const problem = validateConfigValue("discord_members", result.members);
        if (problem) return jsonResp({ error: problem }, 400, cors);
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
          .bind("discord_members", JSON.stringify(result.members), now)
          .run();
        invalidateConfigCache("discord_members");
        return jsonResp({ ok: true, slug: entry.slug, entries: result.members.length }, 200, cors);
      }

      // Admin only, and only when EVAL_ENABLED is on (default off; 404 otherwise). Model bake-off: runs a few cells of questions x
      // candidates through the production retrieval and prompt path and returns answers plus deterministic lint. Stores nothing,
      // posts nothing. At most 6 model calls and 25 seconds per request; the caller loops on nextCursor (see eval.js).
      if (req.method === "POST" && path === "/admin/eval") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        if (!evalEnabled(env)) return jsonResp({ error: "Not found" }, 404, cors);
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > 100000) return jsonResp({ error: "Body too large" }, 413, cors);
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        const parsed = validateEvalRequest(body);
        if (parsed.error) return jsonResp({ error: parsed.error }, 400, cors);
        const out = await runEval(env, parsed);
        return jsonResp(out, 200, { ...cors, "Cache-Control": "no-store" });
      }

      // The persona pack is curated content that lives only in D1. Write-only: there is no GET route for it.
      // Admin token only: a member key must not be able to rewrite the system prompt for every ask.
      if (req.method === "PUT" && path === "/persona") {
        if (!env.BOARD_ADMIN_TOKEN) {
          return jsonResp({ error: "Admin token not configured" }, 503, cors);
        }
        const adminKey = extractKey(req);
        if (!adminKey || !timingSafeEqualStr(adminKey, env.BOARD_ADMIN_TOKEN)) {
          return jsonResp({ error: "Unauthorized" }, 401, cors);
        }
        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > 200000) {
          return jsonResp({ error: "Persona pack too large" }, 413, cors);
        }
        let pack = null;
        try {
          pack = JSON.parse(raw);
        } catch {}
        if (!pack || typeof pack !== "object" || Array.isArray(pack) || typeof pack.version !== "number" || typeof pack.system !== "string") {
          return jsonResp({ error: "Body must be a JSON object with a numeric version and a string system" }, 400, cors);
        }
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('persona', ?, ?)")
          .bind(JSON.stringify(pack), now)
          .run();
        invalidatePersonaCache();
        return jsonResp({ ok: true, version: pack.version, bytes: raw.length }, 200, cors);
      }

      if (req.method === "POST" && path === "/dispatch") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = auth.member;
        const body = await req.json();
        const ids = Array.isArray(body && body.ids) ? body.ids.slice(0, 3) : [];
        if (!ids.length || !body || body.yes !== true) {
          return jsonResp({ error: "Invalid dispatch payload" }, 400, cors);
        }
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT INTO dispatches (slug, name, ask_ids_json, created_at) VALUES (?, ?, ?, ?)")
          .bind(m.slug, m.name, JSON.stringify(ids), now)
          .run();
        const seq = Date.now();
        if (env.DISCORD_WEBHOOK_URL) {
          await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: "Leeroy Jenkins",
              content: clampContent(`📜 **${m.name}** shared ${ids.length} library note${ids.length === 1 ? "" : "s"} from the Leeroy Chamber with the party.`),
              allowed_mentions: ALLOWED_MENTIONS_NONE,
            }),
          }).catch(() => {});
        }
        return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
      }

      // 0e. GET /intents -> Shared brain intents mailbox polling for bot or consumer
      if (path === "/intents" && req.method === "GET") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const after = parseInt(url.searchParams.get("after") || "0", 10) || 0;
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);

        const [rows, countRow] = await Promise.all([
          env.DB.prepare(
            "SELECT seq, at, slug, kind, body, ver FROM intents WHERE seq > ? ORDER BY seq ASC LIMIT ?"
          )
            .bind(after, limit)
            .all(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM intents").first(),
        ]);

        const intents = (rows.results || []).map((r) => {
          let parsed = {};
          try {
            parsed = JSON.parse(r.body);
          } catch {
            parsed = { raw: r.body };
          }
          return {
            seq: r.seq,
            at: r.at,
            slug: r.slug,
            kind: r.kind,
            body: parsed,
            ver: r.ver,
          };
        });

        return jsonResp(
          {
            ok: true,
            intents,
            expired: 0,
            pending: countRow ? countRow.count : 0,
          },
          200,
          cors
        );
      }

      // Admin only: Helpful/Off counts and the latest 50 votes (question, first 160 chars of the answer, no user ids).
      if (req.method === "GET" && path === "/admin/feedback") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const sinceRaw = url.searchParams.get("since");
        const sinceMs = sinceRaw ? Date.parse(sinceRaw) : Date.now() - 30 * 86400000;
        if (!Number.isFinite(sinceMs)) return jsonResp({ error: "since must be an ISO 8601 date" }, 400, cors);
        try {
          return jsonResp(await feedbackReport(env, new Date(sinceMs).toISOString()), 200, cors);
        } catch {
          return jsonResp({ error: "feedback_unavailable" }, 503, cors);
        }
      }

      // 0f. POST /ack -> Acknowledge and clear intents up to `upTo` sequence number
      if (path === "/ack" && req.method === "POST") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        let body = {};
        try {
          body = (await req.json()) || {};
        } catch {}
        const upTo = parseInt(body.upTo || body.up_to || "0", 10);
        if (!upTo || upTo <= 0) {
          return jsonResp({ error: "Missing or invalid upTo sequence number" }, 400, cors);
        }
        const res = await env.DB.prepare("DELETE FROM intents WHERE seq <= ?").bind(upTo).run();
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM intents").first();
        const deleted = (res.meta && res.meta.changes) || 0;
        return jsonResp(
          {
            ok: true,
            deleted,
            pending: countRow ? countRow.count : 0,
          },
          200,
          cors
        );
      }

      // 0g. POST /answer -> Push answer to ask question into ask_turns & broadcast
      if (path === "/answer" && req.method === "POST") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        let body = {};
        try {
          body = (await req.json()) || {};
        } catch {}
        const id = String(body.id || "").trim();
        if (!id) {
          return jsonResp({ error: "Missing ask turn id" }, 400, cors);
        }
        const now = new Date().toISOString();
        const failed = body.failed || null;
        const status = failed ? "failed" : "done";
        const answer = body.answer || null;
        const sources = body.sources ? (typeof body.sources === "string" ? body.sources : JSON.stringify(body.sources)) : null;

        await env.DB.prepare(
          "UPDATE ask_turns SET answer = ?, sources = ?, status = ?, answered_at = ? WHERE id = ?"
        )
          .bind(answer, sources, status, now, id)
          .run();

        const askItem = {
          id,
          status,
          answer,
          sources: body.sources || [],
          answered_at: now,
          failed,
        };
        await broadcastToRoom(env, { type: "ask", ask: askItem });
        await purgeWorkerCache(url.origin, ["/api/bootstrap", `/api/ask?id=${id}`]);

        return jsonResp({ ok: true, id, status }, 200, cors);
      }

      // 0h. GET/POST /signups -> Direct signups endpoint
      if (path === "/signups") {
        if (req.method === "GET") {
          let resp = await getCachedResponse(url.origin, "/api/signups");
          if (!resp) {
            const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
            const doc = row ? JSON.parse(row.json) : { entries: [], tallies: {} };
            resp = jsonResp(doc, 200, {
              ...cors,
              "Cache-Control": "public, max-age=15, stale-while-revalidate=60",
            });
            setCachedResponse(ctx, url.origin, "/api/signups", resp, 15000);
          } else {
            const headers = new Headers(resp.headers);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            resp = new Response(resp.body, { status: resp.status, headers });
          }
          return resp;
        }
        if (req.method === "POST") {
          const auth = await resolveMemberAuth(req, url, env);
          if (!auth.ok) {
            return jsonResp({ error: "Unauthorized board key" }, 401, cors);
          }
          const member = auth.member;
          const body = (await req.json()) || {};
          const now = new Date().toISOString();

          const patch = body.patch && typeof body.patch === "object" ? { ...body.patch } : { ...body };
          delete patch.token;
          delete patch.key;

          const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
          const doc = row
            ? JSON.parse(row.json)
            : { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] };
          doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
          let entry = doc.entries.find(
            (e) =>
              (e.slug && e.slug === member.slug) ||
              (e.name || "").toLowerCase() === member.name.toLowerCase()
          );
          if (!entry) {
            entry = { slug: member.slug, name: member.name };
            doc.entries.push(entry);
          }
          for (const [k, v] of Object.entries(patch)) {
            if (k !== "slug" && k !== "name") {
              entry[k] = v === "vos" ? "Valley of Strength" : v === "xroads" ? "The Crossroads" : v;
            }
          }
          entry.updated = now;
          await recomputeSignupTallies(doc);

          await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
            .bind(JSON.stringify(doc), now)
            .run();

          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "signup",
            body: { patch, entry },
            ver: 1,
            at: now,
          });

          await purgeWorkerCache(url.origin, ["/api/bootstrap", "/api/data/signups.json", "/api/signups"]);
          await broadcastToRoom(env, { type: "data", key: "signups", data: doc });

          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }
      }

      // 1. WebSocket / Live State -> Durable Object (`BoardRoom`) + D1 state
      if (path === "/live" || path === "/state") {
        if (path === "/state" && req.method === "GET") {
          let resp = await getCachedResponse(url.origin, "/api/state");
          if (!resp) {
            const [{ results }, { party }] = await Promise.all([
              env.DB.prepare(
                "SELECT key, json FROM kv_state WHERE key IN ('party','timeline','stats','signups','tonight','launch','decide')"
              ).all(),
              buildPartySheetsFromD1(env),
            ]);
            const map = {};
            for (const row of results || []) {
              try {
                map[row.key] = JSON.parse(row.json);
              } catch {}
            }
            const now = new Date().toISOString();
            resp = jsonResp(
              webBoardLinksDeep({
                type: "state",
                ver: 1,
                at: now,
                party,
                signups: map.signups || null,
                partyDoc: map.party || null,
                tonight: map.tonight || null,
                timeline: map.timeline || null,
                stats: map.stats || null,
                decide: map.decide || null,
                launch: Array.isArray(map.launch)
                  ? map.launch
                  : map.launch && Array.isArray(map.launch.rows)
                  ? map.launch.rows
                  : [],
              }),
              200,
              {
                ...cors,
                "Cache-Control": "public, max-age=10, s-maxage=30, stale-while-revalidate=60",
              }
            );
            setCachedResponse(ctx, url.origin, "/api/state", resp, 30000);
          } else {
            const headers = new Headers(resp.headers);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            resp = new Response(resp.body, { status: resp.status, headers });
          }
          return resp;
        }
        const id = env.BOARD_ROOM.idFromName("global");
        const stub = env.BOARD_ROOM.get(id);
        const doResp = await stub.fetch(req);
        if (doResp.status === 101) return doResp; // WebSocket Upgrade
        const headers = new Headers(doResp.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(doResp.body, { status: doResp.status, headers });
      }

      // 1a. POST /token -> Discord Embedded App SDK OAuth2 code-to-token exchange (`vendor/discord-auth.js`)
      // 1b. Per-user settings and accounts (`/auth/discord`, `/me`, `/state/:doc`)
      const webRes = await handleWebAuth(req, env, { path, ip: req.headers.get("CF-Connecting-IP") || "127.0.0.1", now: Date.now() });
      if (webRes) {
        for (const [k, v] of Object.entries(cors)) if (!webRes.headers.has(k)) webRes.headers.set(k, v);
        return webRes;
      }
      const charsRes = await handleCharacters(req, env, { path, now: Date.now() });
      if (charsRes) {
        for (const [k, v] of Object.entries(cors)) if (!charsRes.headers.has(k)) charsRes.headers.set(k, v);
        return charsRes;
      }
      const rightsRes = await handleDataRights(req, env, { path, now: Date.now() });
      if (rightsRes) {
        for (const [k, v] of Object.entries(cors)) if (!rightsRes.headers.has(k)) rightsRes.headers.set(k, v);
        return rightsRes;
      }
      const accountRes = await handleAccount(req, env, {
        path,
        ip: req.headers.get("CF-Connecting-IP") || "127.0.0.1",
        now: Date.now(),
      });
      if (accountRes) {
        const [status, body, extra] = accountRes;
        return jsonResp(body, status, { ...cors, ...extra, "Cache-Control": "no-store" });
      }

      if (req.method === "POST" && path === "/token") {
        let body = {};
        try {
          body = await req.json();
        } catch {}
        const code = typeof body?.code === "string" ? body.code.trim() : "";
        if (!code || code.length > 512) {
          return jsonResp({ error: "Invalid authorization code" }, 400, cors);
        }
        const clientId = env.DISCORD_CLIENT_ID || "1561857940174938114";
        const clientSecret = env.DISCORD_CLIENT_SECRET || "";
        if (!clientSecret) {
          return jsonResp({ error: "Discord client secret not configured" }, 503, cors);
        }
        const params = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
        });
        const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (!tokenRes.ok) {
          return jsonResp({ error: "Token exchange failed" }, 502, cors);
        }
        const tokenJson = await tokenRes.json().catch(() => null);
        if (!tokenJson || typeof tokenJson.access_token !== "string") {
          return jsonResp({ error: "Invalid token response" }, 502, cors);
        }
        return jsonResp({ access_token: tokenJson.access_token }, 200, cors);
      }

      // 1b. POST /signups -> External Discord Bot sync for `#wow-forever` Sign-ups card
      if (req.method === "POST" && path === "/signups") {
        const auth = await resolveMemberAuth(req, url, env);
        if (!auth.ok) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const body = await req.json();
        const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
        const doc = row ? JSON.parse(row.json) : { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] };
        if (Array.isArray(body.entries)) {
          doc.entries = body.entries;
        } else if (body.name) {
          doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
          let entry = doc.entries.find((e) => (e.name || "").toLowerCase() === String(body.name).toLowerCase());
          if (!entry) {
            entry = { name: body.name };
            doc.entries.push(entry);
          }
          for (const k of ["pack", "meet", "meet_other", "rsvp", "when"]) {
            if (body[k] !== undefined) entry[k] = body[k];
          }
        }
        await recomputeSignupTallies(doc);
        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
          .bind(JSON.stringify(doc), doc.updated)
          .run();
        await purgeWorkerCache(url.origin, ["/api/bootstrap", "/api/data/signups.json"]);
        await broadcastToRoom(env, { type: "data", key: "signups" });
        return jsonResp({ ok: true, signups: doc }, 200, cors);
      }

      // 1c. GET /ask -> Returns latest Q&A turn for `js/brain.js` (`askRead()`)
      if (req.method === "GET" && path === "/ask") {
        const isPrPreview = isPrPreviewEnv(env);
        const auth = await resolveMemberAuth(req, url, env);
        const askId = url.searchParams.get("id");

        let row = null;
        if (askId) {
          row = await env.DB.prepare("SELECT * FROM ask_turns WHERE id = ?").bind(askId).first();
        } else if (auth.ok && auth.member) {
          row = await env.DB.prepare(
            "SELECT * FROM ask_turns WHERE by_name = ? OR by_name = ? OR share = 1 ORDER BY created_at DESC LIMIT 1"
          ).bind(auth.member.name, auth.member.slug).first();
        } else {
          row = await env.DB.prepare(
            "SELECT * FROM ask_turns WHERE share = 1 OR by_name = 'Visitor' ORDER BY created_at DESC LIMIT 1"
          ).first();
        }

        let limitLeft = 6;
        if (!auth.ok) {
          const missingSalt = saltProblems(env, ["USER_SALT"]);
          if (missingSalt.length) return jsonResp(saltErrorBody(missingSalt), 503, cors);
          const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
          const ipHash = await guestIpKey(clientIp, env.USER_SALT);
          const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
          const countRow = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?"
          ).bind(ipHash, oneHourAgo).first();
          const used = countRow ? Number(countRow.count) || 0 : 0;
          limitLeft = Math.max(0, 2 - used);
        }

        if (!row) {
          return jsonResp({ ask: null, limit: { left: limitLeft }, isPrPreview, aiProvider: auth.ok ? resolveAiProvider(env) : "workers-ai" }, 200, cors);
        }
        const status =
          row.status === "thinking" || row.status === "pending"
            ? "queued"
            : row.status === "answered"
            ? "answered"
            : "failed";
        const [provider, model] = isPrPreview
          ? ["workers-ai", row.model || "workers-ai"]
          : String(row.model || "").includes(":")
            ? String(row.model).split(/:(.+)/)
            : [resolveAiProvider(env), row.model || null];
        let sources = [];
        try {
          sources = JSON.parse(row.cites_json || "[]");
        } catch {}
        const numericId = Number(String(row.id).replace(/\D/g, "").slice(0, 13)) || Date.now();
        return jsonResp(
          {
            ask: {
              id: numericId,
              status,
              text: row.question,
              answer: webBoardLinks(row.answer) || null,
              sources,
              provider,
              model,
              at: row.answered_at || row.created_at,
              answeredAt: row.answered_at || null,
            },
            limit: { left: 6 },
            isPrPreview,
            aiProvider: resolveAiProvider(env),
          },
          200,
          cors
        );
      }

      // 1d. GET /wiki/snapshots & GET /wiki/proposals -> D1-backed source snapshots & AI fact proposals
      if (req.method === "GET" && path === "/wiki/snapshots") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          "SELECT id, source_id, url, sha8, substr(body_text, 1, 600) AS preview, fetched_at FROM lib_source_snapshots ORDER BY fetched_at DESC LIMIT 25"
        ).all();
        return jsonResp({ snapshots: results || [] }, 200, cors);
      }

      if (req.method === "GET" && path === "/wiki/proposals") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          "SELECT * FROM wiki_proposals ORDER BY created_at DESC LIMIT 50"
        ).all();
        return jsonResp({ proposals: results || [] }, 200, cors);
      }

      // 1e. PUT /wiki/page -> Direct D1 wiki page authoring/editing (replaces editing markdown in `wow-mage`)
      if (req.method === "PUT" && path === "/wiki/page") {
        const denied = adminGate(req, url, env, cors);
        if (denied) return denied;
        const body = await req.json();
        const pageId = String(body.id || "").trim();
        const category = String(body.category || pageId.split("/")[0] || "").trim();
        const title = String(body.title || pageId.split("/").pop() || "").trim();
        if (!pageId || !category || !title) {
          return jsonResp({ error: "Missing page id, category, or title" }, 400, cors);
        }
        const now = new Date().toISOString();
        const today = now.slice(0, 10);
        await env.DB.prepare(
          `INSERT INTO lib_pages (id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json, related_json, history_json, snapshots_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             category = excluded.category,
             title = excluded.title,
             confidence = excluded.confidence,
             status = excluded.status,
             as_of = excluded.as_of,
             checked = excluded.checked,
             recheck_days = excluded.recheck_days,
             blurb = excluded.blurb,
             aliases_json = excluded.aliases_json,
             facts_json = excluded.facts_json,
             open_json = excluded.open_json,
             related_json = excluded.related_json,
             history_json = excluded.history_json,
             snapshots_json = excluded.snapshots_json,
             updated_at = excluded.updated_at`
        )
          .bind(
            pageId,
            category,
            title,
            body.confidence || "confirmed",
            body.status || "current",
            body.as_of || today,
            body.checked || today,
            Number(body.recheck_days) || 3,
            body.blurb || "",
            JSON.stringify(Array.isArray(body.aliases) ? body.aliases : []),
            JSON.stringify(Array.isArray(body.facts) ? body.facts : []),
            JSON.stringify(Array.isArray(body.open) ? body.open : []),
            JSON.stringify(Array.isArray(body.related) ? body.related : []),
            JSON.stringify(Array.isArray(body.history) ? body.history : []),
            JSON.stringify(Array.isArray(body.snapshots) ? body.snapshots : []),
            now
          )
          .run();

        await recomputeCategoryAndIndex(env, category, {
          date: today,
          page: pageId,
          text: `${title} updated in D1`,
        });
        await purgeWorkerCache(url.origin, [
          "/api/library/index.json",
          "/api/library/search.json",
          "/api/library/open.json",
          `/api/library/${category}.json`,
        ]);
        await broadcastToRoom(env, { type: "library", categories: [category], page: pageId });
        return jsonResp({ ok: true, id: pageId, category, updated_at: now }, 200, cors);
      }

      // 2. GET /bootstrap -> Single-roundtrip Edge-cached startup bundle
      if (req.method === "GET" && path === "/bootstrap") {
        let resp = await getCachedResponse(url.origin, "/api/bootstrap");
        if (!resp) {
          const [{ results }, { party: partySheets }] = await Promise.all([
            env.DB.prepare(
              "SELECT key, json FROM kv_state WHERE key IN ('party','timeline','stats','signups','tonight','launch','marks','decide')"
            ).all(),
            buildPartySheetsFromD1(env),
          ]);
          const isPrPreview = isPrPreviewEnv(env);
          const providers = {};
          for (const k of Object.keys(AI_PROVIDER_LABELS)) {
            providers[k] = isProviderConfigured(env, k);
          }
          const bundle = {
            aiProvider: resolveAiProvider(env),
            isPrPreview,
            providers,
            partySheets,
          };
          for (const row of results || []) {
            try {
              bundle[row.key] = JSON.parse(row.json);
            } catch {
              bundle[row.key] = null;
            }
          }
          resp = jsonResp(webBoardLinksDeep(bundle), 200, {
            ...cors,
            "Cache-Control": "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
          });
          setCachedResponse(ctx, url.origin, "/api/bootstrap", resp, 60000);
        } else {
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          resp = new Response(resp.body, { status: resp.status, headers });
        }
        return resp;
      }

      // 3. GET /library/:name -> Edge-cached library JSON blob from D1 `lib_blobs`
      if (req.method === "GET" && path.startsWith("/library/")) {
        const name = decodeURIComponent(path.slice("/library/".length));
        let resp = await getCachedResponse(url.origin, `/api/library/${name}`);
        if (!resp) {
          const row = await env.DB.prepare("SELECT json, stamp FROM lib_blobs WHERE name = ?")
            .bind(name)
            .first();
          if (!row) return jsonResp({ error: `Library blob ${name} not found` }, 404, cors);
          const ttl = name === "index.json" || name === "refresh.json" || name === "news.json" ? 30 : 3600;
          resp = jsonResp(row.json, 200, {
            ...cors,
            ETag: `"${row.stamp}"`,
            "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl * 4}, stale-while-revalidate=600`,
          });
          setCachedResponse(ctx, url.origin, `/api/library/${name}`, resp, ttl * 1000);
        } else {
          const headers = new Headers(resp.headers);
          for (const [k, v] of Object.entries(cors)) headers.set(k, v);
          resp = new Response(resp.body, { status: resp.status, headers });
        }
        return resp;
      }

      // 4. GET or PUT /data/:name or GET /atlas/:name -> Single document in D1 `kv_state`
      if (path.startsWith("/data/") || path.startsWith("/atlas/")) {
        const raw = decodeURIComponent(path.split("/").pop() || "").replace(/\.json$/, "");
        const cachePath = `/api${path.startsWith("/") ? path : `/${path}`}`;
        if (req.method === "GET") {
          // Config and private working rows live in the same table: serve only documents the public site fetches
          // (allow list in public-docs.js), and keep the private-key guard as a second check.
          const allowed = path.startsWith("/atlas/") ? isPublicAtlasDoc(raw) : isPublicDataDoc(raw);
          if (!allowed || isPrivateKvKey(raw)) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
          let resp = await getCachedResponse(url.origin, cachePath);
          if (!resp) {
            // D1_FEED (default off): stats is computed from D1 and cached 5 minutes; null means serve the stored row as before.
            const fed = path.startsWith("/data/") && feedEnabled(env) ? await serveFeedDoc(env, raw) : null;
            const row = fed || (await env.DB.prepare("SELECT json, updated_at FROM kv_state WHERE key = ?").bind(raw).first());
            if (!row) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
            const etag = `"${raw}-${row.updated_at || '1'}"`;
            let docJson = row.json;
            if (typeof docJson === "string" && docJson.includes("{board:")) {
              try {
                docJson = JSON.stringify(webBoardLinksDeep(JSON.parse(docJson)));
              } catch {}
            }
            resp = jsonResp(docJson, 200, {
              ...cors,
              ETag: etag,
              "Cache-Control": "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
            });
            setCachedResponse(ctx, url.origin, cachePath, resp, 60000);
          } else {
            const headers = new Headers(resp.headers);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            resp = new Response(resp.body, { status: resp.status, headers });
          }
          return resp;
        }
        if (req.method === "PUT") {
          const denied = adminGate(req, url, env, cors);
          if (denied) return denied;
          const body = await req.json();
          const now = new Date().toISOString();
          await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
            .bind(raw, JSON.stringify(body), now)
            .run();
          await purgeWorkerCache(url.origin, ["/api/bootstrap", `/api/data/${raw}.json`]);
          await broadcastToRoom(env, { type: "data", key: raw, data: body });
          return jsonResp({ ok: true, key: raw, updated_at: now }, 200, cors);
        }
      }

      // 5. POST /refresh or POST /intent -> Ask Leeroy, Signups (flat & nested), Journey, Launch, Fact Fix, or Refresh
      if (req.method === "POST" && (path === "/intent" || path === "/refresh")) {
        const auth = await resolveMemberAuth(req, url, env);
        let body = {};
        try {
          body = (await req.json()) || {};
        } catch {}
        const kind = path === "/refresh" ? "refresh" : String(body.kind || "");

        // If not authenticated, ONLY allow public guest asking
        if (!auth.ok) {
          if (kind !== "ask") {
            return jsonResp({ error: "Unauthorized board key" }, 401, cors);
          }
        }

        const member = auth.member || null;
        const by = member ? (member.name || member.slug) : "Visitor";
        const memberSlug = member ? member.slug : "guest";
        const now = new Date().toISOString();
        const numericIntentId = Date.now();
        const intentId = String(numericIntentId);

        // 5a. `signup` (nested `{ kind: "signup", patch: { rsvp } }` or flat `{ kind: "signup", field, value, place }`)
        if (kind === "signup") {
          const patch =
            body.patch && typeof body.patch === "object"
              ? { ...body.patch }
              : body.field
              ? {
                  [body.field]:
                    body.field === "meet" && body.value === "vos"
                      ? "Valley of Strength"
                      : body.field === "meet" && body.value === "xroads"
                      ? "The Crossroads"
                      : body.value,
                  ...(body.place ? { meet_other: body.place } : {}),
                }
              : {};

          const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
          const doc = row
            ? JSON.parse(row.json)
            : { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [] };
          doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
          let entry = doc.entries.find(
            (e) =>
              (e.slug && e.slug === member.slug) ||
              (e.name || "").toLowerCase() === member.name.toLowerCase()
          );
          if (!entry) {
            entry = { slug: member.slug, name: member.name };
            doc.entries.push(entry);
          }
          for (const [k, v] of Object.entries(patch)) {
            entry[k] = v;
          }
          entry.updated = now;
          await recomputeSignupTallies(doc);
          await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
            .bind(JSON.stringify(doc), now)
            .run();
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "signup",
            body: { patch, entry },
            ver: 1,
            at: now,
          });
          await purgeWorkerCache(url.origin, ["/api/bootstrap", "/api/data/signups.json", "/api/signups"]);
          await broadcastToRoom(env, { type: "data", key: "signups", data: doc });
          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }

        // 5b. `journey` (`{ kind: "journey", patch: { journey } }`)
        if (kind === "journey") {
          const jVal = body.patch && body.patch.journey;
          if (["guided", "curious", "everything"].includes(jVal)) {
            const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
            if (row) {
              const doc = JSON.parse(row.json);
              doc.journeys = Array.isArray(doc.journeys) ? doc.journeys : [];
              const jEntry = doc.journeys.find((j) => j.slug === member.slug);
              if (jEntry) jEntry.journey = jVal;
              else doc.journeys.push({ slug: member.slug, name: member.name, journey: jVal });
              await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
                .bind(JSON.stringify(doc), now)
                .run();
            }
          }
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "journey",
            body: { journey: jVal },
            ver: 1,
            at: now,
          });
          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }

        // 5c. `launch` (`{ kind: "launch", patch: { state: "queue"|"in"|"done" } }`)
        if (kind === "launch") {
          const lState = body.patch && body.patch.state;
          if (["queue", "in", "done"].includes(lState)) {
            const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'launch'").first();
            let rows = [];
            if (row) {
              try {
                const parsed = JSON.parse(row.json);
                rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
              } catch {}
            }
            const idx = rows.findIndex((r) => r.slug === member.slug);
            const item = { slug: member.slug, name: member.name, state: lState, at: now };
            if (idx >= 0) rows[idx] = item;
            else rows.push(item);
            await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('launch', ?, ?)")
              .bind(JSON.stringify(rows), now)
              .run();
            await recordSheetEventInD1(env, url.origin, {
              slug: member.slug,
              name: member.name,
              field: "launch_state",
              value: lState,
              visible: true,
              source: "board",
              at: now,
            });
            await purgeWorkerCache(url.origin, ["/api/bootstrap", "/api/data/launch.json"]);
            await broadcastToRoom(env, { type: "data", key: "launch", data: rows });
          }
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "launch",
            body: { state: lState },
            ver: 1,
            at: now,
          });
          return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
        }

        // 5d. `ask` (`{ kind: "ask", patch: { text, share, provider } }`)
        if (kind === "ask") {
          const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
          const question = String(patch.text || body.q || body.text || "").trim();
          const isGuest = !auth.ok;
          const isPrPreview = isPrPreviewEnv(env);

          // For public guests, strictly enforce Cloudflare Workers AI and no Discord broadcast
          const requestedProvider = isGuest || isPrPreview ? "workers-ai" : (patch.provider || body.provider || env.AI_PROVIDER);
          const activeProvider = isGuest || isPrPreview ? "workers-ai" : resolveAiProvider(env, requestedProvider);
          const share = isGuest ? false : (patch.share !== undefined ? Boolean(patch.share) : true);
          const askBy = isGuest ? "Visitor" : by;
          const askSlug = isGuest ? "guest" : memberSlug;

          if (!question) return jsonResp({ error: "Missing question" }, 400, cors);

          // Rate limit check for public guests: 2 questions per hour per IP
          let guestLeft = 6;
          let guestHash = "";
          if (isGuest) {
            const missingSalt = saltProblems(env, ["USER_SALT"]);
            if (missingSalt.length) return jsonResp(saltErrorBody(missingSalt), 503, cors);
            const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
            const ipHash = await guestIpKey(clientIp, env.USER_SALT);
            guestHash = ipHash;
            const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

            const limitRow = await env.DB.prepare(
              "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM guest_rate_limits WHERE ip_hash = ? AND created_at > ?"
            )
              .bind(ipHash, oneHourAgo)
              .first();

            const guestCount = limitRow ? Number(limitRow.count) || 0 : 0;
            if (guestCount >= 2) {
              const oldestTime = limitRow && limitRow.oldest ? Date.parse(limitRow.oldest) : Date.now();
              const retryAfterSec = Math.max(1, Math.ceil((oldestTime + 3600 * 1000 - Date.now()) / 1000));
              return jsonResp(
                {
                  ok: false,
                  why: "limited",
                  error: "Public guest access is limited to 2 questions per hour.",
                  retryAfter: retryAfterSec,
                  left: 0,
                },
                429,
                cors
              );
            }

            // Record this guest question for rate limiting
            await env.DB.prepare(
              "INSERT INTO guest_rate_limits (ip_hash, created_at) VALUES (?, ?)"
            )
              .bind(ipHash, now)
              .run();

            // Asynchronously prune expired entries older than 2 hours
            ctx.waitUntil(
              env.DB.prepare("DELETE FROM guest_rate_limits WHERE created_at < ?")
                .bind(new Date(Date.now() - 7200 * 1000).toISOString())
                .run()
                .catch(() => {})
            );

            guestLeft = Math.max(0, 2 - guestCount - 1);
          }

          await env.DB.prepare(
            "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, ?, 'thinking', ?, ?)"
          )
            .bind(intentId, askBy, question, activeProvider, share ? 1 : 0, now)
            .run();

          const { seq } = await insertIntent(env, {
            slug: askSlug,
            kind: "ask",
            body: { question, by: askBy, provider: activeProvider, share },
            ver: 1,
            at: now,
          });

          const intentItem = {
            id: seq,
            kind: "ask",
            by: askBy,
            slug: askSlug,
            q: question,
            provider: activeProvider,
            status: "thinking",
            at: now,
          };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          const askBudget = askBudgetKeys({ userPart: isGuest ? guestHash : await hashId(memberSlug), guest: isGuest });
          ctx.waitUntil(
            answerWithAi({
              env,
              origin: url.origin,
              intentId,
              by: askBy,
              memberSlug: askSlug,
              question,
              deep: Boolean(body.deep || patch.deep),
              share,
              provider: activeProvider,
              budget: askBudget,
              isMember: !isGuest,
            })
          );

          return jsonResp(
            {
              ok: true,
              id: seq,
              seq,
              status: "thinking",
              provider: activeProvider,
              at: now,
              left: isGuest ? guestLeft : 5,
              ask: { id: intentId, question, by: askBy, status: "thinking", model: activeProvider, at: now },
            },
            200,
            cors
          );
        }

        // 5e. `fix` (flat `{ kind: "fix", page, key, note }` or nested `{ kind: "fix", patch: { page, key, note } }`)
        if (kind === "fix") {
          const src = body.patch && typeof body.patch === "object" ? body.patch : body;
          const pageId = String(src.page || "").trim();
          const factKey = String(src.fact || src.key || "").trim();
          const newVal = String(src.val || src.text || src.note || "").trim();
          const note = String(src.note || "").trim();
          if (!pageId || !factKey || !newVal) {
            return jsonResp({ error: "Missing page, fact, or val" }, 400, cors);
          }

          const pageRow = await env.DB.prepare("SELECT * FROM lib_pages WHERE id = ?").bind(pageId).first();
          if (!pageRow) return jsonResp({ error: `Page ${pageId} not found` }, 404, cors);

          const facts = JSON.parse(pageRow.facts_json || "[]");
          const history = JSON.parse(pageRow.history_json || "[]");
          const existing = facts.find((f) => f.key === factKey);
          const oldVal = existing ? existing.value : null;

          if (existing) {
            existing.value = newVal;
          } else {
            facts.push({ key: factKey, value: newVal, refs: [] });
          }
          history.unshift({
            date: now.slice(0, 10),
            text: `${factKey} updated by ${member.name}${note ? ` (${note})` : ""}`,
          });

          await env.DB.batch([
            env.DB.prepare(
              "UPDATE lib_pages SET facts_json = ?, history_json = ?, checked = ?, updated_at = ? WHERE id = ?"
            ).bind(JSON.stringify(facts), JSON.stringify(history), now.slice(0, 10), now, pageId),
            env.DB.prepare(
              "INSERT INTO fact_fixes (id, page_id, fact_key, old_value, new_value, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(intentId, pageId, factKey, oldVal, newVal, note, member.name, now),
          ]);

          await recomputeCategoryAndIndex(env, pageRow.category, {
            date: now.slice(0, 10),
            page: pageId,
            text: `${factKey}: ${newVal}`,
          });
          await purgeWorkerCache(url.origin, [
            "/api/library/index.json",
            "/api/library/search.json",
            "/api/library/open.json",
            `/api/library/${pageRow.category}.json`,
          ]);

          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "fix",
            body: { pageId, factKey, oldVal, newVal, note, by: member.name },
            ver: 1,
            at: now,
          });

          const intentItem = {
            id: seq,
            kind: "fix",
            by: member.name,
            page: pageId,
            fact: factKey,
            status: "applied",
            at: now,
          };
          await broadcastToRoom(env, {
            type: "library",
            categories: [pageRow.category],
            page: pageId,
            intent: intentItem,
          });

          return jsonResp({ ok: true, id: seq, seq, status: "applied" }, 200, cors);
        }

        // 5f. `refresh` (`POST /api/refresh` or `POST /api/intent { kind: "refresh" }`)
        if (kind === "refresh") {
          const { seq } = await insertIntent(env, {
            slug: member.slug,
            kind: "refresh",
            body: { triggeredBy: member.name },
            ver: 1,
            at: now,
          });

          const intentItem = { id: seq, kind: "refresh", by: member.name, status: "running", at: now };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          ctx.waitUntil(
            runScheduledSourceSweep(env, url.origin, { triggeredBy: member.name, intentId })
          );
          return jsonResp({ ok: true, queued: true, id: seq, seq, status: "running", at: now }, 200, cors);
        }

        return jsonResp({ error: `Unsupported intent kind: ${kind}` }, 400, cors);
      }

      // 6. Health check
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        const body = {
          ok: true,
          service: "leeroy-brain",
          runtime: "cloudflare-workers-d1",
          isPrPreview: isPrPreviewEnv(env),
          at: new Date().toISOString(),
        };
        // Provider detail is for the admin token only; a request without it gets the minimal body, not a 401.
        const healthKey = extractKey(req);
        if (env.BOARD_ADMIN_TOKEN && healthKey && timingSafeEqualStr(healthKey, env.BOARD_ADMIN_TOKEN)) {
          const providers = {};
          for (const k of Object.keys(AI_PROVIDER_LABELS)) {
            providers[k] = isProviderConfigured(env, k);
          }
          body.aiProvider = resolveAiProvider(env);
          body.aiGateway = env.AI_GATEWAY_ID || null;
          body.providers = providers;
          body.saltsMissing = saltProblems(env); // names only; a non-empty list means member keys or guest asks are refused
          const budget = await loadBudget(env);
          body.aiBudget = { day: utcDayKey(), neurons: budget.neurons, cap: dailyCap(env), asks: budget.asks, cron: budget.cron };
        }
        return jsonResp(body, 200, cors);
      }

      return jsonResp({ error: "Not found", path }, 404, cors);
    } catch (err) {
      console.error("Worker error:", err, String((err && err.message) || err));
      return jsonResp({ error: "Internal error" }, 500, cors);
    }
  },

  async scheduled(controller, env, ctx) {
    // The every-minute trigger runs only the timed posts; every other trigger is the source sweep. Timed posts are off until MOMENTS_ENABLED.
    if (controller && controller.cron === MOMENTS_CRON) {
      ctx.waitUntil(
        runMoments(env, { loadSchedule: () => loadConfigKey(env, "moments") }).catch((err) => console.error("moments run failed:", String((err && err.message) || err)))
      );
      return;
    }
    const origin = env.API_ORIGIN || "https://api.leeroy.party";
    ctx.waitUntil(runScheduledSourceSweep(env, origin));
    ctx.waitUntil(cleanupAnswerUx(env));
  },
};
