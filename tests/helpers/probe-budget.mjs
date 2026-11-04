// The Worker-request budget of tests/browser/prod-probe.mjs, as a small module so a test can prove it holds (tests/browser/prod-probe-selftest.mjs).
//   const budget = createBudget(200);
//   await guardContext(ctx, budget);   // every /api request, every redirect and every /api WebSocket of this context is counted BEFORE it is sent; over budget it is refused
// HTTP: ctx.route takes each /api request over and sends it itself with route.fetch({ maxRedirects: 0 }), so the browser never follows a redirect on its own (a redirect
// chain would otherwise reach the Worker many times for one counted request: measured 26 server hits for 1 counted). A 3xx answer is REFUSED (the page's request is aborted)
// and recorded in budget.redirects; the probe fails the run on any. WebSocket: ctx.routeWebSocket (Playwright 1.48+) decides before the socket connects to the server;
// over budget the page's socket is closed and nothing reaches the Worker, so a socket that keeps reconnecting cannot spend more than the budget.
export function createBudget(limit) {
  const b = { limit, used: 0, exceeded: false, refused: 0, redirects: [], spend(n = 1) { if (b.used + n > b.limit) { b.exceeded = true; b.refused++; return false; } b.used += n; return true; } };
  return b;
}
export async function guardContext(ctx, budget) {
  await ctx.route(/\/api\//, async (route) => {
    if (!budget.spend()) return route.abort("blockedbyclient");
    let res;
    try { res = await route.fetch({ maxRedirects: 0 }); } catch (e) { return route.abort("failed"); }
    if (res.status() >= 300 && res.status() < 400) { budget.redirects.push(`${res.status()} ${route.request().method()} ${route.request().url().replace(/[?#].*$/, "")} -> ${(res.headers().location || "?").replace(/[?#].*$/, "")}`); return route.abort("blockedbyclient"); }
    return route.fulfill({ response: res });
  });
  await ctx.routeWebSocket(/\/api\/live/, (ws) => { if (budget.spend()) ws.connectToServer(); else ws.close({ code: 1008, reason: "request budget spent" }); });
}
