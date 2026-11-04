// Pure judging functions for tests/browser/prod-probe.mjs (no browser, no network), so tests/unit/probe-checks.test.mjs can prove that a wrong member
// count, a typed "five" with six members and junk text make the probe fail. Each function returns a list of problem strings; an empty list is a pass.

export const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const slugOf = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); // same as MEM.slug in js/board.js

// Junk a visitor must never read. Raw ids: Discord snowflakes (17 to 20 digits), UUIDs, long hex strings.
const JUNK = [
  [/\bundefined\b/, "the word undefined"],
  [/\bNaN\b/, "NaN"],
  [/\[object \w+\]/, "[object ...]"],
  [/\bInfinity\b/, "Infinity"],
  [/^\s*(?:null|true|false)\s*$/, "a bare null/true/false"],
  [/\{\{|\}\}|\$\{/, "an unfilled template marker"],
  [/(?<![\d.])\d{17,20}(?![\d.])/, "a raw Discord id"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a raw UUID"],
  [/\b[0-9a-f]{32,}\b/i, "a long hex id"],
];
export function junkIn(strings) {
  const out = [];
  for (const s of strings) {
    const t = String(s).replace(/\s+/g, " ").trim();
    for (const [re, what] of JUNK) if (re.test(t)) { out.push(`${what}: "${t.slice(0, 90)}"`); break; }
  }
  return out;
}

// Phrases that are about five of something that is not the party; they stay (same list as tests/browser/six-members.mjs).
export const NOT_PARTY = [/\bfive points (?:fewer|more)\b/i, /\bgroup of five players\b/i, /\bthree of five still travel\b/i, /\bRead from (?:five|four) places\b/i];
const mask = (t) => NOT_PARTY.reduce((s, re) => s.replace(new RegExp(re.source, "gi"), " "), t);

// Copy that states the wrong party size. Only judged when the real party is bigger than five (n > 5), as the owner specified:
//   the word "five"; "four" as the count of the others; and "all/the W of us/you/them" with a typed count word W that is not the real count.
export function wrongCountCopy(strings, n) {
  if (!(n > 5)) return [];
  const real = WORDS[n] || String(n), others = WORDS[n - 1] || String(n - 1);
  const stale = WORDS.slice(2, 13).filter((w) => w !== real);
  const staleOthers = WORDS.slice(2, 13).filter((w) => w !== others);
  const res = [
    /\bfive\b/i,
    // "the other four" (the curated phrase of six-members.mjs, unrestricted) and "the other <W>" only when it ends the phrase or is followed by a party noun ("the other two races" is not the party).
    /\b(?:other|remaining|rest) four\b|\bfour others\b/i,
    new RegExp(`\\b(?:other|remaining|rest) (?:${staleOthers.join("|")})(?=\\s*(?:$|[.,;:!?)"'\u201d]|of\\b|(?:members?|friends?|players?|adventurers?|heroes|people)\\b))|\\b(?:${staleOthers.join("|")}) others\\b`, "i"),
    new RegExp(`\\b(?:all|the) (?:${stale.join("|")}) of (?:us|you|them)\\b`, "i"),
  ];
  const out = [];
  for (const s of strings) {
    const t = mask(String(s).replace(/\s+/g, " ").trim());
    if (res.some((re) => re.test(t))) out.push(`"${t.slice(0, 90)}" (the party has ${n}, "${real}")`);
  }
  return out;
}

export function memberCountProblem(boardCount, partyCount) {
  if (!Number.isInteger(partyCount) || partyCount < 1) return [`/api/state partyDoc has no members (${partyCount})`];
  return boardCount === partyCount ? [] : [`the board shows ${boardCount} members but /api/state partyDoc lists ${partyCount}`];
}

// Distinct strings, trimmed, empty ones dropped.
export const uniq = (a) => [...new Set(a.map((s) => String(s).replace(/\s+/g, " ").trim()).filter(Boolean))];

// Console errors that do not count. Each error is { text, at } (at = the console location's URL). Exempt: a message that STARTS as a report-only CSP report
// ("[Report Only] ..." in Chromium, "Content-Security-Policy-Report-Only ..."); an error whose console LOCATION is the Cloudflare analytics beacon; and, when a request to that
// beacon host was seen failing, the generic network wording a browser uses for it without a URL (the live-smoke.mjs rule). Message text that merely mentions a host or
// "report-only" in the middle is NOT an exemption, and neither is an enforced CSP violation.
export const isReportOnlyCsp = (t) => /^(\[Report Only\]|Content-Security-Policy-Report-Only)/i.test(String(t));
const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ""; } };
export const isInsightsHost = (u) => /(^|\.)cloudflareinsights\.com$/i.test(hostOf(u));
export function consoleFailures(errors, { engine = "", allowWebkitNoWebgl = false, insightsRequestFailed = false } = {}) {
  return errors.filter((e) => {
    const text = typeof e === "string" ? e : e.text, at = typeof e === "string" ? "" : e.at || "";
    if (engine === "webkit" && allowWebkitNoWebgl && /Error creating WebGL context/.test(text)) return false;
    if (isReportOnlyCsp(text)) return false;
    if (isInsightsHost(at)) return false;
    if (insightsRequestFailed && !/https?:\/\//.test(text) && /^(Failed to load resource|.*net::ERR_FAILED|.*Access-Control-Allow-Origin)/i.test(text)) return false;
    return true;
  });
}

// A response with status >= 400: "fail" or "warn" (same rule as tests/browser/live-smoke.mjs): anything from the site itself fails; from the API a 5xx fails,
// a 4xx only warns, except on /api/bootstrap and /api/state, which the board cannot open without (those fail on any 4xx).
export function classifyHttp(url, status, siteOrigin, apiOrigin) {
  if (!(status >= 400)) return "ok";
  let u; try { u = new URL(url); } catch (e) { return "ok"; }
  if (u.origin !== siteOrigin && u.origin !== apiOrigin) return "ok";
  const isApi = /^\/api\//.test(u.pathname) && (u.origin === apiOrigin);
  if (!isApi) return "fail";
  if (status >= 500) return "fail";
  return /^\/api\/(?:bootstrap|state)\/?$/.test(u.pathname) ? "fail" : "warn";
}
