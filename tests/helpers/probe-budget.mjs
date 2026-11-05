// The Worker-request budget of tests/browser/prod-probe.mjs, as a small module so a test can prove it holds (tests/browser/prod-probe-selftest.mjs).
//   const budget = createBudget(200);
//   await guardContext(ctx, budget);   // every /api request, every redirect and every /api WebSocket of this context is counted BEFORE it is sent; over budget it is refused
// HTTP, default mode "browser": ctx.route counts each /api request BEFORE it is sent and then lets the BROWSER send it (route.continue()), so the page gets exactly what a visitor's browser gets:
// its own network stack, CORS handling, HTTP cache and revalidation. (The earlier mode, "fetch", sent the request from the probe with route.fetch() and handed the answer to the page with
// route.fulfill(); on production that made Firefox reject or never use the answer and fall back to the static 5-member data/party.json, while a plain Firefox with no interception showed all 6.)
// A redirect the browser follows by itself is not routed again, so every hop is COUNTED from the context's `request` events (budget.used) and RECORDED in budget.redirects; the probe fails the run
// on any API redirect. The hops of one chain are bounded by the browser (20), and the Node-side reference read refuses redirects outright (redirect: "error"). Mode "fetch" (env
// PROBE_API_ROUTE=fetch) keeps the old behaviour, which refuses a 3xx before the page sees it: for comparison only.
// WebSocket: ctx.routeWebSocket (Playwright 1.48+) decides before the socket connects to the server; over budget the page's socket is closed and nothing reaches the Worker, so a socket that
// keeps reconnecting cannot spend more than the budget.
export function createBudget(limit) {
  const b = { limit, used: 0, exceeded: false, refused: 0, redirects: [], spend(n = 1) { if (b.used + n > b.limit) { b.exceeded = true; b.refused++; return false; } b.used += n; return true; } };
  return b;
}
export async function guardContext(ctx, budget, { mode = "browser" } = {}) {
  if (mode === "fetch") {
    await ctx.route(/\/api\//, async (route) => {
      if (!budget.spend()) return route.abort("blockedbyclient");
      let res;
      try { res = await route.fetch({ maxRedirects: 0 }); } catch (e) { return route.abort("failed"); }
      if (res.status() >= 300 && res.status() < 400) { budget.redirects.push(`${res.status()} ${route.request().method()} ${route.request().url().replace(/[?#].*$/, "")} -> ${(res.headers().location || "?").replace(/[?#].*$/, "")}`); return route.abort("blockedbyclient"); }
      return route.fulfill({ response: res });
    });
  } else {
    await ctx.route(/\/api\//, (route) => (budget.spend() ? route.continue() : route.abort("blockedbyclient")));
    ctx.on("request", (r) => {
      const from = r.redirectedFrom();
      if (!from || !/\/api\//.test(r.url())) return;
      budget.spend(); // a redirect hop is a Worker request too (counted after the fact: the browser follows it by itself)
      budget.redirects.push(`${r.method()} ${from.url().replace(/[?#].*$/, "")} -> ${r.url().replace(/[?#].*$/, "")}`);
    });
  }
  await ctx.routeWebSocket(/\/api\/live/, (ws) => { if (budget.spend()) ws.connectToServer(); else ws.close({ code: 1008, reason: "request budget spent" }); });
}
