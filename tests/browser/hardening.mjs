// Front-end hardening checks (audit of master 49e90ba): F1 board key never leaves for a non-allowlisted origin, F2 javascript:/data: links from data are dropped,
// F4 "Forget me on this browser" clears every board-* and bd:* key and boot prunes bd: cache entries stamped by an older build.
//   node hardening.mjs --url http://127.0.0.1:8080/?preview=1&brain=http://127.0.0.1:8787   (or env PREVIEW_PAGES; tools/local-browser.sh hardening)
// Chromium, 1366x768. The API is answered from tests/fixtures/api-snapshot (zero Worker requests); every request that would leave the machine is answered locally by route interception.
// No AI call, no secret: the "key" is a made-up string of the right shape. Exit 0 when every check passes, 1 otherwise.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stubbed } from "../helpers/browser-stub.mjs";
import { pageUrl } from "../helpers/page-url.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node hardening.mjs --url <pages url> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "testkeytestkeytestkey12";
const ALLOWED = /^(https:\/\/api\.leeroy\.party|https:\/\/leeroy-brain-pr-\d+\.jmattbloise\.workers\.dev|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "content-type": "application/json" };
const isLocal = (u) => /^(127\.0\.0\.1|localhost)$/.test(new URL(u).hostname);

const browser = stubbed(await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {}), { label: "hardening api-stub" });

/* one page, with a log of every request that is not for the local site or the local Worker; those are answered here, nothing leaves the machine */
async function open(url, { init, mutateBootstrap } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block" });
  const seen = [];
  await ctx.route("**/*", async (route) => {
    const r = route.request(), u = r.url(), h = r.headers();
    if (/^(data|blob):/.test(u)) return route.fallback();
    const asked = String(h["access-control-request-headers"] || "").toLowerCase().includes("authorization");
    seen.push({ url: u, method: r.method(), origin: new URL(u).origin, auth: !!h.authorization, preflightAuth: asked });
    if (!isLocal(u)) return r.method() === "OPTIONS" ? route.fulfill({ status: 204, headers: cors }) : route.fulfill({ status: 200, headers: cors, body: "{}" });
    if (r.method() === "GET" && /\/api\/me(\?|$)/.test(u)) return route.fulfill({ status: 401, headers: cors, body: "{}" }); /* not in the snapshot; answered here, still recorded above */
    if (mutateBootstrap && /\/api\/bootstrap(\?|$)/.test(u)) {
      const snap = JSON.parse(readFileSync(path.join(here, "../fixtures/api-snapshot/snapshot.json"), "utf8")).routes["/bootstrap"];
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(mutateBootstrap(JSON.parse(snap.body))) });
    }
    return route.fallback();
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  return { ctx, page, seen };
}

/* F1. A ?brain= value outside the allowlist is ignored: no request goes to it and no Authorization leaves for any non-allowlisted origin. */
const EVIL = [
  "https://evil.example", "https://evil.example/api", "http://evil.example:8787", "https://api.leeroy.party.evil.example",
  "https://api.leeroy.party@evil.example", "http://127.0.0.1.evil.example", "https://leeroy-brain-pr-1.jmattbloise.workers.dev.evil.example",
  "https://leeroy-brain-pr-x.jmattbloise.workers.dev", "https://jmattbloise.workers.dev", "https://leeroy-brain-pr-1.evil.workers.dev",
];
for (const evil of EVIL) {
  const { ctx, page, seen } = await open(pageUrl(BASE, { params: { brain: evil }, hash: `k=${KEY}` }));
  await page.waitForTimeout(2500);
  const bad = seen.filter((x) => !ALLOWED.test(x.origin) && (x.auth || x.preflightAuth));
  ok(`F1 ?brain=${evil}: no Authorization (or preflight asking for it) leaves for a non-allowlisted origin`, bad.length === 0, bad.map((x) => `${x.method} ${x.url}`).join(", "));
  const toEvil = seen.filter((x) => !ALLOWED.test(x.origin) && !/^https?:\/\/(fonts\.|www\.)?(gstatic|googleapis)/.test(x.url));
  ok(`F1 ?brain=${evil}: the board sends nothing to that origin at all (BoardBrain.url cannot bypass the ?api= allowlist)`, toEvil.length === 0, toEvil.slice(0, 3).map((x) => x.url).join(", "));
  const stored = await page.evaluate(() => { try { return localStorage.getItem("board-key"); } catch (e) { return null; } });
  ok(`F1 ?brain=${evil}: the key is still captured and stored (the fix filters the destination, not the key)`, stored === KEY);
  await ctx.close();
}
{ /* positive control: with the allowlisted local Worker the key IS sent, so the checks above are not vacuous */
  const { ctx, page, seen } = await open(pageUrl(BASE, { hash: `k=${KEY}` }));
  await page.waitForTimeout(2500);
  const sent = seen.filter((x) => x.auth && ALLOWED.test(x.origin));
  ok("F1 control: an allowlisted origin (local Worker) still gets the Authorization header on /api/me", sent.some((x) => /\/api\/me$/.test(new URL(x.url).pathname)), JSON.stringify(seen.filter((x) => /\/api\//.test(x.url)).slice(0, 4)));
  await ctx.close();
}

/* F2. h() drops an href/src that is not http(s):, /, # or a relative path with a folder; javascript: and data: fixtures reach the ledger from the bootstrap. */
{
  const evilHref = ["javascript:window.__pwned=1", "JaVaScRiPt:window.__pwned=1", " javascript:window.__pwned=1", "data:text/html,<script>window.__pwned=1</script>", "vbscript:x", "//evil.example/x"];
  const good = "https://discord.com/channels/1/2/3";
  const { ctx, page } = await open(pageUrl(BASE), {
    mutateBootstrap: (b) => {
      const far = Math.floor(Date.now() / 1000) + 86400 * 30, p = b.party;
      p.polls = [{ ...p.polls_closed?.[0], ...(p.polls[0] || {}), title: "Guild name", text: "poll closes soon. Add names in chat.", closes_epoch: far, url: evilHref[0] },
        { title: "Second poll", text: "poll closes soon.", closes_epoch: far, url: good }, { title: "Third poll", text: "poll closes soon.", closes_epoch: far, url: evilHref[3] }];
      p.polls_closed = [];
      for (const o of p.open) o.links = (o.links || []).map((l, i) => ({ ...l, url: evilHref[i % evilHref.length] }));
      return b;
    },
  });
  await page.evaluate(() => window.__boardKit.goScene("ledger"));
  await page.waitForTimeout(1500);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("[href],[src]")].map((n) => ({ tag: n.tagName, v: n.getAttribute("href") ?? n.getAttribute("src") })));
  const bad = hrefs.filter((x) => x.tag !== "LINK" /* the static data: favicon in <head> is not data-driven */ && /^\s*(javascript|data|vbscript):/i.test(x.v || "") || /^\/\/evil/.test(x.v || ""));
  ok("F2 no element has a javascript:, vbscript:, data: or protocol-relative href/src from data", bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  ok("F2 control: the https poll link from the same data is kept", hrefs.some((x) => x.tag === "A" && x.v === good), `${hrefs.filter((x) => x.tag === "A").length} anchors`);
  const slip = await page.evaluate(() => document.querySelectorAll("#ledger-slip a").length);
  ok("F2 control: the ledger rendered its links (the fixture really reached h())", slip >= 1, String(slip));
  ok("F2 nothing ran", !(await page.evaluate(() => window.__pwned)));
  await ctx.close();
}

/* F4. Forget removes every board-* and bd:* key; boot prunes bd: entries stamped by another build. */
{
  const { ctx, page } = await open(pageUrl(BASE), {
    init: () => { try {
      if (localStorage.getItem("__seeded")) return; localStorage.setItem("__seeded", "1");
      for (const k of ["board-theme-x", "board-api", "board-key", "board-before-me", "board-future-thing", "bd:0000000000:data/party.json", "bd:ffffffffff:data/client.json", "unrelated-key"]) localStorage.setItem(k, k === "board-key" ? "testkeytestkeytestkey12" : "1");
    } catch (e) {} },
  });
  await page.waitForTimeout(2500);
  const stamp = await page.evaluate(() => { const s = [...document.scripts].find((x) => /js\/board\.js/.test(x.src)); return ((s && s.src.match(/[?&]v=([0-9a-f]+)/)) || [])[1] || null; });
  let keys = await page.evaluate(() => Object.keys(localStorage));
  ok("F4 boot pruned bd: entries stamped by an older build", !keys.includes("bd:0000000000:data/party.json") && !keys.includes("bd:ffffffffff:data/client.json"), keys.filter((k) => k.startsWith("bd:")).join(", "));
  ok("F4 control: the current build's bd: cache entries are kept (the page wrote them)", !!stamp && keys.some((k) => k.startsWith(`bd:${stamp}:`)), `stamp=${stamp} keys=${keys.filter((k) => k.startsWith("bd:")).join(", ")}`);
  ok("F4 control: before Forget the board-* keys are there", ["board-theme-x", "board-api", "board-future-thing", "board-before-me"].every((k) => keys.includes(k)));
  await page.evaluate(() => document.getElementById("lib-forget").click());
  await page.waitForTimeout(300);
  keys = await page.evaluate(() => Object.keys(localStorage));
  const left = keys.filter((k) => /^(board-|bd:)/.test(k));
  ok("F4 Forget removes every board-* and bd:* key", left.length === 0, left.join(", "));
  ok("F4 Forget leaves keys that are not the board's", keys.includes("unrelated-key"));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
