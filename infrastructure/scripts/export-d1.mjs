#!/usr/bin/env node
// =============================================================================
// D1 Snapshot Exporter & Local Library Index Rebuilder (`scripts/export-d1.mjs`)
// Replaces `wow-mage/board/build-data.mjs` and `wow-mage/scripts/board-publish.mjs`
// so `leeroy-board` is 100% self-contained after retiring `wow-mage`:
//   - `node scripts/export-d1.mjs --rebuild`: Rebuilds `data/library/search.json`,
//     `data/library/open.json`, and `data/library/index.json` stamps/totals from
//     `data/library/<category>.json` using `vendor/rank-core.js`.
//   - `node scripts/export-d1.mjs --local` (or `--remote`): Exports live D1
//     `kv_state` and `lib_blobs` rows back into `data/*.json` and `data/library/*.json`.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { factHays, vocabIdf } from "../worker/rank-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(INFRA_DIR, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const LIB_DIR = path.join(DATA_DIR, "library");

function sha8(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 8);
}

function rebuildLocalLibraryIndexes() {
  const now = new Date().toISOString();
  const indexFile = path.join(LIB_DIR, "index.json");
  const indexDoc = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  const categories = indexDoc.categories || [];

  const allPages = [];
  const indexPages = [];
  let totalFacts = 0;
  let totalOpen = 0;

  for (const cat of categories) {
    const catFile = path.join(LIB_DIR, `${cat.key}.json`);
    if (!fs.existsSync(catFile)) continue;
    const catDoc = JSON.parse(fs.readFileSync(catFile, "utf8"));
    const pages = Array.isArray(catDoc.pages) ? catDoc.pages : [];
    let catFacts = 0;
    let catOpen = 0;
    for (const p of pages) {
      const fCount = Array.isArray(p.facts) ? p.facts.length : 0;
      const oCount = Array.isArray(p.open) ? p.open.length : 0;
      catFacts += fCount;
      catOpen += oCount;
      allPages.push({
        id: p.id,
        category: p.category || cat.key,
        title: p.title,
        aliases: p.aliases || [],
        facts: p.facts || [],
        open: p.open || [],
      });
      indexPages.push({
        id: p.id,
        category: p.category || cat.key,
        title: p.title,
        confidence: p.confidence || "confirmed",
        status: p.status || "current",
        as_of: p.as_of || now.slice(0, 10),
        checked: p.checked || now.slice(0, 10),
        facts: fCount,
        open: oCount,
        blurb: p.blurb || "",
      });
    }
    cat.pages = pages.length;
    cat.facts = catFacts;
    cat.open = catOpen;
    totalFacts += catFacts;
    totalOpen += catOpen;
  }

  // 1. Rebuild `search.json` using `vendor/rank-core.js`
  const searchDoc = {
    generated: now,
    idf: vocabIdf(factHays(allPages)),
  };
  fs.writeFileSync(path.join(LIB_DIR, "search.json"), JSON.stringify(searchDoc));

  // 2. Rebuild `open.json`
  const openFile = path.join(LIB_DIR, "open.json");
  const openDoc = fs.existsSync(openFile)
    ? JSON.parse(fs.readFileSync(openFile, "utf8"))
    : { generated: now, gaps: [], internal_gaps: 0, open: [] };
  openDoc.generated = now;
  openDoc.open = allPages.flatMap((p) =>
    (p.open || []).map((t) => ({
      page: p.id,
      text: typeof t === "string" ? t : t && (t.text || t.question || JSON.stringify(t)),
    }))
  );
  fs.writeFileSync(openFile, JSON.stringify(openDoc));

  // 3. Recompute SHA-8 stamps for all library files and update `index.json`
  const stamps = {};
  for (const f of fs.readdirSync(LIB_DIR)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    stamps[f] = sha8(fs.readFileSync(path.join(LIB_DIR, f), "utf8"));
  }
  indexDoc.generated = now;
  indexDoc.pages = indexPages;
  indexDoc.totals = {
    ...(indexDoc.totals || {}),
    pages: allPages.length,
    facts: totalFacts,
    open: totalOpen,
  };
  indexDoc.stamps = stamps;
  fs.writeFileSync(indexFile, JSON.stringify(indexDoc));

  console.log(
    `Rebuilt library indexes (${allPages.length} pages, ${totalFacts} facts, ${totalOpen} open items).`
  );
}

function queryD1Json(sql, isRemote) {
  const args = [
    "wrangler",
    "d1",
    "execute",
    "leeroy-board-db",
    isRemote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ];
  const out = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd: INFRA_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  return (parsed && parsed[0] && parsed[0].results) || [];
}

const args = new Set(process.argv.slice(2));
const isRemote = args.has("--remote");
const isLocalD1 = args.has("--local");

if (isRemote || isLocalD1) {
  console.log(`Exporting D1 (${isRemote ? "remote" : "local"}) state to data/...`);
  const kvRows = queryD1Json("SELECT key, json FROM kv_state", isRemote);
  for (const r of kvRows) {
    const target = fs.existsSync(path.join(DATA_DIR, "atlas", `${r.key}.json`))
      ? path.join(DATA_DIR, "atlas", `${r.key}.json`)
      : path.join(DATA_DIR, `${r.key}.json`);
    if (fs.existsSync(target) || ["party", "signups", "timeline", "tonight", "stats", "launch", "decide"].includes(r.key)) {
      fs.writeFileSync(target, r.json);
    }
  }
  const blobRows = queryD1Json("SELECT name, json FROM lib_blobs", isRemote);
  for (const b of blobRows) {
    fs.writeFileSync(path.join(LIB_DIR, b.name), b.json);
  }
  console.log(`Exported ${kvRows.length} kv_state documents and ${blobRows.length} lib_blobs from D1.`);
}

rebuildLocalLibraryIndexes();
