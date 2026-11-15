// Member data is Worker-only: the static Pages bundle (leeroy.party/data/*.json) must not carry the files that describe the group's members.
// The Worker serves them through a read-time privacy projection (infrastructure/worker/public-party.js); a static copy would bypass it for ever.
// tools/pages-bundle.mjs is the one place that stages the bundle; both deploy workflows and the local static server use it. This file pins:
//   - the exclusion list exists, names the five member documents, the sign-ups and the reduced links file, and every entry is a real repo file;
//   - both workflows stage the bundle through the script (and no longer copy the data folder themselves), the production deploy and the PR preview alike;
//   - a simulated bundle (the script run into a temp folder) holds none of the private paths and no member field next to a member name, in any file;
//   - the final assertion fires: a stale private file in the output folder makes the script exit 1;
//   - the local static server answers 404 for the private files, like the deploy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { PRIVATE_DATA_FILES, STRIPPED_FILES, BUNDLE_ITEMS, buildBundle, assertBundleClean, stripLinks } from "../../tools/pages-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pages-bundle-"));
const rmrf = (d) => fs.rmSync(d, { recursive: true, force: true });
function* walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }

const EXPECTED_PRIVATE = ["data/party.json", "data/decide.json", "data/tonight.json", "data/guided-atlas.json", "data/client.json", "data/signups.json"];
const WORKFLOWS = [".github/workflows/deploy-cloudflare.yml", ".github/workflows/pr-preview-cloudflare.yml"];

test("the exclusion list names the five member documents plus the sign-ups, and every entry is a real repo file", () => {
  assert.deepEqual([...PRIVATE_DATA_FILES].sort(), [...EXPECTED_PRIVATE].sort());
  for (const rel of PRIVATE_DATA_FILES) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is listed as private but is not in the repository: a rename would silently stop protecting it`);
  assert.deepEqual(Object.keys(STRIPPED_FILES), ["data/atlas/links.json"]);
  assert.ok(BUNDLE_ITEMS.includes("data"), "the data folder is still published (without the private files)");
});

test("every document the Worker projects as member data is excluded from the bundle (public-party.js MEMBER_DOCS)", () => {
  const src = read("infrastructure/worker/public-party.js");
  const m = /export const MEMBER_DOCS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "MEMBER_DOCS not found in public-party.js");
  const names = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  // launch is a list of launch states with no build facts in the repo copy (the Worker removes a hidden state at read time); it is the one projected document not excluded
  const PUBLISHED_ON_PURPOSE = new Set(["launch"]);
  for (const n of names) if (!PUBLISHED_ON_PURPOSE.has(n)) assert.ok(PRIVATE_DATA_FILES.includes(`data/${n}.json`), `data/${n}.json is a projected member document but is not on the exclusion list`);
});

for (const wf of WORKFLOWS) {
  test(`${wf} stages the Pages bundle through tools/pages-bundle.mjs, not its own copy loop`, () => {
    const doc = parseYaml(read(wf));
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps || []);
    const staging = steps.filter((s) => typeof s.run === "string" && /\.cloudflare-dist/.test(s.run) && /pages deploy/.test(s.run));
    assert.equal(staging.length, 1, "exactly one step stages and deploys the bundle");
    const run = staging[0].run;
    assert.match(run, /node tools\/pages-bundle\.mjs \.cloudflare-dist/, "the step runs the shared script");
    assert.ok(run.indexOf("pages-bundle.mjs") < run.indexOf("pages deploy"), "the script runs before the deploy");
    assert.ok(!/cp -R/.test(run), "no step copies the data folder into the bundle by hand any more");
    assert.ok(/(^|\n)\s*set -e/.test(run), "set -e: a failed assertion stops the step before the deploy");
  });
}

test("a simulated bundle holds none of the private paths", () => {
  const out = tmp();
  try {
    buildBundle(root, out);
    for (const rel of PRIVATE_DATA_FILES) assert.ok(!fs.existsSync(path.join(out, rel)), `${rel} is in the bundle`);
    assert.ok(fs.existsSync(path.join(out, "data", "timeline.json")), "public data is still published");
    assert.ok(fs.existsSync(path.join(out, "index.html")));
    // links.json ships without the start_zone records and with the counts they added taken off
    const links = JSON.parse(fs.readFileSync(path.join(out, "data", "atlas", "links.json"), "utf8"));
    assert.ok(Array.isArray(links.records) && links.records.length > 0, "the public records stay");
    assert.ok(!links.records.some((r) => r.kind === "start_zone"), "no start_zone record");
    const src = JSON.parse(read("data/atlas/links.json"));
    const dropped = src.records.filter((r) => r.kind === "start_zone");
    assert.ok(dropped.length > 0, "the repo copy still has start_zone records (the Worker seeds from it)");
    for (const r of dropped) assert.equal(links.counts[r.place].records, src.counts[r.place].records - dropped.filter((d) => d.place === r.place).length, `${r.place}: records count reduced`);
  } finally { rmrf(out); }
});

test("a simulated bundle carries no member field next to a member name, in any file", () => {
  const out = tmp();
  try {
    buildBundle(root, out);
    const members = JSON.parse(read("data/party.json")).members;
    const names = members.map((m) => String(m.name).toLowerCase());
    const MEMBER_ONLY_KEYS = ["board_line", "spec_status", "role_detail"]; // keys that exist only on a party member entry (data/sample/* is fictional and exempt)
    const BUILD_KEYS = ["race", "class", "class_key", "spec", "professions", "start_zone", "board_line", "step"];
    const hits = [];
    const visit = (o, file) => {
      if (Array.isArray(o)) { o.forEach((x) => visit(x, file)); return; }
      if (!o || typeof o !== "object") return;
      const who = ["name", "member", "who"].map((k) => o[k]).find((v) => typeof v === "string" && names.includes(v.toLowerCase()));
      if (who && BUILD_KEYS.some((k) => k in o)) hits.push(`${file}: an object for a member carries ${BUILD_KEYS.filter((k) => k in o).join(",")}`);
      if (!/^data\/sample\//.test(file)) for (const k of MEMBER_ONLY_KEYS) if (k in o) hits.push(`${file}: member-only key ${k}`);
      if (o.kind === "start_zone") hits.push(`${file}: a start_zone record`);
      Object.values(o).forEach((x) => visit(x, file));
    };
    let jsonFiles = 0;
    for (const f of walk(out)) {
      const rel = path.relative(out, f).split(path.sep).join("/");
      if (!f.endsWith(".json")) continue;
      jsonFiles++;
      let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      visit(j, rel);
    }
    assert.ok(jsonFiles > 20, `scanned ${jsonFiles} JSON files`);
    assert.deepEqual(hits, []);
    // no file of the bundle (any type) holds a member's full name next to the word for a class they play on one line of a code or markup file
    for (const f of walk(out)) {
      if (!/\.(js|html|css)$/.test(f)) continue;
      const text = fs.readFileSync(f, "utf8").toLowerCase();
      for (const n of names) if (n.length >= 8 && text.includes(n)) hits.push(`${path.relative(out, f)}: mentions a member name`);
    }
    assert.deepEqual(hits, []);
  } finally { rmrf(out); }
});

test("the final assertion fires: a stale private file in the output folder fails the script (exit 1) and the deploy step with it", () => {
  const out = tmp();
  try {
    fs.mkdirSync(path.join(out, "data"), { recursive: true });
    fs.writeFileSync(path.join(out, "data", "party.json"), "{}"); // what a reused folder, or a copy loop that forgot the list, would leave
    const r = spawnSync(process.execPath, [path.join(root, "tools", "pages-bundle.mjs"), out], { encoding: "utf8" });
    assert.equal(r.status, 1, `exit status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /data\/party\.json is in the bundle/);
    assert.throws(() => assertBundleClean(out), /data\/party\.json is in the bundle/);
    // a clean run exits 0
    const clean = tmp();
    try {
      const ok = spawnSync(process.execPath, [path.join(root, "tools", "pages-bundle.mjs"), clean], { encoding: "utf8" });
      assert.equal(ok.status, 0, ok.stderr);
    } finally { rmrf(clean); }
  } finally { rmrf(out); }
});

test("assertBundleClean also refuses an unreduced links file", () => {
  const out = tmp();
  try {
    buildBundle(root, out);
    fs.writeFileSync(path.join(out, "data", "atlas", "links.json"), read("data/atlas/links.json"));
    assert.throws(() => assertBundleClean(out), /links\.json is in the bundle unreduced/);
  } finally { rmrf(out); }
});

test("stripLinks removes only start_zone records and their counts", () => {
  const j = { records: [{ kind: "start_zone", who: "a", place: "x" }, { kind: "meet_option", place: "y" }], counts: { x: { records: 1 }, y: { records: 1 } }, keep: 1 };
  const o = JSON.parse(stripLinks(JSON.stringify(j)));
  assert.deepEqual(o.records, [{ kind: "meet_option", place: "y" }]);
  assert.deepEqual(o.counts, { x: { records: 0 }, y: { records: 1 } });
  assert.equal(o.keep, 1);
});

test("the local static server answers like the deploy: 404 for the private files, a reduced links file, public data as before", async (t) => {
  const port = await new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
  const srv = spawn(process.execPath, [path.join(root, "tools", "static-server.mjs"), String(port), root], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/robots.txt`); up = true; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    assert.ok(up, "the static server came up");
    for (const rel of PRIVATE_DATA_FILES) {
      const r = await fetch(`http://127.0.0.1:${port}/${rel}`);
      assert.equal(r.status, 404, `/${rel} must be 404 on the static server`);
      assert.equal(r.headers.get("content-type").startsWith("application/json"), false, `/${rel}: not a JSON answer`);
    }
    const links = await fetch(`http://127.0.0.1:${port}/data/atlas/links.json`);
    assert.equal(links.status, 200);
    assert.ok(!(await links.json()).records.some((r) => r.kind === "start_zone"));
    assert.equal((await fetch(`http://127.0.0.1:${port}/data/timeline.json`)).status, 200);
  } finally { srv.kill(); }
});

test("nothing that ships in the bundle fetches a private data file over plain HTTP (js, scenes, atlas, landing, room, rate, next)", () => {
  const FETCHERS = ["js", "scenes", "atlas", "landing", "room", "rate", "next"];
  const bad = [];
  for (const d of FETCHERS) {
    if (!fs.existsSync(path.join(root, d))) continue;
    for (const f of walk(path.join(root, d))) {
      if (!/\.(js|html|mjs)$/.test(f) || /[\\/]vendor[\\/]/.test(f)) continue;
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\*|\/\/|\*)/.test(line)) return; // a comment line
        // a fetch of a private file by a literal path: fetch("data/party.json"), BoardFetch.json("data/decide.json") ... (apiFetch maps the logical name to the Worker and refuses a static read)
        for (const rel of PRIVATE_DATA_FILES) if (new RegExp(`fetch\\(\\s*["'\`]/?${rel.replace(/[./]/g, "\\$&")}`).test(line)) bad.push(`${path.relative(root, f)}:${i + 1}: fetch of ${rel}`);
      });
    }
  }
  assert.deepEqual(bad, []);
});
