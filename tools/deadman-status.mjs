// Prints the dead-man state: each source's age in seconds and the open incidents, read through the signed POST /api/heartbeat/status. docs/runbooks/deadman.md.
//   node tools/deadman-status.mjs <token-file> [base-url]
// <token-file>: a file holding the Discord bot token. It is read, used to derive the heartbeat key and never printed. Exit 0 only when the Worker answered ok:true.
import { readFileSync } from "node:fs";
import { heartbeatKey, signListen } from "../infrastructure/worker/listener-config.js";

const [tokenFile, base = "https://api.leeroy.party"] = process.argv.slice(2);
if (!tokenFile) { console.error("usage: node tools/deadman-status.mjs <token-file> [base-url]"); process.exit(2); }
let token = "";
try { token = readFileSync(tokenFile, "utf8").trim(); } catch { console.error("cannot read the token file"); process.exit(2); }
const key = await heartbeatKey(token);
if (!key) { console.error("the token file does not hold a usable token"); process.exit(2); }
const body = JSON.stringify({ purpose: "heartbeat-status" });
const ts = String(Math.floor(Date.now() / 1000));
let target;
try { target = new URL(base); } catch { console.error("refusing: the base URL is not a URL"); process.exit(2); }
const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
if (target.username || target.password || !(target.protocol === "https:" || (target.protocol === "http:" && local))) { console.error("refusing: the base URL must be https (http only for localhost or 127.0.0.1) and carry no credentials"); process.exit(2); }
let res;
try { res = await fetch(`${base.replace(/\/+$/, "")}/api/heartbeat/status`, {
  method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
  headers: { "Content-Type": "application/json", "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(key, ts, body) },
  body,
}); } catch { console.error("request failed"); process.exit(1); }
let out;
try { out = JSON.parse(await res.text()); } catch { out = { error: "non-JSON answer" }; }
console.log(JSON.stringify({ status: res.status, ...out }, null, 2));
process.exit(res.status === 200 && out.ok === true ? 0 : 1);
