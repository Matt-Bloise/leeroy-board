// Rate-limit key for public guest asks. Pure: no D1, no env, no network.
// The salt (the USER_SALT Worker secret) stops the stored ip_hash being reversed by enumerating IP addresses.
// A missing salt throws SaltMissingError: the caller refuses the request rather than store an unsalted hash.
// An IPv6 address is keyed by its /64 prefix: one household or one rented /64 holds 2^64 addresses, so the full address is no limit at all.
import { sha256Hex } from "./crypto.js";
import { requireSalt } from "./salts.js";

// "2001:db8:1:2:aaaa:bbbb:cccc:dddd" -> "2001:db8:1:2::/64". An IPv4-mapped address (::ffff:1.2.3.4) is the IPv4 address.
// IPv4 and anything that does not parse as IPv6 come back unchanged (trimmed, lowercase).
export function ipRateKey(ip) {
  let s = String(ip ?? "").trim().toLowerCase();
  s = s.replace(/^\[|\]$/g, "").split("%")[0]; // brackets and a zone id are not part of the address
  if (!s.includes(":")) return s;
  const mapped = /^(?:0{0,4}:){2,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  let head = s;
  let tail = "";
  const gap = s.indexOf("::");
  if (gap >= 0) {
    head = s.slice(0, gap);
    tail = s.slice(gap + 2);
    if (tail.includes("::")) return s;
  }
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (gap < 0 && h.length !== 8) return s;
  const groups = gap >= 0 ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function guestIpKey(ip, salt) {
  const s = requireSalt({ USER_SALT: salt }, "USER_SALT");
  return sha256Hex(`${s}:guest-ask:${ipRateKey(ip)}`);
}
