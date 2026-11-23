// Proves what changing wrangler.toml `main` from worker/index.js to worker/entry.js does to the deployed bundle: the same code, and the export list is the default handler and BoardRoom only.
//   node tests/local/entry-bundle-proof.mjs
// Bundles the Worker twice with `wrangler deploy --dry-run` (offline: no deploy, no network call to Cloudflare, nothing written outside a temp folder): once from worker/index.js (the old main) and once
// from worker/entry.js (the new main), both from THIS checkout, so the only difference is the entry module. Prints both export lists and every differing line that is not an export; exit 0 only when the
// new bundle exports exactly { BoardRoom, default } and no code line differs. Needs infrastructure/node_modules (npm ci there).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INFRA = path.join(ROOT, "infrastructure");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entry-proof-"));
const bundle = (main, outName) => {
  const cfg = path.join(INFRA, `wrangler.proof-${outName}.toml`);
  fs.writeFileSync(cfg, fs.readFileSync(path.join(INFRA, "wrangler.toml"), "utf8").replace(/^main = ".*"$/m, `main = "${main}"`));
  try {
    const out = path.join(tmp, outName);
    const r = spawnSync(process.execPath, [path.join(INFRA, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--dry-run", "--config", cfg, "--outdir", out], { cwd: INFRA, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`wrangler dry-run failed for ${main}: ${(r.stderr || r.stdout).slice(-300)}`);
    return fs.readFileSync(path.join(out, path.basename(main)), "utf8");
  } finally { fs.rmSync(cfg, { force: true }); }
};
const exportsOf = (js) => { const m = /\nexport \{([\s\S]*?)\};\n/.exec(js); return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^.* as /, "")).sort() : []; };
const codeLines = (js) => js.split("\n").filter((l, i, a) => !/^\/\/# sourceMappingURL=/.test(l));

let ok = true;
try {
  const oldB = bundle("worker/index.js", "index.js"), newB = bundle("worker/entry.js", "entry.js");
  const ex = { old: exportsOf(oldB), now: exportsOf(newB) };
  console.log(`old main exports (${ex.old.length}): ${ex.old.join(", ")}`);
  console.log(`new main exports (${ex.now.length}): ${ex.now.join(", ")}`);
  if (JSON.stringify(ex.now) !== JSON.stringify(["BoardRoom", "default"])) { ok = false; console.log("FAIL the new bundle must export exactly BoardRoom and default"); }
  const a = codeLines(oldB), b = codeLines(newB);
  const inExport = (lines) => { const s = lines.findIndex((l) => l === "export {"); return s < 0 ? lines : [...lines.slice(0, s), ...lines.slice(lines.indexOf("};", s) + 1)]; };
  const A = new Set(inExport(a)), B = new Set(inExport(b));
  const onlyOld = [...A].filter((l) => !B.has(l)), onlyNew = [...B].filter((l) => !A.has(l));
  console.log(`code lines only in the old bundle: ${onlyOld.length}; only in the new bundle: ${onlyNew.length}`);
  for (const l of onlyOld) console.log(`< ${l.slice(0, 160)}`);
  for (const l of onlyNew) console.log(`> ${l.slice(0, 160)}`);
  // the new bundle adds only the entry module's own marker and its init call
  const allowed = (l) => l === "" || l === "// worker/entry.js" || l === "init_index();";
  if (onlyOld.length || !onlyNew.every(allowed)) { ok = false; console.log("FAIL the bundles differ in code, not only in the export list"); }
} catch (e) { ok = false; console.log(`ERR ${e.message}`); }
finally { fs.rmSync(tmp, { recursive: true, force: true }); try { fs.rmSync(path.join(INFRA, ".wrangler", "tmp"), { recursive: true, force: true }); } catch { /* none */ } }
console.log(ok ? "entry-bundle-proof: the new main deploys the same code with the exports { BoardRoom, default }" : "entry-bundle-proof: FAILED");
process.exit(ok ? 0 : 1);
