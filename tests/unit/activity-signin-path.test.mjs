// Activity sign-in: the account scene must post to the same /api base js/brain.js uses inside the Activity, never /board-api
// (the Developer Portal maps only /api, so /board-api 404s). Real js/brain.js and scenes/account.js in one vm context; fictional host and codes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function load(host) {
  const store = new Map(), fetched = [];
  const ctx = {
    location: { hostname: host, host, search: "", hash: "", protocol: "https:", href: `https://${host}/`, origin: `https://${host}`, pathname: "/" },
    document: { documentElement: { dataset: {} }, addEventListener() {}, hidden: false },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    sessionStorage: { getItem: () => null },
    history: { replaceState() {} }, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Event: class { constructor(n) { this.type = n; } }, dispatchEvent() {}, addEventListener() {},
    fetch: async (url, opt) => { fetched.push({ url: String(url), method: opt && opt.method }); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session: "s".repeat(20), expires_at: Date.now() + 3600000 }) }; },
  };
  ctx.window = ctx; ctx.self = ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("js/brain.js"), ctx);
  ctx.__boardKit = { api: "https://api.leeroy.party" }; /* what board.js exports; the account scene builds only when it is set */
  vm.runInContext(read("scenes/account.js"), ctx);
  return { ctx, fetched };
}
const sdk = { commands: { authorize: async () => ({ code: "fictional-code-1" }) } };

test("inside the Activity the origin comes from brain.js and sign-in posts to /api/auth/discord", async () => {
  const { ctx, fetched } = load("123456789012345678.discordsays.com");
  assert.equal(ctx.BoardBrain.url("/x"), "/api/x", "brain.js picks the relative /api base in the Activity");
  assert.equal(ctx.__accountActivityOrigin(), "https://123456789012345678.discordsays.com");
  ctx.__sdk = sdk;
  assert.equal(await ctx.BoardAccount.signIn(), true);
  const post = fetched.find((f) => f.method === "POST");
  assert.equal(post.url, "https://123456789012345678.discordsays.com/api/auth/discord");
  assert.ok(!fetched.some((f) => f.url.includes("/board-api")), "nothing goes to /board-api");
});

test("signIn does not fetch when brain.js has no base (no hardcoded fallback)", async () => {
  const { ctx, fetched } = load("");
  assert.equal(ctx.__accountActivityOrigin(), null);
  ctx.__sdk = sdk;
  assert.equal(await ctx.BoardAccount.signIn(), false);
  assert.equal(fetched.length, 0);
});

test("source: no /board-api path remains in the account scene", () => {
  assert.ok(!/\/board-api/.test(read("scenes/account.js")));
});
