// One line per suite to run on recorded API fixtures instead of the live Worker:
//   const browser = stubbed(await pw.chromium.launch(...));
// Every context the suite opens then answers /api/ from tests/fixtures/api-snapshot (see api-stub.mjs), so the suite sends zero requests to the Worker.
// Routes a suite adds itself (route.fulfill / route.abort for its own scenarios) are registered later and win over the stub.
// `--live-api` on the command line (or LIVE_API=1) turns the stub off and the suite talks to whatever API the page points at.
// A stub MISS (the page asked for an API path the snapshot lacks, so the fixture is stale) FAILS the suite: a FAIL line is printed and the process exits 1 even when the suite's own checks passed.
// Opt out for one run with API_STUB_ALLOW_MISS=1 (misses are then a WARN, as before); the real fix is `tools/local-browser.sh record-fixtures`.
import { installApiStub } from "./api-stub.mjs";
import { pinContext } from "./clock-arg.mjs";
export const ALLOW_MISS = process.env.API_STUB_ALLOW_MISS === "1";
export const LIVE_API = process.argv.includes("--live-api") || process.env.LIVE_API === "1";
// The same wrapper pins the page clock of every context (tests/helpers/clock-arg.mjs pinnedClock: a fixed time before the launch, or --clock), also with --live-api, so the first-visit
// view a suite reads does not depend on the time the suite runs at. `argv` is only for the unit test.
export function stubbed(browser, { live = LIVE_API, label = "api-stub", argv = process.argv.slice(2) } = {}) {
  const makeContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => { const ctx = await makeContext(...args); try { await pinContext(ctx, argv); } catch (e) { console.error(e.message); process.exit(2); } return ctx; };
  if (live) { console.log(`${label}: off (--live-api): this suite talks to the real API`); return browser; }
  const make = browser.newContext.bind(browser), close = browser.close.bind(browser), stubs = [];
  browser.newContext = async (...args) => { const ctx = await make(...args); stubs.push(await installApiStub(ctx)); return ctx; };
  browser.apiStubReport = () => {
    const r = stubs.map((s) => s.report());
    return { served: r.reduce((n, x) => n + x.served, 0), writes: r.reduce((n, x) => n + x.writes.length, 0), misses: [...new Set(r.flatMap((x) => x.misses))] };
  };
  let said = false, failed = false;
  /* judged once, at close or at process exit (whichever comes first): a miss sets the exit code to 1 unless API_STUB_ALLOW_MISS=1 */
  const judge = () => {
    if (said) return; said = true;
    const r = browser.apiStubReport(), miss = r.misses.length > 0;
    console.log(`${label}: ${r.served} API reads answered from tests/fixtures/api-snapshot, ${r.writes} writes absorbed, 0 sent to the Worker${miss ? `; ${ALLOW_MISS ? "WARN (API_STUB_ALLOW_MISS=1)" : "FAIL"} not in the snapshot (re-record with tools/local-browser.sh record-fixtures): ${r.misses.join(", ")}` : ""}`);
    if (miss && !ALLOW_MISS) failed = true;
  };
  browser.close = async (...a) => { judge(); return close(...a); };
  /* a suite ends with process.exit(fail ? 1 : 0): setting exitCode inside the 'exit' event is what still turns that 0 into 1 */
  process.on("exit", () => { judge(); if (failed) process.exitCode = 1; });
  return browser;
}
