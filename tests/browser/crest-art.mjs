// Class crest art: all nine classes render a crest with zero broken images and zero 404s. Four of them (hunter, rogue, shaman, warrior) have no file in img/crests/, so the board draws
// an inline SVG medallion (js/crest.js) instead of requesting one.
//   node crest-art.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Stubbed: the Worker API is answered from tests/fixtures/api-snapshot (0 Worker requests), no AI call. The party document (static file data/party.json) is replaced in the browser by one
// with nine members, one per class, so the real board code paths draw the crests (the first-screen medallions, the card deck, the sheet).
import { stubbed } from "../helpers/browser-stub.mjs";
import { pageUrl } from "../helpers/page-url.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node crest-art.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const NINE = ["druid", "priest", "paladin", "mage", "warlock", "hunter", "rogue", "shaman", "warrior"];
const LABEL = { druid: "Druid", priest: "Priest", paladin: "Paladin", mage: "Mage", warlock: "Warlock", hunter: "Hunter", rogue: "Rogue", shaman: "Shaman", warrior: "Warrior" };
const COLOR = { druid: "#ff7c0a", priest: "#ffffff", paladin: "#f48cba", mage: "#3fc7eb", warlock: "#8788ee", hunter: "#aad372", rogue: "#fff468", shaman: "#0070dd", warrior: "#c69b6d" };
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {};

const browser = stubbed(await pw.chromium.launch(launch), { label: "crest-art api-stub" });
const url = pageUrl(BASE, { params: { preview: "1" } }), origin = new URL(url).origin;
const party = await (await fetch(new URL("data/party.json", origin))).json().catch(() => null);
ok("data/party.json is readable", !!party && Array.isArray(party.members) && party.members.length >= 5);

for (const [size, opts] of [["1366x768", { viewport: { width: 1366, height: 768 } }], ["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
  const tag = `[${size}]`, bad = [], crestReq = [], errors = [];
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" });
  const nine = { ...party, members: NINE.map((k, i) => ({ ...party.members[i % party.members.length], name: `Tester${i + 1}`, class_key: k, class: LABEL[k], color: COLOR[k] })) };
  for (const glob of ["**/data/party.json*", "**/api/data/party.json*"]) await ctx.route(glob, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(nine) })); // static file, or the Worker route the stub answers
  await ctx.route("**/api/bootstrap*", async (r) => { const j = await (await r.fetch()).json(); j.party = nine; await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) }); }); // the Worker mode: the party comes in the bootstrap (the stub answers r.fetch())
  await ctx.route("**/img/crests/zz-missing.png", (r) => r.fulfill({ status: 200, contentType: "text/plain", body: "not an image" })); // a crest file that is present but broken
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { const u = r.url(); if (u.startsWith(origin) && r.status() >= 400 && /\/img\/(crests|vector)\//.test(u)) bad.push(`${r.status()} ${u.slice(origin.length)}`); });
  page.on("request", (r) => { const u = r.url(); if (/\/img\/(crests|vector)\//.test(u)) crestReq.push(u.slice(origin.length)); });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__boardKit && window.__boardKit.crestMark && window.BoardCrest, null, { timeout: 20000 }).catch(() => {});
  await page.getByText("Just take a look", { exact: false }).first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  /* the kit's own crestMark, one per class, forced to load now (they are lazy) */
  const res = await page.evaluate(async (keys) => {
    const K = window.__boardKit, box = document.createElement("div"); box.id = "crest-test"; box.style.cssText = "position:fixed;left:0;top:0;z-index:99999;display:flex;flex-wrap:wrap;width:600px;background:#222";
    document.body.append(box);
    const imgs = keys.map((k) => { const i = K.crestMark({ class_key: k, name: k }); i.loading = "eager"; box.append(i); return [k, i]; });
    const broken = document.createElement("img"); broken.src = "img/crests/zz-missing.png"; window.BoardCrest.guard(broken, "warrior"); box.append(broken);
    await Promise.all([...imgs.map(([, i]) => i), broken].map((i) => (i.complete && i.naturalWidth ? 0 : new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); setTimeout(r, 4000); }))));
    await new Promise((r) => setTimeout(r, 300));
    return { rows: imgs.map(([k, i]) => ({ k, w: i.naturalWidth, complete: i.complete, src: i.getAttribute("src").slice(0, 30) })), broken: { w: broken.naturalWidth, src: broken.getAttribute("src").slice(0, 30) } };
  }, NINE);
  for (const r of res.rows) ok(`${tag} ${r.k}: crest image loaded (${r.src.startsWith("data:") ? "medallion" : "painted file"})`, r.complete && r.w > 0, JSON.stringify(r));
  ok(`${tag} a crest file that is present but broken is swapped for the medallion`, res.broken.src.startsWith("data:image/svg+xml") && res.broken.w > 0, JSON.stringify(res.broken));

  /* the real board with nine members: every <img> and SVG <image> of a crest on the page is intact */
  for (const hash of ["", "five", "buffs", "roads", "decide"]) {
    await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(900);
    const broken = await page.evaluate(() => [...document.querySelectorAll("img")].filter((i) => i.currentSrc && !i.closest("#crest-test") && i.complete && i.naturalWidth === 0).map((i) => i.currentSrc.slice(-50)));
    ok(`${tag} #${hash || "wall"}: no broken <img> on the page`, broken.length === 0, broken.join(", "));
  }
  const drawn = await page.evaluate(() => ({ cards: document.querySelectorAll("#cards .card[data-k]").length, warrior: document.querySelectorAll('[data-k="warrior"]').length, medallions: [...document.querySelectorAll("img, image")].filter((e) => /^data:image\/svg\+xml/.test(e.getAttribute("src") || e.getAttribute("href") || "")).length }));
  ok(`${tag} the board drew all nine members (not the five of the fixture)`, drawn.cards === 9 && drawn.warrior > 0, JSON.stringify(drawn));
  ok(`${tag} the board itself shows medallions for the classes with no art`, drawn.medallions >= 4, JSON.stringify(drawn));
  const painted = crestReq.filter((u) => /crests\/(hunter|rogue|shaman|warrior)/.test(u));
  ok(`${tag} no request was made for the four crests that have no file`, painted.length === 0, painted.join(", "));
  ok(`${tag} no 4xx on /img/crests or /img/vector`, bad.length === 0, bad.join(", "));
  ok(`${tag} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
await browser.close();
console.log(`crest-art: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
