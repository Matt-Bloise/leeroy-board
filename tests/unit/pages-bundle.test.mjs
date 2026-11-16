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
import { PRIVATE_DATA_FILES, STRIPPED_FILES, BUNDLE_ITEMS, buildBundle, assertBundleClean, stripLinks, isPrivatePath, strippedFor } from "../../tools/pages-bundle.mjs";

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

// What is pinned, exactly: every name in public-party.js MEMBER_DOCS except launch is on the exclusion list (so a document added to MEMBER_DOCS fails here until it is excluded or the
// exception below is argued), and launch's repo copy is checked to hold no member row or field (next test). The exclusion list is NOT pinned equal to MEMBER_DOCS: it also holds signups,
// which the Worker serves without a projection but which VAREN decided is Worker-only too.
test("every MEMBER_DOCS document except launch is on the exclusion list (public-party.js)", () => {
  const src = read("infrastructure/worker/public-party.js");
  const m = /export const MEMBER_DOCS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "MEMBER_DOCS not found in public-party.js");
  const names = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  // launch is intentionally not excluded: its repo copy has no member rows (event, voice, moments, checklist); the Worker removes a hidden launch_state from rows it stores at read time
  const PUBLISHED_ON_PURPOSE = new Set(["launch"]);
  for (const n of names) if (!PUBLISHED_ON_PURPOSE.has(n)) assert.ok(PRIVATE_DATA_FILES.includes(`data/${n}.json`), `data/${n}.json is a projected member document but is not on the exclusion list`);
});

test("a MEMBER_DOCS document that is published (launch) holds no member row or member field in its repo copy", () => {
  const src = read("infrastructure/worker/public-party.js");
  const m = /export const MEMBER_DOCS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  const published = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).filter((n) => !PRIVATE_DATA_FILES.includes(`data/${n}.json`));
  assert.deepEqual(published, ["launch"], "only launch is projected and published: a new one needs this test to be extended on purpose");
  const names = JSON.parse(read("data/party.json")).members.map((x) => String(x.name));
  const FIELDS = ["race", "class", "class_key", "spec", "spec_status", "professions", "start_zone", "board_line", "role_detail", "state", "slug", "launch_state", "members"];
  for (const n of published) {
    const raw = read(`data/${n}.json`);
    const problems = [];
    const visit = (o, at) => {
      if (Array.isArray(o)) { o.forEach((x, i) => visit(x, `${at}[${i}]`)); return; }
      if (!o || typeof o !== "object") return;
      for (const k of FIELDS) if (k in o) problems.push(`${at}.${k}`);
      Object.entries(o).forEach(([k, v]) => visit(v, `${at}.${k}`));
    };
    visit(JSON.parse(raw), n);
    for (const name of names) if (new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).test(raw)) problems.push("a member name");
    assert.deepEqual(problems, [], `data/${n}.json is published but carries member rows or fields`);
  }
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
    // every member name from data/party.json (read now, never written here), as a whole word and as written, in every text file of the bundle. The only allowed places are listed with the reason.
    const ALLOWED = [
      ["privacy/index.html", "the operator's own name in the sentence saying who runs the site"],
      ["scenes/probe.js", "the operator's name in the hardware probe's own send button and copy (an operator tool, not a member's build)"],
      ["data/actions.json", "the operator's name in a step's label that points at scenes/probe.js"],
    ];
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new Set();
    for (const f of walk(out)) {
      if (!/\.(js|html|css|json|txt|xml|svg|md|webmanifest)$/i.test(f) && path.basename(f) !== "_headers") continue;
      const text = fs.readFileSync(f, "utf8"), rel = path.relative(out, f).split(path.sep).join("/");
      for (const x of members.map((m) => String(m.name))) {
        if (!new RegExp(`(?<![A-Za-z0-9])${esc(x)}(?![A-Za-z0-9])`).test(text)) continue;
        if (ALLOWED.some(([file]) => file === rel)) found.add(rel); else hits.push(`${rel}: mentions a member name`);
      }
    }
    assert.deepEqual(hits, []);
    for (const [file, why] of ALLOWED) assert.ok(found.has(file), `allow-list entry ${file} (${why}) no longer matches anything: remove it`);
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

test("the private-path match ignores case, trailing dots and spaces and stream suffixes (a Windows or macOS file system opens them as the same file)", () => {
  for (const rel of PRIVATE_DATA_FILES) {
    for (const v of [rel, rel.toUpperCase(), rel.replace(/^data/, "Data").replace(/json$/, "JSON"), rel + ".", rel + " ", rel + "::$DATA", "./" + rel]) assert.equal(isPrivatePath(v), true, v);
  }
  assert.equal(isPrivatePath("data/timeline.json"), false);
  assert.ok(strippedFor("DATA/Atlas/Links.json"), "the reduced links file is found case-insensitively too");
});

test("the local static server answers like the deploy: 404 for the private files, a reduced links file, public data as before", async (t) => {
  const port = await new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
  const srv = spawn(process.execPath, [path.join(root, "tools", "static-server.mjs"), String(port), root], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/robots.txt`); up = true; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    assert.ok(up, "the static server came up");
    for (const rel of PRIVATE_DATA_FILES.flatMap((p) => [p, p.toUpperCase().replace(/^DATA/, "Data"), p.replace(/party/, "PARTY").replace(/^data/, "DATA")])) {
      const r = await fetch(`http://127.0.0.1:${port}/${rel}`);
      assert.equal(r.status, 404, `/${rel} must be 404 on the static server`);
      assert.equal(r.headers.get("content-type").startsWith("application/json"), false, `/${rel}: not a JSON answer`);
    }
    for (const p of ["data/atlas/links.json", "DATA/ATLAS/LINKS.JSON"]) {
      const links = await fetch(`http://127.0.0.1:${port}/${p}`);
      if (links.status !== 200) { await links.arrayBuffer(); continue; } // a case-sensitive file system has no such file: 404 is fine
      assert.ok(!(await links.json()).records.some((r) => r.kind === "start_zone"), `${p} is reduced`);
    }
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
