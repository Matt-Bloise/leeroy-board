// One line per suite to run on recorded API fixtures instead of the live Worker:
//   const browser = stubbed(await pw.chromium.launch(...));
// Every context the suite opens then answers /api/ from tests/fixtures/api-snapshot (see api-stub.mjs), so the suite sends zero requests to the Worker.
// Routes a suite adds itself (route.fulfill / route.abort for its own scenarios) are registered later and win over the stub.
// `--live-api` on the command line (or LIVE_API=1) turns the stub off and the suite talks to whatever API the page points at.
import { installApiStub } from "./api-stub.mjs";
export const LIVE_API = process.argv.includes("--live-api") || process.env.LIVE_API === "1";
export function stubbed(browser, { live = LIVE_API, label = "api-stub" } = {}) {
  if (live) { console.log(`${label}: off (--live-api): this suite talks to the real API`); return browser; }
  const make = browser.newContext.bind(browser), close = browser.close.bind(browser), stubs = [];
  browser.newContext = async (...args) => { const ctx = await make(...args); stubs.push(await installApiStub(ctx)); return ctx; };
  browser.apiStubReport = () => {
    const r = stubs.map((s) => s.report());
    return { served: r.reduce((n, x) => n + x.served, 0), writes: r.reduce((n, x) => n + x.writes.length, 0), misses: [...new Set(r.flatMap((x) => x.misses))] };
  };
  let said = false;
  browser.close = async (...a) => {
    if (!said) { said = true; const r = browser.apiStubReport(); console.log(`${label}: ${r.served} API reads answered from tests/fixtures/api-snapshot, ${r.writes} writes absorbed, 0 sent to the Worker${r.misses.length ? `; WARN not in the snapshot (re-record): ${r.misses.join(", ")}` : ""}`); }
    return close(...a);
  };
  return browser;
}
