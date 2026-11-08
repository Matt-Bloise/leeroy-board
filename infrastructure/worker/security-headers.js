// Security response headers for the API (api.leeroy.party serves JSON only; no route returns HTML).
// CORP is deliberately cross-origin: the site at leeroy.party fetches this API cross-origin.
export const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

// Adds the headers to any response. Websocket upgrades (status 101) are returned untouched so the handshake is never rebuilt.
export function withSecurityHeaders(resp) {
  if (!resp || resp.status === 101 || resp.webSocket) return resp;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) resp.headers.set(k, v);
    return resp;
  } catch (e) {
    // Immutable headers (a response relayed from fetch or a Durable Object): rebuild with a mutable copy.
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }
}
