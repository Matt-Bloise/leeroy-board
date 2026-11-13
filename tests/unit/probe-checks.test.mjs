// The judging rules of the production probe (tests/browser/prod-probe.mjs), without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { junkIn, wrongCountCopy, memberCountProblem, slugOf, classifyHttp, consoleFailures, isReportOnlyCsp, isCspAdvisory, exemptedAdvisories } from "../helpers/probe-checks.mjs";
import fs from "node:fs";

test("member count: equal passes, any difference fails", () => {
  assert.deepEqual(memberCountProblem(6, 6), []);
  assert.equal(memberCountProblem(5, 6).length, 1);
  assert.equal(memberCountProblem(7, 6).length, 1);
  assert.equal(memberCountProblem(0, 0).length, 1, "an empty reference is itself a failure");
});

test("a typed five with six members fails; with five members it passes", () => {
  assert.equal(wrongCountCopy(["Swipe sideways for all five."], 6).length, 1);
  assert.equal(wrongCountCopy(["Which of the five are you?"], 7).length, 1);
  assert.deepEqual(wrongCountCopy(["Swipe sideways for all five."], 5), []);
  assert.deepEqual(wrongCountCopy(["Swipe sideways for all six."], 6), []);
});

test("other typed counts: the other four, all five of us, the four of you", () => {
  assert.equal(wrongCountCopy(["Ask the other four"], 6).length, 1);
  assert.equal(wrongCountCopy(["Ask the other five"], 6).length, 1, "five is wrong for six members whatever it counts");
  assert.equal(wrongCountCopy(["the four of you"], 6).length, 1);
  assert.deepEqual(wrongCountCopy(["the six of you"], 6), []);
});

test("phrases about five of something else are not the party", () => {
  assert.deepEqual(wrongCountCopy(["The dial steps five points more", "a group of five players", "three of five still travel", "Read from five places"], 6), []);
});

test("junk text: undefined, NaN, [object Object], raw ids", () => {
  for (const bad of ["Level undefined", "NaN gold", "[object Object]", "id 123456789012345678", "x 3f2504e0-4f89-11d3-9a0c-0305e82c3301", "{{name}}", "null"]) assert.equal(junkIn([bad]).length, 1, bad);
  assert.deepEqual(junkIn(["Brindle Oakhand, Tauren Druid", "Level 60 in 4 weeks", "1,234 gold", "Nullify the curse", "Not a number"]), []);
});

test("slugs match the board's own", () => { assert.equal(slugOf("Brindle  Oakhand!"), "brindle-oakhand"); });

test("console exemptions are anchored: the report-only marker must START the message; the Cloudflare beacon is matched by location, not by words in the message", () => {
  const enforced = "Refused to load the image 'https://x/y.png' because it violates the following Content Security Policy directive: \"img-src 'self'\".";
  // enforced violations that merely quote the words must still fail
  assert.equal(consoleFailures([`${enforced} See https://example.org/report-only/policy`]).length, 1);
  assert.equal(consoleFailures([`${enforced} (compare Content-Security-Policy-Report-Only)`]).length, 1);
  assert.equal(isReportOnlyCsp("Refused ... report-only ..."), false);
  assert.equal(isReportOnlyCsp("Content-Security-Policy-Report-Only: blocked x"), true);
  // beacon: by console location (host match, not substring), not by message text
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_FAILED", at: "https://static.cloudflareinsights.com/beacon.min.js" }]).length, 0);
  assert.equal(consoleFailures([{ text: "TypeError: x is not a function (see cloudflareinsights.com)", at: "https://leeroy.party/js/board.js" }]).length, 1);
  assert.equal(consoleFailures([{ text: "boom", at: "https://cloudflareinsights.com.evil.example/x.js" }]).length, 1);
  assert.equal(consoleFailures([{ text: "boom", at: "https://evil.example/cloudflareinsights.com" }]).length, 1);
  // the URL-less network wording is exempt only when a beacon request was seen failing, and never when the message names another URL
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_FAILED", at: "" }]).length, 1);
  const T = 1_000_000, cors = "Origin https://leeroy.party is not allowed by Access-Control-Allow-Origin. Status code: 404", rum = "Beacon API cannot load https://cloudflareinsights.com/cdn-cgi/rum. Origin https://leeroy.party is not allowed by Access-Control-Allow-Origin. Status code: 404";
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_FAILED", at: "", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 0);
  assert.equal(consoleFailures([{ text: "Failed to load resource: the server responded with 500 https://api.leeroy.party/api/x", at: "", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 1);
  assert.equal(consoleFailures([{ text: "TypeError: x", at: "", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 1);
  // the two WebKit lines: exempt within 2 s after a beacon failure (counted via onBeacon), never without one, never later, never for another host
  let n = 0;
  assert.equal(consoleFailures([{ text: cors, at: "", t: T }, { text: rum, at: "", t: T + 10 }], { engine: "webkit", insightsFailedAt: [T - 1500], onBeacon: () => n++ }).length, 0);
  assert.equal(n, 2);
  assert.equal(consoleFailures([{ text: cors, at: "", t: T }, { text: rum, at: "", t: T }]).length, 2, "no beacon failure seen");
  assert.equal(consoleFailures([{ text: cors, at: "", t: T }], { engine: "webkit", insightsFailedAt: [T - 2500] }).length, 1, "more than 2 s after");
  assert.equal(consoleFailures([{ text: cors, at: "", t: T }], { engine: "webkit", insightsFailedAt: [T + 5000] }).length, 1, "failure long after the message");
  assert.equal(consoleFailures([{ text: rum.replace("cloudflareinsights.com", "evil.example"), at: "", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 1, "other host");
  assert.equal(consoleFailures([{ text: cors + " https://api.leeroy.party/api/x", at: "", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 1, "extra text");
  // location: a usable own-origin location is never exempt, even inside the window on WebKit; about:blank or empty is; the wordings are WebKit-only
  assert.equal(consoleFailures([{ text: cors, at: "https://leeroy.party/js/board.js", t: T }, { text: rum, at: "https://leeroy.party/", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 2, "own-origin location");
  assert.equal(consoleFailures([{ text: cors, at: "about:blank", t: T }], { engine: "webkit", insightsFailedAt: [T - 100] }).length, 0);
  assert.equal(consoleFailures([{ text: cors, at: "", t: T }, { text: rum, at: "", t: T }], { engine: "chromium", insightsFailedAt: [T - 100] }).length, 2, "chromium never gets the WebKit wordings");
  assert.equal(consoleFailures([{ text: cors, at: "", t: T }], { insightsFailedAt: [T - 100] }).length, 1, "no engine given");
});

test("console errors: report-only CSP and third-party noise are exempt; an ENFORCED CSP violation fails", () => {
  const enforced = "Refused to load the image 'https://x/y.png' because it violates the following Content Security Policy directive: \"img-src 'self'\".";
  assert.deepEqual(consoleFailures([enforced]), [enforced]);
  assert.deepEqual(consoleFailures(["Content Security Policy: the page's settings blocked a resource"]).length, 1, "the bare phrase is not an exemption");
  assert.deepEqual(consoleFailures([`[Report Only] ${enforced}`, "Content-Security-Policy-Report-Only: the policy blocked x", { text: "Failed to load resource", at: "https://static.cloudflareinsights.com/beacon.min.js" }]), []);
  assert.equal(consoleFailures(["The Content-Security-Policy-Report-Only policy blocked x"]).length, 1, "mid-message mention is not the marker");
  assert.equal(consoleFailures(["failed https://static.cloudflareinsights.com/beacon.min.js"]).length, 1, "message text naming the beacon host is not an exemption");
  assert.equal(isReportOnlyCsp("[Report Only] Refused to load"), true);
  assert.equal(consoleFailures(["Error creating WebGL context"], { engine: "webkit", allowWebkitNoWebgl: true }).length, 0);
  assert.equal(consoleFailures(["Error creating WebGL context"], { engine: "chromium", allowWebkitNoWebgl: true }).length, 1);
  assert.equal(consoleFailures(["TypeError: x is undefined"]).length, 1);
});

test("console errors: our own refusals after the budget is spent are exempt, nothing else is", () => {
  const refused = { text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector", at: "http://127.0.0.1:41234/api/library/tooltips.json" };
  assert.equal(consoleFailures([refused], { budgetSpent: true }).length, 0, "the page's log of a request the probe refused is not a finding");
  assert.equal(consoleFailures([{ ...refused, text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT" }], { budgetSpent: true }).length, 0);
  assert.equal(consoleFailures([refused]).length, 1, "with budget left the same message is a real blocked request and fails");
  assert.equal(consoleFailures([refused], { budgetSpent: false }).length, 1);
  assert.equal(consoleFailures([{ ...refused, at: "http://127.0.0.1:41234/js/board.js" }], { budgetSpent: true }).length, 1, "only /api/ URLs: the probe refuses nothing else");
  assert.equal(consoleFailures([{ ...refused, at: "" }], { budgetSpent: true }).length, 1, "no location, no exemption");
  assert.equal(consoleFailures([{ ...refused, text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector and TypeError: x" }], { budgetSpent: true }).length, 1, "exact message only");
  assert.equal(consoleFailures([{ text: "Failed to load resource: net::ERR_CONNECTION_REFUSED", at: refused.at }], { budgetSpent: true }).length, 1, "other network errors still fail");
  assert.equal(consoleFailures([{ text: "TypeError: x is undefined", at: refused.at }], { budgetSpent: true }).length, 1, "other errors from an /api/ URL still fail");
  assert.equal(consoleFailures(["Refused to load the image 'https://x/y.png' because it violates the following Content Security Policy directive: \"img-src 'self'\"."], { budgetSpent: true }).length, 1);
});

test("the probe tells consoleFailures when the budget is spent", () => {
  const src = fs.readFileSync(new URL("../browser/prod-probe.mjs", import.meta.url), "utf8");
  assert.match(src, /consoleFailures\(errs, \{[^}]*budgetSpent: budget\.exceeded/);
});

test("HTTP statuses: site 4xx/5xx fail; API 5xx fails; API 4xx warns except on bootstrap and state", () => {
  const S = "https://leeroy.party", A = "https://api.leeroy.party";
  assert.equal(classifyHttp(`${S}/js/board.js`, 404, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/library/index`, 503, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/me`, 401, S, A), "warn");
  assert.equal(classifyHttp(`${A}/api/bootstrap`, 404, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/state`, 403, S, A), "fail");
  assert.equal(classifyHttp(`${A}/api/state`, 200, S, A), "ok");
  assert.equal(classifyHttp("https://third.example/x", 500, S, A), "ok", "someone else's host is not ours");
  assert.equal(classifyHttp("http://127.0.0.1:1/api/me", 401, "http://127.0.0.1:1", "http://127.0.0.1:1"), "warn", "local: site and API share an origin, /api/ still counts as the API");
  assert.equal(classifyHttp("http://127.0.0.1:1/css/x.css", 404, "http://127.0.0.1:1", "http://127.0.0.1:1"), "fail");
});

test("WebKit's report-only advisory is exempt, exactly: it must start with \"The Content Security Policy\" AND say report-only; nothing wider", () => {
  const advisory = "The Content Security Policy 'default-src 'self'' was delivered in report-only mode, but does not specify a 'report-uri'; the policy will have no effect.";
  assert.equal(isCspAdvisory(advisory), true);
  assert.equal(isCspAdvisory(advisory.toUpperCase().replace("THE CONTENT SECURITY POLICY", "The Content Security Policy")), true, "report-only is matched case-insensitively");
  assert.deepEqual(consoleFailures([advisory]), []);
  // an enforced block that starts the same way, no report-only: fails
  assert.equal(consoleFailures(["The Content Security Policy 'default-src 'self'' blocked the resource https://evil.example/x.js"]).length, 1);
  // report-only somewhere but not starting that way: fails
  assert.equal(consoleFailures(["Refused to load https://x/y.js: the Content Security Policy is not report-only here"]).length, 1);
  assert.equal(consoleFailures(["Uncaught TypeError: x. The Content Security Policy report-only note"]).length, 1);
  assert.equal(consoleFailures(["Failed to load resource: the server responded with a status of 500"]).length, 1);
});

test("report-only advisories are exempt by wording per engine; an enforced block that merely mentions report-only elsewhere still fails", () => {
  const ff = "Content-Security-Policy: (Report-Only policy) The page's settings would block a JavaScript eval (script-src) from being executed because it violates the following directive: \"script-src 'self'\"";
  const wk = "The Content Security Policy 'default-src 'self'' was delivered in report-only mode, but does not specify a 'report-uri'; the policy will have no effect.";
  // positives: the exact Firefox wording, case-insensitively, and the WebKit advisory
  assert.deepEqual(consoleFailures([ff, ff.replace("(Report-Only policy)", "(report-only POLICY)").replace("Content-Security-Policy:", "Content Security Policy:"), wk]), []);
  // negatives: enforced blocks that mention report-only (or the Firefox marker) somewhere other than the start
  for (const bad of [
    "The Content Security Policy 'default-src 'self'' blocked the resource https://evil.example/report-only.js",
    "The Content Security Policy refused https://x/y.js (see the report-only docs)",
    "Content-Security-Policy: The page's settings blocked the loading of a resource at https://evil.example/x.js (default-src) (Report-Only policy)",
    "Content-Security-Policy: The page's settings blocked the loading of a resource at https://evil.example/report-only.js (default-src)",
    "Refused to load https://x/report-only.js because it violates the following Content Security Policy directive: \"default-src 'self'\" (Report-Only policy)",
    "Uncaught Error: (Report-Only policy) is not defined",
  ]) assert.equal(consoleFailures([bad]).length, 1, bad);
  assert.equal(isCspAdvisory(ff), true);
  assert.equal(isCspAdvisory("Content-Security-Policy: The page's settings blocked x (Report-Only policy)"), false);
  // the exempted ones are listed for the report
  assert.deepEqual(exemptedAdvisories([ff, wk, "[Report Only] Refused to load x", { text: "TypeError: x", at: "" }]).length, 3);
});

test("Firefox as Playwright reports it: the wrapped (Report-Only policy) eval notice is exempt, anchored right after the wrapper; wrapped enforced blocks still fail", () => {
  const exact = "[JavaScript Error: \"Content-Security-Policy: (Report-Only policy) The page's settings would block a JavaScript eval (script-src) from being executed because it violates the following directive: \\\"script-src 'self'\\\"\" {file: \"https://leeroy.party/js/board.js\" line: 12}]";
  assert.deepEqual(consoleFailures([exact, exact.toLowerCase()]), []);
  assert.equal(isCspAdvisory(exact), true);
  for (const bad of [
    "[JavaScript Error: \"Content-Security-Policy: The page's settings blocked the loading of a resource at https://evil.example/x.js (default-src) (Report-Only policy)\" {file: \"https://leeroy.party/js/board.js\" line: 3}]",
    "[JavaScript Error: \"Content-Security-Policy: The page's settings blocked the loading of a resource at https://evil.example/(Report-Only policy).js (default-src)\"]",
    "[JavaScript Error: \"ReferenceError: x is not defined (Report-Only policy)\"]",
    "[JavaScript Error: \"TypeError: x\" {file: \"https://leeroy.party/js/Content-Security-Policy: (Report-Only policy)\"}]",
  ]) assert.equal(consoleFailures([bad]).length, 1, bad);
});

test("a long WebKit advisory whose report-only wording lies beyond 160 characters is exempt when the text is kept whole", () => {
  const policy = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.leeroy.party";
  const full = `The Content Security Policy '${policy}' was delivered in report-only mode, but does not specify a 'report-uri'; the policy will have no effect.`;
  assert.ok(full.indexOf("report-only") > 160);
  assert.deepEqual(consoleFailures([full]), []);
  assert.equal(consoleFailures([full.slice(0, 160)]).length, 1, "cut at 160 characters the wording is gone, which is why the probe must keep the whole text");
});

test("Firefox's harness-eval CSP throttle message (PR 181's ignoredConsoleError) is not a page error; the same text from a real file still fails", () => {
  const throttle = "Content-Security-Policy: Prevented too many CSP reports from being sent within a short period of time.";
  assert.deepEqual(consoleFailures([{ text: throttle, at: "debugger eval code" }]), []);
  assert.deepEqual(consoleFailures([{ text: `[JavaScript Error: "${throttle}" {file: "debugger eval code" line: 1}]`, at: "" }]), []);
  assert.equal(consoleFailures([{ text: throttle, at: "https://leeroy.party/js/board.js" }]).length, 1);
  assert.equal(consoleFailures([{ text: throttle, at: "" }]).length, 1, "no source: not provably the harness");
  assert.equal(consoleFailures([{ text: "TypeError: x", at: "debugger eval code" }]).length, 1, "only that exact message is ignored");
});

// The layout sweep answers the Cloudflare analytics beacon itself (issue 303, run 43452114041): the live endpoint answers 404 without CORS, and WebKit logs that as a
// URL-less console line which the sweep could only excuse inside a 2 s window, so a slow beacon failed a cell. Only the beacon's own endpoint is answered; nothing else.
test("beacon stub: only https cloudflareinsights.com/cdn-cgi/rum is matched, and the answer allows the site's origin", async () => {
  const { isRumUrl, rumStub } = await import("../helpers/probe-checks.mjs");
  for (const u of ["https://cloudflareinsights.com/cdn-cgi/rum", "https://cloudflareinsights.com/cdn-cgi/rum?x=1"]) assert.equal(isRumUrl(u), true, u);
  for (const u of ["http://cloudflareinsights.com/cdn-cgi/rum", "https://cloudflareinsights.com.evil.test/cdn-cgi/rum", "https://cloudflareinsights.com/cdn-cgi/other", "https://leeroy.party/cdn-cgi/rum", "https://static.cloudflareinsights.com/beacon.min.js", "https://cloudflareinsights.com:8443/cdn-cgi/rum", "not a url", "", null]) assert.equal(isRumUrl(u), false, String(u));
  const s = rumStub("https://leeroy.party");
  assert.equal(s.status, 204); assert.equal(s.body, ""); assert.equal(s.headers["access-control-allow-origin"], "https://leeroy.party");
  assert.match(s.headers["access-control-allow-methods"], /POST/); assert.match(s.headers["access-control-allow-methods"], /OPTIONS/); assert.equal(s.headers["access-control-allow-credentials"], "true"); assert.match(s.headers["access-control-allow-headers"], /content-type/i);
  assert.throws(() => rumStub("*"), /an origin/, "never a wildcard"); assert.throws(() => rumStub("leeroy.party"), /an origin/);
});
