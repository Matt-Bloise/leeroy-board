// =============================================================================
// Cloudflare Worker Entry Point (`leeroy-brain`)
// Serves Edge-cached D1 state, library blobs, Claude / Gemini Q&A, Fact Fixes,
// Discord HTTP Interactions, and delegates WebSockets + live mutations to `BoardRoom`.
// =============================================================================

import { BoardRoom } from "./room.js";
import { answerWithClaude, resolveAiProvider } from "./claude.js";
import { runScheduledSourceSweep, recomputeCategoryAndIndex } from "./scraper.js";
import { handleDiscordInteraction, recomputeSignupTallies } from "./discord.js";

export { BoardRoom };

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "*";
  const allowed = !env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS === "*" ? "*" : origin;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Board-Key",
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

function isAuthorized(req, url, env) {
  if (!env.BOARD_ADMIN_TOKEN) return true; // If no token secret is set yet, allow writes in dev
  const k = extractKey(req, url);
  return Boolean(k && k === env.BOARD_ADMIN_TOKEN);
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
      // 0. Discord Serverless HTTP Interactions Endpoint (`POST /api/discord`)
      if (req.method === "POST" && path === "/discord") {
        return await handleDiscordInteraction(req, env, ctx, url.origin);
      }

      // 1. WebSocket / Live State / Sheet mutations -> Durable Object (`BoardRoom`)
      if (path === "/live" || path === "/state" || path === "/sheet") {
        if (path === "/sheet" && req.method === "POST" && !isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
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
          ? String(row.model).split(":")
          : [resolveAiProvider(env), row.model || null];
        let sources = [];
        try {
          sources = JSON.parse(row.cites_json || "[]");
        } catch {}
        return jsonResp(
          {
            ask: {
              id: row.id,
              status,
              text: row.question,
              answer: row.answer || null,
              sources,
              provider,
              model,
              at: row.answered_at || row.created_at,
            },
            limit: { left: 6 },
            aiProvider: resolveAiProvider(env),
          },
          200,
          cors
        );
      }

      // 2. GET /bootstrap -> Single-roundtrip Edge-cached startup bundle
      if (req.method === "GET" && path === "/bootstrap") {
        const cache = caches.default;
        const cacheKey = new Request(`${url.origin}/api/bootstrap`, { method: "GET" });
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const { results } = await env.DB.prepare(
            "SELECT key, json FROM kv_state WHERE key IN ('party','timeline','stats','signups','tonight','launch','marks','decide')"
          ).all();
          const bundle = { aiProvider: resolveAiProvider(env) };
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

      // 4. GET /data/:name or GET /atlas/:name -> Single document from D1 `kv_state`
      if (req.method === "GET" && (path.startsWith("/data/") || path.startsWith("/atlas/"))) {
        const raw = decodeURIComponent(path.split("/").pop() || "").replace(/\.json$/, "");
        const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = ?").bind(raw).first();
        if (!row) return jsonResp({ error: `Document ${raw} not found` }, 404, cors);
        return jsonResp(row.json, 200, {
          ...cors,
          "Cache-Control": "public, max-age=15, s-maxage=60, stale-while-revalidate=300",
        });
      }

      // 5. POST /intent -> Ask Leeroy (Claude or Gemini Free Tier), Fact Fix (D1 update), or Refresh Sweep
      if (req.method === "POST" && path === "/intent") {
        if (!isAuthorized(req, url, env)) {
          return jsonResp({ error: "Unauthorized board key" }, 401, cors);
        }
        const body = await req.json();
        const kind = String(body.kind || "");
        const by = String(body.by || "party").slice(0, 40);
        const now = new Date().toISOString();
        const intentId = `int_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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
            id: intentId,
            kind: "ask",
            by,
            q: question,
            provider: activeProvider,
            status: "thinking",
            at: now,
          };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          // Run Claude or Gemini API call asynchronously via waitUntil so POST /intent returns in <15ms
          ctx.waitUntil(
            answerWithClaude({
              env,
              origin: url.origin,
              intentId,
              by,
              question,
              deep: Boolean(body.deep || patch.deep),
              share,
              provider: activeProvider,
            })
          );

          return jsonResp(
            { ok: true, id: intentId, status: "thinking", provider: activeProvider, at: now, left: 5 },
            200,
            cors
          );
        }

        if (kind === "fix") {
          const pageId = String(body.page || "").trim();
          const factKey = String(body.fact || body.key || "").trim();
          const newVal = String(body.val || body.text || body.note || "").trim();
          const note = String(body.note || "").trim();
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
            text: `${factKey} updated by ${by}${note ? ` (${note})` : ""}`,
          });

          await env.DB.batch([
            env.DB.prepare(
              "UPDATE lib_pages SET facts_json = ?, history_json = ?, checked = ?, updated_at = ? WHERE id = ?"
            ).bind(JSON.stringify(facts), JSON.stringify(history), now.slice(0, 10), now, pageId),
            env.DB.prepare(
              "INSERT INTO fact_fixes (id, page_id, fact_key, old_value, new_value, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(intentId, pageId, factKey, oldVal, newVal, note, by, now),
          ]);

          await recomputeCategoryAndIndex(env, pageRow.category, {
            date: now.slice(0, 10),
            page: pageId,
            text: `${factKey}: ${newVal}`,
          });
          await purgeWorkerCache(url.origin, [
            "/api/library/index.json",
            `/api/library/${pageRow.category}.json`,
          ]);

          const intentItem = {
            id: intentId,
            kind: "fix",
            by,
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

          return jsonResp({ ok: true, id: intentId, status: "applied" }, 200, cors);
        }

        if (kind === "refresh") {
          const intentItem = { id: intentId, kind: "refresh", by, status: "running", at: now };
          await broadcastToRoom(env, { type: "intent", item: intentItem });

          ctx.waitUntil(
            runScheduledSourceSweep(env, url.origin, { triggeredBy: by, intentId })
          );
          return jsonResp({ ok: true, id: intentId, status: "running" }, 200, cors);
        }

        return jsonResp({ error: `Unsupported intent kind: ${kind}` }, 400, cors);
      }

      // 6. Health check
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        return jsonResp(
          {
            ok: true,
            service: "leeroy-brain",
            runtime: "cloudflare-workers-d1",
            aiProvider: resolveAiProvider(env),
            providers: {
              claude: Boolean(env.ANTHROPIC_API_KEY),
              gemini: Boolean(env.GEMINI_API_KEY),
            },
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
