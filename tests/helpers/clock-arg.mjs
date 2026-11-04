// --clock <iso> for the browser suites: the page is loaded with its clock set to that instant (Playwright page.clock.install), so a time-dependent screen
// (the launch hero, which appears 24 h before launch and stays 24 h after) can be checked today without waiting for it. The clock keeps running from there.
// Only the page's Date and timers move; the machine clock, TLS and the Worker are untouched. Without the option nothing changes.
//   parseClock(argv)        -> null when the option is absent, a Date when it is a valid ISO instant; throws Error with a clear message otherwise
//   applyClock(page, date)  -> installs it; call BEFORE page.goto
// The launch is Nov 4 2026 6 PM ET = 23:00Z. The three times the sweep runs at in CI (tests/README.md). From T-1h to T+12h the page opens on the wall with no first-visit sheet
// (js/v15.js openBefore / openAfter), so "after" is 15 h past launch: the hero is still up (24 h) and the first-visit sheet is back.
export const LAUNCH_CLOCKS = { before: "2026-11-03T22:10:00Z", hero: "2026-11-04T10:00:00Z", after: "2026-11-05T14:00:00Z" };
export function parseClock(argv) {
  const i = argv.indexOf("--clock");
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error("--clock needs an ISO time, for example --clock 2026-11-04T10:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) throw new Error(`--clock ${v}: write the time as ISO 8601 with a zone, for example 2026-11-04T10:00:00Z`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`--clock ${v}: not a real date`);
  return d;
}
export async function applyClock(page, date) { if (date) await page.clock.install({ time: date }); }
// THE PIN. A browser suite that reads the first-visit view (name picker, purpose card) must not depend on what time the machine says: from T-1h to T+12h around the launch
// the board opens on the wall with no first-visit sheet (js/v15.js openBefore / openAfter), and the hero is up from T-24h to T+24h. So every suite runs with the page clock
// pinned to DEFAULT_CLOCK, a neutral instant well before the launch (before the hero window, the same one the CI clock steps use), unless --clock names another.
//   pinnedClock(argv)       -> the Date to run at: --clock when given (parseClock rules, throws on a bad value), else DEFAULT_CLOCK
//   pinContext(ctx, argv)   -> installs it on a whole browser context, so every page the context opens starts at that time; call right after newContext, BEFORE the first goto
// tests/helpers/browser-stub.mjs stubbed() does this for every context it makes; a suite that does not use stubbed() calls pinContext itself. tests/unit/browser-clock-pin.test.mjs fails
// for a browser suite that does neither (prod-probe.mjs is the one production suite: real time unless --clock is given).
export const DEFAULT_CLOCK = LAUNCH_CLOCKS.before;
export function pinnedClock(argv = process.argv.slice(2)) { return parseClock(argv) || new Date(DEFAULT_CLOCK); }
export async function pinContext(ctx, argv = process.argv.slice(2)) { const d = pinnedClock(argv); await ctx.clock.install({ time: d }); return d; }
// What the launch hero must be at a faked time (js/v15.js WINDOW: shown from T-24h to T+24h, "soon" before launch and "live" after). The page sets html[data-launch] to the same word.
export const LAUNCH_MS = Date.parse("2026-11-04T23:00:00Z");
export function expectedHero(date) {
  const t = date.getTime(), DAY = 24 * 3600e3;
  if (t < LAUNCH_MS - DAY || t >= LAUNCH_MS + DAY) return "";
  return t < LAUNCH_MS ? "soon" : "live";
}

// A faked-clock run must really be in the state it claims. Returns null when the page matches expectedHero(date), else a message: html[data-launch] and #launch-hero are the
// expected phase (or both absent outside the window) and, after launch, #launch-hero carries is-live (before it, not). The same check layout-sweep.mjs makes.
export async function heroStateProblem(page, date, timeout = 8000) {
  const want = expectedHero(date), at = date.toISOString();
  const got = await page.waitForFunction((w) => (document.documentElement.dataset.launch || "") === w && !!document.querySelector("#launch-hero") === !!w, want, { timeout }).then(() => true, () => false);
  if (!got) {
    const seen = await page.evaluate(() => ({ phase: document.documentElement.dataset.launch || "", hero: !!document.querySelector("#launch-hero") }));
    return `--clock ${at}: expected the launch hero ${want ? `up (${want})` : "absent"}, found data-launch="${seen.phase}" and #launch-hero ${seen.hero ? "present" : "missing"}`;
  }
  if (!want) return null;
  const live = await page.evaluate(() => document.querySelector("#launch-hero").classList.contains("is-live"));
  return live === (want === "live") ? null : `--clock ${at}: #launch-hero ${live ? "has" : "lacks"} the is-live class, expected ${want === "live" ? "live" : "the countdown"}`;
}
