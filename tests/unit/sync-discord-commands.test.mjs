// tools/sync-discord-commands.mjs: idempotent Discord slash command sync. All network is stubbed; nothing here talks to Discord or the Worker.
// The token is built at runtime so no token-shaped literal sits in the repository.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { run, normalize, canonical } from "../../tools/sync-discord-commands.mjs";

const TOKEN = ["MTU2", "fake", Math.random().toString(36).slice(2), "tokenvalue"].join(".");
const APP = "1561857940174938114";
const WORKER = "https://api.leeroy.party";
const TOOL = fileURLToPath(new URL("../../tools/sync-discord-commands.mjs", import.meta.url));

const SAY = {
  name: "say", description: "Post a message as the bot to a configured channel (server admins only)", default_member_permissions: "32", dm_permission: false,
  options: [
    { name: "channel", description: "Channel key", type: 3, required: true, autocomplete: true },
    { name: "text", description: "What to post", type: 3, required: true, max_length: 2000 },
  ],
};
const PING = { name: "ping", description: "Ping" };
const ACK = { name: "ack", description: "Acknowledge", options: [{ name: "up_to", description: "Highest", type: 4, required: true }] };
const MANIFEST = [PING, ACK, SAY];

// What Discord hands back for a stored command: ids, version, null localizations, defaults added.
const asDiscord = (c, extra = {}) => ({
  id: "9" + c.name.length, application_id: APP, version: "1", type: 1, nsfw: false, integration_types: [0], contexts: [0, 1, 2],
  name_localizations: null, description_localizations: null, default_member_permissions: null, dm_permission: true,
  ...c, options: (c.options || []).map((o) => ({ name_localizations: null, description_localizations: null, ...o })), ...extra,
});

function world({ manifest = { commands: MANIFEST }, live = [], status = {}, manifestStatus = 200, manifestBody } = {}) {
  const calls = [];
  const queue = { ...status };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const headers = init.headers || {};
    calls.push({ url: String(url), method, headers, body: init.body });
    const u = String(url);
    const key = `${method} ${u.startsWith(WORKER) ? "worker" : "discord"}`;
    const forced = queue[key]?.shift?.();
    if (forced) return new Response(JSON.stringify(forced.body ?? {}), { status: forced.status });
    if (u === `${WORKER}/api/discord/commands`) {
      return manifestBody !== undefined ? new Response(manifestBody, { status: manifestStatus }) : new Response(JSON.stringify(manifest), { status: manifestStatus });
    }
    if (u === `https://discord.com/api/v10/applications/${APP}/commands` && method === "GET") return new Response(JSON.stringify(live), { status: 200 });
    if (u === `https://discord.com/api/v10/applications/${APP}/commands` && method === "POST") return new Response(JSON.stringify({ id: "1" }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  return { calls, fetchImpl, posts: () => calls.filter((c) => c.method === "POST") };
}
async function go(w, argv = ["--apply"], env = {}) {
  const lines = [], errs = [], sleeps = [];
  const code = await run({ argv, env: { DISCORD_BOT_TOKEN: TOKEN, ...env }, fetchImpl: w.fetchImpl, out: (s) => lines.push(s), err: (s) => errs.push(s), sleep: async (ms) => { sleeps.push(ms); } });
  return { code, lines, errs, sleeps, text: [...lines, ...errs].join("\n") };
}
const postedNames = (w) => w.posts().map((c) => JSON.parse(c.body).name);

test("creates only the missing command and never overwrites the rest", async () => {
  const w = world({ live: [asDiscord(PING), asDiscord(ACK)] });
  const r = await go(w);
  assert.equal(r.code, 0);
  assert.deepEqual(postedNames(w), ["say"]);
  assert.match(r.text, /created: say/);
  assert.match(r.text, /unchanged: 2/);
});

test("a /say definition is posted with default_member_permissions 32 and guild-only", async () => {
  const w = world({ live: [asDiscord(PING), asDiscord(ACK)] });
  await go(w);
  const body = JSON.parse(w.posts()[0].body);
  assert.equal(body.name, "say");
  assert.equal(body.default_member_permissions, "32");
  assert.equal(body.dm_permission, false);
});

test("posts only the commands that differ and reports them as updated", async () => {
  const w = world({ live: [asDiscord(PING), asDiscord({ ...ACK, description: "Old text" }), asDiscord(SAY, { default_member_permissions: "32", dm_permission: false, contexts: [0] })] });
  const r = await go(w);
  assert.deepEqual(postedNames(w), ["ack"]);
  assert.match(r.text, /updated: ack/);
  assert.match(r.text, /created: none/);
  assert.match(r.text, /unchanged: 2/);
});

test("a changed option or a changed permission counts as different", async () => {
  const live = [asDiscord(PING), asDiscord(ACK), asDiscord(SAY, { default_member_permissions: null, dm_permission: false })];
  const w = world({ live });
  await go(w);
  assert.deepEqual(postedNames(w), ["say"]);
  const live2 = [asDiscord(PING), asDiscord({ ...ACK, options: [{ name: "up_to", description: "Highest", type: 4, required: false }] }), asDiscord(SAY, { dm_permission: false, default_member_permissions: "32" })];
  const w2 = world({ live: live2 });
  await go(w2);
  assert.deepEqual(postedNames(w2), ["ack"]);
});

test("everything already in sync: zero POSTs (idempotent), Discord's added defaults are ignored", async () => {
  const w = world({ live: MANIFEST.map((c) => asDiscord(c, c === SAY ? { default_member_permissions: "32", dm_permission: false, contexts: [0] } : {})) });
  const r = await go(w);
  assert.equal(r.code, 0);
  assert.equal(w.posts().length, 0);
  assert.match(r.text, /unchanged: 3/);
});

test("a second run after the first converges: nothing left to post", async () => {
  const live = [asDiscord(PING), asDiscord(ACK)];
  const w = world({ live });
  await go(w);
  const w2 = world({ live: [...live, asDiscord(SAY, { default_member_permissions: "32", dm_permission: false, contexts: [0] })] });
  await go(w2);
  assert.equal(w2.posts().length, 0);
});

test("Discord commands outside the manifest are left alone: only the manifest's names are ever written", async () => {
  const activity = { name: "launch", description: "Activity entry point", type: 4 };
  const w = world({ live: [asDiscord(PING), asDiscord(ACK), asDiscord(activity, { type: 4 })] });
  const r = await go(w);
  assert.deepEqual(postedNames(w), ["say"]);
  assert.doesNotMatch(r.text, /launch/);
});

test("no request is ever a PUT or a DELETE; the only write is POST to the application's commands URL", async () => {
  const w = world({ live: [] });
  await go(w);
  for (const c of w.calls) assert.ok(["GET", "POST"].includes(c.method), c.method);
  for (const c of w.posts()) assert.equal(c.url, `https://discord.com/api/v10/applications/${APP}/commands`);
  const src = readFileSync(TOOL, "utf8");
  assert.equal(/method:\s*["'](PUT|DELETE|PATCH)["']/.test(src), false);
  assert.equal(/["'](PUT|DELETE)["']/.test(src.replace(/\/\/.*$/gm, "")), false);
});

test("the token is only in the Authorization header of Discord calls and never in the output", async () => {
  const w = world({ live: [] });
  const r = await go(w);
  assert.equal(r.text.includes(TOKEN), false);
  for (const c of w.calls) {
    const h = JSON.stringify(c.headers);
    if (c.url.startsWith("https://discord.com/")) assert.equal(c.headers.Authorization, `Bot ${TOKEN}`);
    else assert.equal(h.includes(TOKEN), false, "the token never goes to the Worker");
    assert.equal(String(c.url).includes(TOKEN), false);
    assert.equal(String(c.body || "").includes(TOKEN), false);
  }
});

test("output is names and counts only: no ids, no bodies, no descriptions", async () => {
  const w = world({ live: [asDiscord(PING)] });
  const r = await go(w);
  assert.equal(r.text.includes(APP), false);
  assert.equal(/"|\{|\}/.test(r.text), false);
  assert.equal(r.text.includes("Post a message as the bot"), false);
});

test("missing DISCORD_BOT_TOKEN: warning, exit 0, no network", async () => {
  const w = world();
  const lines = [];
  const code = await run({ argv: ["--apply"], env: {}, fetchImpl: w.fetchImpl, out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(code, 0);
  assert.equal(w.calls.length, 0);
  assert.match(lines.join("\n"), /::warning::.*DISCORD_BOT_TOKEN/);
});

for (const code of [401, 403, 500]) {
  test(`Discord ${code} on the list: exit 0 with a warning, no token in the output, no writes`, async () => {
    const w = world({ status: { "GET discord": [{ status: code, body: { message: `bad ${TOKEN}` } }] } });
    const r = await go(w);
    assert.equal(r.code, 0);
    assert.match(r.text, new RegExp(`::warning::.*${code}`));
    assert.equal(r.text.includes(TOKEN), false);
    assert.equal(w.posts().length, 0);
  });
  test(`Discord ${code} on a write: exit 0 with a warning, stops, no token in the output`, async () => {
    const w = world({ live: [], status: { "POST discord": [{ status: code, body: {} }] } });
    const r = await go(w);
    assert.equal(r.code, 0);
    assert.match(r.text, new RegExp(`::warning::.*${code}`));
    assert.equal(r.text.includes(TOKEN), false);
    assert.equal(w.posts().length, 1, "stops at the first failure");
  });
}

test("a network error whose message contains the token is scrubbed and still exits 0", async () => {
  const w = world();
  const boom = async (url) => { if (String(url).startsWith("https://discord.com")) throw new Error(`socket hang up Bot ${TOKEN}`); return w.fetchImpl(url); };
  const lines = [];
  const code = await run({ argv: ["--apply"], env: { DISCORD_BOT_TOKEN: TOKEN }, fetchImpl: boom, out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(code, 0);
  assert.equal(lines.join("\n").includes(TOKEN), false);
  assert.match(lines.join("\n"), /::warning::/);
});

test("429 honours retry_after once, then continues", async () => {
  const w = world({ live: [], status: { "POST discord": [{ status: 429, body: { retry_after: 2.5 } }] } });
  const r = await go(w);
  assert.deepEqual(r.sleeps, [2500]);
  assert.equal(r.code, 0);
  assert.equal(w.posts().length, 3 + 1, "one rate-limited attempt, then the three commands");
  assert.match(r.text, /created: ping, ack, say/);
});

test("a second 429 stops with a warning and exits 0", async () => {
  const w = world({ live: [], status: { "POST discord": [{ status: 429, body: { retry_after: 1 } }, { status: 429, body: { retry_after: 1 } }] } });
  const r = await go(w);
  assert.equal(r.code, 0);
  assert.equal(r.sleeps.length, 1, "waits once only");
  assert.match(r.text, /::warning::.*rate limited/);
  assert.equal(w.posts().length, 2);
});

test("dry run (the default) reads both sides and makes zero writes", async () => {
  const w = world({ live: [asDiscord(PING)] });
  const r = await go(w, []);
  assert.equal(r.code, 0);
  assert.equal(w.posts().length, 0);
  assert.equal(w.calls.length, 2);
  assert.match(r.text, /would create: ack, say/);
  const r2 = await go(world({ live: [asDiscord(PING)] }), ["--dry-run"]);
  assert.match(r2.text, /would create/);
});

test("malformed manifest: exit 1 and no Discord call", async () => {
  for (const bad of [{ commands: "nope" }, { nothing: true }, { commands: [] }, { commands: [{ description: "no name" }] }, { commands: [{ name: "Bad Name!", description: "x" }] },
    { commands: [PING, PING] }, { commands: [{ name: "x" }] }]) {
    const w = world({ manifest: bad });
    const r = await go(w);
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.equal(w.calls.filter((c) => c.url.startsWith("https://discord.com")).length, 0);
    assert.equal(r.text.includes(TOKEN), false);
  }
  const w = world({ manifestBody: "<html>not json</html>" });
  assert.equal((await go(w)).code, 1);
});

test("a manifest that cannot be fetched (HTTP error) is a warning, exit 0", async () => {
  const r = await go(world({ manifestStatus: 502, manifestBody: "bad gateway" }));
  assert.equal(r.code, 0);
  assert.match(r.text, /::warning::.*502/);
});

test("an unknown flag exits 1 and does no network", async () => {
  const w = world();
  const r = await go(w, ["--apply", "--force"]);
  assert.equal(r.code, 1);
  assert.equal(w.calls.length, 0);
});

test("WORKER_URL and DISCORD_APP_ID are read from the environment", async () => {
  const w = world();
  const calls = [];
  const f = async (url, init) => { calls.push(String(url)); return w.fetchImpl(url.replace("https://staging.example.test", WORKER).replace("/applications/12345678", `/applications/${APP}`), init); };
  await run({ argv: [], env: { DISCORD_BOT_TOKEN: TOKEN, WORKER_URL: "https://staging.example.test/", DISCORD_APP_ID: "12345678" }, fetchImpl: f, out: () => {}, err: () => {} });
  assert.equal(calls[0], "https://staging.example.test/api/discord/commands");
  assert.equal(calls[1], "https://discord.com/api/v10/applications/12345678/commands");
});

test("normalize: Discord-added defaults and null localizations do not change the canonical form", () => {
  assert.equal(canonical(asDiscord(PING)), canonical(PING));
  assert.equal(canonical(asDiscord(SAY, { default_member_permissions: 32, dm_permission: false })), canonical(SAY), "a numeric permission string matches");
  assert.equal(normalize({ name: "a", description: "b", contexts: [0] }).dm_permission, false, "guild-only contexts mean no DM");
  assert.notEqual(canonical({ ...PING, description: "Pong" }), canonical(PING));
});

test("the CLI: no token exits 0 with a warning and an unknown flag exits 1 (real process, no network reached)", () => {
  const env = { ...process.env }; delete env.DISCORD_BOT_TOKEN;
  const a = spawnSync(process.execPath, [TOOL, "--apply"], { env, encoding: "utf8" });
  assert.equal(a.status, 0);
  assert.match(a.stdout, /::warning::/);
  const b = spawnSync(process.execPath, [TOOL, "--bogus"], { env, encoding: "utf8" });
  assert.equal(b.status, 1);
});

// ---- the workflow step that runs it ------------------------------------------------------------------------------------------------------
const wf = parse(readFileSync(fileURLToPath(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url)), "utf8"));
const steps = wf.jobs["deploy-production"].steps;
const idx = (re) => steps.findIndex((s) => re.test(s.name || ""));

test("the deploy runs the command sync as a non-failing step after the Worker deploy, the secret sync and the health check", () => {
  const i = idx(/^Sync Discord slash commands \(idempotent, never deletes\)$/);
  assert.ok(i >= 0);
  const step = steps[i];
  assert.equal(step["continue-on-error"], true);
  assert.equal(step.run.trim(), "node tools/sync-discord-commands.mjs --apply");
  assert.equal(step.env.DISCORD_BOT_TOKEN, "${{ secrets.DISCORD_BOT_TOKEN }}");
  assert.equal(step.env.WORKER_URL, "https://api.leeroy.party");
  assert.ok(i > idx(/^Deploy Cloudflare Worker/), "after the Worker deploy");
  assert.ok(i > idx(/^Sync Worker Secrets/), "after the secret sync");
  assert.ok(i > idx(/^Post-deploy health check/), "after the health check, so the manifest is the new version's");
});
