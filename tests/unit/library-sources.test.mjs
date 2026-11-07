// Library source allow-list test. Scans data/library/*.json for source URLs and checks them against
// data/library-sources.json: every host must be listed, and a link-only host must not have long stored text.
// Existing violations live in knownViolations (with a reason each). That list may only shrink: counts above
// the recorded maximum fail, and counts below it fail too until the entry is lowered or removed.
// No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const libDir = path.join(root, "data", "library");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "data", "library-sources.json"), "utf8"));

const LONG_TEXT = 300;
const TEXT_FIELDS = ["quote", "text", "snippet", "lines"]; // lines: tooltip line arrays, joined
// schema.json is a generated description of the other files (its examples repeat their URLs), not library content.
const SKIP_FILES = new Set(["schema.json"]);
const URL_RE = /https?:\/\/[^\s"<>)\]]+/g;

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

function scanLibrary() {
  const urlCounts = new Map(); // host -> count of URL occurrences
  const longText = new Map(); // "file|host|field" -> count of entries
  const bad = [];
  const walk = (node, file) => {
    if (Array.isArray(node)) { node.forEach((x) => walk(x, file)); return; }
    if (node && typeof node === "object") {
      if (typeof node.url === "string") {
        const host = hostOf(node.url);
        if (host && cfg.hosts[host] && cfg.hosts[host].storedText === "link-only") {
          for (const field of TEXT_FIELDS) {
            const v = node[field];
            const len = Array.isArray(v) ? v.join(" ").length : typeof v === "string" ? v.length : 0;
            if (len > LONG_TEXT) {
              const key = `${file}|${host}|${field}`;
              longText.set(key, (longText.get(key) || 0) + 1);
            }
          }
        }
      }
      for (const k of Object.keys(node)) walk(node[k], file);
      return;
    }
    if (typeof node === "string") {
      for (const u of node.match(URL_RE) || []) {
        const host = hostOf(u);
        if (!host) { bad.push(`${file}: unparseable URL ${u}`); continue; }
        urlCounts.set(host, (urlCounts.get(host) || 0) + 1);
      }
    }
  };
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith(".json") && !SKIP_FILES.has(n)).sort()) {
    walk(JSON.parse(fs.readFileSync(path.join(libDir, f), "utf8")), f);
  }
  return { urlCounts, longText, bad };
}

const scan = scanLibrary();

test("library-sources.json is well formed", () => {
  assert.equal(typeof cfg.comment, "string");
  assert.match(cfg.comment, /draft/i);
  for (const [host, h] of Object.entries(cfg.hosts)) {
    assert.equal(host, host.toLowerCase(), `${host}: host must be lower case`);
    assert.ok(["link-only", "attribution-required"].includes(h.storedText), `${host}: storedText must be link-only or attribution-required`);
    for (const k of ["name", "licence", "attribution", "reviewed"]) assert.equal(typeof h[k], "string", `${host}: missing ${k}`);
    if (h.storedText === "attribution-required") {
      assert.ok(h.attribution.length > 0 && h.licenceUrl, `${host}: attribution-required needs attribution text and licenceUrl`);
    }
  }
  const known = cfg.knownViolations;
  for (const v of known.unlistedHosts) {
    assert.ok(!cfg.hosts[v.host], `${v.host}: now in hosts; remove it from knownViolations.unlistedHosts`);
    assert.ok(v.reason && v.reason.length > 10, `${v.host}: reason required`);
    assert.ok(Number.isInteger(v.maxUrls) && v.maxUrls > 0, `${v.host}: maxUrls must be a positive integer`);
  }
  for (const v of known.linkOnlyLongText) {
    assert.ok(cfg.hosts[v.host]?.storedText === "link-only", `${v.host}: must be a link-only host`);
    assert.ok(v.reason && v.reason.length > 10, `${v.file} ${v.host}: reason required`);
    assert.ok(Number.isInteger(v.maxEntries) && v.maxEntries > 0, `${v.file} ${v.host}: maxEntries must be a positive integer`);
  }
});

test("library files contain only parseable URLs", () => {
  assert.deepEqual(scan.bad, []);
});

test("every library source host is on the allow-list or a counted known violation", () => {
  const known = new Map(cfg.knownViolations.unlistedHosts.map((v) => [v.host, v]));
  const fails = [];
  for (const [host, n] of scan.urlCounts) {
    if (cfg.hosts[host]) continue;
    const k = known.get(host);
    if (!k) fails.push(`${host}: ${n} URL(s), host not allowed. Remove the source or get the host reviewed and added to data/library-sources.json`);
    else if (n > k.maxUrls) fails.push(`${host}: ${n} URL(s) exceeds known maximum ${k.maxUrls}`);
    else if (n < k.maxUrls) fails.push(`${host}: ${n} URL(s) is below recorded ${k.maxUrls}; lower maxUrls (the list only shrinks)`);
  }
  for (const host of known.keys()) {
    if (!scan.urlCounts.has(host)) fails.push(`${host}: no longer used; remove it from knownViolations.unlistedHosts`);
  }
  assert.deepEqual(fails, []);
});

test("link-only hosts have no stored long text (over 300 characters)", () => {
  const known = new Map(cfg.knownViolations.linkOnlyLongText.map((v) => [`${v.file}|${v.host}|${v.field}`, v]));
  const fails = [];
  for (const [key, n] of scan.longText) {
    const k = known.get(key);
    if (!k) fails.push(`${key}: ${n} entr(ies) store text over ${LONG_TEXT} chars from a link-only host`);
    else if (n > k.maxEntries) fails.push(`${key}: ${n} exceeds known maximum ${k.maxEntries}`);
    else if (n < k.maxEntries) fails.push(`${key}: ${n} is below recorded ${k.maxEntries}; lower maxEntries (the list only shrinks)`);
  }
  for (const key of known.keys()) {
    if (!scan.longText.has(key)) fails.push(`${key}: no longer a violation; remove it from knownViolations.linkOnlyLongText`);
  }
  assert.deepEqual(fails, []);
});

// wago.tools robots.txt disallows crawling: it must never be cited, fetched or mirrored by library data or tooling.
const NEVER = ["wago.tools"];
test("no library file cites a crawl-disallowed host", () => {
  const hits = [];
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(libDir, f), "utf8");
    for (const h of NEVER) if (text.includes(h)) hits.push(`${f}: mentions ${h}`);
  }
  assert.deepEqual(hits, []);
  for (const h of NEVER) assert.ok(!cfg.hosts[h] && !cfg.knownViolations.unlistedHosts.some((v) => v.host === h), `${h} must not be listed or tolerated`);
});

// External community sources (link-only, never copied): label, https URL, access date and non-affiliation note are required.
test("external community sources are https, labelled Likely, dated and carry the non-affiliation note", () => {
  const ext = Object.entries(cfg.hosts).filter(([, h]) => h.kind === "external-community");
  assert.ok(ext.some(([host]) => host === "wowforevertools.com"), "wowforevertools.com must be recorded");
  for (const [host, h] of ext) {
    assert.equal(h.storedText, "link-only", `${host}: external community sources are link-only`);
    assert.ok(["Confirmed", "Likely", "Speculative"].includes(h.label), `${host}: label`);
    const u = new URL(h.url);
    assert.equal(u.protocol, "https:", `${host}: https only`);
    assert.equal(u.host, host, `${host}: url host must match the key`);
    assert.match(h.accessed, /^\d{4}-\d{2}-\d{2}$/, `${host}: accessed date`);
    assert.ok(!Number.isNaN(Date.parse(h.accessed)), `${host}: accessed date parses`);
    assert.match(h.attribution, /not affiliated with or endorsed by Blizzard/i, `${host}: non-affiliation note`);
  }
  assert.equal(cfg.hosts["wowforevertools.com"].label, "Likely");
  assert.equal(cfg.hosts["wowforevertools.com"].accessed, "2026-11-07");
});
