// Unit tests for guestIpKey. Made-up ip and salts only. No network, no D1, no AI.
import test from "node:test";
import assert from "node:assert/strict";
import { guestIpKey } from "../../infrastructure/worker/guest-key.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const ip = "203.0.113.7";

test("same ip and salt give the same hash", async () => {
  assert.equal(await guestIpKey(ip, "salt-one-example"), await guestIpKey(ip, "salt-one-example"));
});

test("two salts give two hashes", async () => {
  assert.notEqual(await guestIpKey(ip, "salt-one-example"), await guestIpKey(ip, "salt-two-example"));
});

test("two ips give two hashes under one salt", async () => {
  assert.notEqual(await guestIpKey(ip, "salt-one-example"), await guestIpKey("203.0.113.8", "salt-one-example"));
});

test("the legacy unsalted value differs from the salted one", async () => {
  const legacy = await sha256Hex(`guest-ask:${ip}`);
  assert.notEqual(await guestIpKey(ip, "salt-one-example"), legacy);
});

test("an unset salt falls back to the legacy unsalted value", async () => {
  const legacy = await sha256Hex(`guest-ask:${ip}`);
  assert.equal(await guestIpKey(ip, undefined), legacy);
  assert.equal(await guestIpKey(ip, ""), legacy);
});

test("output is 64 lowercase hex characters", async () => {
  assert.match(await guestIpKey(ip, "salt-one-example"), /^[0-9a-f]{64}$/);
  assert.match(await guestIpKey(ip, undefined), /^[0-9a-f]{64}$/);
});
