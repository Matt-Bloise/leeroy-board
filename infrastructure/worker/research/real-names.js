// /ask research mode (ASK_RESEARCH on): the RESEARCH_NAMES setting and the four outbound protections that stay on in BOTH modes.
//
// RESEARCH_NAMES (wrangler.toml [vars], read in research code only; not on Flagship):
//   "real"      the Claude path sends real names, sheet fields, builds and the asker's turns untokenised. The name guard and the whole-prompt name scan do not run and a name
//               never makes Claude fail over. Friends have consented (docs/privacy.md); the paid Claude API does not train on API data.
//   "tokenised" the earlier behaviour, unchanged: names become per-request tokens and the strict name guard runs (research/claude.js, privacy/*).
// The wrangler.toml value is "real". An UNSET variable reads as "tokenised" (so a deploy that lost the var behaves as before, never as a wider send), and so does any
// value that is not exactly "real" or "tokenised".
//
// The four protections (each tested in tests/unit/ask-real-names.test.mjs):
//   (a) host allow-list: friend text goes only to Anthropic's API, directly or through the AI Gateway's anthropic route; any other URL is refused before a send.
//   (b) secrets: the key, Discord tokens, Bearer / sk-ant style tokens, webhook URLs, any secret-shaped env value and 15+ digit ids never leave. Ids in friend text are
//       redacted to "[id]"; a secret anywhere stops the send. The reply is checked the same way. Failing closed means the honest degraded line, never a refusal.
//   (c) pings: @everyone, @here, <@id>, <@&id> and <#id> are defanged in what is sent and in the reply (Discord posts also carry allowed_mentions none: discord.js).
//   (d) fencing: friend text stays inside the prompt-fence markers (prompt-fence.js); the fence tokens in friend text are stripped where the prompt is built.

export const NAMES_REAL = "real";
export const NAMES_TOKENISED = "tokenised";

export function researchNames(env) {
  const v = env && typeof env.RESEARCH_NAMES === "string" ? env.RESEARCH_NAMES.trim().toLowerCase() : "";
  return v === NAMES_REAL ? NAMES_REAL : NAMES_TOKENISED;
}
export const namesAreReal = (env) => researchNames(env) === NAMES_REAL;

// ---- (a) host allow-list ----------------------------------------------------------------------------------------------------------------------------
export const ANTHROPIC_HOST = "api.anthropic.com";
export const GATEWAY_HOST = "gateway.ai.cloudflare.com";

function hostError(why) {
  const e = new Error(`outbound host refused: ${why}`); // never carries the URL
  e.code = "OUTBOUND_HOST";
  return e;
}

// Throws unless the URL is https on api.anthropic.com (path /v1/messages) or on the AI Gateway host with the anthropic route (/v1/<account>/<gateway>/anthropic/v1/messages).
export function assertAnthropicUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw hostError("unparseable"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw hostError("scheme or credentials");
  const host = u.hostname.toLowerCase();
  if (host === ANTHROPIC_HOST && u.pathname === "/v1/messages") return true;
  if (host === GATEWAY_HOST && /^\/v1\/[^/]+\/[^/]+\/anthropic\/v1\/messages$/.test(u.pathname)) return true;
  throw hostError("not Anthropic");
}

// ---- (b) secrets and ids ----------------------------------------------------------------------------------------------------------------------------
const SECRET_NAME_RE = /TOKEN|SECRET|KEY|SALT|WEBHOOK|PASSWORD|ACCOUNT_ID|CREDENTIAL/i;
const SECRET_PATTERNS = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{6,}/],
  ["api-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ["discord-token", /[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/],
  ["webhook", /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//i],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const LONG_ID_RE = /\d{15,}/g;

// Values of every secret-shaped string in env (and any extra, e.g. the key read from the Secrets Store), 8+ characters. Never logged.
function secretValues(env, extra = []) {
  const out = new Set();
  for (const k of Object.keys(env || {})) {
    if (!SECRET_NAME_RE.test(k) || /MONTHLY_TOKENS$/.test(k)) continue;
    let v;
    try { v = env[k]; } catch { continue; } // a getter that throws (a test's failing flag read) is not a secret
    if (typeof v === "string" && v.length >= 8) out.add(v);
  }
  for (const v of extra) if (typeof v === "string" && v.length >= 8) out.add(v);
  return [...out];
}

// Returns the kinds found ("env-secret", "anthropic-key", "long-id", ...); never a value. ids: also count 15+ digit runs (the body scan; friend text is redacted first).
export function scanSecrets(text, env, { extra = [], ids = true } = {}) {
  const s = String(text ?? "");
  const kinds = [];
  for (const v of secretValues(env, extra)) if (s.includes(v)) { kinds.push("env-secret"); break; }
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(s)) kinds.push(kind);
  if (ids && /\d{15,}/.test(s)) kinds.push("long-id");
  return kinds;
}

export const redactIds = (text) => String(text ?? "").replace(LONG_ID_RE, "[id]");

function secretError(kinds) {
  const e = new Error(`outbound secret guard: ${kinds.join(",")}`);
  e.code = "OUTBOUND_SECRET";
  return e;
}

// ---- (c) pings --------------------------------------------------------------------------------------------------------------------------------------
const ZWSP = "\u200b";
export function defangPings(text) {
  return String(text ?? "")
    .replace(/@(everyone|here)\b/gi, `@${ZWSP}$1`)
    .replace(/<@([!&]?)(\d+)>/g, `<${ZWSP}@$1$2>`)
    .replace(/<#(\d+)>/g, `<${ZWSP}#$1>`);
}

// ---- the real-names prompt --------------------------------------------------------------------------------------------------------------------------
// Redacts ids and defangs pings in both halves, then fails closed on a secret in either (checked on the redacted text: an id is already gone, a token is not).
// Returns { system, user }. Throws OUTBOUND_SECRET.
export function prepareRealPrompt({ system, user }, env, extra = []) {
  const kinds = scanSecrets(`${system}\n${user}`, env, { extra, ids: false }); // before redaction, so a webhook or token shape is seen whole
  const sys = defangPings(redactIds(system));
  const usr = defangPings(redactIds(user));
  kinds.push(...scanSecrets(`${sys}\n${usr}`, env, { extra, ids: false }));
  if (kinds.length) throw secretError([...new Set(kinds)]);
  return { system: sys, user: usr };
}

// The final-body check that runs in BOTH modes (research/claude.js beforeSend): secrets and long ids anywhere in the body, pings in friend text defanged beforehand.
export function guardSecretsInBody(bodyObject, env, extra = []) {
  const kinds = scanSecrets(JSON.stringify(bodyObject), env, { extra, ids: true });
  if (kinds.length) throw secretError([...new Set(kinds)]);
}

// Real-mode reply: null (discard, honest degraded line) when it carries a secret; otherwise pings defanged and ids redacted.
export function cleanRealReply(raw, env, extra = []) {
  const text = String(raw ?? "");
  if (!text.trim()) return null;
  if (scanSecrets(text, env, { extra, ids: false }).length) return null;
  return defangPings(redactIds(text));
}
