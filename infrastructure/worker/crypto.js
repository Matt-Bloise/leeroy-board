// Small WebCrypto helpers shared by the routes. No Node APIs: they run in Workers and in Node 22 alike.
const enc = new TextEncoder();

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
// Compares two strings without returning early at the first difference; the loop always runs to the longer length.
export function timingSafeEqualStr(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}
