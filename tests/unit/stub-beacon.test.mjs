// Every QA and probe browser against a live site answers the analytics beacon report in the browser (tests/helpers/probe-checks.mjs stubbedContext),
// so runs are not counted as visitors and the endpoint's 404 to runner traffic cannot surface. Fake browser, no network. Run: node --test tests/unit/stub-beacon.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubbedContext } from "../helpers/probe-checks.mjs";

function fakeBrowser() {
  const routes = [];
  const ctx = { route: async (match, handler) => routes.push({ match, handler }) };
  return { routes, browser: { newContext: async (opts) => Object.assign(ctx, { opts }) } };
}
const fulfilled = async (routes, url) => {
  for (const r of routes) if (r.match(new URL(url))) { let got = null; await r.handler({ fulfill: (x) => { got = x; } }); return got; }
  return null;
};

test("the rum report is answered with 204 for exactly the site's origin; nothing else is touched", async () => {
  const { routes, browser } = fakeBrowser();
  const ctx = await stubbedContext(browser, { viewport: { width: 390, height: 844 } }, "https://leeroy.party/");
  assert.deepEqual(ctx.opts, { viewport: { width: 390, height: 844 } });
  const r = await fulfilled(routes, "https://cloudflareinsights.com/cdn-cgi/rum");
  assert.equal(r.status, 204);
  assert.equal(r.headers["access-control-allow-origin"], "https://leeroy.party");
  for (const u of ["https://static.cloudflareinsights.com/beacon.min.js", "https://leeroy.party/cdn-cgi/rum", "https://api.leeroy.party/api/state"]) assert.equal(await fulfilled(routes, u), null, u);
});

test("an unusable site URL adds no route", async () => {
  const { routes, browser } = fakeBrowser();
  await stubbedContext(browser, {}, "not a url");
  assert.equal(routes.length, 0);
});

test("every production-facing browser script makes its contexts through stubbedContext, and Lighthouse blocks the insights hosts", () => {
  for (const f of ["live-smoke", "prod-probe", "first-load-weight", "axe", "degraded-modes", "layout-sweep"]) {
    const src = readFileSync(new URL(`../browser/${f}.mjs`, import.meta.url), "utf8");
    const stubbed = /stubbedContext\(browser/.test(src) || /isRumUrl\(u\.href\), \(r\) => r\.fulfill\(rumStub/.test(src);
    assert.ok(stubbed, `${f} answers the beacon`);
    if (f !== "layout-sweep") assert.ok(!/browser\.newContext\(/.test(src), `${f} has no unstubbed context`);
  }
  const lh = JSON.parse(readFileSync(new URL("../../lighthouserc.json", import.meta.url), "utf8"));
  assert.ok(lh.ci.collect.settings.blockedUrlPatterns.includes("*cloudflareinsights.com*"));
});
