// Signs and sends the production Claude self-test (POST /api/selftest/claude). docs/runbooks/claude-selftest.md.
//   node tools/claude-selftest.mjs <token-file> [base-url]
// <token-file>: a file holding the Discord bot token (the same one the Worker holds). It is read, used to derive the signing key and never printed.
// base-url: default https://api.leeroy.party. Prints the JSON the Worker answers; exit 0 only when it said ok:true.
import { readFileSync } from "node:fs";
import { listenerKey, signListen } from "../infrastructure/worker/listener-config.js";

const [tokenFile, base = "https://api.leeroy.party"] = process.argv.slice(2);
if (!tokenFile) { console.error("usage: node tools/claude-selftest.mjs <token-file> [base-url]"); process.exit(2); }
let token = "";
try { token = readFileSync(tokenFile, "utf8").trim(); } catch { console.error("cannot read the token file"); process.exit(2); }
const key = await listenerKey(token);
if (!key) { console.error("the token file does not hold a usable token"); process.exit(2); }
const body = JSON.stringify({ selftest: "claude" });
const ts = String(Math.floor(Date.now() / 1000));
const res = await fetch(`${base.replace(/\/+$/, "")}/api/selftest/claude`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(key, ts, body) },
  body,
});
const text = await res.text();
let out;
try { out = JSON.parse(text); } catch { out = { error: "non-JSON answer" }; }
console.log(JSON.stringify({ status: res.status, ...out }, null, 2));
process.exit(res.status === 200 && out.ok === true ? 0 : 1);
