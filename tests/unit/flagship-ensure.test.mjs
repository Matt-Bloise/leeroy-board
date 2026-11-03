// tools/flagship-ensure.mjs with a fake fetch. No network. flagBody follows the documented flag shape; appBody and the list envelope are UNVERIFIED against the live API.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ensure, loadManifest, flagBody, appBody, PermissionError } from "../../tools/flagship-ensure.mjs";

const manifest = loadManifest(fileURLToPath(new URL("../../infrastructure/flags.json", import.meta.url)));
const B = "https://api.cloudflare.com/client/v4/accounts/acc/flagship/apps";

function fakeApi({ apps = [], flags = {}, status = null } = {}) {
  const log = [];
  const f = async (url, init = {}) => {
    const method = init.method || "GET";
    log.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers && init.headers.Authorization });
    const reply = (code, result) => ({ status: code, ok: code < 400, text: async () => JSON.stringify({ success: code < 400, result }) });
    if (status) return reply(status, null);
    if (url === B && method === "GET") return reply(200, apps);
    if (url === B && method === "POST") { apps.push({ id: "app1", name: init.body && JSON.parse(init.body).name }); return reply(200, { id: "app1" }); }
    const m = url.match(/\/apps\/([^/]+)\/flags$/);
    if (m && method === "GET") return reply(200, flags[m[1]] || []);
    if (m && method === "POST") { const b = JSON.parse(init.body); (flags[m[1]] ||= []).push(b); return reply(200, b); }
    return reply(404, null);
  };
  return { f, log };
}
const run = (api, extra = {}) => ensure({ fetch: api.f, accountId: "acc", token: "TOKEN-VALUE", manifest, ...extra });

test("the manifest is the leeroy-brain app, every flag defaults off, D1 feed first", () => {
  assert.equal(manifest.app, "leeroy-brain");
  assert.equal(manifest.flags[0].key, "d1-feed");
  assert.ok(manifest.flags.every((x) => x.default === "off"));
});

test("first run creates the app and every flag, disabled", async () => {
  const api = fakeApi();
  const r = await run(api);
  assert.equal(r.appId, "app1");
  assert.equal(r.created.app, true);
  assert.deepEqual(r.created.flags, manifest.flags.map((x) => x.key));
  const posts = api.log.filter((x) => x.method === "POST");
  assert.deepEqual(posts[0].body, appBody("leeroy-brain"));
  assert.ok(posts.slice(1).every((x) => x.body.enabled === false && x.body.default_variation === "off"));
  assert.ok(api.log.every((x) => x.auth === "Bearer TOKEN-VALUE"));
});

test("second run sends only GETs", async () => {
  const api = fakeApi();
  await run(api);
  const again = fakeApi({ apps: [{ id: "app1", name: "leeroy-brain" }], flags: { app1: manifest.flags.map((x) => ({ key: x.key, enabled: true })) } });
  const r = await run(again);
  assert.equal(r.appId, "app1");
  assert.deepEqual(again.log.map((x) => x.method), ["GET", "GET"]);
});

test("an existing flag is never PUT or POSTed; only the missing one is created", async () => {
  const keep = manifest.flags[0].key;
  const api = fakeApi({ apps: [{ id: "app1", name: "leeroy-brain" }], flags: { app1: manifest.flags.slice(0, -1).map((x) => ({ key: x.key, enabled: true })) } });
  const r = await run(api);
  assert.deepEqual(r.created.flags, [manifest.flags.at(-1).key]);
  assert.equal(api.log.some((x) => x.method === "PUT" || x.method === "DELETE"), false);
  assert.equal(api.log.some((x) => x.body && x.body.key === keep), false);
});

test("401 and 403 throw a PermissionError that names the permission, without the token", async () => {
  for (const code of [401, 403]) {
    await assert.rejects(run(fakeApi({ status: code })), (e) => e instanceof PermissionError && /Flagship Write/.test(e.message) && /Flagship Read/.test(e.message) && !e.message.includes("TOKEN-VALUE"));
  }
});

test("a transient failure is a plain Error, not a PermissionError", async () => {
  await assert.rejects(run(fakeApi({ status: 503 })), (e) => !(e instanceof PermissionError) && /503/.test(e.message));
});

test("dry run sends nothing and lists the planned requests", async () => {
  let sent = 0;
  const r = await ensure({ fetch: async () => { sent++; throw new Error("no"); }, accountId: "acc", token: "x", manifest, dryRun: true });
  assert.equal(sent, 0);
  assert.equal(r.planned.length, 2 + manifest.flags.length);
  assert.deepEqual(r.planned[2].body, flagBody(manifest.flags[0]));
});

test("flagBody is the documented boolean flag shape", () => {
  const b = flagBody({ key: "d1-feed", description: "x" });
  assert.deepEqual(b, { key: "d1-feed", description: "x", enabled: false, variations: { off: false, on: true }, default_variation: "off", rules: [] });
  assert.ok(b.default_variation in b.variations);
  assert.ok(b.key.length >= 1 && b.key.length <= 64);
  assert.equal(flagBody({ key: "k", description: "y".repeat(600) }).description.length, 512);
  for (const f of manifest.flags) assert.ok(f.key.length <= 64 && flagBody(f).description.length <= 512, f.key);
});

test("loadManifest rejects an on-by-default flag and a duplicate key", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fl-"));
  const w = (n, o) => { const p = path.join(dir, n); fs.writeFileSync(p, JSON.stringify(o)); return p; };
  assert.throws(() => loadManifest(w("a.json", { app: "x", flags: [{ key: "a", default: "on" }] })), /default/);
  assert.throws(() => loadManifest(w("b.json", { app: "x", flags: [{ key: "a", default: "off" }, { key: "a", default: "off" }] })), /duplicate/);
});
