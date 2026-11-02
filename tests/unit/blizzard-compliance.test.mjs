// Compliance guard. The product makes no Blizzard API calls and carries no Blizzard
// marks in its own names. See docs/compliance/blizzard-checklist.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SCAN_DIRS = ["infrastructure", "js", "scenes", "tools"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".toml", ".sql", ".html", ".css", ".md", ".yml", ".yaml", ".txt", ".sh", ""]);
const HOSTS = /(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\.)*api\.blizzard\.com|(?:[a-z0-9-]+\.)*oauth\.battle\.net|(?:[a-z0-9-]+\.)*battle\.net\/oauth)(?![a-z0-9-])/i;
const DISCLAIMER = /not affiliated with or endorsed by Blizzard Entertainment/gi;
const MARKS = /warcraft|blizzard|\bwow\b/i;

const rel = (p) => relative(ROOT, p).split(sep).join("/");
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}
function allowlist() {
  const f = join(ROOT, "docs/compliance/blizzard-api-allowlist.txt");
  assert.ok(existsSync(f), "docs/compliance/blizzard-api-allowlist.txt must exist");
  return readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

test("no code references a Blizzard API host unless the file is allowlisted", () => {
  const allowed = new Set(allowlist());
  const hits = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const r = rel(file);
      if (allowed.has(r)) continue;
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const m = HOSTS.exec(line);
        if (m) hits.push(`${r}:${i + 1} ${m[1]}`);
      });
    }
  }
  assert.deepEqual(hits, [], `Blizzard API host referenced; add the path to docs/compliance/blizzard-api-allowlist.txt only with owner sign-off:\n${hits.join("\n")}`);
});

test("every allowlist entry names an existing file inside a scanned directory", () => {
  for (const e of allowlist()) {
    assert.ok(SCAN_DIRS.some((d) => e.startsWith(d + "/")), `${e} is outside the scanned directories`);
    assert.ok(existsSync(join(ROOT, e)), `${e} does not exist; remove the stale entry`);
  }
});

function productNames() {
  const names = [];
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) names.push(["index.html <title>", title[1]]);
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:name|property)\s*=\s*"([^"]+)"/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (content != null && ["og:title", "og:site_name", "application-name", "apple-mobile-web-app-title", "twitter:title"].includes(key)) names.push([`index.html meta ${key}`, content]);
  }
  for (const f of ["manifest.json", "manifest.webmanifest", "site.webmanifest"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, "utf8"));
    for (const k of ["name", "short_name"]) if (typeof j[k] === "string") names.push([`${f} ${k}`, j[k]]);
  }
  const wr = join(ROOT, "infrastructure/wrangler.toml");
  if (existsSync(wr)) {
    const m = /^name\s*=\s*"([^"]*)"/m.exec(readFileSync(wr, "utf8"));
    if (m) names.push(["infrastructure/wrangler.toml name", m[1]]);
  }
  const pj = join(ROOT, "infrastructure/package.json");
  if (existsSync(pj)) names.push(["infrastructure/package.json name", JSON.parse(readFileSync(pj, "utf8")).name || ""]);
  // Bot and app display names assigned in code: BOT_NAME / APP_NAME / botName / appName / username.
  for (const file of walk(join(ROOT, "infrastructure/worker"))) {
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      const m = /\b(?:BOT_NAME|APP_NAME|botName|appName|bot_name|app_name|username)\s*[:=]\s*["'`]([^"'`]*)["'`]/.exec(line);
      if (m) names.push([`${rel(file)}:${i + 1}`, m[1]]);
    });
  }
  return names;
}

test("product, bot and app names do not use WoW, Warcraft or Blizzard", () => {
  const names = productNames();
  assert.ok(names.some(([w]) => w === "index.html <title>"), "index.html title not found");
  const bad = names.filter(([, v]) => MARKS.test(v.replace(DISCLAIMER, ""))).map(([w, v]) => `${w}: ${v}`);
  assert.deepEqual(bad, [], `Blizzard marks in a product name:\n${bad.join("\n")}`);
});

test("the disclaimer exemption only covers the exact non-affiliation sentence", () => {
  assert.equal(MARKS.test("Not affiliated with or endorsed by Blizzard Entertainment".replace(DISCLAIMER, "")), false);
  assert.equal(MARKS.test("Warcraft Board".replace(DISCLAIMER, "")), true);
  assert.equal(MARKS.test("WoW Companion not affiliated with or endorsed by Blizzard Entertainment".replace(DISCLAIMER, "")), true);
});

test("the host pattern catches the forbidden hosts and ignores lookalikes", () => {
  for (const s of ["https://api.blizzard.com/data", "https://us.api.blizzard.com/x", "https://oauth.battle.net/token", "https://battle.net/oauth/authorize", "https://eu.battle.net/oauth/x"]) assert.ok(HOSTS.test(s), s);
  for (const s of ["Battle.net > WoW > Game Version", "https://leeroy.party/api/data", "https://battle.net/download"]) assert.equal(HOSTS.test(s), false, s);
});
