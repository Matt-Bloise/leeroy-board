// The visual baseline gate (tests/browser/visual-baseline.mjs, job `visual` in preview-tests.yml): the PNG codec and the pixel diff it judges with, the gate wiring in the
// workflows and in tools/ci-report.mjs, and the committed baselines themselves (decodable, the right sizes, one per screen and size, nothing stale).
// Run: node --test tests/unit/visual-baseline-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { decodePng, encodePng, crc32 } from "../helpers/png.mjs";
import { diffImages, judge, diffImage } from "../helpers/pixel-diff.mjs";
import { buildReport } from "../../tools/ci-report.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const { parse } = createRequire(import.meta.url)("yaml");

const img = (w, h, f) => { const data = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4); return { width: w, height: h, data }; };
// A PNG written by hand with one filter type on every row and any colour type, to prove the decoder against encoders other than ours (Chromium picks filters per row).
function handPng(w, h, color, rows, filter, { palette = null, trns = null } = {}) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color], stride = w * ch, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = rows[y][x], a = x >= ch ? rows[y][x - ch] : 0, b = y > 0 ? rows[y - 1][x] : 0, c = x >= ch && y > 0 ? rows[y - 1][x - ch] : 0;
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = color;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []), ...(trns ? [chunk("tRNS", Buffer.from(trns))] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("png: crc32 of a known chunk type, and encode then decode gives back every byte", () => {
  assert.equal(crc32(Buffer.from("IEND", "latin1")), 0xae426082);
  const a = img(37, 23, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255, 255 - x]);
  const b = decodePng(encodePng(a));
  assert.equal(b.width, 37); assert.equal(b.height, 23); assert.deepEqual(Buffer.from(b.data), Buffer.from(a.data));
});

test("png: every filter type and colour type decodes to the same pixels", () => {
  const w = 9, h = 6, rgb = Array.from({ length: h }, (_, y) => Array.from({ length: w * 3 }, (_, i) => (i * 29 + y * 53 + ((i * y) % 7) * 31) & 255));
  for (const f of [0, 1, 2, 3, 4]) {
    const d = decodePng(handPng(w, h, 2, rgb, f));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.deepEqual([...d.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)], [rgb[y][x * 3], rgb[y][x * 3 + 1], rgb[y][x * 3 + 2], 255], `filter ${f} at ${x},${y}`);
  }
  const rgba = rgb.map((r) => r.flatMap((v, i) => (i % 3 === 2 ? [v, (v * 3) & 255] : [v])));
  assert.equal(decodePng(handPng(w, h, 6, rgba, 4)).data[3], rgba[0][3]);
  const grey = rgb.map((r) => r.slice(0, w));
  assert.deepEqual([...decodePng(handPng(w, h, 0, grey, 3)).data.subarray(0, 4)], [grey[0][0], grey[0][0], grey[0][0], 255]);
  const pal = handPng(2, 1, 3, [[1, 0]], 0, { palette: [10, 20, 30, 40, 50, 60], trns: [255, 7] });
  assert.deepEqual([...decodePng(pal).data], [40, 50, 60, 7, 10, 20, 30, 255]);
});

test("png: a broken file is refused, never read as an image", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /signature/);
  const good = encodePng(img(4, 4, () => [1, 2, 3, 255])), bad = Buffer.from(good); bad[bad.length - 20] ^= 0xff;
  assert.throws(() => decodePng(bad), /CRC|short|unknown filter|incorrect|invalid/i);
});

test("pixel diff: a channel moved by the tolerance is unchanged, one more is changed; ratio, box and size", () => {
  const a = img(10, 10, () => [100, 100, 100, 255]);
  const by = (d) => img(10, 10, (x, y) => (x === 3 && y === 4 ? [100, 100 + d, 100, 255] : [100, 100, 100, 255]));
  assert.equal(diffImages(a, by(8), { tolerance: 8 }).changed, 0);
  assert.equal(diffImages(a, by(8), { tolerance: 8 }).maxDelta, 8);
  const r = diffImages(a, by(9), { tolerance: 8 });
  assert.equal(r.changed, 1); assert.equal(r.ratio, 0.01); assert.deepEqual(r.box, { x: 3, y: 4, w: 1, h: 1 });
  assert.equal(diffImages(a, img(10, 11, () => [0, 0, 0, 255])).sizeMismatch, "10x10 vs 10x11");
  assert.equal(diffImage(a, by(9), { tolerance: 8 }).data[(4 * 10 + 3) * 4 + 1], 0, "a changed pixel is painted red");
});

test("pixel diff: judge passes at the limit and fails just above it, and a size change always fails", () => {
  const T = { maxRatio: 0.002 };
  assert.equal(judge({ ratio: 0.002, changed: 2 }, T).pass, true);
  assert.equal(judge({ ratio: 0.00201, changed: 3 }, T).pass, false);
  assert.equal(judge({ sizeMismatch: "1x1 vs 2x2" }, T).pass, false);
});

// --- wiring: a visual change must fail the check unless its baseline is in the same PR ---
const wf = parse(read(".github/workflows/preview-tests.yml"));
test("preview-tests.yml: the visual job serves this checkout, runs the gate, then proves it can fail; report reads it", () => {
  const job = wf.jobs.visual;
  assert.ok(job, "job visual exists");
  assert.match(job.if, /site_changed == 'true'/, "runs whenever a site file changed");
  assert.doesNotMatch(job.if, /full/, "it needs no preview, so it runs on light pushes too");
  assert.deepEqual([].concat(job.needs), ["scope"]);
  const run = job.steps.map((s) => s.run || "").join("\n");
  assert.match(run, /tools\/static-server\.mjs/);
  assert.match(run, /browser\/visual-baseline\.mjs --url "?http:\/\/127\.0\.0\.1/);
  const mutation = job.steps.find((s) => /mutation/i.test(s.name || ""));
  assert.ok(mutation, "a mutation step exists");
  assert.match(mutation.run, /--inject-css/); assert.match(mutation.run, /exit 1|must FAIL|did not fail/i);
  assert.ok([].concat(wf.jobs.report.needs).includes("visual"), "report needs visual");
  assert.match(wf.jobs.report.steps.find((s) => s.id === "build").env.VISUAL_RESULT, /needs\.visual\.result/);
});

test("run.mjs: the visual gate is not also run against the preview inside the browser shards", () => {
  assert.match(read("tests/browser/run.mjs"), /"visual-baseline\.mjs"/);
});

test("visual-baselines.yml: dispatch only, never on the default branch, and only the commit job can write", () => {
  const v = parse(read(".github/workflows/visual-baselines.yml"));
  assert.deepEqual(Object.keys(v.on), ["workflow_dispatch"]);
  assert.equal(v.permissions.contents, "read");
  const writers = Object.entries(v.jobs).filter(([, j]) => j.permissions && j.permissions.contents === "write").map(([k]) => k);
  assert.deepEqual(writers, ["commit"], "one job writes");
  const commit = v.jobs.commit, render = v.jobs.render;
  assert.ok(render && !(render.permissions && render.permissions.contents === "write"), "the job that runs the branch's code cannot write");
  assert.match(String(v.jobs.guard ? v.jobs.guard.steps.map((s) => s.run || "").join("\n") : commit.steps.map((s) => s.run || "").join("\n")), /master|default branch/);
  const steps = commit.steps.map((s) => s.run || "").join("\n");
  assert.match(steps, /tests\/browser\/baselines/);
  assert.doesNotMatch(steps, /npm|node |npx/, "the job with the write token runs no code from the branch");
});

test("ci-report: a failed or missing visual result fails light, full and skipped runs whenever a site file changed", () => {
  const base = { sha7: "abcdef1", apiNeeded: true, siteChanged: true, probeChanged: false, recoverResult: "success", previewResult: "success", runUrl: "u" };
  const results = { unit: "success", stamps: "success", api: "success", crawl: "success", browser: "success", layout: "success" };
  const full = (visual) => buildReport({ ...base, full: true, results: { ...results, visual } });
  assert.equal(full("success").gate, true);
  for (const v of ["failure", "skipped", "cancelled", "missing"]) assert.equal(full(v).gate, false, `full run, visual ${v}`);
  const light = (visual) => buildReport({ ...base, full: false, results: { unit: "success", stamps: "success", api: "skipped", crawl: "skipped", browser: "skipped", layout: "skipped", visual } });
  assert.equal(light("success").pass, true);
  assert.equal(light("failure").pass, false);
  assert.match(light("failure").body, /visual baselines failed/i);
  assert.doesNotMatch(light("failure").body, /Preview tests/, "a light comment never carries the gate words");
  assert.match(full("success").body, /Visual baselines \(Chromium\) \| pass/);
  const notSite = buildReport({ ...base, siteChanged: false, full: true, apiNeeded: true, results: { ...results, browser: "skipped", layout: "skipped", visual: "skipped" } });
  assert.equal(notSite.gate, true, "no site file changed: the visual job may be skipped");
  const docs = buildReport({ ...base, docsOnly: true, siteChanged: false, full: false, results: { unit: "success", stamps: "success", api: "skipped", browser: "skipped", layout: "skipped", visual: "skipped" } });
  assert.equal(docs.gate, true);
});

// --- the committed baselines ---
const BASE_DIR = path.join(ROOT, "tests", "browser", "baselines");
const sceneList = () => { const m = /const SCENES = \[([^\]]+)\]/.exec(read("js/board.js")); assert.ok(m, "js/board.js declares SCENES"); return [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]); };
test("baselines: one PNG per screen and size (first, wall, every scene in js/board.js, landing), each decodes at its size, nothing else", () => {
  const files = existsSync(BASE_DIR) ? readdirSync(BASE_DIR).filter((f) => f.endsWith(".png")).sort() : [];
  const want = [];
  for (const size of ["390x844", "1366x768"]) for (const s of ["first", "wall", ...sceneList(), "landing"]) want.push(`${s}-${size}.png`);
  assert.deepEqual(files, want.sort(), "the baseline set is exactly the screen list");
  for (const f of files) {
    const p = decodePng(readFileSync(path.join(BASE_DIR, f))), [w, h] = f.replace(/\.png$/, "").split("-").pop().split("x").map(Number);
    assert.equal(`${p.width}x${p.height}`, `${w}x${h}`, f);
    let colours = new Set(); for (let i = 0; i < p.data.length && colours.size < 64; i += 4 * 101) colours.add((p.data[i] << 16) | (p.data[i + 1] << 8) | p.data[i + 2]);
    assert.ok(colours.size >= 16, `${f} is nearly blank (${colours.size} colours)`);
    let magenta = 0; for (let i = 0; i < p.data.length; i += 4) if (p.data[i] === 255 && p.data[i + 1] === 0 && p.data[i + 2] === 255) magenta++;
    assert.ok(magenta / (p.width * p.height) < 0.01, `${f} is ${((magenta / (p.width * p.height)) * 100).toFixed(1)}% magenta: a mask, not a page`);
  }
});
