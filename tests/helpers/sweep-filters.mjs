// Pure helpers the layout sweep uses to decide what is a real page problem and what is the test harness itself. Unit-tested in tests/unit/sweep-filters.test.mjs.

// Firefox reports the harness's own page.evaluate (run through eval, file "debugger eval code") to the report-only CSP, then logs
// "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time." (run on the owner's PC, small sizes, wall).
// Real visitors never run that code, so exactly that message from exactly that origin is ignored. The same text from a real file, and every other console error, still fails.
export const CSP_THROTTLE = "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time.";
// the whole source string must be the harness's: "debugger eval code", "eval", or Firefox's "debugger eval code line 234 > eval" form; a file such as eval-tools.js or a URL does not match
export const isHarnessEval = (s) => /^(debugger eval code|eval)(\s+line\s+\d+(\s*>\s*eval)*)?$/i.test(String(s || "").trim());
export function ignoredConsoleError(text, sourceUrl) {
  return String(text || "").trim() === CSP_THROTTLE && isHarnessEval(sourceUrl);
}

// A securitypolicyviolation event is the harness's own when its SOURCE is the harness eval (sourceFile "debugger eval code"). Only the source decides: site code that calls eval(), new Function() or a string
// setTimeout is blocked with blockedURI "eval" but has a real sourceFile, and the policy has no 'unsafe-eval', so it must be kept (it would break once the policy is enforced).
export function realViolations(events) {
  return (events || []).filter((e) => !isHarnessEval(e.sourceFile))
    .map((e) => `${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${(e.sourceFile || "").split("/").slice(-2).join("/")}:${e.lineNumber}${e.sample ? ` "${String(e.sample).slice(0, 40)}"` : ""}`);
}

// Read the collected violations when a cell is over (after every scene was opened and measured, and also when the cell threw). The engine queues the events, so flush two animation frames and settle
// 250 ms first. Every distinct real violation is one failure through `once` (up to 40, with a repeat count). A page that is already gone has nothing to read.
export async function cspCheck(page, once, A) {
  try {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(250);
    const v = realViolations(await page.evaluate(() => window.__csp || []));
    A.checks++;
    const count = new Map(); for (const x of v) count.set(x, (count.get(x) || 0) + 1);
    for (const [x, n] of [...count].slice(0, 40)) once("csp-violation", `${x}${n > 1 ? ` (x${n})` : ""}`);
  } catch (e) { /* the page is gone (closed or crashed): nothing to read */ }
}
