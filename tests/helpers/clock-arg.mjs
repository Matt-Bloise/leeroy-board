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
