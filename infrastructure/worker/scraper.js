// =============================================================================
// 6-Hour Cloudflare Cron Source Sweep, D1 Snapshot Archiver & AI Fact Learner
// (`worker/scraper.js`)
// Replaces `wow-mage/wiki/scripts/source-watch.mjs`, `wiki-ingest.mjs`,
// and `wiki-learn.mjs` entirely inside Cloudflare Workers + D1.
// =============================================================================

import { broadcastToRoom, purgeWorkerCache } from "./index.js";
import { extractWikiFactsWithAi } from "./ai-models.js";
import { factHays, vocabIdf } from "./rank-core.js";

async function sha8Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function stripHtmlToText(rawHtml) {
  return String(rawHtml || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (_, e) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " }[e.toLowerCase()] || " ")
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 24000);
}

export async function recomputeCategoryAndIndex(env, categoryKey, changeEntry = null) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // 1. Rebuild category JSON blob (`${categoryKey}.json`)
  if (categoryKey) {
    const { results: catRows } = await env.DB.prepare(
      "SELECT * FROM lib_pages WHERE category = ? ORDER BY id ASC"
    )
      .bind(categoryKey)
      .all();

    const pages = (catRows || []).map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      confidence: r.confidence,
      status: r.status,
      as_of: r.as_of,
      checked: r.checked,
      recheck_days: r.recheck_days,
      blurb: r.blurb,
      aliases: JSON.parse(r.aliases_json || "[]"),
      facts: JSON.parse(r.facts_json || "[]"),
      open: JSON.parse(r.open_json || "[]"),
      related: JSON.parse(r.related_json || "[]"),
      history: JSON.parse(r.history_json || "[]"),
      snapshots: JSON.parse(r.snapshots_json || "[]"),
    }));

    const catRow = await env.DB.prepare("SELECT json FROM lib_blobs WHERE name = ?")
      .bind(`${categoryKey}.json`)
      .first();
    let existingCat = { key: categoryKey, title: categoryKey, pages: [] };
    if (catRow) {
      try {
        existingCat = JSON.parse(catRow.json);
      } catch {}
    }
    const nextCatJson = JSON.stringify({ ...existingCat, pages });
    const nextCatStamp = await sha8Hex(nextCatJson);

    await env.DB.prepare(
      "INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET stamp = excluded.stamp, json = excluded.json, updated_at = excluded.updated_at"
    )
      .bind(`${categoryKey}.json`, nextCatStamp, nextCatJson, now)
      .run();

    // 1b. Rebuild `search.json` (TF-IDF vocabulary over all facts) and `open.json` directly in D1
    try {
      const { results: allRows } = await env.DB.prepare(
        "SELECT id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json FROM lib_pages ORDER BY id ASC"
      ).all();
      const allPages = (allRows || []).map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        confidence: r.confidence,
        status: r.status,
        as_of: r.as_of,
        checked: r.checked,
        recheck_days: r.recheck_days,
        blurb: r.blurb,
        aliases: JSON.parse(r.aliases_json || "[]"),
        facts: JSON.parse(r.facts_json || "[]"),
        open: JSON.parse(r.open_json || "[]"),
      }));

      const nextSearchJson = JSON.stringify({ generated: now, idf: vocabIdf(factHays(allPages)) });
      const nextSearchStamp = await sha8Hex(nextSearchJson);
      await env.DB.prepare(
        "INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('search.json', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET stamp = excluded.stamp, json = excluded.json, updated_at = excluded.updated_at"
      )
        .bind(nextSearchStamp, nextSearchJson, now)
        .run();

      const openRow = await env.DB.prepare("SELECT json FROM lib_blobs WHERE name = 'open.json'").first();
      let existingOpen = { generated: now, gaps: [], internal_gaps: 0, open: [] };
      if (openRow) {
        try {
          existingOpen = JSON.parse(openRow.json);
        } catch {}
      }
      existingOpen.generated = now;
      existingOpen.open = allPages.flatMap((p) =>
        (Array.isArray(p.open) ? p.open : []).map((t) => ({
          page: p.id,
          text: typeof t === "string" ? t : t && (t.text || t.question || JSON.stringify(t)),
        }))
      );
      const nextOpenJson = JSON.stringify(existingOpen);
      const nextOpenStamp = await sha8Hex(nextOpenJson);
      await env.DB.prepare(
        "INSERT INTO lib_blobs (name, stamp, json, updated_at) VALUES ('open.json', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET stamp = excluded.stamp, json = excluded.json, updated_at = excluded.updated_at"
      )
        .bind(nextOpenStamp, nextOpenJson, now)
        .run();
    } catch (e) {
      console.error("Failed updating search.json / open.json blobs:", e);
    }
  }

  // 2. Update `index.json` stamps, totals, and recent changes
  const idxRow = await env.DB.prepare("SELECT json FROM lib_blobs WHERE name = 'index.json'").first();
  if (idxRow) {
    try {
      const ix = JSON.parse(idxRow.json);
      const { results: blobs } = await env.DB.prepare("SELECT name, stamp FROM lib_blobs").all();
      ix.stamps = ix.stamps || {};
      for (const b of blobs || []) {
        if (b.name !== "index.json") ix.stamps[b.name] = b.stamp;
      }
      ix.generated = now;
      ix.rechecks = (Number(ix.rechecks) || 0) + 1;
      if (changeEntry) {
        ix.changes = [changeEntry, ...(Array.isArray(ix.changes) ? ix.changes : [])].slice(0, 25);
        ix.changes_since = today;
      }
      const nextIdxJson = JSON.stringify(ix);
      const nextIdxStamp = await sha8Hex(nextIdxJson);
      await env.DB.prepare(
        "UPDATE lib_blobs SET stamp = ?, json = ?, updated_at = ? WHERE name = 'index.json'"
      )
        .bind(nextIdxStamp, nextIdxJson, now)
        .run();
    } catch (e) {
      console.error("Failed updating index.json blob:", e);
    }
  }
}

export async function runScheduledSourceSweep(env, origin, opts = {}) {
  const now = new Date().toISOString();
  const { results: sources } = await env.DB.prepare(
    "SELECT * FROM lib_sources ORDER BY checked_at ASC LIMIT 12"
  ).all();

  let checked = 0;
  let changed = 0;
  const touchedCategories = new Set();

  for (const src of sources || []) {
    checked++;
    try {
      const headers = { "User-Agent": "LeeroyBoard-CloudflareWorker/1.0" };
      if (src.etag) headers["If-None-Match"] = src.etag;
      if (src.last_modified) headers["If-Modified-Since"] = src.last_modified;

      const resp = await fetch(src.url, { method: "GET", headers });
      if (resp.status === 304) {
        await env.DB.prepare("UPDATE lib_sources SET checked_at = ?, status = '304' WHERE id = ?")
          .bind(now, src.id)
          .run();
        continue;
      }
      if (!resp.ok) {
        await env.DB.prepare("UPDATE lib_sources SET checked_at = ?, status = ? WHERE id = ?")
          .bind(now, `http_${resp.status}`, src.id)
          .run();
        continue;
      }

      const rawHtml = await resp.text();
      const cleanText = stripHtmlToText(rawHtml);
      const newSha8 = await sha8Hex(cleanText || rawHtml);
      const isFirstSnapshot = !src.sha8;
      const didChange = Boolean(src.sha8 && src.sha8 !== newSha8);
      if (didChange) changed++;

      const sourceUpdateStmts = [
        env.DB.prepare(
          "UPDATE lib_sources SET etag = ?, last_modified = ?, sha8 = ?, checked_at = ?, status = '200', changed_count = changed_count + ? WHERE id = ?"
        ).bind(
          resp.headers.get("ETag") || src.etag || null,
          resp.headers.get("Last-Modified") || src.last_modified || null,
          newSha8,
          now,
          didChange ? 1 : 0,
          src.id
        ),
      ];

      // Store stripped text snapshot in D1 `lib_source_snapshots` when new or changed
      if ((isFirstSnapshot || didChange) && cleanText) {
        const snapId = `${src.id}_${newSha8}`;
        sourceUpdateStmts.push(
          env.DB.prepare(
            "INSERT OR REPLACE INTO lib_source_snapshots (id, source_id, url, sha8, body_text, fetched_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(snapId, src.id, src.url, newSha8, cleanText, now)
        );
      }
      await env.DB.batch(sourceUpdateStmts);

      // Run AI fact learner (`wiki-learn.mjs` replacement) when a monitored source changes
      if (didChange && cleanText) {
        const applied = await extractWikiFactsWithAi({ env, source: src, cleanText });
        for (const item of applied) {
          if (item.category) touchedCategories.add(item.category);
        }
      }
    } catch (e) {
      await env.DB.prepare("UPDATE lib_sources SET checked_at = ?, status = 'error' WHERE id = ?")
        .bind(now, src.id)
        .run();
    }
  }

  for (const cat of touchedCategories) {
    await recomputeCategoryAndIndex(env, cat, {
      date: now.slice(0, 10),
      page: cat,
      text: `Auto-updated facts from scheduled source check`,
    });
  }

  // Update `refresh.json` blob in D1
  const refreshRow = await env.DB.prepare("SELECT json FROM lib_blobs WHERE name = 'refresh.json'").first();
  if (refreshRow) {
    try {
      const refDoc = JSON.parse(refreshRow.json);
      refDoc.generated = now;
      refDoc.last_sweep = { at: now, checked, changed, by: opts.triggeredBy || "cron" };
      const nextRefJson = JSON.stringify(refDoc);
      const nextRefStamp = await sha8Hex(nextRefJson);
      await env.DB.prepare("UPDATE lib_blobs SET stamp = ?, json = ?, updated_at = ? WHERE name = 'refresh.json'")
        .bind(nextRefStamp, nextRefJson, now)
        .run();
    } catch {}
  }

  await recomputeCategoryAndIndex(env, null);
  await purgeWorkerCache(origin, [
    "/api/library/index.json",
    "/api/library/refresh.json",
    "/api/library/news.json",
    ...[...touchedCategories].map((c) => `/api/library/${c}.json`),
  ]);

  await broadcastToRoom(env, {
    type: "library",
    categories: [...touchedCategories],
    intent: opts.intentId
      ? { id: opts.intentId, kind: "refresh", by: opts.triggeredBy || "cron", status: "done", checked, changed, at: now }
      : undefined,
  });
}
