// The preview crawl (tests/helpers/preview-crawl.mjs), run against a local Worker over in-memory SQLite and the repo's real data/*.json documents.
// Two jobs: (1) the crawl is green on the real code and restores the sheet it hid; (2) it goes RED when a route re-exposes a hidden value (a projection bypass on
// GET /api/data/party, a leak in a header, a leak in the live socket) and when the restore would not hold. That second part proves the CI test can fail.
// The same crawl runs against the real PR preview in tests/api/preview-crawl.test.mjs. No network, no AI. Real documents, made-up salts and token.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { purgeWorkerCache, PARTY_CACHE_PATHS } from "../../infrastructure/worker/index.js";
import { BoardRoom } from "../../infrastructure/worker/room.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { invalidatePagesCache } from "../../infrastructure/worker/ai-models.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { crawlPaths, runPreviewCrawl, canaryRegex, buildCanaries, formatTable, assertPreviewBase, MIN_CANARY_LENGTH } from "../helpers/preview-crawl.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });
test.after(() => { globalThis.fetch = realFetch; });

const ROOT = new URL("../../", import.meta.url);
const ORIGIN = "https://api.test";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const AT = "2026-11-12T00:00:00.000Z";
const admin = { Authorization: `Bearer ${ADMIN}` };
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

async function makeEnv({ preview = true } = {}) {
  invalidatePagesCache(); invalidateConfigCache();
  await purgeWorkerCache(ORIGIN, [...PARTY_CACHE_PATHS, "/api/signups", "/api/data/signups", "/api/data/signups.json"]);
  const DB = schemaDb();
  const kv = (k, v) => DB.raw.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").run(k, typeof v === "string" ? v : JSON.stringify(v), AT);
  for (const n of ["party", "decide", "tonight", "guided-atlas", "client", "launch"]) kv(n, readFileSync(new URL(`data/${n}.json`, ROOT), "utf8"));
  kv("signups", { generated: AT, present: true, updated: AT, options: { meet: [], when: [] }, entries: [], tallies: {} });
  const anon = { got: [], send(m) { anon.got.push(m); }, serializeAttachment() {}, deserializeAttachment() { return null; } };
  const room = new BoardRoom({ getWebSockets: () => [anon], setWebSocketAutoResponse() {}, acceptWebSocket() {} }, { DB });
  invalidateConfigCache();
  return { ...(preview ? { IS_PR_PREVIEW: "1" } : {}), anon, room, DB, KEY_SALT: "key-salt-for-tests-0123456789", USER_SALT: "user-salt-for-tests-0123456789", BOARD_ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: "",
    BOARD_ROOM: { idFromName: () => "r", get: () => ({ fetch: (u, init) => room.fetch(u instanceof Request ? u : new Request(u, init)) }) }, BOARD_PUBLIC_URL: "https://leeroy.test" };
}
let ipN = 0;
// `tamper(method, path, headers, res, raw)` may replace an answer: that is the mutation. The env says IS_PR_PREVIEW, so the real GET /api/health answers isPrPreview:true.
function harness(env, { tamper } = {}) {
  const raw = async (method, path, { headers = {}, body } = {}) => {
    const init = { method, headers: { "CF-Connecting-IP": `203.0.113.${(ipN++ % 200) + 1}`, ...headers } };
    if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
    const res = await quiet(() => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx));
    return { status: res.status, text: await res.text(), headers: [...res.headers] };
  };
  const call = async (method, path, o = {}) => {
    const out = await raw(method, path, o);
    return tamper ? tamper(method, path, o.headers || {}, out, raw) : out;
  };
  const live = async (trigger) => {
    env.anon.got.length = 0;
    const sent = [];
    globalThis.WebSocketPair = function () { return { 0: {}, 1: { send: (m) => sent.push(m), serializeAttachment() {} } }; };
    try { await env.room.fetch(new Request("https://room.internal/api/live", { headers: { Upgrade: "websocket" } })); } catch { /* status 101 cannot be built in Node */ }
    delete globalThis.WebSocketPair;
    await trigger();
    return [...sent, ...env.anon.got];
  };
  return { call, live, raw };
}
const fieldsOf = async (h) => JSON.parse((await h.raw("GET", "/api/sheet", { headers: admin })).text).sheet.fields;
const same = (a, b) => Object.keys(a).every((k) => JSON.stringify([a[k].value, a[k].visible !== false]) === JSON.stringify([b[k] ? b[k].value : null, !b[k] || b[k].visible !== false]));

async function crawl(opts = {}) {
  const env = await makeEnv();
  const h = harness(env, opts);
  const before = await fieldsOf(h);
  const lines = [];
  let report = null, error = null;
  try { report = await runPreviewCrawl({ call: h.call, live: opts.live || h.live, admin, say: (s) => lines.push(s) }); } catch (e) { error = e; }
  return { report, error, before, after: await fieldsOf(h), lines, h };
}

test("what is a canary: case-insensitive, plural, word boundary; short and shared values are not searched", () => {
  const rx = canaryRegex("mage");
  assert.ok(rx.test("Undead Frost MAGE") && rx.test("the mages") && !rx.test("an image") && !rx.test("damage") && !rx.test("mageblast"));
  assert.ok(canaryRegex("#3fc7eb").test("color #3FC7EB;"));
  const b = buildCanaries({ sheetFields: { level: { value: 40 }, race: { value: "undead" }, class: { value: "mage" } }, docMember: { class: "Mage", class_key: "mage", race: "Undead" }, others: [{ race: "Undead", class: "Priest" }], planted: { goals: "qzgoal1", launch_state: "qzl1" } });
  assert.ok(b.skipped.includes("level"), "a level of 2 characters is skipped");
  assert.ok(b.shared.includes("race"), "a race another member carries is shared, not searched");
  assert.ok(b.canaries.some((c) => c.field === "class" && c.value === "mage") && !b.canaries.some((c) => c.field === "race"));
  assert.equal(MIN_CANARY_LENGTH, 3);
});

test("the route list is derived from ROUTES, the public document sets and the dispatcher regexes, plain and with the odd query", () => {
  const list = crawlPaths();
  const paths = list.map((p) => p.path);
  assert.ok(list.length >= 60, `derived ${list.length}`);
  for (const must of ["/health", "/state", "/bootstrap", "/data/party", "/data/guided-atlas.json", "/atlas/marks", "/library/index.json", "/signups", "/live"]) assert.ok(paths.includes(must), must);
  assert.ok(paths.includes("/data/party?full=1&raw=1&admin=1&debug=1&x=1") && paths.includes("/health?full=1&raw=1&admin=1&debug=1&x=1"));
  assert.ok(!list.some((p) => p.path.includes("*") || p.path.includes(":")), "no pattern is left unexpanded");
});

test("the guard: a production host is refused", () => {
  for (const h of ["https://api.leeroy.party", "https://leeroy.party/", "https://LEEROY.PARTY"]) assert.throws(() => assertPreviewBase(h), /refusing/);
  assert.doesNotThrow(() => assertPreviewBase("https://leeroy-brain-pr-333.example.workers.dev"));
});

test("the crawl is refused (fails, not skipped) when /api/health does not say isPrPreview:true", async () => {
  const env = await makeEnv({ preview: false });
  const h = harness(env);
  await assert.rejects(runPreviewCrawl({ call: h.call, live: h.live, admin }), /isPrPreview/);
});

test("GREEN: on the real code the crawl finds nothing, reads the live socket, and puts every line back", async () => {
  const { report, error, before, after, lines } = await crawl();
  assert.equal(error, null, error && error.message);
  assert.deepEqual(report.hits, [], `hits: ${report.hits}; routes: ${report.routes.filter((r) => r.hits.length).map((r) => r.path + "=" + r.hits).join(" ")}; live: ${report.live.hits}`);
  assert.equal(report.restored, true);
  assert.ok(report.routes.length >= 60 && report.routes.every((r) => r.status > 0));
  assert.ok(report.live.messages >= 2, "the greeting and the broadcast");
  assert.ok(report.canaries.searched.class && report.canaries.searched.goals && report.canaries.searched.launch_state);
  assert.ok(same(before, after), "every line is as it was");
  assert.ok(!report.routes.some((r) => r.status >= 500), `5xx: ${report.routes.filter((r) => r.status >= 500).map((r) => r.path)}`);
  process.stdout.write(`${lines.join("\n")}\n${formatTable(report)}\n`);
});

test("RED: GET /api/data/party answers the stored document (a projection bypass): the crawl names the fields and still restores the sheet", async () => {
  const bypass = async (m, p, headers, res, raw) => (m === "GET" && /^\/api\/data\/party(\?|$)/.test(p) && !headers.Authorization ? { ...res, text: (await raw("GET", "/api/data/party?stored=1", { headers: admin })).text } : res);
  const { report, before, after } = await crawl({ tamper: bypass });
  assert.ok(report.hits.length >= 3, `hits: ${report.hits}`);
  for (const f of ["class", "class_key", "board_line"]) assert.ok(report.hits.includes(f), `${f} is reported`);
  assert.ok(report.routes.some((r) => r.path.startsWith("/data/party") && r.hits.length), "the route that leaks is named");
  assert.equal(report.restored, true);
  assert.ok(same(before, after), "every line is as it was after a red run");
  process.stdout.write(`red run hits (field names): ${report.hits.join(", ")}\n`);
});

test("RED: a leak in a response header is found", async () => {
  const header = async (m, p, headers, res) => (p.startsWith("/api/signups") ? { ...res, headers: [...res.headers, ["x-debug-board-line", "Undead Frost Mage, Fire at 40"]] } : res);
  const { report } = await crawl({ tamper: header });
  assert.ok(report.hits.includes("board_line"), `hits: ${report.hits}`);
});

test("RED: a leak only in the live socket is found", async () => {
  const env = await makeEnv();
  const h = harness(env);
  const live = async (trigger) => [...(await h.live(trigger)), JSON.stringify({ type: "data", key: "party", data: { members: [{ name: "Bloise", class_key: "mage" }] } })];
  const report = await runPreviewCrawl({ call: h.call, live, admin });
  assert.ok(report.live.hits.includes("class_key"), `live hits: ${report.live.hits}`);
  assert.ok(report.hits.includes("class_key") && report.restored);
});

test("RED: a sheet that cannot be put back fails the run (the restore is asserted)", async () => {
  let restoring = false;
  const env = await makeEnv();
  const h = harness(env);
  const call = async (m, p, o = {}) => (m === "POST" && p === "/api/sheet" && restoring && o.body && o.body.field === "race" && o.body.visible === true ? { status: 200, text: "{}", headers: [] } : h.call(m, p, o));
  const live = async (trigger) => { const r = await h.live(trigger); restoring = true; return r; };
  await assert.rejects(runPreviewCrawl({ call, live, admin }), /not restored for: race/);
});
