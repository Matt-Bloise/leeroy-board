// Noise budget: pure decidePost, quiet hours across both DST changes, config validation, and the D1 ledger SQL against a fake. No network, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { decidePost, noiseDay, nextLocalHour, dayKey, resolveConfig, validateNoiseConfig, readLedger, recordPost, recordShadow, shadowChannel } from "../../infrastructure/worker/noise.js";

const utc = (...a) => Date.UTC(...a);

test("defaults: 3 a day, allowed in the afternoon", () => {
  const now = utc(2026, 10, 3, 18, 0); // 1 PM EST, Nov 3
  assert.deepEqual(decidePost({ now, ledger: { "2026-11-03": 2 } }), { ok: true, day: "2026-11-03", used: 2, limit: 3 });
  const r = decidePost({ now, ledger: { "2026-11-03": 3 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "budget");
  assert.equal(dayKey(r.notBefore), "2026-11-04");
  assert.equal(r.notBefore, utc(2026, 10, 4, 5, 0)); // local midnight Nov 4 = 05:00 UTC (EST)
});

test("per-day override beats perDay, in both directions", () => {
  const now = utc(2026, 10, 4, 18, 0);
  assert.equal(decidePost({ now, ledger: { "2026-11-04": 3 }, config: { overrides: { "2026-11-04": 6 } } }).ok, true);
  assert.equal(decidePost({ now, ledger: { "2026-11-04": 1 }, config: { overrides: { "2026-11-04": 1 } } }).ok, false);
  assert.equal(decidePost({ now, ledger: {}, config: { perDay: 0 } }).ok, false);
});

test("quiet hours 1 to 9 AM: held with notBefore at 9:00 local (EST, winter)", () => {
  for (const [h, m] of [[6, 0], [10, 30], [13, 59]]) { // 1:00 to 8:59 EST
    const r = decidePost({ now: utc(2026, 10, 3, h, m), ledger: {} });
    assert.equal(r.reason, "quiet_hours", `${h}:${m}`);
    assert.equal(r.notBefore, utc(2026, 10, 3, 14, 0));
  }
  assert.equal(decidePost({ now: utc(2026, 10, 3, 5, 59), ledger: {} }).ok, true); // 12:59 AM
  assert.equal(decidePost({ now: utc(2026, 10, 3, 14, 0), ledger: {} }).ok, true); // 9:00 AM
});

test("DST spring forward (Mar 8 2026): 2 AM does not exist, 9 AM is 13:00 UTC", () => {
  assert.equal(decidePost({ now: utc(2026, 2, 8, 5, 59), ledger: {} }).ok, true); // 12:59 AM EST
  assert.equal(decidePost({ now: utc(2026, 2, 8, 6, 0), ledger: {} }).reason, "quiet_hours"); // 1:00 EST
  assert.equal(decidePost({ now: utc(2026, 2, 8, 7, 0), ledger: {} }).reason, "quiet_hours"); // 3:00 EDT
  const r = decidePost({ now: utc(2026, 2, 8, 12, 59), ledger: {} }); // 8:59 EDT
  assert.equal(r.reason, "quiet_hours");
  assert.equal(r.notBefore, utc(2026, 2, 8, 13, 0));
  assert.equal(decidePost({ now: utc(2026, 2, 8, 13, 0), ledger: {} }).ok, true);
  // The night before: held from EST evening to a 9 AM EDT release is computed with the new offset.
  assert.equal(nextLocalHour(utc(2026, 2, 8, 3, 0), 9), utc(2026, 2, 8, 13, 0)); // 10 PM EST Mar 7 -> 9 AM EDT Mar 8
});

test("DST fall back (Nov 1 2026): 1:30 AM happens twice and both are quiet; 9 AM is 14:00 UTC", () => {
  assert.equal(decidePost({ now: utc(2026, 10, 1, 5, 30), ledger: {} }).reason, "quiet_hours"); // 1:30 EDT
  assert.equal(decidePost({ now: utc(2026, 10, 1, 6, 30), ledger: {} }).reason, "quiet_hours"); // 1:30 EST
  const r = decidePost({ now: utc(2026, 10, 1, 13, 59), ledger: {} }); // 8:59 EST
  assert.equal(r.reason, "quiet_hours");
  assert.equal(r.notBefore, utc(2026, 10, 1, 14, 0));
  assert.equal(decidePost({ now: utc(2026, 10, 1, 14, 0), ledger: {} }).ok, true);
  assert.equal(nextLocalHour(utc(2026, 10, 1, 3, 0), 9), utc(2026, 10, 1, 14, 0)); // 11 PM EDT Oct 31 -> 9 AM EST Nov 1
});

test("the ledger day is the New York date, not the UTC date", () => {
  assert.equal(noiseDay(utc(2026, 10, 4, 3, 0)), "2026-11-03"); // 10 PM EST Nov 3 is already Nov 4 in UTC
  assert.equal(noiseDay(utc(2026, 10, 4, 5, 0)), "2026-11-04");
});

test("quiet window may wrap midnight and may be switched off", () => {
  const wrap = { quiet: { start: 22, end: 6 } };
  assert.equal(decidePost({ now: utc(2026, 10, 3, 4, 0), ledger: {}, config: wrap }).reason, "quiet_hours"); // 11 PM
  assert.equal(decidePost({ now: utc(2026, 10, 3, 18, 0), ledger: {}, config: wrap }).ok, true);
  assert.equal(decidePost({ now: utc(2026, 10, 3, 8, 0), ledger: {}, config: { quiet: { start: 3, end: 3 } } }).ok, true);
});

test("config: malformed values fall back, validation rejects them", () => {
  assert.equal(resolveConfig({ perDay: "many", overrides: { bad: 1 }, quiet: { tz: "Not/AZone" } }).perDay, 3);
  assert.deepEqual(resolveConfig(null).overrides, {});
  assert.equal(resolveConfig({ quiet: { tz: "Not/AZone" } }).tz, "America/New_York");
  assert.equal(validateNoiseConfig({ perDay: 3, overrides: { "2026-11-04": 6 }, quiet: { start: 1, end: 9, tz: "America/New_York" } }), null);
  for (const bad of [[], { perDay: -1 }, { perDay: 1.5 }, { extra: 1 }, { overrides: { "Nov 4": 2 } }, { quiet: { start: 24 } }, { quiet: { tz: "Nope/Nope" } }]) {
    assert.ok(validateNoiseConfig(bad), JSON.stringify(bad));
  }
});

// Minimal fake D1 for noise_ledger only.
function fakeLedgerDb() {
  const rows = new Map();
  const db = {
    rows,
    prepare(sql) {
      let args = [];
      const o = {
        bind: (...a) => { args = a; return o; },
        first: async () => { assert.match(sql, /FROM noise_ledger/); const n = rows.get(args.join("|")); return n === undefined ? null : { n }; },
        run: async () => { assert.match(sql, /INSERT INTO noise_ledger/); const k = args.join("|"); rows.set(k, (rows.get(k) || 0) + 1); return { meta: { changes: 1 } }; },
      };
      return o;
    },
  };
  return db;
}

test("ledger stores counts only and shadow entries stay apart from the real budget", async () => {
  const db = fakeLedgerDb();
  await recordPost(db, "chan-1", "2026-11-04");
  await recordPost(db, "chan-1", "2026-11-04");
  await recordShadow(db, "post", "chan-1", "2026-11-04");
  assert.deepEqual(await readLedger(db, "chan-1", "2026-11-04"), { "2026-11-04": 2 });
  assert.deepEqual(await readLedger(db, shadowChannel("post", "chan-1"), "2026-11-04"), { "2026-11-04": 1 });
  assert.deepEqual(await readLedger(db, "chan-2", "2026-11-04"), { "2026-11-04": 0 });
  assert.deepEqual([...db.rows.keys()].sort(), ["2026-11-04|chan-1", "2026-11-04|shadow:post:chan-1"]);
});
