// The Worker-request budget of tests/browser/prod-probe.mjs, as a small module so a test can prove it holds (tests/browser/prod-probe-selftest.mjs).
//   const budget = createBudget(200);
//   await guardContext(ctx, budget);   // every /api request AND every /api WebSocket of this context is counted BEFORE it is sent; over budget it is refused
// HTTP: ctx.route aborts a request once the budget is spent. WebSocket: ctx.routeWebSocket (Playwright 1.48+) decides before the socket connects to the server; over
// budget the page's socket is closed and nothing reaches the Worker, so a socket that keeps reconnecting cannot spend more than the budget.
export function createBudget(limit) {
  const b = { limit, used: 0, exceeded: false, refused: 0, spend(n = 1) { if (b.used + n > b.limit) { b.exceeded = true; b.refused++; return false; } b.used += n; return true; } };
  return b;
}
export async function guardContext(ctx, budget) {
  await ctx.route(/\/api\//, (route) => { if (budget.spend()) route.continue(); else route.abort("blockedbyclient"); });
  await ctx.routeWebSocket(/\/api\/live/, (ws) => { if (budget.spend()) ws.connectToServer(); else ws.close({ code: 1008, reason: "request budget spent" }); });
}
