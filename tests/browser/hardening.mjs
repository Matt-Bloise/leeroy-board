// Front-end hardening checks (audit of master 49e90ba): F1 board key never leaves for a non-allowlisted origin, F2 javascript:/data: links from data are dropped,
// F4 "Forget me on this browser" clears every board-* and bd:* key and boot prunes bd: cache entries stamped by an older build.
//   node hardening.mjs --url http://127.0.0.1:8080/?preview=1&brain=http://127.0.0.1:8787   (or env PREVIEW_PAGES; tools/local-browser.sh hardening)
// Chromium, 1366x768. The API is answered from tests/fixtures/api-snapshot (zero Worker requests); every request that would leave the machine is answered locally by route interception.
// No AI call, no secret: the "key" is a made-up string of the right shape. Exit 0 when every check passes, 1 otherwise.
import { existsSync, readFileSync } from "node:fs";
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
const ALLOWED = /^(https:\/\/api\.leeroy\.party|https:\/\/leeroy-brain-pr-\d+\.(?:jmattbloise|joshbblaine)\.workers\.dev|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "content-type": "application/json" };
const PAGE_ORIGIN = new URL(BASE).origin;
/* The suite must behave the same against a local server and against the deployed PR preview (https://pr-N.leeroy-board.pages.dev), and must never need a live Worker or 127.0.0.1:8787:
   every API origin is answered by route interception (the recorded snapshot, or here). VIRTUAL is a made-up local page origin served from BASE's site, used for the checks that need a page whose host derives no Worker of its own. */
const VIRTUAL = "http://127.0.0.1:8099";
const SITE = process.env.HARDENING_REHEARSE_FROM ? new URL(process.env.HARDENING_REHEARSE_FROM).origin : PAGE_ORIGIN; /* where the site files really come from */
const PROXY = new Map([[VIRTUAL, SITE]]);
if (SITE !== PAGE_ORIGIN) PROXY.set(PAGE_ORIGIN, SITE); /* rehearse CI locally: BASE is a deployed-looking https origin that is served from this local server */
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
    /* the page's own site, the local Worker and the allowlisted Workers (a PR preview Worker in CI) are "ours": the API stub answers them. Everything else is answered here and goes nowhere. */
    const origin = new URL(u).origin;
    const proxied = PROXY.get(origin); /* a page origin served from another place (the virtual local origin, or the rehearsal of the deployed preview): fetch the same path there */
    if (proxied && r.method() === "GET") { try { const res = await route.fetch({ url: proxied + u.slice(origin.length) }); return await route.fulfill({ response: res }); } catch (e) { return; /* the page was closed while this file was in flight */ } }
    const ours = origin === PAGE_ORIGIN || PROXY.has(origin) || isLocal(u) || ALLOWED.test(origin);
    if (!ours) return r.method() === "OPTIONS" ? route.fulfill({ status: 204, headers: cors }) : route.fulfill({ status: 200, headers: cors, body: "{}" });
    { const d = /^\/api\/data\/([a-z0-9-]+)$/.exec(new URL(u).pathname); /* apiFetch asks for /api/data/<name> without .json; the recorded snapshot only has the files by their repo name */
      if (r.method() === "GET" && d && existsSync(path.join(here, "../../data", `${d[1]}.json`))) return route.fulfill({ status: 200, headers: cors, body: readFileSync(path.join(here, "../../data", `${d[1]}.json`), "utf8") }); }
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
  await page.waitForFunction(() => window.BoardBrain && window.__boardKit && typeof window.__boardKit.goScene === "function", null, { timeout: 30000 }).catch(() => {});
  return { ctx, page, seen };
}

/* F1. A ?brain= value outside the allowlist is ignored: no request goes to it and no Authorization leaves for any non-allowlisted origin. */
const EVIL = [
  "https://evil.example", "https://evil.example/api", "http://evil.example:8787", "https://api.leeroy.party.evil.example",
  "https://api.leeroy.party@evil.example", "http://127.0.0.1.evil.example", "https://leeroy-brain-pr-1.jmattbloise.workers.dev.evil.example",
  "https://leeroy-brain-pr-x.jmattbloise.workers.dev", "https://jmattbloise.workers.dev", "https://leeroy-brain-pr-1.evil.workers.dev",
  "https://leeroy-brain-pr-1.joshbblaine.workers.dev.evil.example", "https://leeroy-brain-pr-1.other-account.workers.dev",
];
for (const evil of EVIL) {
  const { ctx, page, seen } = await open(pageUrl(BASE, { params: { brain: evil }, hash: `k=${KEY}` }));
  await page.waitForTimeout(2500);
  const bad = seen.filter((x) => !ALLOWED.test(x.origin) && (x.auth || x.preflightAuth));
  ok(`F1 ?brain=${evil}: no Authorization (or preflight asking for it) leaves for a non-allowlisted origin`, bad.length === 0, bad.map((x) => `${x.method} ${x.url}`).join(", "));
  const toEvil = seen.filter((x) => x.origin === new URL(evil).origin);
  ok(`F1 ?brain=${evil}: the board sends nothing to that origin at all (BoardBrain.url cannot bypass the ?api= allowlist)`, toEvil.length === 0, toEvil.slice(0, 3).map((x) => x.url).join(", "));
  const stored = await page.evaluate(() => { try { return localStorage.getItem("board-key"); } catch (e) { return null; } });
  ok(`F1 ?brain=${evil}: the key is still captured and stored (the fix filters the destination, not the key)`, stored === KEY);
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); await ctx.close();
}
{ /* positive control: with the allowlisted local Worker the key IS sent, so the checks above are not vacuous */
  const { ctx, page, seen } = await open(pageUrl(BASE, { hash: `k=${KEY}` }));
  await page.waitForTimeout(2500);
  const sent = seen.filter((x) => x.auth && ALLOWED.test(x.origin));
  ok("F1 control: an allowlisted origin (local Worker) still gets the Authorization header on /api/me", sent.some((x) => /\/api\/me$/.test(new URL(x.url).pathname)), JSON.stringify(seen.filter((x) => /\/api\//.test(x.url)).slice(0, 4)));
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); await ctx.close();
}

/* F3b. The ?api= / board-api fallback accepts only our own origins: a third-party leeroy-brain*.workers.dev must not be read as board data. ?brain= is set to a refused value so BoardBrain.url is empty and the ?api= path is the one used. */
for (const [how, evil] of [["?api=", "https://leeroy-brain-evil.workers.dev"], ["?api=", "https://leeroy-board-api-x.workers.dev"], ["board-api", "https://leeroy-brain-evil.workers.dev"]]) {
  const viaQuery = how === "?api=";
  const { ctx, page, seen } = await open(pageUrl(VIRTUAL, { params: { preview: "1", brain: "https://evil.example", ...(viaQuery ? { api: evil } : {}) } }), viaQuery ? {} : { init: `try { localStorage.setItem("board-api", ${JSON.stringify(evil)}) } catch (e) {}` });
  await page.waitForTimeout(2500);
  const host = new URL(evil).origin, hit = seen.filter((x) => x.origin === host);
  ok(`F3 ${how} ${evil}: no request goes to a third-party workers.dev`, hit.length === 0, hit.slice(0, 3).map((x) => x.url).join(", "));
  ok(`F3 ${how} ${evil}: the board still loads its data (falls back to the static files)`, seen.some((x) => x.origin === VIRTUAL && /\/data\/(party|timeline)\.json/.test(x.url)), `${seen.length} requests`);
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); await ctx.close();
}
{ /* control: a local Worker via ?api= is still honoured (so the check above is not vacuous); the stub answers it, no live Worker */
  const { ctx, page, seen } = await open(pageUrl(VIRTUAL, { params: { preview: "1", brain: "https://evil.example", api: "http://127.0.0.1:8787" } }));
  await page.waitForTimeout(2500);
  ok("F3 control: ?api=http://127.0.0.1:8787 is still used for /api/data/*", seen.some((x) => x.origin === "http://127.0.0.1:8787" && /\/api\/data\//.test(x.url)), seen.filter((x) => /api\/data/.test(x.url)).length + " api/data requests");
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); await ctx.close();
}

/* F2. h() drops an href/src that is not https(s)://, a one-slash path, # or a relative path with a folder. Every evil value below is rendered as its own poll link, so every one is reached. */
{
  const EVIL_HREF = ["javascript:window.__pwned=1", "JaVaScRiPt:window.__pwned=1", " javascript:window.__pwned=1", "data:text/html,<script>window.__pwned=1</script>", "vbscript:x", "data:image/svg+xml,%3Csvg%20onload%3D%22window.__pwned%3D1%22%2F%3E",
    "//evil.example/x", "//evil.example", "/\\evil.example/x", "///evil.example", "http:evil", "x.png"];
  const good = "https://discord.com/channels/1/2/3";
  const { ctx, page } = await open(pageUrl(BASE), {
    mutateBootstrap: (b) => {
      const far = Math.floor(Date.now() / 1000) + 86400 * 30, p = b.party;
      p.polls = [...EVIL_HREF.map((u, i) => ({ title: `Evil poll ${i}`, text: "poll closes soon.", closes_epoch: far, url: u })), { title: "Good poll", text: "poll closes soon.", closes_epoch: far, url: good }];
      p.polls_closed = [];
      let n = 0; /* one running counter over ALL links of ALL open items, so the list is walked in order and not only for items with 6+ links */
      for (const o of p.open) o.links = (o.links || []).map((l) => ({ ...l, url: EVIL_HREF[n++ % EVIL_HREF.length] }));
      return b;
    },
  });
  await page.evaluate(() => window.__boardKit.goScene("ledger"));
  await page.waitForTimeout(1500);
  const polls = await page.evaluate(() => [...document.querySelectorAll("#ledger-slip .poll")].map((d) => [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"))));
  ok(`F2 every fixture was rendered: ${EVIL_HREF.length + 1} poll cards, each with its link element`, polls.length === EVIL_HREF.length + 1 && polls.every((l) => l.length === 1), JSON.stringify(polls).slice(0, 200));
  ok("F2 each of the evil poll links has NO href (javascript:, data:, vbscript:, //host, /\\host, ///host, http:x, bare file all dropped)", polls.slice(0, EVIL_HREF.length).every((l) => l[0] === null), JSON.stringify(polls.slice(0, EVIL_HREF.length)));
  ok("F2 control: the https poll link in the same data keeps its href", polls[EVIL_HREF.length] && polls[EVIL_HREF.length][0] === good, JSON.stringify(polls[EVIL_HREF.length]));
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("[href],[src]")].map((n) => ({ tag: n.tagName, v: n.getAttribute("href") ?? n.getAttribute("src") })));
  const bad = hrefs.filter((x) => x.tag !== "LINK" /* the static data: favicon in <head> is not data-driven */ && (/^\s*(javascript|data|vbscript):/i.test(x.v || "") || /^(\/[\/\\]|http:evil)/.test(x.v || "")));
  ok("F2 no element anywhere (poll links and the open items' links included) has an unsafe href/src", bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  const crest = await page.evaluate(async () => { const i = window.__boardKit.crestMark({ class_key: "zz-no-art", name: "x" }); window.dispatchEvent(new Event("pointerdown")); /* a first touch warms the wall, which gives a lazy image its src */ for (let n = 0; n < 40 && !i.getAttribute("src"); n++) await new Promise((r) => setTimeout(r, 100)); /* a lazy image made while the wall is cold gets its src on settle */ return i.getAttribute("src"); });
  ok("F2 control: the inline crest medallion (data:image/svg+xml) is still allowed on an <img src>, only there", typeof crest === "string" && /^data:image\/svg\+xml,/.test(crest), String(crest).slice(0, 60));
  ok("F2 nothing ran", !(await page.evaluate(() => window.__pwned)));
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); await ctx.close();
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
  await ctx.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {}); await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
