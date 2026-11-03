// Proves the layout sweep can still FAIL: runs it on one viewport with each broken stylesheet in tests/fixtures/layout-mutations injected (the sweep's --inject-css),
// and asserts that the sweep exits 1 and names the expected invariant. A control run without CSS must pass. Uses the recorded API fixtures, so it sends no Worker request.
//   node tests/helpers/layout-sweep-mutation.mjs --url "http://127.0.0.1:8080/"     (or env PREVIEW_PAGES; tools/local-browser.sh mutation does it with a local site)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), tests = path.join(here, "..");
const argv = process.argv.slice(2), ui = argv.indexOf("--url"), BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node layout-sweep-mutation.mjs --url <pages url>"); process.exit(2); }
const MUTATIONS = [
  { css: "hide-close.css", expect: ["close-viewport"] },
  { css: "cover-close.css", expect: ["close-hit"] },
  { css: "overlap-header.css", expect: ["head-overlap", "close-hit", "close-viewport"] },
  { css: "sideways-scroll.css", expect: ["hscroll"] },
];
const tmp = mkdtempSync(path.join(os.tmpdir(), "sweep-mutation-"));
let bad = 0;
function sweep(extra, tag) {
  const out = path.join(tmp, `${tag}.json`);
  const r = spawnSync(process.execPath, [path.join(tests, "browser", "layout-sweep.mjs"), "--url", BASE, "--sizes", "1366x768", "--states", "looking", "--scenes", "five", "--budget-min", "2", "--out", out, ...extra], { encoding: "utf8" });
  let rep = null; try { rep = JSON.parse(readFileSync(out, "utf8")); } catch (e) {}
  return { code: r.status, rep, text: (r.stdout || "") + (r.stderr || "") };
}
const ok = (name, cond, extra = "") => { if (!cond) bad++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? `: ${extra}` : ""}`); };
const control = sweep([], "control");
ok("control (no injected CSS): the sweep passes", control.code === 0 && control.rep && control.rep.summary.failures === 0, `exit ${control.code}`);
for (const m of MUTATIONS) {
  const r = sweep(["--inject-css", path.join(tests, "fixtures", "layout-mutations", m.css)], m.css);
  const seen = r.rep ? [...new Set(r.rep.failures.map((f) => f.invariant))] : [];
  ok(`mutation ${m.css}: the sweep FAILS`, r.code === 1, `exit ${r.code}`);
  ok(`mutation ${m.css}: names ${m.expect.join(" or ")}`, m.expect.some((e) => seen.includes(e)), `saw ${seen.join(",") || "nothing"}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `layout-sweep-mutation: ${bad} FAILED` : "layout-sweep-mutation: every injected layout bug was caught");
process.exit(bad ? 1 : 0);
