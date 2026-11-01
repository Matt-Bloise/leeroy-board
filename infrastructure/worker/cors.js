// CORS that fails closed. The allow list is ALLOWED_ORIGINS; an empty or missing list allows no browser origin, and a "*"
// entry is dropped rather than honoured. A request with no Origin header (curl, the bot, a same-origin load) carries no
// browser authority and passes without an Allow-Origin header.
export function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter((s) => s && s !== "*" && /^https?:\/\/[^/\s]+$/.test(s)));
}

// { ok, origin }: ok is false for an Origin that is not on the list.
export function originVerdict(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return { ok: true, origin: null };
  return { ok: allowedOrigins(env).has(origin), origin };
}

export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match, If-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Access-Control-Max-Age": "600",
  };
}
