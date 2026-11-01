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
import { answerWithAi, resolveAiProvider, isProviderConfigured, AI_PROVIDER_LABELS } from "./ai-models.js";
import { runScheduledSourceSweep, recomputeCategoryAndIndex } from "./scraper.js";
import { handleDiscordInteraction, recomputeSignupTallies, DISCORD_SLASH_COMMANDS_MANIFEST } from "./discord.js";

export { BoardRoom };

const PARTY_MEMBERS = [
  { slug: "santa", name: "Santa", race: "tauren", class: "druid", spec_path: "feral-tank", professions: ["leatherworking", "skinning"], plan_zone: "mulgore" },
  { slug: "bible-boi", name: "Bible Boi", race: "undead", class: "priest", spec_path: "discipline", professions: ["mining", "engineering"], plan_zone: "tirisfal-glades" },
  { slug: "street-rat", name: "Street Rat", race: "undead", class: "paladin", spec_path: "retribution", spec_at_40: "holy", professions: ["blacksmithing", "mining"], plan_zone: "tirisfal-glades" },
  { slug: "bloise", name: "Bloise", race: "undead", class: "mage", spec_path: "frost", spec_at_40: "fire", professions: ["tailoring", "enchanting"], plan_zone: "tirisfal-glades" },
  { slug: "handsome-squidward", name: "Handsome Squidward", race: "troll", class: "warlock", spec_path: "demonology", professions: ["enchanting", "tailoring"], plan_zone: "durotar" },
];

const SHEET_FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "level", "launch_state", "plan_zone", "goals"];

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "*";
  const allowed = !env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS === "*" ? "*" : origin;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Board-Key, Cache-Control, Pragma",
    "Access-Control-Max-Age": "86400",
  };
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

function extractKey(req, url) {
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (auth.startsWith("Board ")) return auth.slice(6).trim();
  const h = req.headers.get("X-Board-Key");
  if (h) return h.trim();
  return (url.searchParams.get("k") || "").trim();
}

function resolveMember(req, url) {
  const k = extractKey(req, url).toLowerCase();
  for (const m of PARTY_MEMBERS) {
    if (k.startsWith(m.slug) || k.includes(m.slug.replace(/-/g, ""))) return m;
  }
  return PARTY_MEMBERS[3]; // Default to Bloise for general valid board keys
}

function isAuthorized(req, url, env) {
  const k = extractKey(req, url);
  if (!env.BOARD_ADMIN_TOKEN) return true;
  if (k && k === env.BOARD_ADMIN_TOKEN) return true;
  return /^[A-Za-z0-9_-]{22,64}$/.test(k);
}

export async function purgeWorkerCache(origin, paths) {
  const cache = caches.default;
  await Promise.all(
    paths.map((p) => cache.delete(new Request(`${origin}${p}`, { method: "GET" })).catch(() => false))
  );
}

export async function broadcastToRoom(env, payload) {
  try {
    const id = env.BOARD_ROOM.idFromName("global");
    const stub = env.BOARD_ROOM.get(id);
    await stub.fetch("https://room.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Failed to broadcast to BoardRoom:", err);
  }
}

export async function buildPartySheetsFromD1(env) {
  const now = new Date().toISOString();
  const bySlug = new Map();

  for (const m of PARTY_MEMBERS) {
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
  return { party, seq: Date.now() };
}

export async function recordSheetEventInD1(env, origin, { slug, name, field, value, visible = true, source = "board", at }) {
  const now = at || new Date().toISOString();
  const valJson = value === undefined || value === null ? null : JSON.stringify(value);
  await env.DB.prepare(
    "INSERT INTO sheet_events (slug, name, field, value_json, visible, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(slug, name, field, valJson, visible ? 1 : 0, source, now)
    .run();

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
        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'party'")
          .bind(JSON.stringify(partyDoc), now)
          .run();
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/party.json"]);
      }
    }
  } catch {}

  const { party } = await buildPartySheetsFromD1(env);
  await broadcastToRoom(env, { type: "state", party });
  return { party, at: now };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);

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
        return jsonResp({ commands: DISCORD_SLASH_COMMANDS_MANIFEST }, 200, cors);
      }

      // 0b. GET /me -> Resolves board key to party member identity for `js/brain.js`
      if (req.method === "GET" && path === "/me") {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = resolveMember(req, url);
        return jsonResp({ slug: m.slug, name: m.name, pending: [] }, 200, cors);
      }

      // 0c. POST /probe -> Capability probe from `js/brain.js`
      if (req.method === "POST" && path === "/probe") {
        return jsonResp({ ok: true, at: new Date().toISOString() }, 200, cors);
      }

      // 0d. GET /sheet & POST /sheet & PUT /vocab & POST /dispatch -> Party Sheet & Chamber Dispatches (`wow-mage` Phase 0 parity)
      if (path === "/sheet") {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = resolveMember(req, url);
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
          const seq = Date.now();
          return jsonResp({ ok: true, id: seq, seq, at: now, field, value, visible }, 200, cors);
        }
      }

      if (req.method === "PUT" && path === "/vocab") {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized" }, 401, cors);
        }
        const body = await req.json();
        const vocab = (body && body.vocab) || {};
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('vocab', ?, ?)")
          .bind(JSON.stringify(vocab), now)
          .run();
        return jsonResp({ ok: true, fields: Object.keys(vocab).length }, 200, cors);
      }

      if (req.method === "POST" && path === "/dispatch") {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const m = resolveMember(req, url);
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
              content: `📜 **${m.name}** shared ${ids.length} library note${ids.length === 1 ? "" : "s"} from the Leeroy Chamber with the party.`,
            }),
          }).catch(() => {});
        }
        return jsonResp({ ok: true, id: seq, seq, at: now }, 200, cors);
      }

      // 1. WebSocket / Live State -> Durable Object (`BoardRoom`) + D1 state
      if (path === "/live" || path === "/state") {
        if (path === "/state" && req.method === "GET") {
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
          return jsonResp(
            {
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
            },
            200,
            cors
          );
        }
        const id = env.BOARD_ROOM.idFromName("global");
        const stub = env.BOARD_ROOM.get(id);
        const doResp = await stub.fetch(req);
        if (doResp.status === 101) return doResp; // WebSocket Upgrade
        const headers = new Headers(doResp.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(doResp.body, { status: doResp.status, headers });
      }

      // 1b. POST /signups -> External Discord Bot sync for `#wow-forever` Sign-ups card
      if (req.method === "POST" && path === "/signups") {
        if (!isAuthorized(req, url, env)) {
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
        const row = await env.DB.prepare(
          "SELECT * FROM ask_turns ORDER BY created_at DESC LIMIT 1"
        ).first();
        if (!row) {
          return jsonResp({ ask: null, limit: { left: 6 }, aiProvider: resolveAiProvider(env) }, 200, cors);
        }
        const status =
          row.status === "thinking" || row.status === "pending"
            ? "queued"
            : row.status === "answered"
            ? "answered"
            : "failed";
        const [provider, model] = String(row.model || "").includes(":")
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
              answer: row.answer || null,
              sources,
              provider,
              model,
              at: row.answered_at || row.created_at,
              answeredAt: row.answered_at || null,
            },
            limit: { left: 6 },
            aiProvider: resolveAiProvider(env),
          },
          200,
          cors
        );
      }

      // 1d. GET /wiki/snapshots & GET /wiki/proposals -> D1-backed source snapshots & AI fact proposals
      if (req.method === "GET" && path === "/wiki/snapshots") {
        const { results } = await env.DB.prepare(
          "SELECT id, source_id, url, sha8, substr(body_text, 1, 600) AS preview, fetched_at FROM lib_source_snapshots ORDER BY fetched_at DESC LIMIT 25"
        ).all();
        return jsonResp({ snapshots: results || [] }, 200, cors);
      }

      if (req.method === "GET" && path === "/wiki/proposals") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM wiki_proposals ORDER BY created_at DESC LIMIT 50"
        ).all();
        return jsonResp({ proposals: results || [] }, 200, cors);
      }

      // 1e. PUT /wiki/page -> Direct D1 wiki page authoring/editing (replaces editing markdown in `wow-mage`)
      if (req.method === "PUT" && path === "/wiki/page") {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
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
        const cache = caches.default;
        const cacheKey = new Request(`${url.origin}/api/bootstrap`, { method: "GET" });
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const [{ results }, { party: partySheets }] = await Promise.all([
            env.DB.prepare(
              "SELECT key, json FROM kv_state WHERE key IN ('party','timeline','stats','signups','tonight','launch','marks','decide')"
            ).all(),
            buildPartySheetsFromD1(env),
          ]);
          const bundle = { aiProvider: resolveAiProvider(env), partySheets };
          for (const row of results || []) {
            try {
              bundle[row.key] = JSON.parse(row.json);
            } catch {
              bundle[row.key] = null;
            }
          }
          resp = jsonResp(bundle, 200, {
            ...cors,
            "Cache-Control": "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
          });
          ctx.waitUntil(cache.put(cacheKey, resp.clone()));
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
        const cache = caches.default;
        const cacheKey = new Request(`${url.origin}/api/library/${name}`, { method: "GET" });
        let resp = await cache.match(cacheKey);
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
          ctx.waitUntil(cache.put(cacheKey, resp.clone()));
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
        if (req.method === "GET") {
          const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(raw).first();
          if (!row) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
          return jsonResp(row.json, 200, {
            ...cors,
            "Cache-Control": "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
          });
        }
        if (req.method === "PUT") {
          if (!isAuthorized(req, url, env)) {
            return jsonResp({ error: "Unauthorized board key" }, 401, cors);
          }
          const body = await req.json();
          const now = new Date().toISOString();
          await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)")
            .bind(raw, JSON.stringify(body), now)
            .run();
          await purgeWorkerCache(url.origin, ["/api/bootstrap", `/api/data/${raw}.json`]);
          await broadcastToRoom(env, { type: "data", key: raw });
          return jsonResp({ ok: true, key: raw, updated_at: now }, 200, cors);
        }
      }

      // 5. POST /refresh or POST /intent -> Ask Leeroy, Signups (flat & nested), Journey, Launch, Fact Fix, or Refresh
      if (req.method === "POST" && (path === "/intent" || path === "/refresh")) {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        let body = {};
        try {
          body = (await req.json()) || {};
        } catch {}
        const kind = path === "/refresh" ? "refresh" : String(body.kind || "");
        const member = resolveMember(req, url);
        const by = String(body.by || member.slug || "party").slice(0, 40);
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
          await purgeWorkerCache(url.origin, ["/api/bootstrap", "/api/data/signups.json"]);
          await broadcastToRoom(env, { type: "data", key: "signups" });
          return jsonResp({ ok: true, id: numericIntentId, seq: numericIntentId, at: now }, 200, cors);
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
          return jsonResp({ ok: true, id: numericIntentId, seq: numericIntentId, at: now }, 200, cors);
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
          }
          return jsonResp({ ok: true, id: numericIntentId, seq: numericIntentId, at: now }, 200, cors);
        }

        // 5d. `ask` (`{ kind: "ask", patch: { text, share, provider } }`)
        if (kind === "ask") {
          const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
          const question = String(patch.text || body.q || body.text || "").trim();
          const share = patch.share !== undefined ? Boolean(patch.share) : true;
          const requestedProvider = patch.provider || body.provider || env.AI_PROVIDER;
          const activeProvider = resolveAiProvider(env, requestedProvider);

          if (!question) return jsonResp({ error: "Missing question" }, 400, cors);

          await env.DB.prepare(
            "INSERT INTO ask_turns (id, by_name, question, model, status, created_at) VALUES (?, ?, ?, ?, 'thinking', ?)"
          )
            .bind(intentId, by, question, activeProvider, now)
            .run();

          const intentItem = {
            id: numericIntentId,
            kind: "ask",
            by,
            q: question,
            provider: activeProvider,
            status: "thinking",
            at: now,
          };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          ctx.waitUntil(
            answerWithAi({
              env,
              origin: url.origin,
              intentId,
              by,
              question,
              deep: Boolean(body.deep || patch.deep),
              share,
              provider: requestedProvider || activeProvider,
            })
          );

          return jsonResp(
            {
              ok: true,
              id: numericIntentId,
              status: "thinking",
              provider: requestedProvider || activeProvider,
              at: now,
              left: 5,
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

          const intentItem = {
            id: numericIntentId,
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

          return jsonResp({ ok: true, id: numericIntentId, seq: numericIntentId, status: "applied" }, 200, cors);
        }

        // 5f. `refresh` (`POST /api/refresh` or `POST /api/intent { kind: "refresh" }`)
        if (kind === "refresh") {
          const intentItem = { id: numericIntentId, kind: "refresh", by: member.name, status: "running", at: now };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          ctx.waitUntil(
            runScheduledSourceSweep(env, url.origin, { triggeredBy: member.name, intentId })
          );
          return jsonResp({ ok: true, queued: true, id: numericIntentId, seq: numericIntentId, status: "running", at: now }, 200, cors);
        }

        return jsonResp({ error: `Unsupported intent kind: ${kind}` }, 400, cors);
      }

      // 6. Health check
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        const providers = {};
        for (const k of Object.keys(AI_PROVIDER_LABELS)) {
          providers[k] = isProviderConfigured(env, k);
        }
        return jsonResp(
          {
            ok: true,
            service: "leeroy-brain",
            runtime: "cloudflare-workers-d1",
            aiProvider: resolveAiProvider(env),
            providers,
          },
          200,
          cors
        );
      }

      return jsonResp({ error: "Not found", path }, 404, cors);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResp({ error: String((err && err.message) || err) }, 500, cors);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSourceSweep(env, "https://leeroy-brain.jmattbloise.workers.dev"));
  },
};
