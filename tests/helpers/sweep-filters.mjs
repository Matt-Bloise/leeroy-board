// Pure helpers the layout sweep uses to decide what is a real page problem and what is the test harness itself. Unit-tested in tests/unit/sweep-filters.test.mjs.

// Firefox reports the harness's own page.evaluate (run through eval, file "debugger eval code") to the report-only CSP, then logs
// "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time." (run on the owner's PC, small sizes, wall).
// Real visitors never run that code, so exactly that message from exactly that origin is ignored. The same text from a real file, and every other console error, still fails.
export const CSP_THROTTLE = "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time.";
export const isHarnessEval = (s) => /^(debugger eval code|eval)\b/i.test(String(s || "").trim());
export function ignoredConsoleError(text, sourceUrl) {
  return String(text || "").trim() === CSP_THROTTLE && isHarnessEval(sourceUrl);
}

// A securitypolicyviolation event is the harness's own when it comes from eval (sourceFile or blockedURI is "debugger eval code" / "eval"). Real violations are formatted one line each.
export function realViolations(events) {
  return (events || []).filter((e) => !isHarnessEval(e.sourceFile) && !isHarnessEval(e.blockedURI))
    .map((e) => `${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${(e.sourceFile || "").split("/").slice(-2).join("/")}:${e.lineNumber}${e.sample ? ` "${String(e.sample).slice(0, 40)}"` : ""}`);
}
