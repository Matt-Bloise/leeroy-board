// Pure helpers the layout sweep uses to decide what is a real page problem and what is the test harness itself. Unit-tested in tests/unit/sweep-filters.test.mjs.

// Firefox reports the harness's own page.evaluate (run through eval, file "debugger eval code") to the report-only CSP, then logs
// "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time." (run on the owner's PC, small sizes, wall).
// Real visitors never run that code, so exactly that message from exactly that origin is ignored. The same text from a real file, and every other console error, still fails.
export const CSP_THROTTLE = "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time.";
// the whole source string must be the harness's: "debugger eval code", "eval", or Firefox's "debugger eval code line 234 > eval" form; a file such as eval-tools.js or a URL does not match
export const isHarnessEval = (s) => /^(debugger eval code|eval)(?:\s+line\s+\d+(?:\s*>\s*eval)*)*$/i.test(String(s || "").trim());
// Firefox can hand the console error over as one string: [JavaScript Error: "<message>" {file: "<file>" line: N}]. When the text has that shape, the message and the file are taken from it (the file inside the text is
// then the only source that counts); otherwise the text is the message and the file is the console location's url. Ownership is the same everywhere: exact throttle message AND a harness-eval file.
const JS_ERROR = /^\[JavaScript Error: "([\s\S]*?)"\s*(?:\{file: "([^"]*)"(?:\s+line: \d+)?\s*\})?\s*\]$/;
export function ignoredConsoleError(text, sourceUrl) {
  let msg = String(text || "").trim(), file = sourceUrl;
  const m = JS_ERROR.exec(msg);
  if (m) { msg = m[1].trim(); file = m[2] === undefined ? sourceUrl : m[2]; }
  return msg === CSP_THROTTLE && isHarnessEval(file);
}

// A securitypolicyviolation event is the harness's own when its SOURCE is the harness eval (sourceFile "debugger eval code"). Only the source decides: site code that calls eval(), new Function() or a string
// setTimeout is blocked with blockedURI "eval" but has a real sourceFile, and the policy has no 'unsafe-eval', so it must be kept (it would break once the policy is enforced).
//
// The sweep's own test environment is not a page problem either. Locally the site's API is the local Worker (for example http://127.0.0.1:8787, via ?brain=), which the report-only connect-src does not list
// (production lists api.leeroy.party and the workers.dev hosts). So a violation whose blockedURI is on the sweep's configured API origin, or on a loopback host (127.0.0.1, localhost, [::1]) when the sweep itself runs
// against a loopback page, is ignored. Any other origin (a third party, a non-loopback host) is still a violation. ctx = { apiOrigins: [origin, ...], local: boolean }, built by sweepContext().
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const isLoopbackUrl = (u) => { try { return LOOPBACK.has(new URL(u).hostname.toLowerCase()); } catch (e) { return false; } };
export function sweepContext(baseUrl) {
  let apiOrigins = [], local = false;
  try { const b = new URL(baseUrl); local = LOOPBACK.has(b.hostname.toLowerCase()); const brain = b.searchParams.get("brain"); if (brain && /^https?:/i.test(brain)) apiOrigins = [new URL(brain).origin]; } catch (e) { /* no base: nothing is local */ }
  return { apiOrigins, local };
}
// Only a connect-src violation can be the test environment's own API: a script, image, style or worker violation on a loopback or API host is a real finding and stays visible. Hosts are compared parsed
// (hostname and port), never by substring.
const ownEnvironment = (e, ctx) => {
  if (!ctx || !/^connect-src$/.test(String(e.violatedDirective || ""))) return false;
  let o; try { const u = new URL(e.blockedURI); if (!/^(https?|wss?):$/.test(u.protocol)) return false; o = u; } catch (err) { return false; }
  if ((ctx.apiOrigins || []).some((a) => { try { const x = new URL(a); return x.hostname === o.hostname && x.port === o.port; } catch (err) { return false; } })) return true;
  return !!ctx.local && LOOPBACK.has(o.hostname.toLowerCase());
};
export function realViolations(events, ctx) {
  return (events || []).filter((e) => !isHarnessEval(e.sourceFile) && !ownEnvironment(e, ctx))
    .map((e) => `${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${(e.sourceFile || "").split("/").slice(-2).join("/")}:${e.lineNumber}${e.sample ? ` "${String(e.sample).slice(0, 40)}"` : ""}`);
}

// Read the collected violations when a cell is over (after every scene was opened and measured, and also when the cell threw). The engine queues the events, so flush two animation frames and settle
// 250 ms first. Every distinct real violation is one failure through `once` (up to 40, with a repeat count). A page that is already gone has nothing to read.
export async function cspCheck(page, once, A, ctx) {
  try {
    // two frames, but never wait for them for ever: a hung or throttled page (a background tab, a stalled compositor) may not run animation frames, so a timer in the page ends the wait after 500 ms
    await page.evaluate(() => new Promise((r) => { const t = setTimeout(r, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); }));
    await page.waitForTimeout(250);
    const v = realViolations(await page.evaluate(() => window.__csp || []), ctx);
    A.checks++;
    const count = new Map(); for (const x of v) count.set(x, (count.get(x) || 0) + 1);
    for (const [x, n] of [...count].slice(0, 40)) once("csp-violation", `${x}${n > 1 ? ` (x${n})` : ""}`);
  } catch (e) { /* the page is gone (closed or crashed): nothing to read */ }
}
