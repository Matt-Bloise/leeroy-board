import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSP_THROTTLE, isHarnessEval, ignoredConsoleError, realViolations, cspCheck, sweepContext } from "../helpers/sweep-filters.mjs";

test("the CSP throttle message from the harness's own eval is ignored", () => {
  assert.equal(ignoredConsoleError(CSP_THROTTLE, "debugger eval code"), true);
  assert.equal(ignoredConsoleError(CSP_THROTTLE + "\n", "debugger eval code line 234 > eval"), true);
});
test("the same text from a real file, and any other console error, still fails", () => {
  assert.equal(ignoredConsoleError(CSP_THROTTLE, "https://leeroy.party/js/board.js"), false);
  assert.equal(ignoredConsoleError(CSP_THROTTLE, ""), false);
  assert.equal(ignoredConsoleError("TypeError: x is undefined", "debugger eval code"), false);
  assert.equal(ignoredConsoleError(CSP_THROTTLE + " Extra.", "debugger eval code"), false);
});
test("only the harness's own source counts as eval: a file named like eval does not", () => {
  for (const ok of ["debugger eval code", "eval", "debugger eval code line 234 > eval", "  Debugger eval code "]) assert.equal(isHarnessEval(ok), true, ok);
  for (const no of ["eval-tools.js", "eval.js", "https://leeroy.party/js/eval", "evaluate", "debugger eval code.js", "", undefined]) assert.equal(isHarnessEval(no), false, String(no));
  assert.equal(ignoredConsoleError(CSP_THROTTLE, "eval-tools.js"), false);
});
test("violations from the harness eval are dropped; real ones, including site eval() blocked as 'eval', are all kept", () => {
  const out = realViolations([
    { violatedDirective: "script-src-elem", blockedURI: "eval", sourceFile: "debugger eval code", lineNumber: 234 },
    { violatedDirective: "script-src", blockedURI: "inline", sourceFile: "debugger eval code line 9 > eval", lineNumber: 1 },
    { violatedDirective: "img-src", blockedURI: "https://x.invalid/a.png", sourceFile: "http://h/css/board.css", lineNumber: 7 },
    { violatedDirective: "img-src", blockedURI: "https://y.invalid/b.png", sourceFile: "", lineNumber: 0, sample: "s" },
    { violatedDirective: "script-src", blockedURI: "eval", sourceFile: "https://leeroy.party/js/board.js", lineNumber: 9 },
  ]);
  assert.equal(out.length, 3);
  assert.match(out[0], /img-src blocked https:\/\/x\.invalid\/a\.png at css\/board\.css:7/);
  assert.match(out[1], /y\.invalid/);
  assert.match(out[2], /script-src blocked eval at js\/board\.js:9/); // would break once the policy is enforced
});

// a stub page that records the order of calls
function stubPage(events, { fail } = {}) {
  const log = [];
  return {
    log,
    evaluate: async (fn) => { if (fail) throw new Error("Target closed"); const src = String(fn); if (/requestAnimationFrame/.test(src)) { log.push("flush"); return; } log.push("read"); return events; },
    waitForTimeout: async (ms) => { log.push(`wait ${ms}`); },
  };
}
const sink = () => { const got = [], A = { checks: 0 }; return { got, A, once: (inv, d) => got.push([inv, d]) }; };

test("cspCheck flushes two frames and waits 250 ms BEFORE it reads, then names every distinct violation once", async () => {
  const ev = [
    { violatedDirective: "img-src", blockedURI: "https://a.invalid/1.png", sourceFile: "http://h/css/a.css", lineNumber: 1 },
    { violatedDirective: "img-src", blockedURI: "https://a.invalid/1.png", sourceFile: "http://h/css/a.css", lineNumber: 1 },
    { violatedDirective: "font-src", blockedURI: "https://b.invalid/f.woff2", sourceFile: "http://h/css/b.css", lineNumber: 2 },
    { violatedDirective: "script-src", blockedURI: "eval", sourceFile: "debugger eval code", lineNumber: 3 },
  ];
  const page = stubPage(ev), s = sink();
  await cspCheck(page, s.once, s.A);
  assert.deepEqual(page.log, ["flush", "wait 250", "read"]);
  assert.equal(s.A.checks, 1);
  assert.equal(s.got.length, 2);
  assert.ok(s.got.every(([inv]) => inv === "csp-violation"));
  assert.match(s.got[0][1], /a\.invalid\/1\.png.*\(x2\)/);
  assert.match(s.got[1][1], /font-src blocked https:\/\/b\.invalid/);
});
test("cspCheck reports nothing for a clean page and does not throw on a page that is gone", async () => {
  const s = sink(); await cspCheck(stubPage([]), s.once, s.A); assert.deepEqual(s.got, []);
  const t = sink(); await cspCheck(stubPage([], { fail: true }), t.once, t.A); assert.deepEqual(t.got, []);
});
test("the sweep reads the violations in the cell's finally block (after the scenes and on a failed cell) and filters console errors", () => {
  const src = readFileSync(new URL("../browser/layout-sweep.mjs", import.meta.url), "utf8");
  assert.match(src, /finally \{[^}]*await cspCheck\(page, once, A, SWEEP_CTX\)/);
  assert.doesNotMatch(src, /wallChecks\(page, size, once, A\); \}\s*\n\s*await cspCheck/);
  assert.match(src, /ignoredConsoleError\(m\.text\(\)/);
});

// the sweep's own test environment (the local Worker on 127.0.0.1:8787) is not a page problem; third parties and eval from the site still are
const V = (directive, blocked, source = "http://127.0.0.1:8080/js/brain.js") => ({ violatedDirective: directive, blockedURI: blocked, sourceFile: source, lineNumber: 5 });
test("a connect-src violation for the local API origin is ignored when the sweep runs locally", () => {
  const ctx = sweepContext("http://127.0.0.1:8080/?brain=http://127.0.0.1:8787");
  assert.deepEqual(ctx, { apiOrigins: ["http://127.0.0.1:8787"], local: true });
  assert.deepEqual(realViolations([V("connect-src", "http://127.0.0.1:8787/api/bootstrap"), V("connect-src", "http://127.0.0.1:8787/api/votes", "http://127.0.0.1:8080/js/votes.js"), V("connect-src", "ws://127.0.0.1:8787/room")], ctx), []);
  assert.deepEqual(realViolations([V("connect-src", "http://localhost:8787/api/x"), V("connect-src", "http://[::1]:8787/api/x")], ctx), []); // any loopback host on a local run
});
test("a connect-src violation for a real third party or a non-loopback origin still fails, local run or not", () => {
  const ctx = sweepContext("http://127.0.0.1:8080/?brain=http://127.0.0.1:8787");
  for (const bad of ["https://evil.example/collect", "https://api.leeroy.party.evil.example/x", "http://192.168.1.5:8787/api/x", "https://127.0.0.1.evil.example/x"]) assert.equal(realViolations([V("connect-src", bad)], ctx).length, 1, bad);
  assert.equal(realViolations([V("connect-src", "https://evil.example/collect")], sweepContext("https://leeroy.party/")).length, 1);
});
test("loopback is only the test environment when the sweep itself is local: against a non-local page it is a violation", () => {
  const ctx = sweepContext("https://pr-1.leeroy-board.pages.dev/");
  assert.deepEqual(ctx, { apiOrigins: [], local: false });
  assert.equal(realViolations([V("connect-src", "http://127.0.0.1:8787/api/bootstrap")], ctx).length, 1);
  assert.equal(realViolations([V("connect-src", "http://127.0.0.1:8787/api/bootstrap")]).length, 1); // no context at all
});
test("an eval from site code still fails, and so does an inline violation, on a local run", () => {
  const ctx = sweepContext("http://127.0.0.1:8080/?brain=http://127.0.0.1:8787");
  const out = realViolations([V("script-src", "eval", "https://leeroy.party/js/board.js"), V("script-src-elem", "inline", "http://127.0.0.1:8080/index.html"), V("img-src", "data", "http://127.0.0.1:8080/css/a.css")], ctx);
  assert.equal(out.length, 3);
  assert.match(out[0], /script-src blocked eval at js\/board\.js:5/);
});
test("a configured API origin on another host is ignored by host and port, whatever the local flag", () => {
  const ctx = sweepContext("https://pages.example/?brain=https://worker.example:9443");
  assert.deepEqual(ctx.apiOrigins, ["https://worker.example:9443"]);
  assert.equal(realViolations([V("connect-src", "https://worker.example:9443/api/data")], ctx).length, 0);
  assert.equal(realViolations([V("connect-src", "https://worker.example:9444/api/data")], ctx).length, 1);
});
