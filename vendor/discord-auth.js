/* Discord sign-in for the Activity (2026-10-31). The participants list needs an authorised session (SDK code 4006 without one):
   authorize -> POST /api/token on leeroy-brain (the Worker holds the client secret and returns only { access_token }) -> authenticate.
   Loaded lazily by startDiscordPresence in js/board.js, only inside the Activity frame; the web visitor never imports it.
   The token is handed straight to authenticate and kept nowhere: not stored, not logged, not returned. Resolves true or false,
   never throws. The relative /api path is mapped to the Worker by the Developer Portal URL Mapping, like js/brain.js. */
const CLIENT_ID = "1561857940174938114";
export async function signIn(sdk, doFetch) {
  try {
    const send = doFetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!send || !sdk || !sdk.commands || typeof sdk.commands.authorize !== "function") return false;
    const { code } = await sdk.commands.authorize({ client_id: CLIENT_ID, response_type: "code", state: "", prompt: "none", scope: ["identify"] });
    if (typeof code !== "string" || !code) return false;
    const r = await send("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!r.ok) return false;
    const t = await r.json();
    if (!t || typeof t.access_token !== "string") return false;
    return Boolean(await sdk.commands.authenticate({ access_token: t.access_token }));
  } catch (e) { return false; }
}
