// Keyboard path through the member's Next steps card (audit 2026-11-06, finding 1): Tab must never stall on the closed "Show me more" disclosure.
//   node next-steps-keyboard.mjs --url https://pr-N.leeroy-board.pages.dev/   (or env PREVIEW_PAGES)
// Chromium, 390x844 and 1366x768. The viewer is the first member on the board (read at run time), chosen through localStorage; nothing is sent and no AI is called.
// Checks: Tab from the "Show me more" summary moves focus to a different element; Tab never leaves focus on the same element twice in a row over a full lap;
// no element inside the closed details ever takes focus; Shift+Tab is symmetric; after the disclosure is opened its links are reachable.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
import { gotoRetry } from "../helpers/goto-retry.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const BASE = arg("--url") || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node next-steps-keyboard.mjs --url <pages origin> (or set PREVIEW_PAGES)"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const WHAT = () => { const a = document.activeElement; if (!a || a === document.body) return "body"; const d = a.closest("details"); return { tag: a.tagName.toLowerCase(), text: (a.textContent || a.getAttribute("aria-label") || a.id || "").trim().slice(0, 40), inClosed: !!(d && !d.open && !(a.tagName === "SUMMARY" && a.parentNode === d)), summary: a.tagName === "SUMMARY" && a.classList.contains("nx-rest-s") }; };
const sig = (w) => (w === "body" ? "body" : `${w.tag}:${w.text}`);

const browser = stubbed(await pw.chromium.launch());
try {
  const probe = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" }), pp = await probe.newPage();
  await gotoRetry(pp, pageUrl(BASE, { params: { preview: "1" } }), { waitUntil: "load" }, { label: "next-steps-keyboard probe" });
  await pp.waitForFunction(() => window.__next && window.__next.input().party, null, { timeout: 20000 }).catch(() => {});
  const who = await pp.evaluate(() => { try { return { name: window.__next.input().party.members[0].name }; } catch (e) { return null; } });
  await probe.close();
  ok("found a board member to act as", !!(who && who.name));
  if (!who) process.exit(1);
  for (const [w, h, touch] of [[390, 844, true], [1366, 768, false]]) {
    const t = `[${w}x${h}]`, ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, serviceWorkers: "block", reducedMotion: "reduce" }), page = await ctx.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await ctx.addInitScript((me) => { try { localStorage.setItem("board-me", me); localStorage.setItem("board-journey", "everything"); } catch (e) {} }, slug(who.name));
    await gotoRetry(page, pageUrl(BASE, { params: { preview: "1" }, hash: "tonight" }), { waitUntil: "load" }, { label: `next-steps-keyboard ${t}` });
    await page.waitForFunction(() => window.__next && window.__next.status().stepId, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const has = await page.evaluate(() => { const d = document.querySelector("#nx-rest"); return !!d && !d.open && d.querySelector("a[href], button") !== null; });
    ok(`${t} the closed "Show me more" disclosure with links inside is on the card`, has);
    if (!has) { await ctx.close(); continue; }
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    const seen = [];
    let stalled = 0, inClosed = 0, hitSummary = false, afterSummary = null;
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      const w1 = await page.evaluate(WHAT); seen.push(sig(w1));
      if (w1 !== "body" && w1.inClosed) inClosed++;
      if (i > 0 && seen[i] === seen[i - 1]) stalled++;
      if (hitSummary && afterSummary === null) afterSummary = seen[i];
      if (w1 !== "body" && w1.summary) hitSummary = true;
    }
    ok(`${t} Tab reached the "Show me more" summary`, hitSummary, seen.slice(0, 12).join(" > "));
    ok(`${t} Tab from the summary moves to another element`, !!afterSummary && !/Show me more/.test(afterSummary), String(afterSummary));
    ok(`${t} Tab never leaves focus unchanged (60 presses)`, stalled === 0, `${stalled} stalls: ${seen.slice(0, 14).join(" > ")}`);
    ok(`${t} nothing inside the closed details takes focus`, inClosed === 0, String(inClosed));
    ok(`${t} Tab visits more than the card itself (at least 6 distinct stops)`, new Set(seen).size >= 6, [...new Set(seen)].join(" > "));
    // Shift+Tab goes back the same way: from the stop after the summary it lands on the summary
    const back = await page.evaluate(() => { const s = document.querySelector("summary.nx-rest-s"); if (s) s.focus(); return !!s; });
    if (back) {
      await page.keyboard.press("Tab"); const fwd = sig(await page.evaluate(WHAT));
      await page.keyboard.press("Shift+Tab"); const w2 = await page.evaluate(WHAT);
      ok(`${t} Shift+Tab returns to the summary`, w2 !== "body" && w2.summary, `${fwd} then ${sig(w2)}`);
    }
    // open the disclosure: its links become reachable
    await page.evaluate(() => { const d = document.querySelector("#nx-rest"); if (d) d.open = true; });
    await page.evaluate(() => document.querySelector("summary.nx-rest-s").focus());
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => { const a = document.activeElement, d = document.querySelector("#nx-rest"); return !!(a && d && d.contains(a) && !a.classList.contains("nx-rest-s")); });
    ok(`${t} with the disclosure open Tab enters its links`, inside, sig(await page.evaluate(WHAT)));
    ok(`${t} no page errors`, errors.length === 0, errors.join(" | ").slice(0, 200));
    await page.screenshot({ path: `${process.env.TEMP || "/tmp"}/next-steps-keyboard-${w}.png` }).catch(() => {});
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
