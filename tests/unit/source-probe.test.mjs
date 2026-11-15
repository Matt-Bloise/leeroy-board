// tools/source-probe.mjs: offline by default (fixtures, no network); the --live path is exercised only with a stubbed fetch. A test that reaches the real fetch fails the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRobots,
  robotsAllows,
  checkSourceUrl,
  htmlToText,
  measureParseCpu,
  needsJsHeuristic,
  probeSource,
  runProbe,
  renderMarkdown,
  makeFixtureFetch,
  main,
  DEFAULT_CONFIG,
  DEFAULT_FIXTURES,
} from "../../tools/source-probe.mjs";

const UA = "LeeroyBoard-CloudflareWorker/1.0";
const config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG, "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(DEFAULT_FIXTURES, "manifest.json"), "utf8"));

const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("network use in a dry-run test");
};
test.after(() => {
  globalThis.fetch = realFetch;
});

function ctxFor(responses, over = {}) {
  const log = [];
  const fetchFn = makeFixtureFetch({ responses }, DEFAULT_FIXTURES, log);
  return {
    log,
    ctx: {
      fetchFn,
      userAgent: UA,
      allowedHosts: ["a.example", "b.example"],
      limits: { timeoutMs: 1000, maxBytes: 1000, maxRedirects: 3, delayMs: 0, ...(over.limits || {}) },
      robotsCache: new Map(),
      requestCount: 0,
    },
  };
}
const ROBOTS_OPEN = { "https://a.example/robots.txt": { status: 404, body: "" }, "https://b.example/robots.txt": { status: 404, body: "" } };

test("robots: longest match wins, Allow wins a tie, wildcard and end anchor work", () => {
  const g = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.json$\n");
  assert.equal(robotsAllows(g, UA, "/private/x").allowed, false);
  assert.equal(robotsAllows(g, UA, "/private/open/page").allowed, true);
  assert.equal(robotsAllows(g, UA, "/data/x.json").allowed, false);
  assert.equal(robotsAllows(g, UA, "/data/x.json5").allowed, true);
  const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a\n");
  assert.equal(robotsAllows(tie, UA, "/a").allowed, true);
});

test("robots: a named group for our agent beats *, empty Disallow allows, no group allows", () => {
  const g = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: LeeroyBoard-CloudflareWorker\nDisallow: /x\n");
  // Every matching group applies (see the merge test below), so the * group's "Disallow: /" now also binds us.
  assert.equal(robotsAllows(g, UA, "/anything").allowed, false);
  assert.equal(robotsAllows(g, UA, "/x/y").allowed, false);
  const specificOnly = parseRobots("User-agent: LeeroyBoard-CloudflareWorker\nDisallow: /x\n\nUser-agent: other\nDisallow: /\n");
  assert.equal(robotsAllows(specificOnly, UA, "/anything").allowed, true);
  assert.equal(robotsAllows(specificOnly, UA, "/x/y").allowed, false);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), UA, "/z").allowed, true);
  assert.equal(robotsAllows(parseRobots("User-agent: other\nDisallow: /\n"), UA, "/z").allowed, true);
  assert.equal(robotsAllows(parseRobots(""), UA, "/z").allowed, true);
});

test("guards: non-https, bad url, credentials and off-list hosts are refused", () => {
  const hosts = ["a.example"];
  assert.equal(checkSourceUrl("http://a.example/", hosts).reason, "not_https");
  assert.equal(checkSourceUrl("not a url", hosts).reason, "bad_url");
  assert.equal(checkSourceUrl("https://u:p@a.example/", hosts).reason, "credentials_in_url");
  assert.equal(checkSourceUrl("https://evil.example/", hosts).reason, "host_not_allowed");
  assert.equal(checkSourceUrl("https://sub.a.example/", hosts).reason, "host_not_allowed");
  assert.equal(checkSourceUrl("https://A.EXAMPLE/x", hosts).ok, true);
});

test("a non-allow-listed host or http url is refused and nothing is fetched", async () => {
  const { ctx, log } = ctxFor({});
  const a = await probeSource({ id: "x", url: "https://evil.example/" }, ctx);
  const b = await probeSource({ id: "y", url: "http://a.example/" }, ctx);
  assert.equal(a.outcome, "refused");
  assert.equal(a.refusal, "host_not_allowed");
  assert.equal(b.refusal, "not_https");
  assert.equal(log.length, 0);
});

test("robots disallow: the page is never requested", async () => {
  const { ctx, log } = ctxFor({
    "https://a.example/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /secret\n" },
    "https://a.example/secret/page": { status: 200, body: "<p>should not be fetched</p>" },
  });
  const r = await probeSource({ id: "x", url: "https://a.example/secret/page" }, ctx);
  assert.equal(r.outcome, "robots_deny");
  assert.equal(r.robots.verdict, "deny");
  assert.match(r.robots.rule, /Disallow: \/secret/);
  assert.deepEqual(log, ["https://a.example/robots.txt"]);
});

test("robots unreachable (5xx) is treated as deny; 404 as allow", async () => {
  const c1 = ctxFor({ "https://a.example/robots.txt": { status: 503, body: "" }, "https://a.example/p": { status: 200, body: "<p>x</p>" } });
  assert.equal((await probeSource({ id: "x", url: "https://a.example/p" }, c1.ctx)).outcome, "robots_deny");
  const c2 = ctxFor({ ...ROBOTS_OPEN, "https://a.example/p": { status: 200, contentType: "text/html", body: "<p>hello</p>" } });
  assert.equal((await probeSource({ id: "x", url: "https://a.example/p" }, c2.ctx)).outcome, "ok");
});

test("same-host redirect is followed and recorded; the new path is robots-checked", async () => {
  const { ctx, log } = ctxFor({
    "https://a.example/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /moved-blocked\n" },
    "https://a.example/old": { status: 301, location: "/new" },
    "https://a.example/new": { status: 200, contentType: "text/html", body: "<p>ok</p>" },
    "https://a.example/to-blocked": { status: 302, location: "/moved-blocked" },
  });
  const r = await probeSource({ id: "x", url: "https://a.example/old" }, ctx);
  assert.equal(r.outcome, "ok");
  assert.equal(r.redirects.length, 1);
  assert.equal(r.redirects[0].followed, true);
  assert.equal(r.redirects[0].to, "/new");
  const r2 = await probeSource({ id: "y", url: "https://a.example/to-blocked" }, ctx);
  assert.equal(r2.outcome, "robots_deny");
  assert.equal(r2.redirects[0].followed, true);
  assert.ok(!log.includes("https://a.example/moved-blocked"));
});

test("cross-host redirect is recorded and not followed, even to another allow-listed host", async () => {
  const { ctx, log } = ctxFor({
    ...ROBOTS_OPEN,
    "https://a.example/go": { status: 302, location: "https://b.example/landing" },
    "https://b.example/landing": { status: 200, body: "<p>no</p>" },
    "https://a.example/out": { status: 302, location: "https://elsewhere.test/x" },
    "https://a.example/down": { status: 302, location: "http://a.example/plain" },
  });
  const r = await probeSource({ id: "x", url: "https://a.example/go" }, ctx);
  assert.equal(r.outcome, "redirect_cross_host");
  assert.deepEqual([r.redirects[0].followed, r.redirects[0].reason, r.redirects[0].to], [false, "cross_host_not_followed", "https://b.example/landing"]);
  assert.ok(!log.includes("https://b.example/landing"));
  assert.equal((await probeSource({ id: "y", url: "https://a.example/out" }, ctx)).outcome, "redirect_cross_host");
  const down = await probeSource({ id: "z", url: "https://a.example/down" }, ctx);
  assert.equal(down.outcome, "redirect_refused");
  assert.equal(down.redirects[0].reason, "not_https");
});

test("redirect loops stop at maxRedirects", async () => {
  const { ctx, log } = ctxFor({ ...ROBOTS_OPEN, "https://a.example/loop": { status: 302, location: "/loop" } });
  const r = await probeSource({ id: "x", url: "https://a.example/loop" }, ctx);
  assert.equal(r.outcome, "redirect_limit");
  assert.equal(log.filter((u) => u === "https://a.example/loop").length, 4);
});

test("size cap: the body is cut at maxBytes and flagged truncated", async () => {
  const big = "<p>" + "word ".repeat(2000) + "</p>";
  const { ctx } = ctxFor({ ...ROBOTS_OPEN, "https://a.example/big": { status: 200, contentType: "text/html", body: big } }, { limits: { maxBytes: 1000 } });
  const r = await probeSource({ id: "x", url: "https://a.example/big" }, ctx);
  assert.equal(r.outcome, "ok_truncated");
  assert.equal(r.bytes, 1000);
  assert.equal(r.truncated, true);
  const exact = "x".repeat(1000);
  const c2 = ctxFor({ ...ROBOTS_OPEN, "https://a.example/e": { status: 200, body: exact } });
  const r2 = await probeSource({ id: "y", url: "https://a.example/e" }, c2.ctx);
  assert.equal(r2.truncated, false);
  assert.equal(r2.bytes, 1000);
});

test("http errors and thrown errors are recorded, not raised", async () => {
  const { ctx } = ctxFor({ ...ROBOTS_OPEN, "https://a.example/gone": { status: 410, body: "" } });
  const r = await probeSource({ id: "x", url: "https://a.example/gone" }, ctx);
  assert.equal(r.outcome, "http_error");
  assert.equal(r.status, 410);
  const failing = { ...ctx, fetchFn: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, robotsCache: new Map() };
  const e = await probeSource({ id: "y", url: "https://a.example/p" }, failing);
  assert.equal(e.outcome, "robots_deny"); // robots could not be read: fail closed
  const robotsOk = { ...ctx, robotsCache: new Map([["a.example", { status: 404, groups: [], state: "absent_allow_all" }]]), fetchFn: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } };
  const e2 = await probeSource({ id: "z", url: "https://a.example/p" }, robotsOk);
  assert.equal(e2.outcome, "error");
  assert.match(e2.error, /TimeoutError/);
});

test("JS heuristic: server-rendered pages pass, app shells are flagged", () => {
  const news = fs.readFileSync(path.join(DEFAULT_FIXTURES, "news-index.html"), "utf8");
  const spa = fs.readFileSync(path.join(DEFAULT_FIXTURES, "forum-spa.html"), "utf8");
  assert.equal(needsJsHeuristic(news, htmlToText(news).length).needsJs, false);
  const j = needsJsHeuristic(spa, htmlToText(spa).length);
  assert.equal(j.needsJs, true);
  assert.ok(j.reasons.includes("empty_app_root"));
});

test("CPU measurement has the documented shape and never carries text", () => {
  const html = fs.readFileSync(path.join(DEFAULT_FIXTURES, "news-index.html"), "utf8");
  const c = measureParseCpu(html);
  assert.deepEqual(Object.keys(c).sort(), ["budgetMs", "cpuMs", "fractionOfBudget", "maxMicros", "medianMicros", "note", "passes", "textChars"]);
  assert.equal(c.passes, 5);
  assert.equal(c.budgetMs, 10);
  assert.ok(c.cpuMs >= 0 && Number.isFinite(c.cpuMs));
  assert.ok(c.textChars > 100);
  assert.ok(c.maxMicros >= c.medianMicros);
  assert.ok(Math.abs(c.fractionOfBudget - c.cpuMs / 10) < 1e-9);
});

test("full dry run over the shipped config: outcomes, report shape, markdown, no network", async () => {
  const log = [];
  const fetchFn = makeFixtureFetch(manifest, DEFAULT_FIXTURES, log);
  const report = await runProbe(config, { fetchFn, dryRun: true, now: Date.UTC(2026, 10, 14) });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.network, false);
  assert.equal(report.generatedAt, "2026-11-14T00:00:00.000Z");
  const by = Object.fromEntries(report.results.map((r) => [r.id, r]));
  assert.equal(by.P1.outcome, "ok");
  assert.equal(by.P2.outcome, "ok");
  assert.equal(by.P2.redirects[0].followed, true);
  assert.equal(by.P3.outcome, "ok");
  assert.equal(by.P3.needsJs.needsJs, true);
  assert.equal(by.P4.outcome, "ok");
  assert.equal(by.P5.outcome, "redirect_cross_host");
  assert.equal(by.P6.outcome, "ok");
  assert.equal(by.P7.outcome, "robots_deny");
  assert.ok(!log.includes("https://www.method.gg/"));
  assert.equal(report.requestCount, log.length);
  assert.equal(report.summary.sources, 7);
  assert.equal(report.summary.outcomes.ok, 5);
  assert.deepEqual(report.summary.needsJs, ["P3"]);
  assert.equal(JSON.stringify(report).includes("Mossback"), false, "page text must not reach the report");
  const md = renderMarkdown(report);
  assert.match(md, /^# Source probe report/);
  assert.match(md, /Mode: dry-run/);
  assert.match(md, /\| P7 \| robots_deny/);
  assert.match(md, /cross_host_not_followed/);
  assert.equal(md.includes("\u2014"), false);
});

test("CLI main in dry-run writes JSON and markdown to --out", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "source-probe-"));
  try {
    const orig = console.log;
    console.log = () => {};
    let report;
    try {
      report = await main(["--dry-run", "--out", out]);
    } finally {
      console.log = orig;
    }
    const json = JSON.parse(fs.readFileSync(path.join(out, "source-probe-report.json"), "utf8"));
    assert.equal(json.tool, "source-probe");
    assert.equal(json.results.length, report.results.length);
    assert.ok(fs.readFileSync(path.join(out, "source-probe-report.md"), "utf8").includes("Source probe report"));
    await assert.rejects(() => main(["--dry-run"]), /--out/);
    await assert.rejects(() => main(["--bogus"]), /unknown argument/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

async function runMain(argv, fetchStub) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "source-probe-live-"));
  const orig = console.log;
  const prev = globalThis.fetch;
  globalThis.fetch = fetchStub;
  console.log = () => {};
  try {
    const report = await main([...argv, "--out", out]);
    return report;
  } finally {
    console.log = orig;
    globalThis.fetch = prev;
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test("default run is offline: it never calls fetch, with or without --dry-run", async () => {
  const calls = [];
  const spy = async (u) => {
    calls.push(String(u));
    return new Response("", { status: 404 });
  };
  const bare = await runMain([], spy);
  const dry = await runMain(["--dry-run"], spy);
  assert.equal(calls.length, 0, `fetch was called: ${calls.join(",")}`);
  assert.equal(bare.mode, "dry-run");
  assert.equal(bare.network, false);
  assert.equal(dry.mode, "dry-run");
});

test("--live is the only way to reach the network, and --live with --dry-run is refused", async () => {
  const calls = [];
  const stub = async (u) => {
    calls.push(String(u));
    if (String(u).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:\n", { status: 200 });
    return new Response("<html><body><p>" + "text ".repeat(200) + "</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  const report = await runMain(["--live", "--delay", "0"], stub);
  assert.equal(report.mode, "live");
  assert.equal(report.network, true);
  assert.ok(calls.length > 0, "the stubbed fetch was used");
  assert.ok(calls.every((u) => u.startsWith("https://")));
  await assert.rejects(() => runMain(["--live", "--dry-run"], stub), /--live.*--dry-run|--dry-run.*--live/);
});

test("robots: every matching group is merged (our agent and *), so a Disallow in any of them applies", () => {
  const star = parseRobots("User-agent: LeeroyBoard-CloudflareWorker\nDisallow: /a\n\nUser-agent: *\nDisallow: /private\n");
  assert.equal(robotsAllows(star, UA, "/private/x").allowed, false, "the * group still applies beside the specific group");
  assert.equal(robotsAllows(star, UA, "/a/b").allowed, false);
  assert.equal(robotsAllows(star, UA, "/open").allowed, true);
  const twoSpecific = parseRobots("User-agent: LeeroyBoard-CloudflareWorker\nDisallow: /a\n\nUser-agent: leeroyboard-cloudflareworker\nDisallow: /b\n");
  assert.equal(robotsAllows(twoSpecific, UA, "/b/x").allowed, false, "the second matching group disallows");
  assert.equal(robotsAllows(twoSpecific, UA, "/a/x").allowed, false);
  const second = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: LeeroyBoard\nDisallow: /secret\n");
  assert.equal(robotsAllows(second, UA, "/secret/page").allowed, false);
  assert.equal(robotsAllows(second, UA, "/ok").allowed, true);
  const tie = parseRobots("User-agent: *\nAllow: /p\n\nUser-agent: LeeroyBoard-CloudflareWorker\nDisallow: /p\n");
  assert.equal(robotsAllows(tie, UA, "/p").allowed, true, "merged: equal-length Allow wins a tie");
});

test("config allow-list: every source host is listed, all https, and hosts exist in data/library-sources.json", () => {
  const lib = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "library-sources.json"), "utf8"));
  for (const s of config.sources) {
    const c = checkSourceUrl(s.url, config.allowedHosts);
    assert.equal(c.ok, true, s.url);
  }
  for (const h of config.allowedHosts) assert.ok(lib.hosts[h], `${h} missing from data/library-sources.json`);
});
