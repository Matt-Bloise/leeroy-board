// The committed download can never drift from the source: downloads/LeeroyBuild-<version>.zip must equal a fresh build of addon/LeeroyBuild,
// and the page get-addon/index.html must show that zip's version, size and SHA-256. Fix a failure with: node addon/build-zip.mjs --out downloads
// Run: node --test tests/unit/addon-download.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip, collectAddon, addonVersion, readZip } from "../../addon/build-zip.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = addonVersion();
const zipPath = path.join(root, "downloads", `LeeroyBuild-${version}.zip`);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("rebuilding gives identical bytes", () => {
  assert.ok(buildZip(collectAddon()).equals(buildZip(collectAddon())));
});

test("the committed zip equals a fresh build of addon/LeeroyBuild", () => {
  const committed = readFileSync(zipPath);
  const fresh = buildZip(collectAddon());
  assert.ok(committed.equals(fresh), "downloads zip is stale; run: node addon/build-zip.mjs --out downloads");
  for (const e of readZip(committed)) assert.ok(e.crcOk && e.name.startsWith("LeeroyBuild/"), e.name);
});

test("only the current version's zip is in downloads/", () => {
  assert.deepEqual(readdirSync(path.join(root, "downloads")), [`LeeroyBuild-${version}.zip`]);
});

test("the page shows this zip's version, size and SHA-256, and links it with download", () => {
  const html = readFileSync(path.join(root, "get-addon", "index.html"), "utf8");
  const zip = readFileSync(zipPath);
  const text = (id) => new RegExp(`id="${id}">([^<]*)<`).exec(html)?.[1];
  assert.equal(text("ver"), version);
  assert.equal(text("size"), `${zip.length} bytes`);
  assert.equal(text("sha"), sha(zip));
  const a = /<a class="dl" id="dl" href="([^"]+)" download>([^<]*)</.exec(html);
  assert.ok(a, "download link");
  assert.equal(a[1], `../downloads/LeeroyBuild-${version}.zip`);
  assert.ok(a[2].includes(version));
});

test("the page copy has no em dash, emoji, or unproven claim", () => {
  const html = readFileSync(path.join(root, "get-addon", "index.html"), "utf8");
  assert.ok(!/—|–|[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html));
  assert.ok(!/curseforge|approved by|tested in the game/i.test(html));
  assert.match(html, /\/console scriptErrors 1/);
  assert.match(html, /Tell us if it will not load/);
});

test("the board links to the page", () => {
  assert.match(readFileSync(path.join(root, "index.html"), "utf8"), /href="\/get-addon\/">Get the add-on</);
});
