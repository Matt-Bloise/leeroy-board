// The browser suites must not depend on what time they run at. From T-1h to T+12h around the launch the board opens on the wall with no first-visit sheet (js/v15.js openBefore /
// openAfter) and the hero is up from T-24h to T+24h, so a suite that reads the first-visit view (name picker, purpose card) fails deterministically in those hours. Every suite
// therefore pins the page clock to a fixed time before the launch (tests/helpers/clock-arg.mjs pinnedClock / pinContext, applied by browser-stub.mjs stubbed() for every context it makes),
// overridable with --clock. This test fails when that pin goes missing: from the helper, from stubbed(), or from any suite in tests/browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CLOCK, LAUNCH_MS, expectedHero, pinnedClock, pinContext } from "../helpers/clock-arg.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = path.join(here, "..", "browser");
const HOUR = 3600e3;
const read = (f) => fs.readFileSync(path.join(BROWSER, f), "utf8");

// Not browser suites: the runner, a retry helper. prod-probe.mjs is the production probe: real time on purpose (what a visitor sees right now, launch wall included), --clock only
// for its self-test, which must hand it the pin (checked below).
const NOT_SUITES = new Set(["run.mjs", "smoke-retry.mjs"]);
const PRODUCTION = new Set(["prod-probe.mjs"]);
// The probe's self-test opens no board page itself; it runs the probe against a local fixture server and must hand it the pin (checked in the last test).
const SELFTEST = new Set(["prod-probe-selftest.mjs"]);

// A suite pins when it wraps its browser in stubbed() (which pins every context) or calls pinContext(ctx, ...) right after each page context it opens.
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, ""); // whole-line comments only: a block-comment regex is fooled by "/*" inside strings and globs
export function pinProblem(src) {
  const code = strip(src);
  const usesStubbed = /import\s*\{[^}]*\bstubbed\b[^}]*\}\s*from\s*"\.\.\/helpers\/browser-stub\.mjs"/.test(code) && /\bstubbed\(/.test(code);
  if (usesStubbed) return null;
  const importsPin = /import\s*\{[^}]*\bpinContext\b[^}]*\}\s*from\s*"\.\.\/helpers\/clock-arg\.mjs"/.test(code);
  const pageContexts = (code.match(/const ctx = await browser\.newContext\(/g) || []).length;
  const pinned = (code.match(/const ctx = await browser\.newContext\([^\n]*\);\s*await pinContext\(ctx\b/g) || []).length;
  if (!importsPin) return "neither wraps its browser in stubbed() nor imports pinContext from helpers/clock-arg.mjs";
  if (pageContexts === 0) return "imports pinContext but opens no page context it could pin";
  if (pinned !== pageContexts) return `${pageContexts} page contexts opened, ${pinned} followed by await pinContext(ctx, ...)`;
  return null;
}

test("the default pin is a neutral time well before the launch, outside the hero and the wall windows", () => {
  const t = Date.parse(DEFAULT_CLOCK);
  assert.ok(Number.isFinite(t));
  assert.ok(t < LAUNCH_MS - 24 * HOUR, "before the hero window (T-24h)");
  assert.equal(expectedHero(new Date(t)), "");
  assert.ok(!(t >= LAUNCH_MS - HOUR && t < LAUNCH_MS + 12 * HOUR), "outside the wall window (T-1h .. T+12h)");
});

test("pinnedClock: the pin by default, --clock when given, an error for a bad value", () => {
  assert.equal(pinnedClock([]).toISOString(), new Date(DEFAULT_CLOCK).toISOString());
  assert.equal(pinnedClock(["--url", "https://x/"]).toISOString(), new Date(DEFAULT_CLOCK).toISOString());
  assert.equal(pinnedClock(["--clock", "2026-11-04T10:00:00Z"]).toISOString(), "2026-11-04T10:00:00.000Z");
  assert.throws(() => pinnedClock(["--clock", "tomorrow"]), /--clock/);
});

test("pinContext installs the pin on the whole context", async () => {
  const calls = [];
  const ctx = { clock: { install: async (o) => calls.push(o) } };
  await pinContext(ctx, []);
  await pinContext(ctx, ["--clock", "2026-11-05T14:00:00Z"]);
  assert.deepEqual(calls.map((c) => c.time.toISOString()), [new Date(DEFAULT_CLOCK).toISOString(), "2026-11-05T14:00:00.000Z"]);
});

for (const live of [false, true]) {
  test(`stubbed() pins every context it makes (${live ? "--live-api" : "recorded API"}), and only one clock install per context`, async () => {
    const calls = [];
    const mk = () => ({ clock: { install: async (o) => calls.push(o.time.toISOString()) }, route: async () => {}, routeWebSocket: async () => {}, on: () => {}, addInitScript: async () => {} });
    const browser = { newContext: async () => mk(), close: async () => {} };
    // the recorded-API path also installs the API stub, which needs a fuller context than this fake; the pin is installed before it, which is all this test reads
    const wrapped = stubbed(browser, { live, label: "pin-test", argv: [] });
    try { await wrapped.newContext(); } catch (e) { if (!live && !calls.length) throw e; }
    assert.deepEqual(calls, [new Date(DEFAULT_CLOCK).toISOString()]);
  });
}

test("stubbed() hands --clock to the pin", async () => {
  const calls = [];
  const browser = { newContext: async () => ({ clock: { install: async (o) => calls.push(o.time.toISOString()) } }), close: async () => {} };
  const wrapped = stubbed(browser, { live: true, label: "pin-test", argv: ["--clock", "2026-11-04T10:00:00Z"] });
  await wrapped.newContext();
  assert.deepEqual(calls, ["2026-11-04T10:00:00.000Z"]);
});

test("pinProblem: a suite that opens contexts without the pin is caught", () => {
  const bare = `import { pageUrl } from "../helpers/page-url.mjs";\nconst pw = await import("playwright");\nconst browser = await pw.chromium.launch();\nconst ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });\n`;
  assert.match(pinProblem(bare), /neither wraps/);
  assert.equal(pinProblem(`import { stubbed } from "../helpers/browser-stub.mjs";\nconst browser = stubbed(await pw.chromium.launch());\nconst ctx = await browser.newContext({});\n`), null);
  assert.equal(pinProblem(`import { pinContext } from "../helpers/clock-arg.mjs";\nconst ctx = await browser.newContext({ a: 1 }); await pinContext(ctx, argv);\n`), null);
  assert.match(pinProblem(`import { pinContext } from "../helpers/clock-arg.mjs";\nconst ctx = await browser.newContext({ a: 1 });\nconst ctx = await browser.newContext({ a: 2 }); await pinContext(ctx, argv);\n`), /2 page contexts opened, 1 followed/);
  // a mention in a comment is not a pin
  assert.match(pinProblem(`// stubbed(browser) would pin this\nconst browser = await pw.chromium.launch();\n`), /neither wraps/);
});

test("every browser suite installs the clock pin", () => {
  const suites = fs.readdirSync(BROWSER).filter((f) => f.endsWith(".mjs") && !NOT_SUITES.has(f) && !PRODUCTION.has(f) && !SELFTEST.has(f));
  assert.ok(suites.length >= 20, `found ${suites.length} suites`);
  const bad = suites.map((f) => [f, pinProblem(read(f))]).filter(([, p]) => p);
  assert.deepEqual(bad, [], `these suites do not pin the page clock (use stubbed() from helpers/browser-stub.mjs, or pinContext(ctx, argv) from helpers/clock-arg.mjs): ${bad.map(([f, p]) => `${f}: ${p}`).join("; ")}`);
});

test("the production probe runs in real time unless --clock is given, and its self-test hands it the pin", () => {
  const probe = strip(read("prod-probe.mjs")), selftest = strip(read("prod-probe-selftest.mjs"));
  assert.match(probe, /CLOCK = parseClock\(argv\)/);
  assert.match(probe, /if \(CLOCK\) await ctx\.clock\.install/);
  assert.doesNotMatch(probe, /pinnedClock|pinContext|DEFAULT_CLOCK/, "production is not pinned: it reports what a visitor sees right now");
  assert.match(selftest, /"--clock", DEFAULT_CLOCK/);
});
