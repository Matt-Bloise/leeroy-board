// page.goto that survives a tab left on about:blank. Measured 3 November 2026 (tests/browser/nextstep.mjs, 12 runs on master, 20 on the Batch C follow-up branch): in about a third of the runs
// one of the six contexts ends with page.goto() resolved (the navigation request even logged a 200) but page.url() === "about:blank", an empty document: no scripts, no window.__boardKit,
// so no window.__next. That is the browser tab, not the page's own load order (a page that loaded has its scripts), and a second goto() on the same tab loads it. The same empty-page symptom
// ("0 chars, 0 controls") was the one failure of degraded-modes in CI. Bounded (3 tries) and loud: every retry prints a WARN line, and a tab that is still blank returns as it is so the check fails with its url.
export async function gotoRetry(page, url, options = {}, { tries = 3, label = "" } = {}) {
  let response = await page.goto(url, options);
  for (let i = 1; i < tries && page.url() === "about:blank"; i++) {
    console.log(`WARN ${label ? `${label}: ` : ""}the tab was left on about:blank after loading ${String(url).slice(0, 90)}; loading it again (${i} of ${tries - 1})`);
    response = await page.goto(url, options);
  }
  return response;
}
