// B66 regression: a friend who is not signed in taps a deep link such as https://leeroy.party/#library.events.launch and chooses "Continue with Discord":
// the destination hash must still be the destination. Today nothing in the page leaves the origin for a login round trip (the open web board opens straight on the
// hash, "Continue with Discord" opens the Sign-ups card in Discord in a new tab, and the Worker's /auth/discord/start is not called by any front-end code), so the hash
// must survive untouched; this suite pins that down.
//   node deep-link-login.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)   optional: env PW_CHROMIUM = path to a Chromium binary
// Nothing is sent and there is no AI call: /api/ is answered from tests/fixtures/api-snapshot and window.open is recorded instead of opening a tab. The Discord sign-up
// link is whatever the page itself loaded (D.tonight.links.signup, from the bootstrap snapshot when the page has an API origin and from data/tonight.json when it has
// none), read back from the page, so the check holds on either data path. Per destination (a Library page, a scene with a sub-address, a plain scene) and size (390x844 touch, 1366x768),
// from a first visit with nothing remembered: the scene opens on that hash; the hash is unchanged after the page settles; tapping "Continue with Discord" (the first-run
// button behind the scene, clicked in the page) keeps the hash and the open scene, leaves the page's own URL alone, opens only the page's own Discord sign-up link in a new tab,
// and never requests /auth/discord/start or any other /auth/ path. A deep link that arrives with ?login=ok (what the Worker's callback sends) opens the same destination.
// Exit 0 when every check passes, 1 otherwise.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node deep-link-login.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const TOKENS = [["library.events.launch", /Library/], ["five.party", null], ["signups", null]];

async function visit(browser, width, height, token, query = {}) {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone, serviceWorkers: "block", reducedMotion: "reduce" });
  await ctx.addInitScript(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push([String(u), t, f]); return null; }; });
  const authReqs = [];
  ctx.on("request", (r) => { if (/\/auth\//.test(new URL(r.url()).pathname)) authReqs.push(r.url()); });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pageUrl(BASE, { params: { preview: "1", ...query }, hash: token }), { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { ctx, page, errors, authReqs };
}
const state = (page) => page.evaluate(() => ({ hash: location.hash, href: location.href, open: document.documentElement.classList.contains("scene-open") && !document.querySelector("#scene").hidden, title: (document.querySelector("#sheet-title") || {}).textContent || "", first: !!document.querySelector("#nx-fr2-go"), opened: window.__opened, signup: (((window.__boardKit || {}).D || {}).tonight || {}).links?.signup || null }));

const browser = stubbed(await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}));
try {
  for (const [width, height] of [[390, 844], [1366, 768]]) {
    for (const [token, titleRe] of TOKENS) {
      const t = `[#${token} @${width}x${height}]`, { ctx, page, errors, authReqs } = await visit(browser, width, height, `#${token}`);
      const a = await state(page);
      ok(`${t} signed out, the deep link opens its scene`, a.open && (!titleRe || titleRe.test(a.title)), `open ${a.open}, title "${a.title}"`);
      ok(`${t} the hash is still the destination`, a.hash === `#${token}`, a.hash);
      ok(`${t} the first-run "Continue with Discord" button exists behind the scene`, a.first);
      ok(`${t} the page loaded a Discord sign-up link`, /^https:\/\/discord\.com\//.test(String(a.signup)), String(a.signup));
      await page.evaluate(() => document.querySelector("#nx-fr2-go").click());
      await page.waitForTimeout(1200);
      const b = await state(page);
      ok(`${t} after "Continue with Discord" the hash is still the destination`, b.hash === `#${token}`, b.hash);
      ok(`${t} the scene is still open and the page URL is unchanged`, b.open && b.href === a.href, `${a.href} -> ${b.href}`);
      ok(`${t} the only thing opened is the Discord sign-up card, in a new tab`, b.opened.length === 1 && b.opened[0][0] === a.signup && /_blank/.test(b.opened[0][1]), JSON.stringify(b.opened));
      ok(`${t} no /auth/ request was made`, authReqs.length === 0, authReqs.join(" | "));
      ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
    const t = `[?login=ok#library.events.launch @${width}x${height}]`, { ctx, page, errors } = await visit(browser, width, height, "#library.events.launch", { login: "ok" });
    const c = await state(page);
    ok(`${t} the destination opens as it does without ?login`, c.open && c.hash === "#library.events.launch" && /Library/.test(c.title), `open ${c.open}, hash ${c.hash}, title "${c.title}"`);
    ok(`${t} no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
