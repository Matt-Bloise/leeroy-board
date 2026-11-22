// A suite that sets localStorage "board-as" to a member's name runs as that member only if the board knows the name (js/board.js ignores a name that is not on the party document,
// and the page then silently runs as "nobody chosen"). This opens one throw-away page with the name set and fails loudly (throws) unless the sign-up form's name select (#as)
// took it, so a stale or wrong name stops the suite instead of weakening it.
//   await assertMemberState(browser, url, standIn(0).name)
import { standIn } from "./fictional-party.mjs";
export async function assertMemberState(browser, url, name = standIn(0).name) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "block" });
  try {
    await ctx.addInitScript((n) => { try { localStorage.setItem("board-as", n); localStorage.setItem("board-hinted", "1"); localStorage.setItem("board-room", "off"); } catch (e) {} }, name);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => { const s = document.querySelector("#as"); return !!s && s.options.length > 1; }, null, { timeout: 20000 }).catch(() => {});
    const got = await page.evaluate(() => { const s = document.querySelector("#as"); return s ? { value: s.value, options: [...s.options].map((o) => o.value).slice(0, 12) } : null; });
    if (!got || got.value !== name) throw new Error(`member-state: "${name}" is not a member on this page (the sign-up name select holds ${JSON.stringify(got && got.value)}; names offered: ${JSON.stringify(got && got.options)}): the suite would run as nobody chosen. Fix the name (tests/helpers/fictional-party.mjs standIn) or re-record the snapshot.`);
  } finally { await ctx.close(); }
}
