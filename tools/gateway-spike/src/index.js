// Throwaway Worker entry for the gateway spike. Routes /spike/* to one named Durable Object. No other bindings, no D1, no production secrets.
export { GatewayDO } from "./gateway-do.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/spike/")) return new Response("gateway spike", { status: 404 });
    const stub = env.GATEWAY.get(env.GATEWAY.idFromName("spike"));
    return stub.fetch(request);
  },
};
