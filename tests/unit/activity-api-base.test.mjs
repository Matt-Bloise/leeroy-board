// Activity API base and footer-link target, from the real js/brain.js and the real source text of js/board.js (API, externalTarget).
// Inside the Activity the Portal maps /api to the Worker: K.api must be this page's own origin and sign-in must POST to <origin>/api/auth/discord.
// On the web (leeroy.party, pr-*.pages.dev, ?api=) the base is what master chose. Fictional host and codes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const BOARD = read("js/board.js");
const cut = (re, what) => { const m = re.exec(BOARD); assert.ok(m, `board.js still has ${what}`); return m[0]; };
const API_OK = [cut(/^const API_OK = .*$/m, "API_OK"), cut(/^const PREVIEW_WORKER = .*$/m, "PREVIEW_WORKER"), cut(/^const apiOk = .*$/m, "apiOk")].join("\n"), API_SRC = cut(/^const API = \(\(\) => \{[\s\S]*?^\}\)\(\);$/m, "the API base"), EXT_SRC = cut(/^function externalTarget\(a\) \{[\s\S]*?^\}$/m, "externalTarget");

function load(host, search = "") {
  const store = new Map(), fetched = [];
  const ctx = {
    location: { hostname: host, host, search, hash: "", protocol: "https:", href: `https://${host}/${search}`, origin: `https://${host}`, pathname: "/" },
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
  ctx.api = vm.runInContext(`(function () { ${API_OK}\n${API_SRC}\nreturn API; })()`, ctx);
  ctx.ext = vm.runInContext(`(function () { ${EXT_SRC}\nreturn externalTarget; })()`, ctx);
  return { ctx, fetched };
}
const ACT = "123456789012345678.discordsays.com";

test("Activity: K.api is the page origin and the sign-in POST goes to <origin>/api/auth/discord", async () => {
  const { ctx, fetched } = load(ACT);
  assert.equal(ctx.BoardBrain.url("/x"), "/api/x");
  assert.equal(ctx.api, `https://${ACT}`);
  ctx.__boardKit = { api: ctx.api };
  vm.runInContext(read("scenes/account.js"), ctx);
  assert.ok(ctx.BoardAccount, "the account scene builds in the Activity");
  ctx.__sdk = { commands: { authorize: async () => ({ code: "fictional-code-1" }) } };
  assert.equal(await ctx.BoardAccount.signIn(), true);
  const post = fetched.find((f) => f.method === "POST");
  assert.equal(post.url, `https://${ACT}/api/auth/discord`);
});

test("web: the base is unchanged (leeroy.party and pr-*.pages.dev have none, ?api= keeps its allowlist)", () => {
  assert.equal(load("leeroy.party").ctx.api, null);
  assert.equal(load("pr-12.leeroy-board.pages.dev").ctx.api, null);
  assert.equal(load("leeroy.party", "?api=https://api.leeroy.party").ctx.api, "https://api.leeroy.party");
  assert.equal(load("leeroy.party", "?api=https://evil.test").ctx.api, null);
  const { ctx } = load("leeroy.party");
  ctx.__boardKit = { api: ctx.api };
  vm.runInContext(read("scenes/account.js"), ctx);
  assert.equal(ctx.BoardAccount, undefined, "no account scene without a base");
});

const link = (ctx, raw, foot = true) => ({ getAttribute: () => raw, href: new URL(raw, ctx.location.href).href, closest: (s) => (foot && s === "#legal-foot" ? {} : null) });

test("footer links: same-origin paths map to leeroy.party, everything else stays a plain link", () => {
  const { ctx } = load(ACT);
  assert.equal(ctx.ext(link(ctx, "/landing/addon/")), "https://leeroy.party/landing/addon/");
  assert.equal(ctx.ext(link(ctx, "/privacy/?a=1#top")), "https://leeroy.party/privacy/?a=1#top");
  const BS = String.fromCharCode(92); /* backslash */
  for (const bad of ["javascript:alert(1)", "//evil.test/x", `/${BS}evil.test/x`, `${BS}${BS}evil.test/x`, "data:text/html,x", "tel:+10000000000", "blob:https://evil.test/1", "mailto:a@b.test", "#top"]) {
    assert.equal(ctx.ext(link(ctx, bad)), null, bad);
  }
  assert.equal(ctx.ext(link(ctx, "/privacy/", false)), null, "only the footer's own links are rewritten");
  assert.equal(ctx.ext(link(ctx, "https://example.test/a", false)), "https://example.test/a", "absolute http(s) links still open outside");
});
