// Stamps a PR PREVIEW build with its own isolated Worker. The production sources carry no personal workers.dev host (the account subdomain carries a personal name): production talks to api.leeroy.party only.
// A preview build gets, in the staged copy only (.cloudflare-dist), three things:
//   js/brain.js   const WORKER = "<preview Worker URL>";          (the page talks to its own preview Worker; brain.js allows that one origin)
//   js/board.js   const PREVIEW_WORKER = "<preview Worker origin>"; (the same origin on the key-destination allowlist)
//   _headers      the Worker's exact https:// and wss:// origins added to connect-src of every Content-Security-Policy line (Report-Only today; nothing is tightened, one exact host is added)
// usage: node tools/preview-stamp.mjs <dist-dir> <worker-url>      (exit 1 and nothing half-written when a replacement does not apply)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const URL_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)?\.workers\.dev$/;

// -> { brain, board, headers } the three new texts, or throws. Pure.
export function stampTexts({ brain, board, headers }, workerUrl) {
  if (!URL_RE.test(String(workerUrl))) throw new Error("the Worker URL must be https://<name>[.<subdomain>].workers.dev");
  const host = workerUrl.replace(/^https:\/\//, "");
  const once = (text, re, what) => { const n = (text.match(re) || []).length; if (n !== 1) throw new Error(`${what}: found ${n} times, expected exactly once`); };
  once(brain, /const WORKER = "[^"]*";/g, "js/brain.js: the WORKER constant");
  once(board, /const PREVIEW_WORKER = "[^"]*";/g, "js/board.js: the PREVIEW_WORKER constant");
  const brain2 = brain.replace(/const WORKER = "[^"]*";/, () => `const WORKER = "${workerUrl}";`);
  const board2 = board.replace(/const PREVIEW_WORKER = "[^"]*";/, () => `const PREVIEW_WORKER = "${workerUrl}";`);
  if (!brain2.includes(`const WORKER = "${workerUrl}";`) || !board2.includes(`const PREVIEW_WORKER = "${workerUrl}";`)) throw new Error("the stamp is not present in the output");
  // Every Content-Security-Policy line with connect-src gets the exact origins right after the directive name; a line where that does not apply (connect-src followed by a tab or a semicolon) fails the build instead of staying silently unchanged.
  const want = `connect-src https://${host} wss://${host}`;
  let lines = 0;
  const headers2 = headers.split("\n").map((l) => {
    if (l.trim().startsWith("#") || !/Content-Security-Policy(-Report-Only)?:/i.test(l) || !/connect-src(?![\w-])/.test(l)) return l;
    lines++;
    const out = l.replace(/connect-src(?![\w-])/, () => want);
    if (!out.includes(want) || out === l) throw new Error("_headers: a connect-src directive was not stamped");
    return out;
  }).join("\n");
  if (lines < 1) throw new Error("_headers: no Content-Security-Policy line with connect-src");
  return { brain: brain2, board: board2, headers: headers2 };
}

export function stampDist(dir, workerUrl) {
  const f = { brain: path.join(dir, "js/brain.js"), board: path.join(dir, "js/board.js"), headers: path.join(dir, "_headers") };
  const out = stampTexts({ brain: readFileSync(f.brain, "utf8"), board: readFileSync(f.board, "utf8"), headers: readFileSync(f.headers, "utf8") }, workerUrl);
  writeFileSync(f.brain, out.brain, "utf8"); writeFileSync(f.board, out.board, "utf8"); writeFileSync(f.headers, out.headers, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { stampDist(process.argv[2], process.argv[3]); console.log("Preview build stamped (the Worker host is not printed)."); } catch (e) { console.error("::error::" + e.message); process.exit(1); }
}
