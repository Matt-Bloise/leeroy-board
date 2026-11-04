import test from "node:test";
import assert from "node:assert/strict";
import { CSP_THROTTLE, ignoredConsoleError, realViolations } from "../helpers/sweep-filters.mjs";

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
test("violations from eval are dropped, real ones are all named", () => {
  const ev = [
    { violatedDirective: "script-src-elem", blockedURI: "eval", sourceFile: "debugger eval code", lineNumber: 234 },
    { violatedDirective: "script-src", blockedURI: "inline", sourceFile: "debugger eval code", lineNumber: 1 },
    { violatedDirective: "img-src", blockedURI: "https://x.invalid/a.png", sourceFile: "http://h/css/board.css", lineNumber: 7 },
    { violatedDirective: "img-src", blockedURI: "https://y.invalid/b.png", sourceFile: "", lineNumber: 0, sample: "s" },
  ];
  const out = realViolations(ev);
  assert.equal(out.length, 2);
  assert.match(out[0], /img-src blocked https:\/\/x\.invalid\/a\.png at css\/board\.css:7/);
  assert.match(out[1], /y\.invalid/);
  assert.deepEqual(realViolations([{ violatedDirective: "script-src", blockedURI: "eval", sourceFile: "https://h/js/a.js", lineNumber: 3 }]), []);
});
test("the sweep actually uses both filters", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../browser/layout-sweep.mjs", import.meta.url), "utf8");
  assert.match(src, /ignoredConsoleError\(m\.text\(\)/);
  assert.match(src, /realViolations\(await page\.evaluate/);
});
