// Rate-limit key for public guest asks. Pure: no D1, no env, no network.
// With a salt the stored ip_hash cannot be reversed by enumerating IP addresses.
// Without a salt it falls back to the legacy unsalted form so a missing secret never breaks the limiter.
import { sha256Hex } from "./crypto.js";

export function guestIpKey(ip, salt) {
  const hasSalt = salt !== undefined && salt !== null && String(salt) !== "";
  return sha256Hex(hasSalt ? `${salt}:guest-ask:${ip}` : `guest-ask:${ip}`);
}
