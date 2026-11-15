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
//   (b) secrets (best effort, named shapes): the key, Discord tokens, Bearer / sk-ant / AWS / JWT / Slack / Basic style tokens, webhook URLs, any secret-shaped env value and 15+ digit ids are screened. Ids in friend text are
//       redacted to "[id]"; a secret in the asker's own text stops the send; elsewhere in the prompt (sheet fields, sign-ups, library, persona) it is redacted and the ask goes on. The reply is checked the same way. Failing closed means the honest degraded line, never a refusal.
//   (c) pings: @everyone, @here, <@id>, <@&id> and <#id> are defanged in what is sent and in the reply (Discord posts also carry allowed_mentions none: discord.js).
//   (d) fencing: friend text stays inside the prompt-fence markers (prompt-fence.js); the fence tokens in friend text are stripped where the prompt is built.

export const NAMES_REAL = "real";
export const NAMES_TOKENISED = "tokenised";

export function researchNames(env) {
  // Exactly "real" (lowercase, no trim) reads real; anything else, including " real " and "REAL", reads tokenised (fails toward privacy).
  return env && env.RESEARCH_NAMES === NAMES_REAL ? NAMES_REAL : NAMES_TOKENISED;
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
// Best effort: named shapes, not a promise that no secret can pass. A password typed in free text ("the password is ...") is NOT reliably caught, and a short Bearer token is not.
const SECRET_NAME_RE = /TOKEN|SECRET|KEY|SALT|WEBHOOK|PASSWORD|ACCOUNT_ID|CREDENTIAL/i;
const SECRET_PATTERNS = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{6,}/],
  ["api-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  // Case-sensitive "Bearer " and a token-shaped tail: 20+ token characters that include a digit ("standard bearer responsibilities" is not a secret).
  // No pattern below may match across a line break ([ \t] and never \s between tokens): the whole prompt is scanned after its lines are screened, and a word at the end of one stored line plus a
  // token-shaped label at the start of the next must not read as one secret (it blanked the prompt for every later ask).
  ["bearer", /\bBearer[ \t]+(?=[A-Za-z0-9._~+\/=-]{0,200}\d)[A-Za-z0-9._~+\/=-]{20,}/],
  ["discord-token", /[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/],
  ["discord-mfa", /\bmfa\.[A-Za-z0-9_-]{20,}/],
  ["webhook", /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//i],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["basic-auth", /\bAuthorization:[ \t]*Basic[ \t]+[A-Za-z0-9+\/]{8,}={0,2}/i],
  // The header form is matched in any case ("authorization: bearer ..."); the bare word "Bearer" above stays case-sensitive.
  ["auth-bearer", /\bauthorization[ \t]*:[ \t]*bearer[ \t]+[A-Za-z0-9._~+\/=-]{20,}/i],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// Bare hex: 40+ hex characters with at least 12 distinct characters and at least one letter (an md5, 32 zeros or a run of digits is not a token). A hex-shaped string is REDACTED
// (never a reason to stop the send): see redactHex. It is a "secret" only for scanSecrets, which the callers run after redactHex.
const HEX_RUN_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{40,}(?![0-9A-Fa-f])/g;
const isHexToken = (m) => new Set(m.toLowerCase()).size >= 12 && /[a-fA-F]/.test(m);
export const redactHex = (text) => String(text ?? "").replace(HEX_RUN_RE, (m) => (isHexToken(m) ? "[hex]" : m));
// 15+ digits, ASCII or fullwidth (U+FF10 to U+FF19).
const FW0 = String.fromCharCode(0xff10);
const FW9 = String.fromCharCode(0xff19);
const LONG_ID_SRC = `[0-9${FW0}-${FW9}]{15,}`;
const LONG_ID_RE = new RegExp(LONG_ID_SRC, "g");
const LONG_ID_TEST = new RegExp(LONG_ID_SRC);

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
  for (const m of s.match(HEX_RUN_RE) || []) if (isHexToken(m)) { kinds.push("hex-token"); break; }
  if (ids && LONG_ID_TEST.test(s)) kinds.push("long-id");
  return kinds;
}

export const redactIds = (text) => String(text ?? "").replace(LONG_ID_RE, "[id]");

// A secret-shaped line is DROPPED whole, never partly redacted (a half-redacted webhook URL or key still leaks the rest). A line holding a private key BEGIN marker takes everything up to the
// END marker, or the rest of the text when there is none. Used on prompt parts that are not the asker's own typed text (sign-ups, the tonight title, library and persona text); sheet fields are
// dropped whole one level up (research/claude.js researchParty).
const BEGIN_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const END_KEY_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
// Bounded: a BEGIN marker takes the lines up to a matching END marker when one follows within KEY_MAX_LINES lines and before any fence line; with no such END it takes at most KEY_LOSE_LINES lines.
// A line holding a prompt fence token (<<< or >>>) is never dropped for being near a marker, and ends the skip, so a stray marker can never remove the LIBRARY or USER_QUESTION sections.
const KEY_MAX_LINES = 80;
const KEY_LOSE_LINES = 3;
const FENCE_LINE = /<<<|>>>/;
export function dropSecretLines(text, env, extra = []) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (BEGIN_KEY_RE.test(line) && !FENCE_LINE.test(line)) {
      if (END_KEY_RE.test(line)) continue; // BEGIN and END on one line: that line only
      let end = -1;
      for (let j = i + 1; j < lines.length && j <= i + KEY_MAX_LINES && !FENCE_LINE.test(lines[j]); j++) if (END_KEY_RE.test(lines[j])) { end = j; break; }
      if (end >= 0) { i = end; continue; }
      let k = 0; // no matching END: this line and at most the next KEY_LOSE_LINES lines, never a fence line
      while (k < KEY_LOSE_LINES && i + 1 < lines.length && !FENCE_LINE.test(lines[i + 1])) { i++; k++; }
      continue;
    }
    if (scanSecrets(line, env, { extra, ids: false }).length) continue;
    out.push(line);
  }
  return out.join("\n");
}

function secretError(kinds) {
  const e = new Error(`outbound secret guard: ${kinds.join(",")}`);
  e.code = "OUTBOUND_SECRET";
  return e;
}

// ---- (c) pings --------------------------------------------------------------------------------------------------------------------------------------
// Every "@everyone" / "@here" is broken whatever follows it ("@everyonelol", "@here1"), with a fullwidth at-sign, with zero-width characters or up to three spaces or newlines between the @
// and the word. The break is one zero-width space after the @, inserted IN PLACE (whitespace is kept) and only when none is there yet (idempotent). An e-mail address
// ("bob@hereford.co.uk": a letter or digit before the @ and a domain after the word) is left alone. <#id> channel links do not ping and are left alone.
const ZWSP = String.fromCharCode(0x200b);
const FW_AT = String.fromCharCode(0xff20);
const ZERO_WIDTH = `${ZWSP}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x2060)}${String.fromCharCode(0xfeff)}`;
const PING_WORD_RE = new RegExp(`(?<before>[A-Za-z0-9]?)([@${FW_AT}])(?<gap>[${ZERO_WIDTH}\\s]{0,3})(?<word>every\\s{0,3}one|here)(?<after>[A-Za-z0-9-]*\\.[A-Za-z]{2,})?`, "gi");
const HAS_ZW = new RegExp(`[${ZERO_WIDTH}]`);
export function defangPings(text) {
  return String(text ?? "")
    .replace(PING_WORD_RE, (m, before, at, gap, word, after, _off, _str, g) => {
      if (before && g.after) return m; // looks like an e-mail address
      return HAS_ZW.test(gap) ? m : `${before}${at}${ZWSP}${gap}${word}${g.after || ""}`;
    })
    .replace(/<@([!&]?)(\d+)>/g, `<${ZWSP}@$1$2>`);
}

// ---- the real-names prompt --------------------------------------------------------------------------------------------------------------------------
// `friend` lists the asker's own typed text (the question, the previous question, the earlier turns, the asker string): a key or token shape THERE stops the send. Hex-shaped strings (redactHex)
// are replaced by "[hex]" everywhere and never stop the ask. A secret-shaped line anywhere else in the prompt (sign-up, tonight title, library, persona) is dropped whole (dropSecretLines).
// Ids become "[id]" and pings are defanged in both halves; a final scan of the whole result fails closed on anything left (a shape that spans a line break). Returns { system, user }.
// Throws OUTBOUND_SECRET.
export function prepareRealPrompt({ system, user }, env, extra = [], { friend = [] } = {}) {
  const typed = scanSecrets(redactHex(friend.filter((x) => typeof x === "string").join("\n")), env, { extra, ids: false });
  if (typed.length) throw secretError([...new Set(typed)]);
  const sys = defangPings(redactIds(dropSecretLines(redactHex(system), env, extra)));
  const usr = defangPings(redactIds(dropSecretLines(redactHex(user), env, extra)));
  const left = scanSecrets(`${sys}\n${usr}`, env, { extra, ids: false });
  if (left.length) throw secretError([...new Set(left)]);
  return { system: sys, user: usr };
}

// The final-body check that runs in BOTH modes (research/claude.js beforeSend): secrets and long ids anywhere in the body, pings in friend text defanged beforehand.
export function guardSecretsInBody(bodyObject, env, extra = []) {
  const kinds = scanSecrets(JSON.stringify(bodyObject), env, { extra, ids: true });
  if (kinds.length) throw secretError([...new Set(kinds)]);
}

// Real-mode reply: null (discard, honest degraded line) when it carries a secret; otherwise pings defanged and ids redacted.
export function cleanRealReply(raw, env, extra = []) {
  const text = redactHex(raw);
  if (!text.trim()) return null;
  if (scanSecrets(text, env, { extra, ids: false }).length) return null;
  return defangPings(redactIds(text));
}
