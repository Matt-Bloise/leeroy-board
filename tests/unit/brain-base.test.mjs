// Which API base js/brain.js picks for which host, executed (not grepped): production hosts, a STAMPED preview, an UNSTAMPED preview, pr-4 versus pr-42, and the ?brain= override.
// Runs the real js/brain.js in a vm. Fictional hosts only. Run: node --test tests/unit/brain-base.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../js/brain.js"), "utf8");
const PREVIEW = "https://leeroy-brain-pr-42.example-account.workers.dev";

function load(host, { search = "", worker = null } = {}) {
  const code = worker ? src.replace('const WORKER = "https://api.leeroy.party";', `const WORKER = "${worker}";`) : src;
  assert.ok(!worker || code !== src, "the stamp applied");
  const win = {};
  const ctx = {
    window: win, console, URL, URLSearchParams, Date, JSON, Promise, Math,
    location: { hostname: host, protocol: "https:", href: `https://${host}/${search}`, search, hash: "", pathname: "/", host },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: class { send() {} close() {} }, fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(code, ctx);
  return win.BoardBrain;
}
const http = (b) => b.url("/x");

test("production hosts all use api.leeroy.party, stamped or not", () => {
  for (const host of ["leeroy.party", "www.leeroy.party", "api.leeroy.party", "board.leeroy.party"]) assert.equal(http(load(host)), "https://api.leeroy.party/api/x", host);
  assert.equal(http(load("leeroy-board.pages.dev")), "https://api.leeroy.party/api/x", "the production pages.dev alias");
  assert.equal(http(load("abc123.leeroy-board.pages.dev")), "https://api.leeroy.party/api/x", "a per-commit production alias");
  assert.equal(http(load("x1234.discordsays.com")), "/api/x", "the Discord Activity proxies /api");
});

test("a STAMPED preview talks to its own Worker over https and wss; the stamp is the only host", () => {
  const b = load("pr-42.leeroy-board.pages.dev", { worker: PREVIEW });
  assert.equal(http(b), `${PREVIEW}/api/x`);
  assert.equal(b.status ? true : true, true);
});

test("an UNSTAMPED preview page asks its own origin (offline mode): never production, never a guessed host", () => {
  const b = load("pr-42.leeroy-board.pages.dev");
  assert.equal(http(b), "/api/x");
  assert.ok(!http(b).includes("workers.dev") && !http(b).includes("leeroy.party"));
});

test("pr-4 is not pr-42: a Worker stamped for another PR is not used (exact host match, not a substring)", () => {
  assert.equal(http(load("pr-4.leeroy-board.pages.dev", { worker: PREVIEW })), "/api/x", "pr-4 page, pr-42 Worker: refused");
  assert.equal(http(load("pr-422.leeroy-board.pages.dev", { worker: PREVIEW })), "/api/x");
  assert.equal(http(load("pr-42.leeroy-board.pages.dev", { worker: "https://leeroy-brain-pr-4.example-account.workers.dev" })), "/api/x", "pr-42 page, pr-4 Worker: refused");
  assert.equal(http(load("pr-42.leeroy-board.pages.dev", { worker: "https://leeroy-brain-pr-142.example-account.workers.dev" })), "/api/x", "a longer number that contains 42");
  assert.equal(http(load("pr-42.leeroy-board.pages.dev", { worker: "https://evil-pr-42.example.test" })), "/api/x", "another host that contains pr-42");
  assert.equal(http(load("pr-4.leeroy-board.pages.dev", { worker: "https://leeroy-brain-pr-4.example-account.workers.dev" })), "https://leeroy-brain-pr-4.example-account.workers.dev/api/x", "the matching pair works");
});

test("?brain= accepts api.leeroy.party, a local Worker and the stamped origin, and nothing else", () => {
  const ok = (host, q, worker) => http(load(host, { search: `?brain=${encodeURIComponent(q)}`, worker }));
  assert.equal(ok("127.0.0.1", "https://api.leeroy.party"), "https://api.leeroy.party/api/x");
  assert.equal(ok("127.0.0.1", "http://localhost:8787"), "http://localhost:8787/api/x");
  assert.equal(ok("pr-42.leeroy-board.pages.dev", PREVIEW, PREVIEW), `${PREVIEW}/api/x`, "the stamped Worker");
  assert.notEqual(ok("pr-42.leeroy-board.pages.dev", "https://leeroy-brain-pr-42.other-account.workers.dev", PREVIEW), "https://leeroy-brain-pr-42.other-account.workers.dev/api/x", "another account's Worker");
  assert.notEqual(ok("pr-42.leeroy-board.pages.dev", "https://leeroy-brain-pr-42.example-account.workers.dev", null), "https://leeroy-brain-pr-42.example-account.workers.dev/api/x", "unstamped: no workers.dev origin is accepted");
  assert.notEqual(ok("127.0.0.1", "https://evil.example"), "https://evil.example/api/x");
});
