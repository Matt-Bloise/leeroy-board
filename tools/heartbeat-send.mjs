// Sends one signed dead-man heartbeat (POST /api/heartbeat), or one every N seconds. docs/runbooks/deadman.md.
//   node tools/heartbeat-send.mjs <token-file> [--source pc-bot|pc-session] [--base https://api.leeroy.party] [--loop N] [--seq START]
// <token-file>: a file holding the Discord bot token (the same one the Worker holds). It is read, used to derive the heartbeat key and never printed.
// --loop N: repeat every N seconds (20..3600; the Worker records at most one heartbeat per source per 20 s) until stopped. Without it: one send, exit 0 only on HTTP 200.
// Prints one status line per send (HTTP status and whether it was recorded) and nothing else. https only (http for localhost / 127.0.0.1), no redirects followed, no credentials in the URL.
import { readFileSync } from "node:fs";
import { heartbeatKey, signListen } from "../infrastructure/worker/listener-config.js";

const SOURCES = ["pc-bot", "pc-session"];
const argv = process.argv.slice(2);
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const tokenFile = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
const opt = { source: "pc-bot", base: "https://api.leeroy.party", loop: null, seq: 0 };
for (let i = tokenFile ? 1 : 0; i < argv.length; i += 2) {
  const k = argv[i], v = argv[i + 1];
  if (!["--source", "--base", "--loop", "--seq"].includes(k) || v === undefined) die(`unknown or incomplete option ${String(k).slice(0, 20)}`);
  opt[k.slice(2)] = v;
}
if (!tokenFile) die("usage: node tools/heartbeat-send.mjs <token-file> [--source pc-bot|pc-session] [--base url] [--loop N] [--seq START]");
if (!SOURCES.includes(opt.source)) die(`--source must be one of ${SOURCES.join(", ")}`);
let loopS = null;
if (opt.loop !== null) { loopS = Number(opt.loop); if (!Number.isInteger(loopS) || loopS < 20 || loopS > 3600) die("--loop must be a whole number of seconds from 20 to 3600"); }
let seq = Number(opt.seq);
if (!Number.isSafeInteger(seq) || seq < 0) die("--seq must be a non-negative integer");

let token = "";
try { token = readFileSync(tokenFile, "utf8").trim(); } catch { die("cannot read the token file"); }
const key = await heartbeatKey(token);
if (!key) die("the token file does not hold a usable token");
let target;
try { target = new URL(opt.base); } catch { die("refusing: the base URL is not a URL"); }
const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
if (target.username || target.password || !(target.protocol === "https:" || (target.protocol === "http:" && local))) die("refusing: the base URL must be https (http only for localhost or 127.0.0.1) and carry no credentials");
const url = `${opt.base.replace(/\/+$/, "")}/api/heartbeat`;

async function sendOnce() {
  const body = JSON.stringify({ purpose: "heartbeat", source: opt.source, seq: seq++ }); // exactly this shape: the Worker refuses any other signed body
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const res = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(key, ts, body) },
      body,
    });
    let out = {};
    try { out = JSON.parse(await res.text()); } catch {}
    console.log(`${new Date().toISOString()} heartbeat ${opt.source} status=${res.status} recorded=${out && out.recorded === true ? "yes" : out && out.recorded === false ? "no" : "n/a"}`);
    return res.status === 200;
  } catch {
    console.log(`${new Date().toISOString()} heartbeat ${opt.source} request failed`);
    return false;
  }
}

if (loopS === null) process.exit((await sendOnce()) ? 0 : 1);
for (;;) { await sendOnce(); await new Promise((r) => setTimeout(r, loopS * 1000)); }
