#!/usr/bin/env node
// =============================================================================
// `seed-d1.mjs` — Compiles the existing static `data/*.json`, `data/library/*.json`,
// and `data/atlas/{links,marks}.json` files into SQL `INSERT OR REPLACE` batches
// and executes them against Cloudflare D1 (local or remote).
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(INFRA_DIR, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const LIB_DIR = path.join(DATA_DIR, "library");
const ATLAS_DIR = path.join(DATA_DIR, "atlas");

const isRemote = process.argv.includes("--remote");
const dryRun = process.argv.includes("--dry-run");
const dbName = process.env.D1_DATABASE_NAME || "leeroy-board-db";
const now = new Date().toISOString();

function sqlStr(val) {
  if (val === null || val === undefined) return "NULL";
  return `'${String(val).replace(/'/g, "''")}'`;
}

function sha8(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 8);
}

const CHUNK_SIZE = 50000;

function splitChunks(str, size = CHUNK_SIZE) {
  if (!str || str.length <= size) return [str || ""];
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

const statements = [];

// 1. Seed `kv_state` from `data/*.json` and `data/atlas/{marks,links}.json`
const kvFiles = [
  ["party", path.join(DATA_DIR, "party.json")],
  ["timeline", path.join(DATA_DIR, "timeline.json")],
  ["stats", path.join(DATA_DIR, "stats.json")],
  ["signups", path.join(DATA_DIR, "signups.json")],
  ["tonight", path.join(DATA_DIR, "tonight.json")],
  ["launch", path.join(DATA_DIR, "launch.json")],
  ["decide", path.join(DATA_DIR, "decide.json")],
  ["guided-atlas", path.join(DATA_DIR, "guided-atlas.json")],
  ["marks", path.join(ATLAS_DIR, "marks.json")],
  ["links", path.join(ATLAS_DIR, "links.json")],
];

for (const [key, filePath] of kvFiles) {
  if (!fs.existsSync(filePath)) continue;
  const raw = JSON.stringify(JSON.parse(fs.readFileSync(filePath, "utf8")));
  const chunks = splitChunks(raw);
  statements.push(
    `INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (${sqlStr(key)}, ${sqlStr(chunks[0])}, ${sqlStr(now)});`
  );
  for (let i = 1; i < chunks.length; i++) {
    statements.push(
      `UPDATE kv_state SET json = json || ${sqlStr(chunks[i])} WHERE key = ${sqlStr(key)};`
    );
  }
}

// 2. Seed `lib_blobs`, `lib_pages`, and `lib_sources` from `data/library/*.json`
if (fs.existsSync(LIB_DIR)) {
  const libFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".json"));
  const sourcesMap = new Map();

  for (const file of libFiles) {
    const fullPath = path.join(LIB_DIR, file);
    const raw = JSON.stringify(JSON.parse(fs.readFileSync(fullPath, "utf8")));
    const stamp = sha8(raw);
    const chunks = splitChunks(raw);

    statements.push(
      `INSERT OR REPLACE INTO lib_blobs (name, stamp, json, updated_at) VALUES (${sqlStr(file)}, ${sqlStr(stamp)}, ${sqlStr(chunks[0])}, ${sqlStr(now)});`
    );
    for (let i = 1; i < chunks.length; i++) {
      statements.push(
        `UPDATE lib_blobs SET json = json || ${sqlStr(chunks[i])} WHERE name = ${sqlStr(file)};`
      );
    }

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.pages) && file !== "index.json") {
        for (const p of parsed.pages) {
          statements.push(
            `INSERT OR REPLACE INTO lib_pages (id, category, title, confidence, status, as_of, checked, recheck_days, blurb, aliases_json, facts_json, open_json, related_json, history_json, snapshots_json, updated_at) VALUES (${sqlStr(p.id)}, ${sqlStr(p.category)}, ${sqlStr(p.title)}, ${sqlStr(p.confidence || "confirmed")}, ${sqlStr(p.status || "current")}, ${sqlStr(p.as_of || null)}, ${sqlStr(p.checked || null)}, ${Number(p.recheck_days) || 7}, ${sqlStr(p.blurb || "")}, ${sqlStr(JSON.stringify(p.aliases || []))}, ${sqlStr(JSON.stringify(p.facts || []))}, ${sqlStr(JSON.stringify(p.open || []))}, ${sqlStr(JSON.stringify(p.related || []))}, ${sqlStr(JSON.stringify(p.history || []))}, ${sqlStr(JSON.stringify(p.snapshots || []))}, ${sqlStr(now)});`
          );

          for (const f of p.facts || []) {
            for (const r of f.refs || []) {
              if (r.id && r.url && !sourcesMap.has(r.id)) {
                sourcesMap.set(r.id, {
                  id: r.id,
                  url: r.url,
                  host: r.host || "",
                  label: r.label || r.id,
                  tier: Number(r.tier) || 2,
                });
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Skipping page extraction for ${file}:`, e.message);
    }
  }

  for (const s of sourcesMap.values()) {
    statements.push(
      `INSERT OR IGNORE INTO lib_sources (id, url, host, label, tier, status) VALUES (${sqlStr(s.id)}, ${sqlStr(s.url)}, ${sqlStr(s.host)}, ${sqlStr(s.label)}, ${s.tier}, 'ok');`
    );
  }
}

if (dryRun) {
  const outSqlPath = path.join(INFRA_DIR, ".seed-bundle.sql");
  fs.writeFileSync(outSqlPath, statements.join("\n"), "utf8");
  console.log(`Generated ${statements.length} SQL statements -> ${outSqlPath}`);
  console.log("Dry-run complete. Skipping wrangler d1 execute.");
  process.exit(0);
}

// Execute in batches of 20 statements to stay well below workerd's prepared-statement cache limit
const BATCH_SIZE = 20;
const totalBatches = Math.ceil(statements.length / BATCH_SIZE);
console.log(`Generated ${statements.length} SQL statements across ${totalBatches} batch(es).`);

for (let b = 0; b < totalBatches; b++) {
  const batch = statements.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
  const outSqlPath = path.join(INFRA_DIR, `.seed-bundle-${b}.sql`);
  fs.writeFileSync(outSqlPath, batch.join("\n"), "utf8");
  try {
    const args = [
      "wrangler",
      "d1",
      "execute",
      dbName,
      isRemote ? "--remote" : "--local",
      `--file=${outSqlPath}`,
    ];
    console.log(`[Batch ${b + 1}/${totalBatches}] Executing ${batch.length} statements...`);
    execFileSync("npx", args, { cwd: INFRA_DIR, stdio: "inherit", shell: true });
  } finally {
    if (fs.existsSync(outSqlPath)) fs.unlinkSync(outSqlPath);
  }
}
