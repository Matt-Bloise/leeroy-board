// Starts the Worker on the REAL local runtime (`wrangler dev --local`: workerd with miniflare bindings, a throwaway D1 folder, made-up tokens) and checks that it answers. Nothing leaves the machine, no AI.
//   node tests/local/dev-start.mjs [port]
// Not part of `node --test tests/unit/*`: it needs infrastructure/node_modules (npm install there). Before worker/entry.js existed the Worker could not start here at all (the entry module exported
// non-handler values and workerd refused them), so a change could not be tried on a real runtime before a push. Use this to try one: start it, then call any route. Exit 0 when all three answer 200.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), port = Number(process.argv[2] || 8803);
let failed = false;
const INFRA = path.join(root, "infrastructure");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dev-start-")), dir = path.join(tmp, "d1");
const TOKEN = "dev-admin-token-0123456789abcdef", SALT = "dev-salt-0123456789abcdef";
const wr = (args) => { const r = spawnSync("npx", ["wrangler", ...args], { cwd: INFRA, encoding: "utf8", shell: process.platform === "win32" }); if (r.status !== 0) throw new Error("wrangler failed: " + (r.stderr || r.stdout).slice(-300)); };
let log = "", dev = null;
try {
  wr(["d1", "execute", "leeroy-board-db", "--local", "--persist-to", dir, "--file", path.join(INFRA, "schema.sql")]);
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--persist-to", dir, "--var", `BOARD_ADMIN_TOKEN:${TOKEN}`, "--var", `KEY_SALT:${SALT}`, "--var", `USER_SALT:${SALT}`], { cwd: INFRA, shell: true, detached: process.platform !== "win32" });
  dev.stdout.on("data", (d) => { log += d; }); dev.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 90; i++) { if (/Ready on/.test(log)) { ready = true; break; } if (dev.exitCode !== null) break; await new Promise((r) => setTimeout(r, 1000)); }
  console.log("ready:", ready);
  if (!ready) { failed = true; console.log(log.slice(-600)); }
  else {
    const h = await fetch(`http://127.0.0.1:${port}/api/health`); console.log("health", h.status, (await h.text()).slice(0, 120)); if (h.status !== 200) failed = true;
    const m = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${TOKEN}` } }); console.log("me (admin token)", m.status); if (m.status !== 200) failed = true;
    const s = await fetch(`http://127.0.0.1:${port}/api/state`); console.log("state", s.status); if (s.status !== 200) failed = true;
  }
} catch (e) { console.log("ERR", e.message); failed = true; }
finally {
  if (dev && dev.pid) { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"]); else { try { process.kill(-dev.pid, "SIGKILL"); } catch { try { dev.kill("SIGKILL"); } catch {} } } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(INFRA, ".wrangler", "tmp"), { recursive: true, force: true }); } catch {} // the bundler temp folder only (tests/unit/group-memory.test.mjs walks the tree); local D1 state under .wrangler/state is never touched
}
process.exit(failed ? 1 : 0);
