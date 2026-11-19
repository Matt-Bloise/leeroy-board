// Signs and sends one shadow-compare call (POST /api/shadow/ask). docs/runbooks/shadow-ask.md.
//   node tools/shadow-ask.mjs <token-file> [--question "text"] [--as <roster-slug>] [--local-answer-file <file>] [--base https://api.leeroy.party]
// <token-file>: a file holding the Discord bot token (the same one the Worker holds). It is read, used to derive the signing key and never printed.
// The question comes from --question, or from stdin when that is not given. --as names a roster slug (the run then uses that member's build and group memory); without it the run has no build.
// --local-answer-file: the local bot's answer to the same question, stored beside the Worker's for the comparison (cut to 1500 characters).
// --base: default https://api.leeroy.party; https only (http only for localhost or 127.0.0.1), no credentials in the URL.
// Prints the JSON the Worker answers (with http_status added) plus a one-line timing verdict. Exit 0 only when the Worker said ok:true (status answered).
import { readFileSync } from "node:fs";
import { listenerKey, signListen } from "../infrastructure/worker/listener-config.js";
import { MAX_QUESTION_CHARS } from "../infrastructure/worker/limits.js";

const HARD_END_MS = 22000; // the ask's hard end: 26 s deadline minus the 4 s margin (research/no-wall.js hardEndMs)
const LOCAL_CHARS = 1500;
const BODY_MAX = 4096;
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const argv = process.argv.slice(2);
let tokenFile = null, question = null, as = null, localFile = null, base = "https://api.leeroy.party";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { if (i + 1 >= argv.length) die(`missing value for ${a}`); return argv[++i]; };
  if (a === "--question") question = val();
  else if (a === "--as") as = val();
  else if (a === "--local-answer-file") localFile = val();
  else if (a === "--base") base = val();
  else if (a.startsWith("--")) die(`unknown option ${a}`);
  else if (tokenFile === null) tokenFile = a;
  else die("usage: node tools/shadow-ask.mjs <token-file> [--question text] [--as slug] [--local-answer-file file] [--base url]");
}
if (!tokenFile) die("usage: node tools/shadow-ask.mjs <token-file> [--question text] [--as slug] [--local-answer-file file] [--base url]");
let target;
try { target = new URL(base); } catch { die("refusing: the base URL is not a URL"); }
const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
if (target.username || target.password || !(target.protocol === "https:" || (target.protocol === "http:" && local))) die("refusing: the base URL must be https (http only for localhost or 127.0.0.1) and carry no credentials");
let token = "";
try { token = readFileSync(tokenFile, "utf8").trim(); } catch { die("cannot read the token file"); }
const key = await listenerKey(token);
if (!key) die("the token file does not hold a usable token");
if (question === null) {
  if (process.stdin.isTTY) die("no question: pass --question or pipe the question on stdin");
  try { question = readFileSync(0, "utf8"); } catch { question = ""; }
}
question = String(question).trim();
if (!question) die("no question");
if (Array.from(question).length > MAX_QUESTION_CHARS) die(`the question is over ${MAX_QUESTION_CHARS} characters`);
const payload = { purpose: "shadow-ask", question };
if (as) payload.as = as;
if (localFile) {
  let text = "";
  try { text = readFileSync(localFile, "utf8").trim(); } catch { die("cannot read the local answer file"); }
  if (text) payload.local_answer = Array.from(text).slice(0, LOCAL_CHARS).join("");
}
const body = JSON.stringify(payload); // exactly these keys: the Worker refuses any other signed body
if (Buffer.byteLength(body) > BODY_MAX) die("refusing: the body is over 4 KB (shorten the question or the local answer)");
const ts = String(Math.floor(Date.now() / 1000));
let res;
const t0 = Date.now();
try { res = await fetch(`${base.replace(/\/+$/, "")}/api/shadow/ask`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Listen-Timestamp": ts, "X-Listen-Signature": await signListen(key, ts, body) },
  body,
}); } catch { die("request failed", 1); }
const wallMs = Date.now() - t0;
const text = await res.text();
let out;
try { out = JSON.parse(text); } catch { out = { error: "non-JSON answer" }; }
console.log(JSON.stringify({ http_status: res.status, ...out }, null, 2)); // the Worker's own "status" (answered, degraded, ...) stays as it is
if (Number.isFinite(out.latency_ms)) {
  const s = (out.latency_ms / 1000).toFixed(1);
  console.log(out.latency_ms < HARD_END_MS
    ? `timing: compose ${s} s (round trip ${(wallMs / 1000).toFixed(1)} s): within the ask hard end (under 22 s)`
    : `timing: compose ${s} s (round trip ${(wallMs / 1000).toFixed(1)} s): over the ask hard end (22 s); a real /ask would have answered with the degraded line`);
}
process.exit(res.status === 200 && out.ok === true ? 0 : 1);
