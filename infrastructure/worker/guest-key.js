// Rate-limit key for public guest asks. Pure: no D1, no env, no network.
// The salt (the USER_SALT Worker secret) stops the stored ip_hash being reversed by enumerating IP addresses.
// A missing salt throws SaltMissingError: the caller refuses the request rather than store an unsalted hash.
import { sha256Hex } from "./crypto.js";
import { requireSalt } from "./salts.js";

export function guestIpKey(ip, salt) {
  const s = requireSalt({ USER_SALT: salt }, "USER_SALT");
  return sha256Hex(`${s}:guest-ask:${ip}`);
}
