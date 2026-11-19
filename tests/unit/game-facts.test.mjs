// THE GAME-FACTS STORE (migration 0016, POST /api/facts/load, lookupGameFacts, tools/facts-load.mjs). Real Worker code over an in-memory SQLite D1 built from schema.sql (FTS5 included); synthetic, fictional facts only;
// no network (the tool's fetch goes to the Worker in-process or to a local stub); nothing here is client data.
//   gate      flag off / PR preview / no bot token = 404; bad, stale or foreign-key signature = 401; body over 256 KB = 413; replay and a not-newer timestamp = 409; 120 accepted calls an hour = 429
//   write     strict validation refuses the WHOLE batch; upsert is idempotent; begin conflict; finish diff and supersede; an unfinished or failed load is invisible; rows are never deleted
//   lookup    name windows through the index (apostrophes, colons, hyphens, rank suffixes both ways), ambiguity returns every row, hostile input stays a bound value; wrong rows are do-not-say; superseded and unverifiable excluded; no friend data anywhere
//   tool      dry run sends nothing; host rules; token never printed; redirect refused; resume after a failed batch; repo-write refused
// Run: node --test tests/unit/game-facts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import worker from "../../infrastructure/worker/index.js";
import { handleFactsLoad, validateRow, parseFactsBody, FACTS_STATE_KEY, FACTS_MAX_BODY, FACTS_PER_HOUR, FACT_KINDS } from "../../infrastructure/worker/game-facts.js";
import { lookupGameFacts, questionWindows, candidateKeys, buildNameSql, buildCuratedSql, chooseNames, curatedMatches, askedRank, parseNote, LOOKUP_MAX_KEYS, LOOKUP_MAX_TOKENS } from "../../infrastructure/worker/game-facts-lookup.js";
import { normName, baseName } from "../../infrastructure/worker/game-facts-name.js";
import { signListen, listenerKey, shadowKey, heartbeatKey, heartbeatStatusKey, factsLoadKey, FACTS_LOAD_KEY_LABEL, resetListenerKeyCacheForTests, resetHeartbeatKeyCacheForTests } from "../../infrastructure/worker/listener-config.js";
import { schemaDb } from "../helpers/sqlite-d1.mjs";
import { run as runTool, checkBase, buildPlan, deriveRankRows, deriveTableRows, rankStats, rankNote, deriveTraitRows, deriveCuratedRows, curatedBuild, batch, nameStats, writeCost, KIND_ORDER, DEFAULT_ROW_BUDGET, WRITES_PER_FACT, WRITES_PER_SUFFIXED_FACT, WRITES_PER_CALL, WRITES_PER_RETIRED_FACT } from "../../tools/facts-load.mjs";
import { sha256 } from "../../tools/replay/common.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BOT = ["bot", "token", "for", "facts", "0123456789"].join("-");
const KEY = await factsLoadKey(BOT);
const ctx = { waitUntil() {}, passThroughOnException() {} };
const quiet = async (fn) => { const real = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = real; } };

let seq = 0; // each call signs its own second, all inside the 120 s window and strictly increasing: now - 100 + seq
const nowS = () => Math.floor(Date.now() / 1000);
const nextTs = () => nowS() - 100 + seq++;
test.beforeEach(() => { resetListenerKeyCacheForTests(); resetHeartbeatKeyCacheForTests(); seq = 0; });

const mkEnv = (DB, extra = {}) => ({ DB, DISCORD_BOT_TOKEN: BOT, GAME_FACTS_LOAD: "on", ...extra });
async function call(env, obj, { key = KEY, ts = null, sig = null, raw = null, headers = true, handler = null, deps = {} } = {}) {
  const body = raw ?? JSON.stringify(obj);
  if (ts === null) ts = nextTs();
  const h = { "Content-Type": "application/json" };
  if (headers) { h["X-Listen-Timestamp"] = String(ts); h["X-Listen-Signature"] = sig ?? (await signListen(key, String(ts), body)); }
  const req = new Request("https://worker.test/api/facts/load", { method: "POST", headers: h, body });
  const res = handler ? await handler(req, env, deps) : await quiet(() => worker.fetch(req, env, ctx));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, ts };
}
const P = "facts-load";
const BUILD = "9.9.9.1";
const BUILD2 = "9.9.9.2";
const SHA = "a".repeat(64);
const FILES = { "spelllevels.csv": { sha256: SHA, bytes: 10, rows: 3 } };
const begin = (env, { kind = "client", build = BUILD, kinds = kind === "curated" ? { curated: 3 } : { spell_level: 3 }, opts } = {}) => call(env, { purpose: P, op: "begin", build, manifest_sha256: SHA, files: FILES, kind, kinds }, opts);
const kindsOf = (rows) => rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
const mkRow = (i, over = {}) => ({ id: `spelllevels:${i}`, kind: "spell_level", subject: `Zorbo ${["Alpha", "Beta", "Gamma", "Delta", "Epsilon"][i % 5]} Bolt${i}`, claim: `Zorbo ${["Alpha", "Beta", "Gamma", "Delta", "Epsilon"][i % 5]} Bolt${i} requires level ${i + 4}.`, value: String(i + 4), unit: "level", source_table: "spelllevels", row_id: String(i), build: BUILD, verdict: "holds", source_class: "client-db2", note: "", ...over });
const rowsOp = (env, loadId, rows, opts) => call(env, { purpose: P, op: "rows", load_id: loadId, rows }, opts);
const finish = (env, loadId, opts) => call(env, { purpose: P, op: "finish", load_id: loadId }, opts);
async function loadAll(env, rows, { kind = "client", build = BUILD } = {}) {
  const b = await begin(env, { kind, build, kinds: kindsOf(rows) });
  assert.equal(b.status, 200, b.text);
  const r = await rowsOp(env, b.json.load_id, rows);
  assert.equal(r.status, 200, r.text);
  const f = await finish(env, b.json.load_id);
  assert.equal(f.status, 200, f.text);
  return { id: b.json.load_id, finish: f.json };
}
const one = (DB, sql, ...a) => DB.raw.prepare(sql).get(...a);
const all = (DB, sql, ...a) => DB.raw.prepare(sql).all(...a).map((r) => ({ ...r }));
const nGood = (n, from = 1) => Array.from({ length: n }, (_, i) => mkRow(from + i));
const fresh = async () => { const DB = await schemaDb(); return { DB, env: mkEnv(DB) }; };

// ---- gate ----------------------------------------------------------------------------------------------------------------------------------------
test("flag off, unset or any value but on: 404 for a validly signed call, nothing read or written", async () => {
  for (const v of ["off", undefined, "", "true", "1", "yes", "dry"]) {
    const { DB } = await fresh();
    const before = one(DB, "SELECT COUNT(*) AS c FROM kv_state").c;
    const r = await begin(mkEnv(DB, { GAME_FACTS_LOAD: v }));
    assert.equal(r.status, 404, String(v));
    assert.deepEqual(r.json, { error: "not found" });
    assert.equal(one(DB, "SELECT COUNT(*) AS c FROM kv_state").c, before);
    assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 0);
  }
  const { DB } = await fresh();
  assert.equal((await begin(mkEnv(DB, { GAME_FACTS_LOAD: " ON " }))).status, 200, "trimmed and case-folded, like the other flags");
});

test("a PR preview and a missing or short bot token: 404", async () => {
  const { DB } = await fresh();
  for (const extra of [{ IS_PR_PREVIEW: "true" }, { PR_NUMBER: "12" }, { WORKER_NAME: "leeroy-board-pr-12" }, { DISCORD_BOT_TOKEN: undefined }, { DISCORD_BOT_TOKEN: "short" }]) {
    const r = await begin(mkEnv(DB, extra));
    assert.equal(r.status, 404, JSON.stringify(extra));
  }
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 0);
});

test("the route is on the Worker's route table and answers only POST", async () => {
  const { ROUTES } = await import("../../infrastructure/worker/index.js");
  assert.ok(ROUTES.includes("POST /facts/load"));
  const { env } = await fresh();
  const res = await worker.fetch(new Request("https://worker.test/api/facts/load", { method: "GET" }), env, ctx);
  assert.notEqual(res.status, 200);
});

test("signature: missing headers, a wrong signature, a stale or future timestamp, a non-integer timestamp: 401", async () => {
  const { DB, env } = await fresh();
  const body = JSON.stringify({ purpose: P, op: "begin", build: BUILD, manifest_sha256: SHA, files: FILES, kind: "client", kinds: { spell_level: 3 } });
  assert.equal((await call(env, null, { raw: body, headers: false })).status, 401);
  assert.equal((await call(env, null, { raw: body, sig: "0".repeat(64) })).status, 401);
  assert.equal((await call(env, null, { raw: body, ts: nowS() - 600 })).status, 401, "stale");
  assert.equal((await call(env, null, { raw: body, ts: nowS() + 600 })).status, 401, "future");
  assert.equal((await call(env, null, { raw: body, ts: "1.5", sig: await signListen(KEY, "1.5", body) })).status, 401);
  const bad = await call(env, null, { raw: body });
  assert.equal(bad.status, 200);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 1, "only the validly signed call wrote");
  const r = await call(env, null, { raw: body, sig: bad.ts && "f".repeat(64) });
  assert.equal(r.status, 401);
  assert.deepEqual(Object.keys((await call(env, null, { raw: body, headers: false })).json).sort(), ["ok", "reason"]);
});

test("every other derived key is refused: listener, self-test (the listener key), shadow, heartbeat per source, heartbeat status", async () => {
  const { DB, env } = await fresh();
  assert.equal(FACTS_LOAD_KEY_LABEL, "leeroy-facts-load-v1");
  const keys = { listener: await listenerKey(BOT), shadow: await shadowKey(BOT), hbBot: await heartbeatKey(BOT, "pc-bot"), hbSession: await heartbeatKey(BOT, "pc-session"), hbStatus: await heartbeatStatusKey(BOT) };
  for (const [name, k] of Object.entries(keys)) {
    const r = await begin(env, { opts: { key: k } });
    assert.equal(r.status, 401, name);
  }
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 0);
  assert.equal((await begin(env)).status, 200, "the facts key works");
  // and the facts key opens no other signed route
  const body = JSON.stringify({ purpose: P, op: "begin" });
  const ts = nextTs();
  for (const path of ["/api/shadow/ask", "/api/heartbeat", "/api/heartbeat/status", "/api/listen", "/api/selftest/claude"]) {
    const sig = await signListen(KEY, String(ts), body);
    const res = await quiet(() => worker.fetch(new Request(`https://worker.test${path}`, { method: "POST", headers: { "X-Listen-Timestamp": String(ts), "X-Listen-Signature": sig }, body }), mkEnv(DB, { SHADOW_ASK: "on", DEADMAN: "on", LISTENER: "live", ASK_RESEARCH: "on" }), ctx));
    assert.ok([401, 404, 400].includes(res.status), `${path} answered ${res.status}`);
    assert.notEqual(res.status, 200, path);
  }
});

test("body cap: over 256 KB is 413 before the signature is read (declared or streamed); at the cap a valid call still passes the cap", async () => {
  const { DB, env } = await fresh();
  const huge = JSON.stringify({ purpose: P, op: "rows", load_id: "x", rows: [], pad: "p".repeat(FACTS_MAX_BODY) });
  const r = await call(env, null, { raw: huge });
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { ok: false, reason: "too_large" });
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM kv_state WHERE key = ?", FACTS_STATE_KEY).c, 0);
  const req = new Request("https://worker.test/api/facts/load", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(FACTS_MAX_BODY + 10))); c.close(); } }), duplex: "half" });
  assert.equal((await handleFactsLoad(req, env)).status, 413);
});

test("replay: the same signed request twice is 409; an older or equal signed second is 409; a newer one passes; refusals write nothing", async () => {
  const { DB, env } = await fresh();
  const ts = nextTs();
  const a = await begin(env, { opts: { ts } });
  assert.equal(a.status, 200);
  const again = await begin(env, { opts: { ts } });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { ok: false, reason: "replay" });
  assert.equal((await begin(env, { kind: "curated", opts: { ts: ts - 5 } })).status, 409, "older second, even with a fresh signature over a different body");
  assert.equal((await begin(env, { kind: "curated", opts: { ts: ts + 1 } })).status, 200);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 2);
  assert.equal(JSON.parse(one(DB, "SELECT json FROM kv_state WHERE key = ?", FACTS_STATE_KEY).json).last_ts, ts + 1);
});

test("rate limit: 120 accepted calls in an hour, the 121st is 429 with Retry-After; calls beyond are not recorded; an hour later it passes", async () => {
  const { DB, env } = await fresh();
  const t0 = Date.now();
  const hits = Array.from({ length: FACTS_PER_HOUR }, (_, i) => t0 - 3000 * (i + 1));
  DB.raw.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, 'x')").run(FACTS_STATE_KEY, JSON.stringify({ last_ts: 0, hits }));
  const r = await begin(env);
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "rate_limited");
  assert.ok(r.json.retry_after >= 1);
  assert.equal(JSON.parse(one(DB, "SELECT json FROM kv_state WHERE key = ?", FACTS_STATE_KEY).json).hits.length, FACTS_PER_HOUR, "the refused call is not recorded");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 0);
  const later = await begin(env, { opts: { handler: handleFactsLoad, deps: { now: () => new Date(t0 + 2 * 3600 * 1000) } } });
  assert.equal(later.status, 200);
});

test("only the facts-load purpose and the listed keys are accepted: a signed listener event, self-test or heartbeat body is 400 and writes nothing", async () => {
  const { DB, env } = await fresh();
  for (const body of [{}, { purpose: "shadow-ask", question: "x" }, { purpose: "heartbeat", source: "pc-bot" }, { purpose: P }, { purpose: P, op: "drop" }, { purpose: P, op: "begin", extra: 1, build: BUILD, manifest_sha256: SHA, files: FILES, kind: "client", kinds: { spell_level: 3 } },
    { purpose: P, op: "finish", load_id: "00000000-0000-0000-0000-000000000000", rows: [] }, [], "x", { purpose: P, op: "rows", load_id: "../etc", rows: [mkRow(1)] }]) {
    const r = await call(env, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const raw = await call(env, null, { raw: "{not json" });
  assert.equal(raw.status, 400);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 0);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, 0);
});

// ---- begin / rows / finish -----------------------------------------------------------------------------------------------------------------------
test("begin validates every field; the response is fixed fields only", async () => {
  const { env } = await fresh();
  const good = { purpose: P, op: "begin", build: BUILD, manifest_sha256: SHA, files: FILES, kind: "client", kinds: { spell_level: 3 } };
  for (const [name, patch] of Object.entries({ build: { build: "v1.2" }, build2: { build: "1" }, buildLong: { build: "1.".repeat(20) }, sha: { manifest_sha256: "A".repeat(64) }, kind: { kind: "other" }, kinds0: { kinds: {} }, kindsBig: { kinds: { spell_level: 1e9 } }, kindsStr: { kinds: { spell_level: "3" } }, kindsUnknown: { kinds: { friend: 3 } }, kindsCurated: { kinds: { curated: 3 } }, kindsArr: { kinds: [] }, kindsZero: { kinds: { spell_level: 0 } }, kindsNeg: { kinds: { spell_level: -1 } }, noKinds: { kinds: undefined },
    files: { files: {} }, filesArr: { files: [] }, fileName: { files: { "../x": FILES["spelllevels.csv"] } }, fileKey: { files: { a: { sha256: SHA, bytes: 1, rows: 1, extra: 1 } } }, fileSha: { files: { a: { sha256: "zz", bytes: 1, rows: 1 } } }, fileBytes: { files: { a: { sha256: SHA, bytes: -1, rows: 1 } } } })) {
    const r = await call(env, { ...good, ...patch });
    assert.equal(r.status, 400, name);
  }
  const ok = await call(env, good);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json).sort(), ["accepted", "load_id", "ok"]);
  assert.match(ok.json.load_id, /^[0-9a-f-]{36}$/);
});

test("begin conflict: a second begin of the same kind while one is open is 409; another kind is fine; after 30 minutes the dead open load is marked failed and a new one opens", async () => {
  const { DB, env } = await fresh();
  const a = await begin(env);
  assert.equal(a.status, 200);
  const b = await begin(env);
  assert.equal(b.status, 409);
  assert.deepEqual(b.json, { ok: false, reason: "conflict" });
  assert.equal((await begin(env, { kind: "curated" })).status, 200);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 2);
  const late = await begin(env, { opts: { handler: handleFactsLoad, deps: { now: () => new Date(Date.now() + 31 * 60 * 1000) } } });
  assert.equal(late.status, 200);
  assert.equal(one(DB, "SELECT status FROM game_fact_loads WHERE id = ?", a.json.load_id).status, "failed");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads WHERE kind = 'client' AND status = 'open'").c, 1);
  const young = await begin(env, { opts: { handler: handleFactsLoad, deps: { now: () => new Date(Date.now() + 33 * 60 * 1000) } } });
  assert.equal(young.status, 409, "the new open load is younger than 30 minutes");
});

test("rows: a good batch is stored and counted; the response has fixed fields only", async () => {
  const { DB, env } = await fresh();
  const b = await begin(env, { kinds: { spell_level: 3 } });
  const r = await rowsOp(env, b.json.load_id, nGood(3));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["accepted", "load_id", "ok"]);
  assert.equal(r.json.accepted, 3);
  const row = one(DB, "SELECT * FROM game_facts WHERE id = 'spelllevels:2'");
  assert.equal(row.subject_norm, normName(row.subject));
  assert.equal(row.subject_base, baseName(row.subject_norm));
  assert.equal(row.load_id, b.json.load_id);
  assert.equal(row.superseded, 0);
  assert.equal(JSON.parse(one(DB, "SELECT counts_json FROM game_fact_loads WHERE id = ?", b.json.load_id).counts_json).added, 3);
});

test("strict validation: ONE bad row refuses the WHOLE batch (400 invalid_row), nothing is written, and the timestamp is not consumed", async () => {
  const { DB, env } = await fresh();
  const b = await begin(env, { kinds: { spell_level: 5 } });
  const long = (n) => "x".repeat(n);
  const LOAD_DEPENDENT = new Set(["curatedKindOnClient", "buildOther", "build2"]);
  const bad = {
    kind: { kind: "friend" }, curatedKindOnClient: { kind: "curated", id: "curated:C1" }, id: { id: "Spell:1" }, id2: { id: "spell:" }, id3: { id: "spell:../etc" }, id4: { id: `spell:${long(41)}` }, idCurated: { id: "curated:1", kind: "spell_level" },
    subject: { subject: long(121) }, subjectEmpty: { subject: "" }, claim: { claim: long(401) }, claimEmpty: { claim: "" }, value: { value: long(81) }, note: { note: long(301) },
    unit: { unit: "furlongs" }, verdict: { verdict: "maybe" }, source_class: { source_class: "friend-said" }, build: { build: "v9" }, build2: { build: "1.2" }, buildOther: { build: BUILD2 },
    table: { source_table: "Spell Levels" }, rowid: { row_id: "1 2" }, num: { value: 5 }, nullClaim: { claim: null }, arrClaim: { claim: ["x"] },
    ctl: { claim: "fine\u0000text" }, ctl2: { claim: "line\nbreak" }, ctl3: { subject: "tab\there" }, ctl4: { note: "esc\u001b[0m" }, ctl5: { claim: "zero\u200bwidth" }, ctl6: { claim: "bidi\u202etext" }, ctl7: { claim: "sep\u2028x" }, del: { claim: "del\u007f" },
    extra: { slug: "red-fox" }, extra2: { author: "x" }, extra3: { asker_slug: "x" }, extra4: { question: "x" },
  };
  for (const [name, patch] of Object.entries(bad)) {
    const t = nextTs();
    const batchRows = [mkRow(1), mkRow(2, patch), mkRow(3)];
    const r = await rowsOp(env, b.json.load_id, batchRows, { ts: t });
    assert.equal(r.status, 400, name);
    assert.deepEqual(r.json, { ok: false, reason: "invalid_row" }, name);
    assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, 0, `${name}: the good rows in the same batch were not stored`);
    if (!LOAD_DEPENDENT.has(name)) { // checked before anything is recorded: the same signed second still works. (A row that disagrees with the load itself is only known once the load is read, after the replay state.)
      const ok = await rowsOp(env, b.json.load_id, [mkRow(1)], { ts: t });
      assert.equal(ok.status, 200, `${name}: timestamp not consumed`);
    }
    DB.raw.exec("DELETE FROM game_facts");
  }
  // non-object rows, duplicate ids in one batch, too many rows, no rows
  for (const rows of [[mkRow(1), null], [mkRow(1), "x"], [mkRow(1), [mkRow(2)]], [mkRow(1), mkRow(1)], nGood(201), []]) assert.equal((await rowsOp(env, b.json.load_id, rows)).status, 400);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, 0);
});

test("validateRow accepts every vocabulary value and the edge lengths", () => {
  for (const kind of FACT_KINDS.filter((k) => k !== "curated")) assert.ok(validateRow(mkRow(1, { kind }), "client").row, kind);
  assert.ok(validateRow(mkRow(1, { subject: "s".repeat(120), claim: "c".repeat(400), value: "v".repeat(80), note: "n".repeat(300), id: `a_b:${"1".repeat(40)}` }), "client").row);
  assert.ok(validateRow({ ...mkRow(1), id: "curated:C003", kind: "curated", subject: "Curated", source_table: "", row_id: "" }, "curated").row);
  assert.equal(validateRow(mkRow(1, { kind: "curated" }), "client").error, "row_kind");
  for (const v of [null, 1, "x", [], {}]) assert.ok(validateRow(v, "client").error);
  assert.equal(parseFactsBody({ purpose: P, op: "rows", load_id: "0".repeat(36), rows: [{}] }).op, "rows");
});

test("a client load carries one build; a curated load takes rows of their own builds", async () => {
  const { env } = await fresh();
  const b = await begin(env, { kinds: { spell_level: 2 } });
  assert.equal((await rowsOp(env, b.json.load_id, [mkRow(1, { build: BUILD2 })])).status, 400);
  const c = await begin(env, { kind: "curated", kinds: { curated: 2 } });
  const cur = (n, build) => ({ id: `curated:C${n}`, kind: "curated", subject: `Curated subject ${n}`, claim: `Curated claim number ${n}.`, value: "", unit: "", source_table: "", row_id: "", build, verdict: "holds", source_class: "wiki", note: "" });
  assert.equal((await rowsOp(env, c.json.load_id, [cur(1, "1.2.3"), cur(2, "2026.11.19")])).status, 200);
  assert.equal((await rowsOp(env, c.json.load_id, [mkRow(1)])).status, 400, "a client row cannot enter a curated load");
});

test("upsert is idempotent: the same batch twice leaves one row per id, and the counts do not double", async () => {
  const { DB, env } = await fresh();
  const b = await begin(env, { kinds: { spell_level: 4 } });
  const rows = nGood(4);
  const first = await rowsOp(env, b.json.load_id, rows);
  const second = await rowsOp(env, b.json.load_id, rows);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, 4);
  assert.equal(JSON.parse(one(DB, "SELECT counts_json FROM game_fact_loads WHERE id = ?", b.json.load_id).counts_json).added, 4);
});

test("finish: refused while the loaded rows are not the expected count (the load stays open); then done, with counts", async () => {
  const { DB, env } = await fresh();
  const b = await begin(env, { kinds: { spell_level: 5 } });
  await rowsOp(env, b.json.load_id, nGood(3));
  const early = await finish(env, b.json.load_id);
  assert.equal(early.status, 409);
  assert.deepEqual(early.json, { ok: false, reason: "incomplete", accepted: 3 });
  assert.equal(one(DB, "SELECT status FROM game_fact_loads WHERE id = ?", b.json.load_id).status, "open");
  await rowsOp(env, b.json.load_id, nGood(2, 4));
  const f = await finish(env, b.json.load_id);
  assert.equal(f.status, 200);
  assert.deepEqual(f.json.counts, { total: 5, added: 5, changed: 0, unchanged: 0, removed: 0 });
  assert.deepEqual(Object.keys(f.json).sort(), ["accepted", "counts", "load_id", "ok"]);
  assert.equal(one(DB, "SELECT status FROM game_fact_loads WHERE id = ?", b.json.load_id).status, "done");
  const again = await finish(env, b.json.load_id);
  assert.equal(again.status, 200, "finish on a done load is idempotent: a lost response can be retried");
  assert.deepEqual(again.json, f.json);
  assert.equal((await rowsOp(env, b.json.load_id, [mkRow(9)])).status, 409, "or take more rows");
  assert.equal((await finish(env, "11111111-1111-1111-1111-111111111111")).status, 404);
});

test("build change: a new load diffs against the old (added, changed value, removed), supersedes what it did not re-see, and never deletes", async () => {
  const { DB, env } = await fresh();
  const a = await loadAll(env, nGood(3), { build: BUILD }); // ids 1, 2, 3 at BUILD
  assert.equal(a.finish.counts.added, 3);
  const second = [mkRow(1, { build: BUILD2 }), mkRow(2, { build: BUILD2, value: "99", claim: "Changed claim for two." }), mkRow(4, { build: BUILD2 })]; // 1 same, 2 changed, 3 gone, 4 new
  const b = await loadAll(env, second, { build: BUILD2 });
  assert.deepEqual(b.finish.counts, { total: 3, added: 1, changed: 1, unchanged: 1, removed: 1 });
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, 6, "rows are never deleted: each load keeps its own row per id");
  const live = (id) => all(DB, "SELECT load_id, superseded, build FROM game_facts WHERE id = ? ORDER BY load_id = ?", `spelllevels:${id}`, b.id);
  assert.deepEqual(live(3).map((r) => r.superseded), [1], "gone from the new build: retired");
  for (const id of [1, 2]) assert.deepEqual(live(id).map((r) => [r.load_id, r.superseded]), [[a.id, 1], [b.id, 0]], String(id));
  assert.deepEqual(live(4).map((r) => [r.load_id, r.superseded]), [[b.id, 0]]);
  assert.equal(live(1)[1].build, BUILD2);
  const meta = JSON.parse(one(DB, "SELECT counts_json FROM game_fact_loads WHERE id = ?", b.id).counts_json);
  assert.equal(meta.prev_load_id, a.id); assert.equal(meta.prev_build, BUILD);
  // a later load that brings id 3 back revives it
  const c = await loadAll(env, [mkRow(3, { build: "9.9.9.3" })], { build: "9.9.9.3" });
  assert.equal(c.finish.counts.removed, 3);
  assert.deepEqual(all(DB, "SELECT load_id FROM game_facts WHERE id = 'spelllevels:3' AND superseded = 0").map((r) => r.load_id), [c.id]);
});

test("a curated load only supersedes curated rows, and a client load never touches them", async () => {
  const { DB, env } = await fresh();
  const cur = (n) => ({ id: `curated:C${n}`, kind: "curated", subject: `Curated subject ${n}`, claim: `Curated claim ${n}.`, value: "", unit: "", source_table: "", row_id: "", build: "2026.11.19", verdict: "holds", source_class: "wiki", note: "" });
  await loadAll(env, [cur(1), cur(2)], { kind: "curated" });
  await loadAll(env, nGood(2));
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind = 'curated' AND superseded = 0").c, 2);
  await loadAll(env, [cur(1)], { kind: "curated" });
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind = 'curated' AND superseded = 0").c, 1);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind <> 'curated' AND superseded = 0").c, 2);
});

test("a database error answers 503 with a fixed reason and no D1 text", async () => {
  const { DB } = await fresh();
  const broken = { ...DB, prepare: (sql) => { if (/game_fact_loads/.test(sql)) throw new Error("D1_ERROR: secret table detail"); return DB.prepare(sql); } };
  const r = await begin(mkEnv(broken));
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { ok: false, reason: "unavailable" });
  assert.ok(!/secret|D1_ERROR/.test(r.text));
});

// ---- visibility and lookup -----------------------------------------------------------------------------------------------------------------------
const ids = (r) => r.rows.map((x) => x.id).sort();
const named = (i, subject, over = {}) => mkRow(i, { subject, claim: `${subject} requires level ${i + 4}.`, ...over });


test("an unfinished or failed load is invisible to the lookup; a finished one is visible", async () => {
  const { DB, env } = await fresh();
  const b = await begin(env, { kinds: { spell_level: 2 } });
  await rowsOp(env, b.json.load_id, [named(1, "Frostglaive"), named(2, "Icewhisper")]);
  assert.deepEqual((await lookupGameFacts(env, "what level is Frostglaive")).rows, [], "open load: invisible");
  DB.raw.prepare("UPDATE game_fact_loads SET status = 'failed' WHERE id = ?").run(b.json.load_id);
  assert.deepEqual((await lookupGameFacts(env, "what level is Frostglaive")).rows, [], "failed load: invisible");
  DB.raw.prepare("UPDATE game_fact_loads SET status = 'open' WHERE id = ?").run(b.json.load_id);
  assert.equal((await finish(env, b.json.load_id)).status, 200);
  const seen = await lookupGameFacts(env, "what level is Frostglaive");
  assert.deepEqual(seen.rows.map((r) => r.id), ["spelllevels:1"]);
  assert.deepEqual(Object.keys(seen.rows[0]).sort(), ["build", "claim", "id", "kind", "row_id", "source_table", "subject", "unit", "value"]);
  assert.equal(seen.ambiguous, false); assert.equal(seen.via, "names");
});

test("curated lookup: holds rows, wrong rows as doNotSay, never unverifiable or superseded ones", async () => {
  const { DB, env } = await fresh();
  const cur = (n, over) => ({ id: `curated:C${n}`, kind: "curated", subject: `Curated subject ${n}`, claim: "", value: "", unit: "", source_table: "facts", row_id: `C${n}`, build: "2026.11.19", verdict: "holds", source_class: "wiki", note: "", ...over });
  await loadAll(env, [
    cur(1, { claim: "Glimmerfang is learned at level 20.", verdict: "holds" }),
    cur(2, { claim: "Glimmerfang is learned at level 40.", verdict: "wrong" }),
    cur(3, { claim: "Glimmerfang probably costs 90 mana.", verdict: "unverifiable" }),
  ], { kind: "curated", build: "2026.11.19" });
  const r = await lookupGameFacts(env, "At what level do I learn Glimmerfang?");
  assert.deepEqual(r.rows.map((x) => x.id), ["curated:C1"]);
  assert.deepEqual(r.doNotSay.map((x) => x.id), ["curated:C2"]);
  assert.ok(!JSON.stringify(r).includes("90 mana"), "unverifiable is not returned");
  await loadAll(env, [cur(2, { claim: "Glimmerfang is learned at level 40.", verdict: "wrong" }), cur(4, { claim: "Other thing entirely." })], { kind: "curated", build: "2026.11.20" });
  const r2 = await lookupGameFacts(env, "At what level do I learn Glimmerfang?");
  assert.deepEqual(r2.rows, [], "a superseded row is excluded");
  assert.deepEqual(r2.doNotSay.map((x) => x.id), ["curated:C2"]);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE id = 'curated:C1'").c, 1, "still in the table");
});

test("names fold the same way in the loader and the lookup: apostrophes, colons, hyphens, 'of', diacritics, case", async () => {
  assert.equal(normName("Light's Vigil"), "lights vigil");
  assert.equal(normName("Light\u2019s Vigil"), "lights vigil");
  assert.equal(normName("Polymorph: Chicken"), "polymorph chicken");
  assert.equal(normName("Engrave Pants - Envenom"), "engrave pants envenom");
  assert.equal(normName("Curse of Thule"), "curse of thule");
  assert.equal(normName("  Caf\u00e9-\u00dcnit!! "), "cafe unit");
  assert.equal(normName(null), ""); assert.equal(normName("!!!"), "");
  const { env } = await fresh();
  await loadAll(env, [named(1, "Light's Vigil"), named(2, "Polymorph: Chicken"), named(3, "Engrave Pants - Envenom"), named(4, "Curse of Thule"), named(5, "Curse of Tongues"), named(6, "Caf\u00e9 Blast")]);
  const one1 = async (q) => ids(await lookupGameFacts(env, q));
  assert.deepEqual(await one1("what does Lights Vigil do"), ["spelllevels:1"]);
  assert.deepEqual(await one1("what does LIGHT'S VIGIL do?"), ["spelllevels:1"]);
  assert.deepEqual(await one1("level of polymorph chicken"), ["spelllevels:2"]);
  assert.deepEqual(await one1("Polymorph: Chicken, level?"), ["spelllevels:2"]);
  assert.deepEqual(await one1("engrave pants envenom"), ["spelllevels:3"]);
  assert.deepEqual(await one1("Engrave Pants - Envenom"), ["spelllevels:3"]);
  assert.deepEqual(await one1("level of Curse of Thule?"), ["spelllevels:4"], "the longest name wins; 'of' stays in the name");
  assert.deepEqual(await one1("cafe blast"), ["spelllevels:6"]);
});

test("rank suffixes: base names, and both directions of the lookup", async () => {
  for (const [name, norm, base] of [["Frostbolt Rank 4", "frostbolt rank 4", "frostbolt"], ["Frostbolt Rank IV", "frostbolt rank iv", "frostbolt"], ["Arcane Spirit III", "arcane spirit iii", "arcane spirit"], ["Dragon's Breath II", "dragons breath ii", "dragons breath"],
    ["Curse of Thule", "curse of thule", ""], ["Light's Vigil", "lights vigil", ""], ["Rank 4", "rank 4", ""], ["Heal Rank", "heal rank", ""], ["Vi", "vi", ""], ["Victory Rush", "victory rush", ""], ["Mark of the Wild", "mark of the wild", ""]]) {
    assert.equal(normName(name), norm, name); assert.equal(baseName(norm), base, `${name} -> base`);
  }
  const { DB, env } = await fresh();
  await loadAll(env, [named(1, "Arcane Spirit III"), named(2, "Frostbolt"), named(3, "Cinderblast Rank 2"), named(4, "Plainstrike")]);
  const got = async (q) => ids(await lookupGameFacts(env, q));
  assert.deepEqual(await got("What level is Arcane Spirit III?"), ["spelllevels:1"], "the full key keeps the numeral that is part of the name");
  assert.deepEqual(await got("What level is Arcane Spirit?"), ["spelllevels:1"], "the base name finds the row that ends in a numeral");
  assert.deepEqual(await got("What level is Arcane Spirit II?"), [], "asking for rank II never returns rank III on its own");
  assert.deepEqual(await got("What level is Frostbolt Rank 4?"), ["spelllevels:2"], "a question with a rank suffix finds the name without it");
  assert.deepEqual(await got("What level is Frostbolt rank IV?"), ["spelllevels:2"]);
  assert.deepEqual(await got("What level is Cinderblast?"), ["spelllevels:3"], "and the other way round: the base finds 'Cinderblast Rank 2'");
  assert.deepEqual(await got("What level is Cinderblast Rank 2?"), ["spelllevels:3"]);
  assert.deepEqual(await got("What level is Cinderblast Rank 3?"), [], "another rank is not this row");
  assert.deepEqual(all(DB, "SELECT id, subject_norm, subject_base FROM game_facts ORDER BY id").map((r) => [r.subject_norm, r.subject_base]), [["arcane spirit iii", "arcane spirit"], ["frostbolt", ""], ["cinderblast rank 2", "cinderblast"], ["plainstrike", ""]]);
});

test("longest window first, no overlaps: 'Fire Blast' hides 'Fire' but not a second name in the question", async () => {
  const { env } = await fresh();
  await loadAll(env, [named(1, "Fire Blast"), named(2, "Fireball"), named(3, "Fire"), named(4, "Frostbolt")]);
  assert.deepEqual(ids(await lookupGameFacts(env, "compare Fire Blast and Frostbolt")), ["spelllevels:1", "spelllevels:4"]);
  assert.deepEqual(ids(await lookupGameFacts(env, "level of Fire Blast")), ["spelllevels:1"]);
  assert.deepEqual(ids(await lookupGameFacts(env, "level of Fire")), ["spelllevels:3"]);
  assert.deepEqual(ids(await lookupGameFacts(env, "Fire Blast, Fireball")), ["spelllevels:1", "spelllevels:2"]);
});

test("ambiguity: every row that shares a name comes back with its id and ambiguous is true; different kinds of one spell are not ambiguity", async () => {
  const { env } = await fresh();
  const cd = (i, subject) => mkRow(i, { id: `spellcooldowns:${i}`, kind: "spell_cooldown", unit: "seconds", source_table: "spellcooldowns", subject, claim: `${subject} has a cooldown of ${i} seconds.`, value: String(i) });
  await loadAll(env, [named(1, "Twinbolt"), named(2, "Twinbolt"), named(3, "Twinbolt"), cd(9, "Twinbolt"), named(5, "Loneblast"), cd(6, "Loneblast")]);
  const t = await lookupGameFacts(env, "What level is Twinbolt?");
  assert.equal(t.ambiguous, true);
  assert.deepEqual(ids(t), ["spelllevels:1", "spelllevels:2", "spelllevels:3", "spellcooldowns:9"].sort(), "all rows, nothing picked silently");
  assert.ok(t.rows.every((r) => r.subject === "Twinbolt" && r.value && r.row_id));
  const l = await lookupGameFacts(env, "Loneblast");
  assert.equal(l.ambiguous, false);
  assert.deepEqual(ids(l), ["spellcooldowns:6", "spelllevels:5"].sort());
  const limited = await lookupGameFacts(env, "Twinbolt", { limit: 1 });
  assert.equal(limited.rows.length, 4, "the limit never cuts a name's rows");
});

test("no candidates, no tokens, stop words only: empty answers; a database error answers empty and never throws", async () => {
  const { env } = await fresh();
  await loadAll(env, [named(1, "Frostglaive")]);
  for (const q of ["", "   ", "the of and or not what", null, undefined, 12345, "zzzz qqqq"]) assert.deepEqual((await lookupGameFacts(env, q)).rows, [], String(q));
  assert.equal((await lookupGameFacts(env, "")).via, "names", "an empty question still runs the curated lookup");
  assert.deepEqual(await lookupGameFacts({ DB: { prepare: () => { throw new Error("D1 down"); } } }, "Frostglaive"), { rows: [], doNotSay: [], ambiguous: false, via: "none" });
});

test("hostile questions: operators, quotes, NEAR, star, caret, column filters, parentheses and SQL only ever become bound values", async () => {
  const { DB, env } = await fresh();
  await loadAll(env, [named(1, "Gloomhowl"), named(2, "Brightwing")]);
  const hostile = ['Gloomhowl OR Brightwing', 'Gloomhowl AND NOT Brightwing', 'NEAR(Gloomhowl Brightwing, 3)', 'Gloomhowl*', '^Gloomhowl', 'subject:Gloomhowl', '{subject claim}: Gloomhowl',
    '"unbalanced', "Gloomhowl'; DROP TABLE game_facts; --", "Gloomhowl' OR '1'='1", '(((Gloomhowl', ')Gloomhowl(', '%', '_', "' --", '\u0000Gloomhowl', 'a'.repeat(5000), Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ")];
  for (const q of hostile) {
    const r = await lookupGameFacts(env, q);
    assert.equal(r.via, "names", q.slice(0, 30));
    for (const row of r.rows) assert.ok(["spelllevels:1", "spelllevels:2"].includes(row.id));
  }
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, 2, "nothing was changed or dropped");
  assert.deepEqual(ids(await lookupGameFacts(env, "Gloomhowl OR Brightwing")), ["spelllevels:1", "spelllevels:2"], "an operator word in the question is just a word");
  assert.deepEqual(ids(await lookupGameFacts(env, "Gloomhowl'; DROP TABLE game_facts; --")), ["spelllevels:1"]);
});

test("the window and SQL builders: capped, letters and digits only, the question never in the SQL text, at most 100 bound values", () => {
  const w = questionWindows("What level is Fire Blast Rank 4?");
  assert.ok(w.windows.some((x) => x.key === "fire blast rank 4" && x.start === 3 && x.len === 4 && x.next === ""));
  assert.ok(w.windows.some((x) => x.key === "fire blast" && x.next === "rank"), "each window knows the word that follows it");
  assert.ok(!w.windows.some((x) => x.len === 1 && ["what", "is"].includes(x.key)), "a one-word stop window is never a name");
  assert.ok(w.windows.some((x) => x.key === "what level is"), "longer windows may contain stop words");
  const many = questionWindows(Array.from({ length: 200 }, (_, i) => `word${i}`).join(" "));
  assert.equal(many.tokens.length, LOOKUP_MAX_TOKENS);
  const k = candidateKeys(many.windows);
  assert.ok(k.exact.length <= LOOKUP_MAX_KEYS && k.byBase.length <= LOOKUP_MAX_KEYS);
  assert.ok(k.exact[0].split(" ").length >= k.exact[k.exact.length - 1].split(" ").length, "longest windows first");
  for (const column of ["subject_norm", "subject_base"]) {
    const q = buildNameSql(["fire blast", "x'; drop table t; --"], column, 400);
    assert.ok(!q.sql.includes("fire blast") && !q.sql.includes("drop"), "the keys are bound, not in the text");
    assert.deepEqual(q.binds, ["fire blast", "x'; drop table t; --", 400]);
    assert.match(q.sql, /l\.status = 'done'/); assert.match(q.sql, /superseded = 0/);
  }
  assert.match(buildNameSql(["a"], "subject_base", 5).sql, /subject_base <> ''/, "the partial index is usable only when the query says so");
  assert.throws(() => buildNameSql(["a"], "claim; DROP TABLE x", 5), /bad column/);
  assert.ok(candidateKeys(many.windows).exact.length + 1 <= 100);
  assert.equal(buildCuratedSql(300).binds.length, 1);
  assert.deepEqual(questionWindows(null), { tokens: [], windows: [] });
  assert.deepEqual(chooseNames([], []), []);
  assert.deepEqual(curatedMatches("", [{ id: "x", subject: "a", claim: "b" }]), []);
});
test("no friend data: the tables have no person column, a row with one is refused, and no Worker file outside the loader reads these tables", async () => {
  const { DB } = await fresh();
  for (const t of ["game_facts", "game_fact_loads"]) {
    const cols = all(DB, `PRAGMA table_info(${t})`).map((c) => c.name);
    for (const c of cols) assert.ok(!/slug|author|asker|user|member|discord|name_|email|ip|token/i.test(c.replace(/^subject.*/, "")), `${t}.${c}`);
  }
  const { readdirSync } = await import("node:fs");
  const dir = join(ROOT, "infrastructure", "worker");
  const readers = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name) && /game_facts|game_fact_loads/.test(readFileSync(p, "utf8"))) readers.push(e.name); } };
  walk(dir);
  assert.deepEqual(readers.sort(), ["data-rights.js", "export.js", "game-facts-lookup.js", "game-facts-read.js", "game-facts.js"], "the only ask-path file that names the store is the reader (game-facts-read.js, behind GAME_FACTS_READ)");
});

// ---- the tool --------------------------------------------------------------------------------------------------------------------------------------
const tmp = () => mkdtempSync(join(tmpdir(), "facts-test-"));
const letters = (i) => { let s = ""; while (i > 0) { s = String.fromCharCode(97 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
// Fictional tables with the real tables' columns. nItems items make several batches.
function writeTables(dir, { nItems = 450, build = BUILD, ranks = false } = {}) {
  const csv = (header, rows) => [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
  const spellname = [], spelllevels = [], cds = [], misc = [], power = [], spell = [], sco = [];
  for (let i = 1; i <= 6; i++) {
    const id = 1000 + i;
    spellname.push([id, `Zorbo ${letters(i)} Bolt`]);
    spelllevels.push([id, 0, 0, 0, i + 4, 0, id]);
    cds.push([id, 0, 0, (i + 1) * 1000, 0, 0, id]);
    misc.push([id, 0, 1 + (i % 2), id]);
    power.push([id, 0, 10 * i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, id]);
    spell.push([id, i === 1 && ranks ? "Rank 1" : "", "", ""]); // a UNIQUE name with a rank line stays a legacy row: no rank in its claim
  }
  // Twinname Strike: two unrelated spells with one name. Not player-facing (BaseLevel 0) unless the ranks fixture is on.
  spellname.push([2001, "Twinname Strike"], [2002, "Twinname Strike"]); spelllevels.push([2001, 0, 0, 0, ranks ? 9 : 0, 0, 2001], [2002, 0, 0, 0, ranks ? 9 : 0, 0, 2002]);
  spell.push([2001, ranks ? "Rank 1" : "", "", ""], [2002, ranks ? "Rank 1" : "", "", ""]);
  if (ranks) {
    // Zephyr Lance: four ranks of one spell (ids 3001-3004). Ember's Vow: Rite: two ranks, apostrophe and colon. Row ids of every own table are NOT the SpellID.
    const ladder = (name, firstId, levels) => levels.forEach((lv, k) => {
      const id = firstId + k;
      spellname.push([id, name]); spell.push([id, `Rank ${k + 1}`, "", ""]);
      spelllevels.push([7000 + id, 0, 0, 0, lv, 0, id]);
      cds.push([9000 + id, 0, 0, 8000, 0, 0, id]);
      misc.push([8000 + id, 0, 2, id]);
      power.push([6000 + id, 0, 10 * (k + 1), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, id]);
      sco.push([id, id, 8]);
    });
    ladder("Zephyr Lance", 3001, [4, 12, 20, 28]);
    ladder("Ember's Vow: Rite", 3011, [10, 30]);
    sco.push([2001, 2001, 5], [2002, 2002, 7]);
  }
  const items = [];
  for (let i = 1; i <= nItems; i++) items.push([5000 + i, "", `Fakeblade of ${letters(i)}`, 10 + i, 2 + (i % 50), 1]);
  const tables = {
    "spellname.csv": csv(["ID", "Name_lang"], spellname),
    "spelllevels.csv": csv(["ID", "DifficultyID", "MaxLevel", "MaxPassiveAuraLevel", "BaseLevel", "SpellLevel", "SpellID"], spelllevels),
    "itemsparse.csv": csv(["ID", "Description_lang", "Display_lang", "ItemLevel", "RequiredLevel", "OverallQualityID"], items),
    "spellcooldowns.csv": csv(["ID", "DifficultyID", "CategoryRecoveryTime", "RecoveryTime", "StartRecoveryTime", "AuraSpellID", "SpellID"], cds),
    "spellmisc.csv": csv(["ID", "DifficultyID", "CastingTimeIndex", "SpellID"], misc),
    "spellcasttimes.csv": csv(["ID", "Base", "Minimum"], [[1, 0, 0], [2, 1500, 0]]),
    "spell.csv": csv(["ID", "NameSubtext_lang", "Description_lang", "AuraDescription_lang"], spell),
    "spellclassoptions.csv": csv(["ID", "SpellID", "SpellClassSet"], sco),
    "chrclasses.csv": csv(["Name_lang", "ID", "SpellClassSet"], [["Fiction Mage", 8, 8], ["Fiction Rogue", 4, 5], ["Fiction Priest", 5, 7], ["Fiction None", 99, 0]]),
    "spellpower.csv": csv(["ID", "OrderIndex", "ManaCost", "ManaCostPerLevel", "ManaPerSecond", "PowerDisplayID", "AltPowerBarID", "PowerCostPct", "PowerCostMaxPct", "OptionalCostPct", "PowerPctPerSecond", "PowerType", "RequiredAuraSpellID", "OptionalCost", "SpellID"], power),
  };
  const files = {};
  for (const [name, text] of Object.entries(tables)) { writeFileSync(join(dir, name), text); files[name] = { sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), rows: text.trim().split("\n").length - 1 }; }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ build, files }, null, 1));
  return files;
}
const node = (id, name, over = {}) => ({ nodeId: String(id), entryId: String(id + 100), spellId: String(id + 200), name, maxRanks: 2, x: 0, y: 0, type: "0", text: "", edgesTo: [], conds: [], requires: [], requiredBy: [], linkedWith: [], ...over });
const traitsFile = (dir, build = BUILD) => {
  const trees = { trees: { 1112: { treeId: "1112", system: "1", nodeCount: 6, nodes: [
    node(1, "Frostweave Mastery", { maxRanks: 5 }),
    node(2, "Icicle Sting", { conds: [{ condType: "0", spentAmountRequired: "10", currency: "3", tab: "1" }], requires: [{ nodeId: "1", name: "Frostweave Mastery", edgeRowId: "9" }] }),
    node(3, "Dupename"), node(4, "Dupename"),
    node(5, "Nocond Thing", { conds: [{ condType: "0", spentAmountRequired: "0", currency: "3" }] }),
    node(6, "Frostweave Mastery Improved", { requires: [{ nodeId: "1" }] }), // name contains the prerequisite's name: skipped
  ] }, 9999: { treeId: "9999", system: "1", nodeCount: 1, nodes: [node(1, "Ghost Talent")] } }, build };
  const p = join(dir, "traits.json"); writeFileSync(p, JSON.stringify(trees)); return p;
};
const jsonl = (dir, name, lines) => { const p = join(dir, name); writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return p; };
const curatedLines = () => [
  { cid: "C001", claim: "Glimmerfang is learned at level 20.", value: "20", verdict: "holds", source_class: "blizzard", build: "1.60.1.70959", source: "somewhere", checked_at: "2026-11-19", next_step: "" },
  { cid: "C002", claim: "Glimmerfang is learned at level 40.", value: "40", verdict: "wrong", source_class: "tavern-or-forever-guide", build: "web notes as of 2026-11-19", next_step: "" },
  { cid: "C003", claim: "Short claim about a thing.", value: "v".repeat(100), verdict: "unverifiable", source_class: "mystery-source", build: "no build here", next_step: "ask in game" },
  { cid: "bad cid!", claim: "x", value: "y", verdict: "holds", source_class: "wiki", build: "1.2.3" },
  { cid: "C005", claim: "c".repeat(380), value: "v".repeat(100), verdict: "holds", source_class: "wiki", build: "1.2.3" },
  { cid: "C006", claim: "Bad verdict.", value: "1", verdict: "perhaps", source_class: "wiki", build: "1.2.3" },
];
const clientFactLines = () => [{ cids: ["C003"], claim: "Zorbo Alpha Bolt needs level 5.", value: "5", verdict: "holds", source_class: "client-db2", table: "spelllevels", row_id: "1001", build: "1.60.1.70959", checked_at: "2026-11-19", note: "client row" }];

function inprocess(env, { onCall = null } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), op: body.op, redirect: init.redirect, kinds: body.kinds });
    const forced = onCall ? onCall(seen.length, body) : null;
    if (forced) return new Response(JSON.stringify(forced.json || {}), { status: forced.status });
    return quiet(() => worker.fetch(new Request(String(url), init), env, ctx));
  };
  return { fetchImpl, seen };
}
function clockDeps(env, extra = {}) {
  let clock = Date.now();
  const out = [];
  return { out, deps: { now: () => clock, sleep: async (ms) => { clock += ms; }, log: (l) => out.push(l), err: (l) => out.push(l), ...extra } };
}
const scopeOf = (st, kind) => Object.entries(st.scopes).find(([k]) => k.startsWith(`${kind}:`))[1]; // scopes are keyed kind:planhash
const tokenFile = (dir, text = BOT) => { const p = join(dir, "token.txt"); writeFileSync(p, text + "\n"); return p; };

test("tool plan: the table rows follow truth-gen's kinds and uniqueness rules; traits follow the eligibility rules; counts only", () => {
  const dir = tmp(); writeTables(dir, { nItems: 10 });
  const plan = buildPlan({ tables: dir, traits: traitsFile(dir), facts: jsonl(dir, "facts.jsonl", curatedLines()), clientFacts: jsonl(dir, "client-facts.jsonl", clientFactLines()) });
  assert.equal(plan.build, BUILD);
  assert.equal(plan.manifest_sha256, sha256(readFileSync(join(dir, "MANIFEST.json"))));
  const client = plan.loads.find((l) => l.kind === "client");
  const byKind = client.counts;
  assert.deepEqual(byKind, { item_level_req: 10, spell_cast_time: 3, spell_cooldown: 6, spell_level: 6, spell_mana_cost: 6, trait_max_ranks: 4, trait_points_required: 1, trait_prereq: 1 });
  // the duplicate-name spell and the zero-row spells are not facts; ids are table:row
  assert.ok(!client.rows.some((r) => /Twinname/.test(r.subject)));
  assert.ok(client.rows.every((r) => /^[a-z_]+:[A-Za-z0-9_.-]{1,40}$/.test(r.id) && r.build === BUILD && r.source_class === "client-db2"));
  assert.equal(new Set(client.rows.map((r) => r.id)).size, client.rows.length);
  const lvl = client.rows.find((r) => r.id === "spelllevels:1001");
  assert.equal(lvl.claim, "Zorbo a Bolt requires level 5."); assert.equal(lvl.value, "5"); assert.equal(lvl.unit, "level");
  assert.ok(client.files["traits.json"] && client.files["spelllevels.csv"] && client.files["spellname.csv"]);
  assert.ok(!client.rows.some((r) => /Ghost Talent/.test(r.claim)), "only the eight class trees");
  assert.deepEqual(client.rows.filter((r) => r.kind === "trait_prereq").map((r) => r.value), ["Frostweave Mastery"]);
  const cur = plan.loads.find((l) => l.kind === "curated");
  assert.equal(cur.rows.length, 4, "C001, C002, C003 and the client-facts row; bad cid, bad verdict and the too-long line are skipped");
  assert.deepEqual(plan.skipped.curated, { bad_cid: 1, bad_verdict: 1, too_long: 1 });
  const c2 = cur.rows.find((r) => r.id === "curated:C002");
  assert.equal(c2.verdict, "wrong"); assert.equal(c2.build, "2026.11.19", "free-text build with a date becomes the date");
  const c3 = cur.rows.find((r) => r.id === "curated:C003");
  assert.equal(c3.build, BUILD, "no usable build: the load's build"); assert.equal(c3.source_class, "none"); assert.equal(c3.value, ""); assert.ok(c3.claim.includes("v".repeat(100)), "a long value moves into the claim, never cut"); assert.equal(c3.note, "ask in game");
  assert.ok(plan.notes.build_fallback >= 1);
  const cf = cur.rows.find((r) => r.source_table === "spelllevels");
  assert.match(cf.id, /^curated:cf-[0-9a-f]{12}$/); assert.equal(cf.row_id, "1001");
  assert.equal(batch(nGood(450)).length, 3);
  assert.deepEqual(curatedBuild("1.60.1.70959", "9.9.9"), { build: "1.60.1.70959", fallback: false });
  assert.deepEqual(deriveCuratedRows([], [], BUILD).rows, []);
  assert.equal(deriveTraitRows({}, BUILD).treesUsed, 0);
});

test("tool plan refuses: a table that fails its MANIFEST check (hash, bytes, rows), a traits file of another build, no curated input", () => {
  const dir = tmp(); writeTables(dir, { nItems: 5 });
  const csv = join(dir, "spelllevels.csv");
  const orig = readFileSync(csv, "utf8");
  writeFileSync(csv, orig.replace("1001,0,0,0,5,0,1001", "1001,0,0,0,6,0,1001"));
  assert.throws(() => buildPlan({ tables: dir, scope: "client" }), /sha256 differs from MANIFEST/);
  writeFileSync(csv, orig + "9,9,9,9,9,9,9\n");
  assert.throws(() => buildPlan({ tables: dir, scope: "client" }), /MANIFEST/);
  writeFileSync(csv, orig);
  assert.ok(buildPlan({ tables: dir, scope: "client" }));
  assert.throws(() => buildPlan({ tables: dir, traits: traitsFile(dir, "1.2.3.4"), scope: "client" }), /traits file build differs/);
  assert.throws(() => buildPlan({ tables: dir, scope: "curated" }), /a curated load replaces ALL curated rows/);
  const m = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")); m.build = "FAKE"; writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(m));
  assert.throws(() => buildPlan({ tables: dir, scope: "client" }), /no usable build/);
});

test("tool dry run (the default) sends nothing, needs no token, prints counts and the build and manifest hash, and no row text", async () => {
  const dir = tmp(); writeTables(dir, { nItems: 10 });
  const { out, deps } = clockDeps();
  let sent = 0;
  const code = await runTool(["--tables", dir, "--traits", traitsFile(dir), "--facts", jsonl(dir, "facts.jsonl", curatedLines()), "--client-facts", jsonl(dir, "client-facts.jsonl", clientFactLines())], { ...deps, fetchImpl: async () => { sent++; throw new Error("no network in a dry run"); } });
  assert.equal(code, 0);
  assert.equal(sent, 0);
  const text = out.join("\n");
  assert.match(text, new RegExp(`build ${BUILD.replace(/\./g, "\\.")}`));
  assert.match(text, /manifest_sha256 [0-9a-f]{64}/);
  assert.match(text, /spell_level\s+6/);
  assert.match(text, /dry run: nothing was sent/);
  for (const secret of ["Zorbo", "Fakeblade", "Frostweave", "Glimmerfang", "level 5"]) assert.ok(!text.includes(secret), `no row text: ${secret}`);
  const explicit = await runTool(["--dry-run", "--tables", dir, "--scope", "client"], { ...clockDeps().deps, fetchImpl: async () => { sent++; } });
  assert.equal(explicit, 0); assert.equal(sent, 0);
});

test("tool: bad arguments and --apply without a token file are refused before anything is sent", async () => {
  const dir = tmp(); writeTables(dir, { nItems: 5 });
  let sent = 0;
  const f = async () => { sent++; return new Response("{}"); };
  for (const argv of [[], ["--tables"], ["--tables", dir, "--wat"], ["--tables", dir, "--scope", "x"], ["--tables", dir, "--max-calls", "0"], ["--tables", dir, "--max-calls", "500"], ["a", "b", "--tables", dir], ["--tables", join(dir, "nope")]]) {
    assert.notEqual(await runTool(argv, { ...clockDeps().deps, fetchImpl: f }), 0, JSON.stringify(argv));
  }
  assert.equal(await runTool(["--tables", dir, "--scope", "client", "--apply"], { ...clockDeps().deps, fetchImpl: f }), 2);
  assert.equal(await runTool([join(dir, "missing-token.txt"), "--tables", dir, "--scope", "client", "--apply"], { ...clockDeps().deps, fetchImpl: f }), 2);
  assert.equal(await runTool([tokenFile(dir, "tiny"), "--tables", dir, "--scope", "client", "--apply"], { ...clockDeps().deps, fetchImpl: f }), 2);
  assert.equal(sent, 0);
});

test("tool host rules: https only (http for localhost, 127.0.0.1, [::1]), no credentials, only api.leeroy.party or a local host unless --allow-host names it", async () => {
  assert.ok(checkBase("https://api.leeroy.party").url.endsWith("/api/facts/load"));
  assert.equal(checkBase("https://api.leeroy.party/").url, "https://api.leeroy.party/api/facts/load");
  for (const u of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "https://localhost"]) assert.ok(checkBase(u).url, u);
  for (const u of ["http://api.leeroy.party", "http://example.com", "ftp://localhost", "https://user:pw@api.leeroy.party", "https://u@api.leeroy.party", "not a url", "https://example.com", "https://api.leeroy.party.evil.test", "https://evil.test/api.leeroy.party", "http://0.0.0.0:80", "http://localhost.evil.test"]) assert.ok(checkBase(u).error, u);
  assert.ok(checkBase("https://staging.example.test", "staging.example.test").url);
  assert.ok(checkBase("http://staging.example.test", "staging.example.test").error, "--allow-host never allows plain http");
  assert.ok(checkBase("https://other.example.test", "staging.example.test").error);
  const dir = tmp(); writeTables(dir, { nItems: 5 });
  let sent = 0;
  const code = await runTool([tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "https://evil.test"], { ...clockDeps().deps, fetchImpl: async () => { sent++; return new Response("{}"); } });
  assert.equal(code, 2); assert.equal(sent, 0);
});

test("tool end to end: begin, rows in batches, finish against the Worker; signed with the facts key; ids, counts, the lookup, and a second identical run supersedes nothing", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir);
  const { fetchImpl, seen } = inprocess(env);
  const { out, deps } = clockDeps();
  const argv = [tokenFile(dir), "--tables", dir, "--traits", traitsFile(dir), "--facts", jsonl(dir, "facts.jsonl", curatedLines()), "--client-facts", jsonl(dir, "client-facts.jsonl", clientFactLines()), "--apply", "--base", "http://localhost:8787", "--state", join(dir, "state.json")];
  const code = await runTool(argv, { ...deps, fetchImpl });
  assert.equal(code, 0, out.join("\n"));
  assert.ok(seen.every((s) => s.redirect === "error" && s.url === "http://localhost:8787/api/facts/load"));
  assert.deepEqual(seen.map((s) => s.op).filter((o) => o !== "rows"), ["begin", "finish", "begin", "finish"]);
  const loads = all(DB, "SELECT kind, status, build, manifest_sha256 FROM game_fact_loads ORDER BY kind");
  assert.deepEqual(loads.map((l) => [l.kind, l.status, l.build]), [["client", "done", BUILD], ["curated", "done", BUILD]]);
  assert.equal(loads[0].manifest_sha256, sha256(readFileSync(join(dir, "MANIFEST.json"))));
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind = 'item_level_req' AND superseded = 0").c, 450);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind = 'curated'").c, 4, "bad cid, bad verdict and the too-long line skipped");
  assert.ok(Object.keys(JSON.parse(one(DB, "SELECT files_json FROM game_fact_loads WHERE kind = 'client'").files_json)).includes("traits.json"));
  const text = out.join("\n");
  assert.match(text, /finish client: total \d+, added \d+, changed 0, unchanged 0, removed 0/);
  assert.ok(!text.includes(BOT) && !text.includes("Zorbo"));
  const got = await lookupGameFacts(env, "What level do I need to learn Zorbo a Bolt?");
  const lv = got.rows.find((r) => r.id === "spelllevels:1001");
  assert.ok(lv, "the table fact is found (a curated fact about the same spell may rank beside it)");
  assert.equal(lv.value, "5");
  assert.ok((await lookupGameFacts(env, "Which talent is needed before Icicle Sting?")).rows.some((r) => r.id.startsWith("trait_prereq:")));
  assert.ok((await lookupGameFacts(env, "Is Glimmerfang learned at level 40?")).doNotSay.some((r) => r.id === "curated:C002"));
  assert.ok(!existsSync(join(dir, "state.json")), "state removed after a finished load");
  // a second identical run: everything unchanged, nothing removed
  await deps.sleep(2000); // real time moves on between two runs
  const again = await runTool(argv, { ...deps, fetchImpl });
  assert.equal(again, 0, out.join("; "));
  const second = JSON.parse(one(DB, "SELECT counts_json FROM game_fact_loads WHERE kind = 'client' AND status = 'done' ORDER BY finished_at DESC, rowid DESC LIMIT 1").counts_json);
  assert.equal(second.added, 0); assert.equal(second.changed, 0); assert.equal(second.removed, 0);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 0").c, one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 1").c, "every old row retired, every new row live");
});

test("tool resume: a failed batch stops the run, keeps the load id, and the same command continues without a second begin", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir);
  const state = join(dir, "state.json");
  const argv = [tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://127.0.0.1:8787", "--state", state];
  const a = inprocess(env, { onCall: (n, body) => (body.op === "rows" && n === 3 ? { status: 503, json: { ok: false, reason: "unavailable" } } : null) });
  const first = clockDeps();
  assert.equal(await runTool(argv, { ...first.deps, fetchImpl: a.fetchImpl }), 1);
  assert.match(first.out.join("\n"), /stopped \(rows batch 2 failed: HTTP 503, reason unavailable\); run the same command again to resume/);
  const st = scopeOf(JSON.parse(readFileSync(state, "utf8")), "client");
  assert.equal(st.next, 1); assert.equal(st.done, false);
  assert.equal(one(DB, "SELECT status FROM game_fact_loads").status, "open");
  const b = inprocess(env);
  const second = first; // one clock for both runs (a later run always has a later second)
  assert.equal(await runTool(argv, { ...second.deps, fetchImpl: b.fetchImpl }), 0, second.out.join("\n"));
  assert.ok(!b.seen.some((s) => s.op === "begin"), "no second begin");
  assert.match(second.out.join("\n"), /resume client: 1 of \d+ batches already sent/);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 1);
  assert.equal(one(DB, "SELECT status FROM game_fact_loads").status, "done");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 0").c, 450 + 6 * 3 + 3);
});

test("tool call budget: --max-calls stops with a resume message, never past the budget", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir);
  const { fetchImpl, seen } = inprocess(env);
  const { out, deps } = clockDeps();
  const code = await runTool([tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:8787", "--state", join(dir, "s.json"), "--max-calls", "2"], { ...deps, fetchImpl });
  assert.equal(code, 1);
  assert.equal(seen.length, 2);
  assert.match(out.join("\n"), /call budget used up/);
  assert.equal(one(DB, "SELECT status FROM game_fact_loads").status, "open");
});

test("tool: every call is signed with the facts key, each second strictly newer than the last, even when the clock does not move between calls", async () => {
  const { env } = await fresh();
  const dir = tmp(); writeTables(dir, { nItems: 3 });
  const stamps = [];
  const sigs = [];
  const fetchImpl = async (url, init) => { stamps.push(Number(init.headers["X-Listen-Timestamp"])); sigs.push([init.headers["X-Listen-Signature"], init.headers["X-Listen-Timestamp"], init.body]); return quiet(() => worker.fetch(new Request(String(url), init), env, ctx)); };
  const { deps } = clockDeps();
  assert.equal(await runTool([tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:8787", "--state", join(dir, "s.json")], { ...deps, fetchImpl }), 0);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] > stamps[i - 1], `call ${i}`);
  for (const [sig, ts, body] of sigs) assert.equal(sig, await signListen(KEY, ts, body));
  for (const k of [await listenerKey(BOT), await shadowKey(BOT)]) assert.notEqual(sigs[0][0], await signListen(k, sigs[0][1], sigs[0][2]));
});

test("tool never prints the token: a failing run, a refused host and an unreadable plan leave it out of every line it prints", async () => {
  const { env } = await fresh();
  const dir = tmp(); writeTables(dir, { nItems: 3 });
  const lines = [];
  const deps = { ...clockDeps().deps, log: (l) => lines.push(l), err: (l) => lines.push(l) };
  const tf = tokenFile(dir);
  await runTool([tf, "--tables", dir, "--scope", "client", "--apply", "--base", "https://evil.test"], deps);
  await runTool([tf, "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:1", "--state", join(dir, "s1.json")], { ...deps, fetchImpl: async () => { throw new Error(`connect failed ${BOT}`); } });
  await runTool([tf, "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:1", "--state", join(dir, "s2.json")], { ...deps, fetchImpl: async () => new Response(JSON.stringify({ ok: false, reason: BOT }), { status: 400 }) });
  await runTool([tf, "--tables", join(dir, "none"), "--apply"], deps);
  assert.ok(lines.length > 3);
  for (const l of lines) { assert.ok(!l.includes(BOT), l); assert.ok(!l.includes(sha256(BOT)), l); }
  assert.ok(lines.some((l) => /reason other/.test(l)), "a reason that is not a fixed class prints as 'other', never as received");
});

test("tool refuses redirects: the request carries redirect: error, and a real 302 from a local server stops the run without following it", async () => {
  const dir = tmp(); writeTables(dir, { nItems: 3 });
  let target = 0;
  const hit = http.createServer((q, r) => { target++; r.end("{}"); });
  await new Promise((r) => hit.listen(0, "127.0.0.1", r));
  const bounce = http.createServer((q, r) => { r.writeHead(302, { Location: `http://127.0.0.1:${hit.address().port}/api/facts/load` }); r.end(); });
  await new Promise((r) => bounce.listen(0, "127.0.0.1", r));
  try {
    const { out, deps } = clockDeps();
    const code = await runTool([tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", `http://127.0.0.1:${bounce.address().port}`, "--state", join(dir, "s.json")], { ...deps, fetchImpl: globalThis.fetch });
    assert.equal(code, 1);
    assert.equal(target, 0, "the redirect target was never contacted");
    assert.match(out.join("\n"), /stopped \(begin client failed/);
  } finally { bounce.close(); hit.close(); }
});

test("tool writes nothing into the repo: a --state path inside the checkout is refused before any call, and the run leaves no file in the repo", async () => {
  const dir = tmp(); writeTables(dir, { nItems: 3 });
  let sent = 0;
  const { out, deps } = clockDeps();
  const code = await runTool([tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:8787", "--state", join(ROOT, "tests", "unit", "state-should-not-exist.json")], { ...deps, fetchImpl: async () => { sent++; return new Response("{}"); } });
  assert.equal(code, 2);
  assert.equal(sent, 0);
  assert.match(out.join("\n"), /refusing: refusing to write inside the repo/);
  assert.ok(!existsSync(join(ROOT, "tests", "unit", "state-should-not-exist.json")));
});

// ---- review round: visibility, concurrency, partial input, anchors, lookup, resume ----------------------------------------------------------------
const stale = (DB, pattern) => { // a DB whose FIRST read of the load row says "open", whatever it is: a read that is stale by the time the batch runs
  let forged = false;
  return { ...DB, prepare: (sql) => {
    if (!forged && pattern.test(sql)) { forged = true; const st = DB.prepare(sql); return { bind: (...a) => ({ first: async () => ({ ...(await st.bind(...a).first()), status: "open" }) }) }; }
    return DB.prepare(sql);
  } };
};
const published = (DB, where = "1 = 1") => one(DB, `SELECT COUNT(*) AS c FROM game_facts g JOIN game_fact_loads l ON l.id = g.load_id WHERE l.status = 'done' AND g.superseded = 0 AND ${where}`).c; // what a lookup can see
const LOAD_READ = /SELECT id, build, kind, status, counts_json, finished_at FROM game_fact_loads/;

test("a failed, interrupted or open reload never hides a published fact", async () => {
  const { DB, env } = await fresh();
  const mk = (i, over = {}) => mkRow(i, { subject: `Frostglaive ${["", "One", "Two"][i]}`, claim: `Frostglaive ${i} requires level ${10 + i}.`, ...over });
  await loadAll(env, [mk(1), mk(2)]);
  const claims = async () => [...(await lookupGameFacts(env, "Frostglaive One")).rows, ...(await lookupGameFacts(env, "Frostglaive Two")).rows].map((r) => r.claim).sort();
  const before = await claims();
  assert.equal(before.length, 2);
  const b = await begin(env, { build: BUILD2, kinds: { spell_level: 2 } });
  await rowsOp(env, b.json.load_id, [mk(1, { build: BUILD2, claim: "Frostglaive 1 requires level 99.", value: "99" })]);
  assert.deepEqual(await claims(), before, "an open reload with a changed value: the published rows are untouched");
  const late = await begin(env, { build: BUILD2, kinds: { spell_level: 2 }, opts: { handler: handleFactsLoad, deps: { now: () => new Date(Date.now() + 31 * 60 * 1000) } } });
  assert.equal(late.status, 200, "the interrupted load is marked failed after 30 minutes");
  assert.equal(one(DB, "SELECT status FROM game_fact_loads WHERE id = ?", b.json.load_id).status, "failed");
  assert.deepEqual(await claims(), before, "an interrupted reload");
  const n = one(DB, "SELECT COUNT(*) AS c FROM game_facts").c;
  assert.equal((await rowsOp(env, b.json.load_id, [mk(2, { build: BUILD2 })])).status, 409, "a failed load takes no more rows");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts").c, n);
  assert.equal((await finish(env, late.json.load_id)).status, 409, "an incomplete finish");
  assert.deepEqual(await claims(), before);
  await rowsOp(env, late.json.load_id, [mk(1, { build: BUILD2, claim: "Frostglaive 1 requires level 99.", value: "99" }), mk(2, { build: BUILD2 })]);
  assert.deepEqual(await claims(), before, "all rows sent but not finished: still the old facts");
  assert.equal((await finish(env, late.json.load_id)).status, 200);
  const after = await claims();
  assert.ok(after.includes("Frostglaive 1 requires level 99.") && !after.includes("Frostglaive 1 requires level 11."), "published at finish");
  assert.equal(after.length, 2);
});

test("rows and finish are consistent: a late rows call writes nothing, even from a stale read; a delayed finish supersedes nothing", async () => {
  const { DB, env } = await fresh();
  const a = await loadAll(env, nGood(3));
  const total = () => one(DB, "SELECT COUNT(*) AS c FROM game_facts").c;
  const countsBefore = one(DB, "SELECT counts_json FROM game_fact_loads WHERE id = ?", a.id).counts_json;
  assert.equal((await rowsOp(env, a.id, [mkRow(9)])).status, 409);
  assert.equal(total(), 3);
  const late = await call({ ...env, DB: stale(DB, LOAD_READ) }, { purpose: P, op: "rows", load_id: a.id, rows: [mkRow(9), mkRow(10)] });
  assert.equal(late.status, 409, "the pre-read said open, the statement itself still refused");
  assert.equal(total(), 3, "the guard is in the INSERT: nothing was written");
  assert.equal(one(DB, "SELECT counts_json FROM game_fact_loads WHERE id = ?", a.id).counts_json, countsBefore, "and the counters did not move");
  // a dead load (failed) holding a complete set of rows, and a newer load that is live
  const x = await begin(env, { kinds: { spell_level: 3 } });
  await rowsOp(env, x.json.load_id, nGood(3, 20));
  DB.raw.prepare("UPDATE game_fact_loads SET status = 'failed' WHERE id = ?").run(x.json.load_id);
  const y = await loadAll(env, nGood(3, 30));
  const liveY = () => one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE load_id = ? AND superseded = 0", y.id).c;
  const retired = () => one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE superseded = 1").c;
  const r0 = retired();
  assert.equal(liveY(), 3);
  const delayed = await call({ ...env, DB: stale(DB, LOAD_READ) }, { purpose: P, op: "finish", load_id: x.json.load_id });
  assert.equal(delayed.status, 409);
  assert.equal(liveY(), 3, "the newer load's rows are still live");
  assert.equal(retired(), r0, "nothing was superseded");
  assert.equal(one(DB, "SELECT status FROM game_fact_loads WHERE id = ?", x.json.load_id).status, "failed");
  for (const i of [20, 21, 22]) assert.deepEqual((await lookupGameFacts(env, mkRow(i).subject)).rows, [], "the failed load's rows are never served");
});

test("begin declares the kinds with a count each; finish needs every declared kind complete and retires only the declared kinds; an older build is refused", async () => {
  const { DB, env } = await fresh();
  const trait = (i, build = BUILD) => mkRow(i, { id: `trait_max_ranks:1112-${i}`, kind: "trait_max_ranks", unit: "ranks", source_table: "traitnode", subject: `Frostweave ${i}`, claim: `Frostweave ${i} is a Mage talent with 2 ranks.`, value: "2", build });
  const item = (i) => mkRow(i, { id: `itemsparse:${i}`, kind: "item_level_req", source_table: "itemsparse", build: BUILD2 });
  await loadAll(env, [...nGood(2), trait(1), trait(2)]);
  const b = await begin(env, { build: BUILD2, kinds: { spell_level: 2 } });
  assert.equal((await rowsOp(env, b.json.load_id, [trait(3, BUILD2)])).status, 400, "a kind begin did not declare");
  await rowsOp(env, b.json.load_id, [mkRow(1, { build: BUILD2 })]);
  assert.equal((await finish(env, b.json.load_id)).status, 409, "one of two declared spell_level rows");
  await rowsOp(env, b.json.load_id, [mkRow(2, { build: BUILD2 })]);
  assert.equal((await finish(env, b.json.load_id)).status, 200);
  assert.equal(published(DB, "g.kind = 'trait_max_ranks'"), 2, "a load without traits never retires trait facts");
  assert.equal(published(DB, "g.kind = 'spell_level'"), 2);
  const c = await begin(env, { build: BUILD2, kinds: { spell_level: 1, item_level_req: 1 } });
  await rowsOp(env, c.json.load_id, [mkRow(1, { build: BUILD2 })]);
  assert.equal((await finish(env, c.json.load_id)).status, 409, "a declared kind with no rows at all");
  assert.equal(published(DB, "g.kind = 'spell_level'"), 2, "nothing retired by the refused finish");
  await rowsOp(env, c.json.load_id, [item(1)]);
  assert.equal((await finish(env, c.json.load_id)).status, 200);
  assert.equal(published(DB, "g.kind = 'spell_level'"), 1, "now spell_level is the declared one-row set");
  const old = await begin(env, { build: "9.9.9.0", kinds: { spell_level: 1 } });
  assert.equal(old.status, 409);
  assert.deepEqual(old.json, { ok: false, reason: "older_build" });
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads WHERE build = '9.9.9.0'").c, 0);
  assert.equal((await begin(env, { build: BUILD2, kinds: { spell_level: 1 } })).status, 200, "the same build may be loaded again");
  assert.equal((await begin(env, { kind: "curated", build: "9.9.9.10", kinds: { curated: 1 } })).status, 200, "another kind of load has its own build line");
});

test("anchors: a field that ends in a newline, CRLF or CR is rejected (in JS a bare $ matches only at the very end; this pins it)", () => {
  const base = mkRow(1);
  for (const field of ["id", "source_table", "row_id", "build", "unit", "verdict", "source_class", "kind"]) {
    for (const suffix of ["\n", "\r\n", "\r", "\u2028", " "]) assert.ok(validateRow({ ...base, [field]: base[field] + suffix }, "client").error, `${field} + ${JSON.stringify(suffix)}`);
  }
  const shaOk = "a".repeat(64), files = { "a.csv": { sha256: shaOk, bytes: 1, rows: 1 } };
  const ok = { purpose: P, op: "begin", build: BUILD, manifest_sha256: shaOk, files, kind: "client", kinds: { spell_level: 1 } };
  assert.equal(parseFactsBody(ok).op, "begin");
  for (const patch of [{ build: `${BUILD}\n` }, { build: `${BUILD}\r\n` }, { manifest_sha256: `${shaOk}\n` }, { files: { "a.csv\n": files["a.csv"] } }, { files: { "a.csv": { ...files["a.csv"], sha256: `${shaOk}\r\n` } } }]) assert.ok(parseFactsBody({ ...ok, ...patch }).error, JSON.stringify(patch).slice(0, 40));
  const id = "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12);
  assert.equal(parseFactsBody({ purpose: P, op: "finish", load_id: id }).op, "finish");
  for (const bad of [`${id}\n`, `${id}\r\n`]) { assert.ok(parseFactsBody({ purpose: P, op: "finish", load_id: bad }).error); assert.ok(parseFactsBody({ purpose: P, op: "rows", load_id: bad, rows: [mkRow(1)] }).error); }
});

test("lookup: curated facts have subjects and sources, so similar ones do not collapse; the newest done load per id is chosen in the query", async () => {
  const { DB, env } = await fresh();
  const derived = deriveCuratedRows(curatedLines(), clientFactLines(), BUILD);
  for (const r of derived.rows) { assert.ok(r.subject.length >= 1 && r.subject.length <= 120, r.id); assert.ok(r.source_table && r.row_id, r.id); assert.ok(validateRow(r, "curated").row, r.id); }
  const cur = (n, claim) => ({ id: `curated:C${n}`, kind: "curated", subject: claim.slice(0, 80), claim, value: "", unit: "", source_table: "facts", row_id: `C${n}`, build: "2026.11.19", verdict: "holds", source_class: "wiki", note: "" });
  await loadAll(env, [cur(1, "Stormcaller Totem lasts 20 seconds."), cur(2, "Stormcaller Totem lasts 30 seconds in raids.")], { kind: "curated", build: "2026.11.19" });
  assert.deepEqual((await lookupGameFacts(env, "How long does Stormcaller Totem last?")).rows.map((r) => r.id).sort(), ["curated:C1", "curated:C2"]);
  // a stale or lost superseded flag: the query still serves the newest done load of an id
  await loadAll(env, [named(700, "Sparkmoth", { claim: "Sparkmoth requires level 10.", value: "10", build: "9.9.9.5" })], { build: "9.9.9.5" });
  await loadAll(env, [named(700, "Sparkmoth", { claim: "Sparkmoth requires level 12.", value: "12", build: "9.9.9.10" })], { build: "9.9.9.10" });
  DB.raw.prepare("UPDATE game_facts SET superseded = 0").run();
  const r = await lookupGameFacts(env, "Sparkmoth");
  assert.deepEqual(r.rows.map((x) => [x.id, x.value, x.build]), [["spelllevels:700", "12", "9.9.9.10"]], "the older load's row of the same id is not served, and the name is not reported ambiguous");
  assert.equal(r.ambiguous, false);
});

test("tool state keeps progress per scope: a lost client finish leaves the file, the rerun resumes only that scope and the Worker answers the repeated finish", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir, { nItems: 5 });
  const state = join(dir, "state.json");
  const argv = [tokenFile(dir), "--tables", dir, "--facts", jsonl(dir, "facts.jsonl", curatedLines()), "--client-facts", jsonl(dir, "client-facts.jsonl", clientFactLines()), "--apply", "--base", "http://localhost:8787", "--state", state];
  const a = inprocess(env);
  let finishes = 0;
  const lossy = async (url, init) => { const res = await a.fetchImpl(url, init); return JSON.parse(init.body).op === "finish" && ++finishes === 2 ? new Response("{}", { status: 502 }) : res; }; // the Worker processed it; the answer was lost
  const first = clockDeps();
  assert.equal(await runTool(argv, { ...first.deps, fetchImpl: lossy }), 1);
  const st = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(scopeOf(st, "curated").done, true, "curated loads first"); assert.equal(scopeOf(st, "client").done, false);
  assert.deepEqual(all(DB, "SELECT status FROM game_fact_loads ORDER BY kind").map((l) => l.status), ["done", "done"], "the Worker had finished both");
  await first.deps.sleep(2000);
  const b = inprocess(env);
  assert.equal(await runTool(argv, { ...first.deps, fetchImpl: b.fetchImpl }), 0, first.out.join("; "));
  assert.deepEqual(b.seen.map((s) => s.op), ["finish"], "no begin, no rows: only the unfinished scope's finish, answered again with the same counts");
  assert.match(first.out.join("\n"), /curated: already finished in an earlier run/);
  assert.ok(!existsSync(state), "removed once every planned scope is finished");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads").c, 2);
});

test("tool declares exactly the kinds it generated: a run without --traits retires no trait fact", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir, { nItems: 5 });
  const base = [tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:8787", "--state", join(dir, "state.json")];
  const first = clockDeps();
  const a = inprocess(env);
  assert.equal(await runTool([...base, "--traits", traitsFile(dir)], { ...first.deps, fetchImpl: a.fetchImpl }), 0, first.out.join("; "));
  const declaredA = a.seen.find((s) => s.op === "begin").kinds;
  assert.ok(declaredA.trait_max_ranks > 0 && declaredA.spell_level > 0);
  await first.deps.sleep(2000);
  const b = inprocess(env);
  assert.equal(await runTool(base, { ...first.deps, fetchImpl: b.fetchImpl }), 0, first.out.join("; "));
  const declaredB = b.seen.find((s) => s.op === "begin").kinds;
  assert.deepEqual(Object.keys(declaredB).sort(), ["item_level_req", "spell_cast_time", "spell_cooldown", "spell_level", "spell_mana_cost"]);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind LIKE 'trait_%' AND superseded = 0").c, declaredA.trait_max_ranks + declaredA.trait_points_required + declaredA.trait_prereq, "trait facts stay published");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE kind LIKE 'trait_%' AND superseded = 1").c, 0);
  const lone = await runTool(["--tables", dir, "--facts", jsonl(dir, "f2.jsonl", curatedLines()), "--scope", "curated"], { ...clockDeps().deps });
  assert.equal(lone, 2, "a curated load replaces every curated row, so it needs both curated files");
});

// ---- option C: load order, --kinds, the daily rows-written budget ----------------------------------------------------------------------------------------
test("tool plan: curated loads first; in the client load traits and spells come before item_level_req; --kinds restricts; unknown kinds and an empty plan are refused", () => {
  const dir = tmp(); writeTables(dir, { nItems: 10 });
  const base = { tables: dir, traits: traitsFile(dir), facts: jsonl(dir, "facts.jsonl", curatedLines()), clientFacts: jsonl(dir, "client-facts.jsonl", clientFactLines()) };
  const plan = buildPlan(base);
  assert.deepEqual(plan.loads.map((l) => l.kind), ["curated", "client"]);
  const kinds = plan.loads[1].rows.map((r) => r.kind);
  const order = [...new Set(kinds)];
  assert.deepEqual(order, KIND_ORDER.filter((k) => k !== "curated" && order.includes(k)), "kinds appear in KIND_ORDER, one block each");
  assert.equal(order[order.length - 1], "item_level_req", "item_level_req last");
  assert.equal(order[0].startsWith("trait_"), true);
  const only = buildPlan({ ...base, kinds: ["spell_level", "spell_cooldown"], scope: "client" });
  assert.deepEqual(Object.keys(only.loads[0].counts).sort(), ["spell_cooldown", "spell_level"]);
  assert.deepEqual(buildPlan({ ...base, kinds: ["curated"] }).loads.map((l) => l.kind), ["curated"]);
  assert.throws(() => buildPlan({ ...base, kinds: ["friend"] }), /--kinds names fact kinds/);
  assert.throws(() => buildPlan({ ...base, kinds: [] }), /--kinds names fact kinds/);
  assert.throws(() => buildPlan({ tables: dir, kinds: ["trait_max_ranks"], scope: "client" }), /nothing to load/, "a kind with no input file");
  assert.ok(plan.loads[1].suffixed >= 0 && Number.isInteger(plan.loads[1].suffixed));
});

test("tool dry run prints the load order, per-kind name counts (unique and ambiguous, counts only), and the estimated D1 rows written against the budget", async () => {
  const dir = tmp(); writeTables(dir, { nItems: 10 });
  const { out, deps } = clockDeps();
  assert.equal(await runTool(["--tables", dir, "--traits", traitsFile(dir), "--facts", jsonl(dir, "facts.jsonl", curatedLines()), "--client-facts", jsonl(dir, "client-facts.jsonl", clientFactLines())], { ...deps, fetchImpl: async () => { throw new Error("no network"); } }), 0);
  const text = out.join("\n");
  assert.ok(text.indexOf("load curated") < text.indexOf("load client"));
  assert.ok(text.indexOf("spell_level") < text.indexOf("item_level_req"));
  assert.match(text, /spell_level\s+6\s+names 6: unique 6, ambiguous 0/);
  assert.match(text, /estimated D1 rows written: \d+/);
  assert.match(text, /budget per run 60000 \(D1 Free: 100000 a day\), so 1 run\(s\)/);
  for (const secret of ["Zorbo", "Fakeblade", "Frostweave"]) assert.ok(!text.includes(secret), secret);
  const st = nameStats([{ kind: "spell_level", subject: "Fire Blast" }, { kind: "spell_level", subject: "fire-blast" }, { kind: "spell_level", subject: "Frostbolt" }, { kind: "spell_cooldown", subject: "Fire Blast" }, { kind: "curated", subject: "x" }]);
  assert.deepEqual(st, { spell_level: { names: 2, unique: 1, ambiguous: 1 }, spell_cooldown: { names: 1, unique: 1, ambiguous: 0 } }, "names are compared after the shared normaliser");
  for (const bad of ["50", "90001", "abc", "1.5"]) assert.notEqual(await runTool(["--tables", dir, "--max-rows-per-run", bad], { ...clockDeps().deps }), 0, bad);
  assert.notEqual(await runTool(["--tables", dir, "--kinds", "friend", "--scope", "client"], { ...clockDeps().deps }), 0);
});

test("tool write budget: a run stops cleanly under --max-rows-per-run with the load still open and the published facts untouched; the next run resumes and finishes", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir);
  const state = join(dir, "state.json");
  const argv = (extra) => [tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:8787", "--state", state, ...extra];
  await loadAll(env, [mkRow(1, { id: "spelllevels:1001", subject: "Zorbo a Bolt", claim: "Zorbo a Bolt requires level 5." })]); // an earlier published load must stay visible
  const { deps, out } = clockDeps();
  const a = inprocess(env);
  const cost = writeCost(200, 0, 1);
  assert.equal(await runTool(argv(["--max-rows-per-run", String(writeCost(0, 0, 2) + cost + 50)]), { ...deps, fetchImpl: a.fetchImpl }), 1);
  assert.match(out.join("\n"), /stopped \(daily rows-written budget reached \(\d+ of \d+ counted\)\)/);
  assert.deepEqual(a.seen.map((s) => s.op), ["begin", "rows"], "begin and one batch, then it stopped before the next");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads WHERE status = 'open'").c, 1);
  assert.equal((await lookupGameFacts(env, "Zorbo a Bolt")).rows.length, 1, "the published fact is still served while the new load is open");
  await deps.sleep(2000);
  const b = inprocess(env);
  assert.equal(await runTool(argv([]), { ...deps, fetchImpl: b.fetchImpl }), 0, out.join("; "));
  assert.ok(!b.seen.some((s) => s.op === "begin"), "resumed, not restarted");
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_fact_loads WHERE status = 'done' AND kind = 'client'").c, 2);
  assert.match(out.join("\n"), /done: \d+ calls, about \d+ D1 rows written/);
});

test("tool write constants: the tool's counting and the smoke's measurement use the same numbers, and the cost function is the arithmetic stated", () => {
  assert.deepEqual([WRITES_PER_FACT, WRITES_PER_SUFFIXED_FACT, WRITES_PER_CALL, WRITES_PER_RETIRED_FACT], [2, 1, 3, 1]);
  assert.equal(writeCost(100, 10, 2), 100 * 2 + 10 + 2 * 3);
  assert.equal(writeCost(0, 0, 1), 3);
  assert.ok(DEFAULT_ROW_BUDGET <= 100000 && DEFAULT_ROW_BUDGET === 60000);
  assert.deepEqual(KIND_ORDER.slice(-1), ["item_level_req"]);
});

// ---- shared-name player spells: ranks ---------------------------------------------------------------------------------------------------------------
const rankPlan = (dir, extra = {}) => buildPlan({ tables: dir, scope: "client", ...extra });
const rankDir = (opts = {}) => { const dir = tmp(); writeTables(dir, { nItems: 10, ranks: true, ...opts }); return dir; };
const rowsById = (rows) => new Map(rows.map((r) => [r.id, r]));
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));

test("rank rows: every rank of a shared-name player spell is its own fact per kind, keyed by its own table row id, with the rank in the claim and the note", () => {
  const dir = rankDir();
  const { rows } = deriveRankRows(dir, manifestOf(dir));
  const lance = rows.filter((r) => r.subject === "Zephyr Lance");
  assert.deepEqual(lance.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {}), { spell_level: 4, spell_cooldown: 4, spell_cast_time: 4, spell_mana_cost: 4 });
  const r4 = rowsById(lance);
  assert.equal(r4.get("spelllevels:10004").claim, "Zephyr Lance (Rank 4) requires level 28.");
  assert.equal(r4.get("spelllevels:10004").value, "28"); assert.equal(r4.get("spelllevels:10004").unit, "level");
  assert.equal(r4.get("spelllevels:10004").note, "rank=4;class=Fiction Mage");
  assert.equal(r4.get("spellcooldowns:12004").claim, "Zephyr Lance (Rank 4) has a cooldown of 8 seconds.");
  assert.equal(r4.get("spellmisc:11004").claim, "Zephyr Lance (Rank 4) has a cast time of 1.5 seconds.");
  assert.equal(r4.get("spellpower:9004").claim, "Zephyr Lance (Rank 4) costs 40 mana.");
  assert.ok(rows.every((r) => r.id !== "spelllevels:3004"), "the id is the table row id, never the SpellID");
  const vow = rows.filter((r) => r.subject === "Ember's Vow: Rite" && r.kind === "spell_level").map((r) => r.claim).sort();
  assert.deepEqual(vow, ["Ember's Vow: Rite (Rank 1) requires level 10.", "Ember's Vow: Rite (Rank 2) requires level 30."]);
  const twin = rows.filter((r) => r.subject === "Twinname Strike" && r.kind === "spell_level");
  assert.deepEqual(twin.map((r) => r.note).sort(), ["rank=1;class=Fiction Priest", "rank=1;class=Fiction Rogue"]);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.ok(rows.every((r) => !validateRow(r, "client").error), "every row passes the Worker's own validation");
  assert.equal(rankNote(0, ""), ""); assert.equal(rankNote(3, ""), "rank=3");
});

test("rank rows: ids, claims and values of every row the unique-name loader already produced are unchanged, and the two derivations never share a spell", () => {
  const before = tmp(); writeTables(before, { nItems: 10 });
  const after = rankDir();
  const old = rankPlan(before).loads[0].rows, now = rankPlan(after).loads[0].rows;
  const nowById = rowsById(now);
  for (const r of old) assert.deepEqual(nowById.get(r.id), r, "a row that existed before keeps its id and every field: " + r.id);
  const rankRows = deriveRankRows(after, manifestOf(after)).rows;
  const oldIds = new Set(old.map((r) => r.id));
  assert.ok(rankRows.every((r) => !oldIds.has(r.id)), "no rank row reuses a legacy id");
  assert.equal(now.length, old.length + rankRows.length);
  const zorbo = nowById.get("spelllevels:1001");
  assert.equal(zorbo.claim, "Zorbo a Bolt requires level 5."); assert.equal(zorbo.note, "", "a unique name with a rank line stays a legacy row");
  assert.deepEqual(rankPlan(after).loads[0].rows, now, "a re-derivation is identical, so a re-load does not churn");
});

test("rank rows: the rank path and the legacy path agree on a unique name (drift guard); BaseLevel 0 is not a player spell", () => {
  const dir = tmp(); writeTables(dir, { nItems: 10 });
  const manifest = manifestOf(dir);
  const legacy = rowsById(deriveTableRows(dir, manifest).rows);
  const viaRank = deriveRankRows(dir, manifest, { includeUnique: true }).rows;
  assert.ok(viaRank.length >= 20, "level, cooldown, cast time and mana rows of the six Zorbo spells");
  for (const r of viaRank) assert.deepEqual(legacy.get(r.id), r, "same id, claim, value and unit on both paths: " + r.id);
  assert.equal(deriveRankRows(dir, manifest).rows.length, 0, "no shared name, no rank row");
  assert.ok(!viaRank.some((r) => r.subject === "Twinname Strike"));
});

test("rank rows: the plan counts them per kind (counts only) and splits shared names into ranks of one spell and different spells; they load before item_level_req", () => {
  const dir = rankDir();
  const l = rankPlan(dir).loads[0];
  assert.deepEqual(l.ranked.perKind, { spell_level: 8, spell_cooldown: 6, spell_cast_time: 6, spell_mana_cost: 6 });
  assert.equal(l.ranked.names, 3);
  assert.equal(l.ranked.ranksOfOne, 2, "Zephyr Lance and Ember's Vow have distinct ranks");
  assert.equal(l.ranked.differentSpells, 1, "Twinname Strike: two spells, the same rank");
  assert.equal(l.ranked.single, 0);
  const kinds = l.rows.map((r) => r.kind);
  assert.ok(kinds.lastIndexOf("spell_mana_cost") < kinds.indexOf("item_level_req"));
  const only = rankPlan(dir, { kinds: ["spell_level"] }).loads[0];
  assert.deepEqual(Object.keys(only.counts), ["spell_level"]);
  assert.equal(only.counts.spell_level, 6 + 8);
  assert.equal(rankStats(only.rows, new Set()).rows, 0);
});

test("rank lookup: 'Zephyr Lance rank 4' returns only the rank-4 rows; no rank returns every rank in order; a rank that does not exist returns nothing and says so", async () => {
  const { env } = await fresh();
  await loadAll(env, rankPlan(rankDir()).loads[0].rows);
  const r4 = await lookupGameFacts(env, "what is the cooldown and level of Zephyr Lance rank 4?", { limit: 5 });
  assert.deepEqual(r4.rows.map((r) => [r.kind, r.rank, r.id]).sort(), [["spell_cooldown", 4, "spellcooldowns:12004"], ["spell_level", 4, "spelllevels:10004"], ["spell_cast_time", 4, "spellmisc:11004"], ["spell_mana_cost", 4, "spellpower:9004"]].sort());
  assert.equal(r4.rows.find((r) => r.kind === "spell_level").value, "28");
  assert.equal(r4.rows[0].hint, "Fiction Mage");
  assert.equal(r4.ambiguous, false);
  assert.equal(r4.rankMissing, undefined);
  for (const q of ["Zephyr Lance rank IV level", "rank 4 Zephyr Lance level", "Zephyr Lance Rank 4"]) assert.deepEqual((await lookupGameFacts(env, q)).rows.map((r) => r.rank), [4, 4, 4, 4], q);
  const all = await lookupGameFacts(env, "when do I get Zephyr Lance?");
  assert.deepEqual(all.rows.map((r) => r.rank), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], "the whole ladder, lowest rank first, never cut by the limit");
  assert.deepEqual(all.rows.filter((r) => r.kind === "spell_level").map((r) => r.value), ["4", "12", "20", "28"]);
  assert.equal(all.ambiguous, true, "several rows of one kind for one name");
  const none = await lookupGameFacts(env, "level of Zephyr Lance rank 9");
  assert.deepEqual(none.rows, []); assert.equal(none.rankMissing, true);
});

test("rank lookup: a name shared by different spells returns both with class hints and ambiguous; apostrophes and colons fold; a legacy row has no rank key", async () => {
  const { env } = await fresh();
  await loadAll(env, rankPlan(rankDir()).loads[0].rows);
  const tw = await lookupGameFacts(env, "What level is Twinname Strike rank 1?");
  assert.deepEqual(tw.rows.map((r) => [r.id, r.hint, r.rank]).sort(), [["spelllevels:2001", "Fiction Rogue", 1], ["spelllevels:2002", "Fiction Priest", 1]].sort());
  assert.equal(tw.ambiguous, true);
  const vow = await lookupGameFacts(env, "what level is embers vow rite rank 2");
  assert.deepEqual(vow.rows.filter((r) => r.kind === "spell_level").map((r) => [r.rank, r.value]), [[2, "30"]]);
  assert.equal(vow.rows.length, 4);
  const z = (await lookupGameFacts(env, "what level is Zorbo a Bolt")).rows.find((r) => r.kind === "spell_level");
  assert.deepEqual(Object.keys(z).sort(), ["build", "claim", "id", "kind", "row_id", "source_table", "subject", "unit", "value"]);
  assert.equal(z.claim, "Zorbo a Bolt requires level 5.");
});

test("rank lookup helpers: askedRank reads rank N, rank roman and rank-before-name; parseNote accepts only the two known keys", () => {
  const t = (s) => questionWindows(s).tokens;
  assert.equal(askedRank(t("fireball rank 4 level"), { start: 0, len: 1 }), 4);
  assert.equal(askedRank(t("fireball rank iv"), { start: 0, len: 1 }), 4);
  assert.equal(askedRank(t("rank 7 fireball"), { start: 2, len: 1 }), 7);
  assert.equal(askedRank(t("when do I get fireball"), { start: 4, len: 1 }), null);
  assert.equal(askedRank(t("fireball rank"), { start: 0, len: 1 }), null);
  assert.deepEqual(parseNote("rank=4;class=Mage"), { rank: 4, hint: "Mage" });
  assert.deepEqual(parseNote("rank=abc;evil=1;class=<b>"), {});
  assert.deepEqual(parseNote(""), {}); assert.deepEqual(parseNote(null), {});
});

test("rank load: --max-rows-per-run stops after the batch that carries the rank rows, the load stays open, the next run resumes; a second identical load changes nothing", async () => {
  const { DB, env } = await fresh();
  const dir = tmp(); writeTables(dir, { nItems: 450, ranks: true });
  const state = join(dir, "state.json");
  const argv = (extra, st = state) => [tokenFile(dir), "--tables", dir, "--scope", "client", "--apply", "--base", "http://localhost:8787", "--state", st, ...extra];
  const first = rankPlan(dir).loads[0].batches[0];
  assert.ok(first.some((r) => r.id === "spelllevels:10004"), "the rank rows are in the first batch (spells come before item_level_req)");
  const { deps, out } = clockDeps();
  const a = inprocess(env);
  const budget = writeCost(0, 0, 2) + writeCost(first.length, first.filter((r) => baseName(normName(r.subject))).length, 1) + 50;
  assert.equal(await runTool(argv(["--max-rows-per-run", String(budget)]), { ...deps, fetchImpl: a.fetchImpl }), 1);
  assert.deepEqual(a.seen.map((x) => x.op), ["begin", "rows"]);
  assert.equal(one(DB, "SELECT COUNT(*) AS c FROM game_facts WHERE id = 'spelllevels:10004'").c, 1, "the rank row is in the open load");
  assert.deepEqual((await lookupGameFacts(env, "Zephyr Lance rank 4")).rows, [], "open load: invisible");
  await deps.sleep(2000);
  const b = inprocess(env);
  assert.equal(await runTool(argv([]), { ...deps, fetchImpl: b.fetchImpl }), 0, out.join("; "));
  assert.equal((await lookupGameFacts(env, "Zephyr Lance rank 4")).rows.length, 4);
  const again = inprocess(env);
  const lines = [];
  await deps.sleep(2000);
  assert.equal(await runTool(argv([], join(dir, "state2.json")), { ...deps, log: (l) => lines.push(l), fetchImpl: again.fetchImpl }), 0);
  assert.match(lines.join("\n"), /finish client: total \d+, added 0, changed 0, unchanged \d+, removed 0/);
});
