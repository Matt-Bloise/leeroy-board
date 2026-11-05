// Party-size board check (flag party.n): the board is loaded with a six-member AND a seven-member fixture (made-up names only), and nothing the visitor can see may still say "five".
//   node six-members.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM = path to a Chromium binary
//   optional: --out <dir>  writes a text dump and a screenshot of the Next card, The party scene and the Library page (six members, 390 and 1366 wide) into <dir>
// Nothing is sent and there is no AI call. data/party.json, data/signups.json and data/client.json are answered from tests/fixtures/six-members (client.json is the
// real file with the flag party.n switched on or off by the test); both the static path and the Worker path (/api/data/<name>) are intercepted, /api/bootstrap is
// refused so the board falls back to them. Fixtures: party.json + signups.json (six), party-seven.json + signups-seven.json (seven); five members is the six minus the last.
// Part 1, per count (6 and 7) and width (320, 390, 768, 1024, 1366), flag on: one name chip per member; none cut off or off screen; no overlap; each at least 44px tall;
//   no horizontal scroll; the roster (The party scene) shows one card per member and the front tile one medallion each; the first screen and the roster scene say no "five".
// Part 2, per count (6 and 7), at 390 (phone: tab bar at the bottom) and 1366 (tab strip), for a first visit, "Just take a look" and a picked name: EVERY scene
//   (timeline, five, five.party, five.sheet-<member>, roads, racials, legacy, buffs, ledger, signups, librarian, library, decide, tonight) is opened and its visible text,
//   labels, titles, alt text and the tab bar are searched for the word "five" and for "four" used as the count of the others ("the other four"). Library prose and game
//   facts that really are about five (see NOT_PARTY) are the only exceptions, each named with its reason. The whole DOM (hidden text too), the page title and the meta
//   descriptions are searched once per count as well.
// Part 3, flag off with six members, and flag on with FIVE members: the old wording ("The five", "all five", "the five of us") is unchanged.
// Part 4, the party changes while the page is open (seven, then back to five): the words follow.
// Exit 0 when every check passes, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES, OUT = arg("--out");
if (!BASE) { console.error("usage: node six-members.mjs --url <pages origin> (or set PREVIEW_PAGES) [--out <dir>]"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n) => fs.readFileSync(path.join(here, "..", "fixtures", "six-members", `${n}.json`), "utf8");
const SIGNUPS = { 5: FIX("signups"), 6: FIX("signups"), 7: FIX("signups-seven") };
const SIX = JSON.parse(FIX("party"));
const PARTY = { 5: JSON.stringify({ ...SIX, members: SIX.members.slice(0, 5) }), 6: FIX("party"), 7: FIX("party-seven") };
const WORD = { 5: "five", 6: "six", 7: "seven" };
const namesOf = (n) => JSON.parse(PARTY[n]).members.map((m) => m.name);
if (OUT) fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const WIDTHS = [320, 390, 768, 1024, 1366];
const DATA_RE = /\/(?:api\/)?data\/(party|signups|client)(?:\.json)?(?:\?|$)/;
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" }, body });

// The word "five" (and "four" as the count of the others) must not be on screen when the party is not five. These phrases are about five of something that is not the party, so
// they stay: the dial in the Bonuses scene steps by five points; the game's dungeon is a group of five players; the summon rule is three of a five-player group; the footer
// counts its five SOURCES (Party Board, client tables, Blizzard's dates, the bot's log, the sign-up card), which does not change when a member joins.
const NOT_PARTY = [/\bfive points (?:fewer|more)\b/i, /\bgroup of five players\b/i, /\bthree of five still travel\b/i, /\bRead from (?:five|four) places\b/i];
const FIVE_RE = /\bfive\b/i;
const FOUR_OTHER_RE = /\b(?:other|remaining|rest) four\b|\bfour others\b|\bthe four of (?:you|us|them)\b|\bfour (?:friends|members|players|of us)\b/i;

// The chips render in steps (the first .tn-name can be visible before the rest of the party is), so a count taken right after the first one races the render.
// Wait (bounded) until the number of visible name chips equals the expected member count; if it never does, say what the DOM held so the assertion that follows is readable.
const CHIP_SEL = ".tn-name";
const visibleChips = (page) => page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((b) => b.getClientRects().length).length, CHIP_SEL);
async function settleChips(page, expected, width, timeout = 10000) {
  const reached = await page.waitForFunction(([sel, n]) => Array.from(document.querySelectorAll(sel)).filter((b) => b.getClientRects().length).length === n, [CHIP_SEL, expected], { timeout }).then(() => true, () => false);
  if (!reached) console.log(`NOTE name chips did not reach ${expected} within ${timeout / 1000}s at ${width}px: the DOM has ${await visibleChips(page).catch(() => "?")} visible '${CHIP_SEL}' elements`);
  return reached;
}

async function setup(browser, width, { flagOn = true, count = 6, state = "looking" } = {}) {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.route("**/api/bootstrap*", (r) => r.abort());
  await ctx.route(DATA_RE, async (route) => {
    const n = DATA_RE.exec(route.request().url())[1];
    if (n === "party") return json(route, PARTY[count]);
    if (n === "signups") return json(route, SIGNUPS[count]);
    const res = await route.fetch(), j = await res.json();
    j.flags = { ...(j.flags || {}), "party.n": flagOn };
    return json(route, JSON.stringify(j));
  });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" });
  await page.waitForSelector("#nx-fr2-look, .tn-name", { state: "attached", timeout: 20000 }).catch(() => {});
  if (state !== "gate") {
    // "Just take a look" must be TAKEN, not only looked for: the link (or the chips themselves, on a visit that skips the first-visit sheet) can be attached a moment before it is visible,
    // and a click skipped because the link was not visible yet leaves the chips hidden for good (0 visible .tn-name, the click on a chip then times out). So wait until one of the two is visible.
    await page.waitForFunction(() => { const vis = (e) => !!e && e.getClientRects().length > 0; return vis(document.querySelector("#nx-fr2-look")) || Array.from(document.querySelectorAll(".tn-name")).some(vis); }, null, { timeout: 20000 }).catch(() => {});
    const look = page.locator("#nx-fr2-look");
    if (await look.isVisible().catch(() => false)) await look.click();
    await page.waitForSelector(".tn-name", { state: "visible", timeout: 20000 }).catch(() => {});
    await settleChips(page, count, width);
  }
  if (state === "member") {
    await page.locator(".tn-name", { hasText: namesOf(count)[0] }).first().click();
    await page.getByRole("button", { name: /Show me what is next/ }).first().click().catch(() => {});
  }
  await page.waitForTimeout(state === "gate" ? 800 : 1000);
  return { ctx, page, errors };
}

const chipInfo = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const chips = Array.from(document.querySelectorAll(".tn-name")).filter((b) => b.getClientRects().length).map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, clipped: b.scrollWidth > b.clientWidth + 1 }; });
  let overlap = 0;
  for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) {
    const a = chips[i], c = chips[j], dx = Math.min(a.r, c.r) - Math.max(a.x, c.x), dy = Math.min(a.b, c.b) - Math.max(a.y, c.y);
    if (dx > 1 && dy > 1) overlap++;
  }
  return { vw, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, chips, overlap };
});

// Every string a reader or a screen reader gets: text nodes, aria-label, title, alt, placeholder, option text; `all` also takes what is hidden. Hits that match
// NOT_PARTY are dropped. Returns [{ where, text }] for the word five and for four-as-the-other-count.
const copyHits = (page, all) => page.evaluate(({ all, five, four, notParty }) => {
  const FIVE = new RegExp(five, "i"), FOUR = new RegExp(four, "i"), SAFE = notParty.map((s) => new RegExp(s, "i"));
  const hits = [], seen = new Set();
  const shown = (el) => { for (let e = el; e; e = e.parentElement) { if (e.tagName === "OPTION" || e.tagName === "SELECT") continue; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return false; } return !!(el.getClientRects().length) || el.closest("select"); };
  const note = (where, text, el) => {
    const t = String(text).replace(/\s+/g, " ").trim();
    if (!t || (!FIVE.test(t) && !FOUR.test(t))) return;
    const masked = SAFE.reduce((s, re) => s.replace(new RegExp(re.source, "gi"), " "), t);
    if (!FIVE.test(masked) && !FOUR.test(masked)) return;
    const id = el ? (el.id ? `#${el.id}` : el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase()) : "";
    const k = `${where}|${t}`; if (seen.has(k)) return; seen.add(k);
    hits.push({ where: `${where}${id ? ` ${id}` : ""}`, text: t.slice(0, 90) });
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement; if (p && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) && (all || shown(p))) note("text", n.nodeValue, p); }
  for (const el of document.querySelectorAll("[aria-label],[title],[alt],[placeholder],[aria-description],[aria-roledescription]")) {
    if (!all && !shown(el)) continue;
    for (const a of ["aria-label", "title", "alt", "placeholder", "aria-description", "aria-roledescription"]) { const v = el.getAttribute(a); if (v) note(a, v, el); }
  }
  if (all) {
    note("document.title", document.title, null);
    for (const m of document.querySelectorAll('meta[name="description"],meta[property="og:description"],meta[name="twitter:description"],meta[property="og:title"],meta[name="twitter:title"]')) note(`meta ${m.getAttribute("name") || m.getAttribute("property")}`, m.getAttribute("content"), null);
  }
  return hits;
}, { all, five: FIVE_RE.source, four: FOUR_OTHER_RE.source, notParty: NOT_PARTY.map((r) => r.source) });
const show = (hits) => hits.map((h) => `${h.where}: "${h.text}"`).join(" || ");

const isOpen = () => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden;
async function openHash(page, hash) {
  const top = hash.split(".")[0];
  const once = async () => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    return page.waitForFunction(([k]) => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden && (() => { const p = document.querySelector(`#panel-${k}`); return !p || !p.hidden; })(), [top], { timeout: 8000 }).then(() => true, () => false);
  };
  let up = await once();
  if (!up) { await page.evaluate(() => { location.hash = ""; }); await page.waitForTimeout(800); up = await once(); } // a slow machine: one more try, as the other suites do
  await page.waitForTimeout(700);
  return up;
}
const SCENES = ["timeline", "five", "five.party", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide", "tonight"];
const SHOT = new Set(["tonight", "five.party", "library"]);
async function dump(page, count, width, state, hash) {
  if (!OUT || count !== 6 || !SHOT.has(hash) || state !== "member") return;
  const label = { tonight: "next-card", "five.party": "the-party-scene", library: "library" }[hash], f = `${label}-6-members-${width}`, panel = `#panel-${hash.split(".")[0]}`;
  if (hash === "library") await page.waitForTimeout(2500); // the Library page builds its shelves after the scene opens
  const text = await page.evaluate((sel) => { const p = document.querySelector(sel); return `${(document.querySelector("#sheet-title") || {}).textContent || ""}\n\n${p ? p.innerText : "(panel not found)"}`; }, panel);
  fs.writeFileSync(path.join(OUT, `${f}.txt`), `${text.replace(/\n{3,}/g, "\n\n")}\n`);
  await page.screenshot({ path: path.join(OUT, `${f}.png`) });
}

const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  for (const count of [6, 7]) {
    const NAMES = namesOf(count), W = WORD[count];
    ok(`fixture has ${W} made-up members`, NAMES.length === count && new Set(NAMES).size === count, NAMES.join(", "));
    // Part 1: layout and the first two screens, five widths
    for (const width of WIDTHS) {
      const t = `[${count} @${width}]`, { ctx, page, errors } = await setup(browser, width, { count });
      const c = await chipInfo(page);
      ok(`${t} ${W} name chips`, c.chips.length === count && NAMES.every((n) => c.chips.some((x) => x.t === n)), c.chips.map((x) => x.t).join(" | "));
      ok(`${t} no horizontal scroll`, c.sw <= c.vw + 1 && c.bw <= c.vw + 1, `viewport ${c.vw}, document ${c.sw}, body ${c.bw}`);
      ok(`${t} every chip on screen sideways`, c.chips.every((x) => x.x >= -0.5 && x.r <= c.vw + 0.5), JSON.stringify(c.chips.map((x) => [Math.round(x.x), Math.round(x.r)])));
      ok(`${t} no chip text cut off`, c.chips.every((x) => !x.clipped), c.chips.filter((x) => x.clipped).map((x) => x.t).join(", "));
      ok(`${t} no chips overlap`, c.overlap === 0, `${c.overlap} overlapping pairs`);
      ok(`${t} every chip is at least 44px tall`, c.chips.every((x) => x.h >= 44), c.chips.map((x) => Math.round(x.h * 10) / 10).join(", "));
      const front = await copyHits(page, false);
      ok(`${t} first screen: no copy says "five" or "the other four"`, front.length === 0, show(front));
      ok(`${t} the front tile shows ${W} medallions`, (await page.locator("#ts-five .med").count()) === count, String(await page.locator("#ts-five .med").count()));
      await page.goto(pageUrl(BASE, { params: { preview: "1" }, hash: "five" }), { waitUntil: "load" });
      await page.waitForSelector("#cards .card", { state: "attached", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
      ok(`${t} the roster shows ${W} cards`, (await page.locator("#cards .card").count()) === count, String(await page.locator("#cards .card").count()));
      ok(`${t} the scene is titled for the party`, /The party/.test(await page.locator("#sheet-title").innerText().catch(() => "")) || /The party/.test(await page.locator("#tab-five").innerText().catch(() => "")));
      const scene = await copyHits(page, false);
      ok(`${t} roster scene: no copy says "five" or "the other four"`, scene.length === 0, show(scene));
      const c2 = await chipInfo(page);
      ok(`${t} no horizontal scroll on the roster scene`, c2.sw <= c2.vw + 1 && c2.bw <= c2.vw + 1, `viewport ${c2.vw}, document ${c2.sw}`);
      ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
    // Part 2: walk every scene, in every visitor state, at the phone bar and the desktop strip
    for (const width of [390, 1366]) {
      // member:curious and member:everything are the other journeys; their Next card is longer (the tonight line says how many "of the six" are in)
      for (const state of ["gate", "looking", "member", "member:curious", "member:everything"]) {
        const [base, journey] = state.split(":");
        const t = `[${count} @${width} ${state}]`, { ctx, page, errors } = await setup(browser, width, { count, state: base });
        if (journey) { await page.evaluate((j) => { const b = document.querySelector(`[data-journey="${j}"]`); if (b) b.click(); }, journey); await page.waitForTimeout(900); }
        const first = await copyHits(page, false);
        ok(`${t} start screen and tab bar: no "five" and no "the other four"`, first.length === 0, show(first));
        if (state === "gate") {
          const all = await copyHits(page, true);
          ok(`${t} whole DOM (hidden text, page title, meta): no "five" and no "the other four"`, all.length === 0, show(all));
          const dom = await page.evaluate(() => document.body.textContent + " " + [...document.querySelectorAll("[aria-label],[title]")].map((e) => (e.getAttribute("aria-label") || "") + " " + (e.getAttribute("title") || "")).join(" "));
          ok(`${t} the page says the real count (${W})`, new RegExp(`for the ${W} of us`).test(dom) && new RegExp(`Swipe sideways for all ${W}\\.`).test(dom) && /Open the party/.test(dom) && /Which of the party are you/.test(dom));
          ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
          await ctx.close(); continue;
        }
        const slug = await page.evaluate(() => { const a = document.querySelector('.card[data-slug]'); return a ? a.dataset.slug : null; });
        const scenes = [...SCENES]; const si = scenes.indexOf("five.party") + 1; scenes.splice(si, 0, `five.sheet-${slug || "x"}`);
        for (const hash of scenes) {
          const up = await openHash(page, hash);
          const hits = await copyHits(page, false);
          ok(`${t} #${hash}: opens, and no "five" or "the other four" in its text, labels or the tab bar`, up && hits.length === 0, up ? show(hits) : "the scene did not open");
          await dump(page, count, width, journey ? "journey" : base, hash);
        }
        if (width < 768) {
          await page.evaluate(() => { location.hash = ""; }); await page.waitForTimeout(500);
          const more = page.locator("#bottombar").getByRole("button", { name: /More/ }).first();
          if (await more.count()) { await more.click().catch(() => {}); await page.waitForTimeout(600); }
          const mh = await copyHits(page, false);
          ok(`${t} the More menu: no "five" or "the other four"`, mh.length === 0, show(mh));
        }
        if (base === "member") {
          const all = await copyHits(page, true);
          ok(`${t} whole DOM after every scene was built: no "five" and no "the other four"`, all.length === 0, show(all));
        }
        ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
        await ctx.close();
      }
    }
  }
  // Part 3a: flag off is production today: six members in the data change nothing about the wording.
  const off = await setup(browser, 1366, { flagOn: false });
  const wording = (page) => page.evaluate(() => {
    const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
    const dom = document.body.textContent + " " + [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ");
    return { tab: t("#tab-five"), hint: t("#panel-five .swipe-hint"), tile: t("#tt-five"), go: t("#tt-five") && document.querySelector("#tt-five").parentNode.querySelector(".word").textContent.trim(), legend: t("fieldset legend"), gate: /for the five of us/.test(dom), as: document.querySelector("#as") && document.querySelector("#as").getAttribute("aria-label") };
  });
  const OLD = { tab: "The five", hint: "Swipe sideways for all five.", tile: "The five", go: "Open the five", legend: "Which of the five are you?", gate: true, as: "Which of the five are you" };
  const w0 = await wording(off.page);
  ok("[flag off] the old copy is unchanged", JSON.stringify(w0) === JSON.stringify(OLD), JSON.stringify(w0));
  ok("[flag off] chips still come from the data", (await chipInfo(off.page)).chips.length === 6);
  await off.ctx.close();
  // Part 3b: flag on, five members: also the old wording, word for word.
  const five = await setup(browser, 1366, { flagOn: true, count: 5 });
  const w5 = await wording(five.page);
  ok("[flag on, five members] the old copy is unchanged", JSON.stringify(w5) === JSON.stringify(OLD), JSON.stringify(w5));
  ok("[flag on, five members] five chips", (await chipInfo(five.page)).chips.length === 5);
  await five.page.goto(pageUrl(BASE, { params: { preview: "1" }, hash: "five" }), { waitUntil: "load" });
  await five.page.waitForTimeout(1200);
  ok("[flag on, five members] the scene is still titled The five", /The five/.test(await five.page.locator("#sheet-title").innerText().catch(() => "")));
  await five.ctx.close();
  // Part 4: the party changes while the page is open (the board's own data handler sets D.party and re-renders): the words follow it, seven and then back to five.
  const live = await setup(browser, 1366, { count: 6, state: "member" });
  await live.page.evaluate((p) => { const K = window.__boardKit; K.D.party = JSON.parse(p); K.render.tiles(); K.emit("rendered"); }, PARTY[7]);
  const seven = await copyHits(live.page, true);
  ok("[live change to seven] no \"five\" and no \"the other four\" anywhere", seven.length === 0, show(seven));
  ok("[live change to seven] the tab, the hint and the gate say seven", await live.page.evaluate(() => /^The party$/.test(document.querySelector("#tab-five").textContent.trim()) && document.querySelector("#panel-five .swipe-hint").textContent === "Swipe sideways for all seven." && /for the seven of us/.test(document.body.textContent)));
  await live.page.evaluate((p) => { const K = window.__boardKit; K.D.party = JSON.parse(p); K.render.tiles(); K.emit("rendered"); }, PARTY[5]);
  const back = await wording(live.page);
  ok("[live change back to five] the old copy is back, word for word", JSON.stringify(back) === JSON.stringify(OLD), JSON.stringify(back));
  ok("[live change] no page errors", live.errors.length === 0, live.errors.join(" | "));
  await live.ctx.close();
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
