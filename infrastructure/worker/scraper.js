// =============================================================================
// 15-Minute Cloudflare Cron Source Sweep & D1 Library Blob Rebuilder
// (`worker/scraper.js`)
// =============================================================================

import { broadcastToRoom, purgeWorkerCache } from "./index.js";

async function sha8Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    "SELECT * FROM lib_sources ORDER BY COALESCE(checked_at, '1970-01-01') ASC LIMIT 12"
  ).all();

  let checked = 0;
  let changed = 0;

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

      const text = await resp.text();
      const newSha8 = await sha8Hex(text);
      const didChange = Boolean(src.sha8 && src.sha8 !== newSha8);
      if (didChange) changed++;

      await env.DB.prepare(
        "UPDATE lib_sources SET etag = ?, last_modified = ?, sha8 = ?, checked_at = ?, status = '200', changed_count = changed_count + ? WHERE id = ?"
      )
        .bind(
          resp.headers.get("ETag") || src.etag || null,
          resp.headers.get("Last-Modified") || src.last_modified || null,
          newSha8,
          now,
          didChange ? 1 : 0,
          src.id
        )
        .run();
    } catch (e) {
      await env.DB.prepare("UPDATE lib_sources SET checked_at = ?, status = 'error' WHERE id = ?")
        .bind(now, src.id)
        .run();
    }
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
  await purgeWorkerCache(origin, ["/api/library/index.json", "/api/library/refresh.json", "/api/library/news.json"]);

  await broadcastToRoom(env, {
    type: "library",
    categories: [],
    intent: opts.intentId
      ? { id: opts.intentId, kind: "refresh", by: opts.triggeredBy || "cron", status: "done", checked, changed, at: now }
      : undefined,
  });
}
