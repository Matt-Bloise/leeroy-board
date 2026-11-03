import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { flagOn, legacyVarName } from "../../infrastructure/worker/flags.js";
import { feedOn } from "../../infrastructure/worker/feed.js";

const bind = (fn) => ({ getBooleanValue: fn });

test("binding true -> on; false -> off; the default passed is false", async () => {
  let seen;
  assert.equal(await flagOn({ FLAGS: bind(async (...a) => { seen = a; return true; }) }, "d1-feed"), true);
  assert.deepEqual(seen, ["d1-feed", false]);
  assert.equal(await flagOn({ FLAGS: bind(async () => false) }, "d1-feed"), false);
});

test("a throw (sync or async) means off, even when the legacy var says on", async () => {
  assert.equal(await flagOn({ D1_FEED: "on", FLAGS: bind(async () => { throw new Error("boom"); }) }, "d1-feed"), false);
  assert.equal(await flagOn({ D1_FEED: "on", FLAGS: bind(() => { throw new Error("boom"); }) }, "d1-feed"), false);
});

test("a non-boolean answer is off", async () => {
  for (const v of ["true", 1, null, undefined]) assert.equal(await flagOn({ FLAGS: bind(async () => v) }, "d1-feed"), false);
});

test("no binding: the legacy [vars] value decides, as before", async () => {
  assert.equal(await flagOn({ D1_FEED: "on" }, "d1-feed"), true);
  assert.equal(await flagOn({ D1_FEED: " ON " }, "d1-feed"), true);
  assert.equal(await flagOn({ D1_FEED: "off" }, "d1-feed"), false);
  assert.equal(await flagOn({}, "d1-feed"), false);
  assert.equal(await flagOn(undefined, "d1-feed"), false);
  assert.equal(await flagOn({ FLAGS: {} , D1_FEED: "on" }, "d1-feed"), true, "a binding without getBooleanValue counts as missing");
});

test("feedOn uses the d1-feed flag", async () => {
  assert.equal(await feedOn({ D1_FEED: "on" }), true);
  assert.equal(await feedOn({ D1_FEED: "on", FLAGS: bind(async () => false) }), false);
});

test("key to legacy var mapping, and every manifest flag maps to an existing [vars] entry that is off", () => {
  assert.equal(legacyVarName("d1-feed"), "D1_FEED");
  const toml = fs.readFileSync(fileURLToPath(new URL("../../infrastructure/wrangler.toml", import.meta.url)), "utf8");
  const m = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../infrastructure/flags.json", import.meta.url)), "utf8"));
  for (const f of m.flags) {
    assert.equal(legacyVarName(f.key), f.legacy_var, f.key);
    assert.match(toml, new RegExp(`^${f.legacy_var} = "off"`, "m"), `${f.legacy_var} must stay off in wrangler.toml`);
  }
});

test("wrangler.toml commits no [[flagship]] block (the app_id is added at deploy time)", () => {
  const toml = fs.readFileSync(fileURLToPath(new URL("../../infrastructure/wrangler.toml", import.meta.url)), "utf8");
  assert.equal(/^\s*\[\[flagship\]\]/m.test(toml), false);
});
