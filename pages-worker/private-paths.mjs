// The ONE definition of which data paths are private member data, shared by three things that must never disagree:
//   - tools/pages-bundle.mjs (what the staged Pages bundle leaves out, and the final assertion), tools/static-server.mjs, tools/pages-prune.mjs
//   - pages-worker/index.js (the Pages Function that answers 404 for these paths on every hostname, whatever an edge cache still holds)
//   - tests/browser/prod-probe.mjs (the production check that none of them answers 200)
// Pure: no node: imports, no I/O, so it runs unchanged inside the Cloudflare Pages Worker (the bundler copies this whole folder to <bundle>/_worker.js/).
// docs/runbooks/member-data-worker-only.md

// Repo-relative, forward-slash paths that must never be published. party/decide/tonight/guided-atlas/client are the five documents public-party.js
// MEMBER_DOCS projects ("client" carries the classes and races at the table: the same facts by elimination), plus signups (who is on, with their RSVP and
// meeting choice: read from the Worker only).
export const PRIVATE_DATA_FILES = Object.freeze(["data/party.json", "data/decide.json", "data/tonight.json", "data/guided-atlas.json", "data/client.json", "data/signups.json"]);

const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.?\//, "");

// The form a repo-relative path is compared in. A Windows or macOS file system (the local static server) opens "Data/PARTY.json", "data/party.json." and "data/party.json::$DATA" as the same file,
// so the comparison ignores case, trailing dots and spaces, and an NTFS stream suffix. The deploy (Linux) is case-sensitive; the stricter local rule can only hide more.
export const canonPath = (rel) => norm(rel).replace(/::.*$/, "").replace(/[. ]+$/, "").toLowerCase();
export const isPrivatePath = (rel) => PRIVATE_DATA_FILES.includes(canonPath(rel));

// What a REQUEST path is compared in (a URL pathname as the Worker sees it, with or without a query). Everything that could make a server, a CDN or a file system open the
// same file is folded away, and anything that only over-blocks is accepted: this list guards a 404, so a wrong "private" costs a 404 on a path that has no file anyway.
//   - query and fragment cut off (before and after decoding: "%3f" is decoded and cut too), percent-decoding repeated until it settles (double encoding), NFKC (full-width letters)
//   - backslash is a slash, control characters (NUL, tab, newline) are dropped, empty and "." segments vanish, ".." pops a segment (encoded dots are decoded first)
//   - per segment: path parameter (";x") and NTFS stream ("::$DATA") cut, trailing dots and spaces cut, lower case
//   - the ".json" extension is optional and a trailing slash is ignored
// Returns the canonical path without a leading slash, or null when decoding never settles (more than MAX_DECODE_ROUNDS layers: treated as private by isPrivateRequestPath).
export const MAX_DECODE_ROUNDS = 5;
function decodeOnce(s) {
  try { return decodeURIComponent(s); }
  catch { return s.replace(/%([0-9a-f]{2})/gi, (m, h) => { const n = parseInt(h, 16); return n < 0x80 ? String.fromCharCode(n) : m; }); } // malformed sequence: decode the ASCII bytes that are valid
}
export function canonRequestPath(input) {
  let s = String(input).replace(/[?#][\s\S]*$/, "");
  for (let round = 0; ; round++) {
    const d = decodeOnce(s);
    if (d === s) break;
    if (round >= MAX_DECODE_ROUNDS) return null;
    s = d;
  }
  s = s.normalize("NFKC").replace(/[?#][\s\S]*$/, "").replace(/\\/g, "/").replace(/[\u0000-\u001f\u007f]/g, "");
  const out = [];
  for (const raw of s.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") { out.pop(); continue; }
    const seg = raw.replace(/;.*$/, "").replace(/::.*$/, "").replace(/[. ]+$/, "").toLowerCase();
    if (seg !== "") out.push(seg);
  }
  return out.join("/");
}

const REQUEST_FORMS = new Set(PRIVATE_DATA_FILES.flatMap((f) => [f, f.replace(/\.json$/, "")]));
export const isPrivateRequestPath = (input) => { const c = canonRequestPath(input); return c === null || REQUEST_FORMS.has(c); };

// The Pages routing file (_routes.json): the Function runs only for these routes, every other request is a static asset request that never invokes it (free and unlimited).
// Rule syntax (wrangler's reference implementation, templates/pages-dev-util.ts isRoutingRuleMatch, which runs `pages dev`): matched against the URL pathname (no query, no fragment), case-SENSITIVE,
// `*` is any run of characters (slashes too) anywhere in the rule, and a rule that does not end in `*` also matches with one trailing slash. Limits (wrangler validateRoutes): at most 100 rules, 100
// characters each, every rule starts with "/", and a rule ending in "/*" may not overlap another rule. Per private file, three rules:
//   /data/party.json   /data/party   the literal paths (what a plain request names)
//   /*party.json*      any path that contains the file name followed by anything: "/data/./party.json", "/data/x/../party.json", "/data\party.json", "//data//party.json", "/data/party.json;v=1".
//                      The edge was measured serving the stale copy for the dot-segment and backslash forms (docs/runbooks/member-data-worker-only.md), so the route must catch them even if routing
//                      sees the raw path. A public file such as data/sample/party.json also matches: the Function hands it to the assets unchanged (one extra invocation, same answer).
// and one rule for the whole class of percent-encoded paths:
//   /*%*               any path that contains a "%": "/data/%70arty.json", "/data%2Fparty.json", "/%64ata/...", double encodings. No shipped file has a "%" in its name, so real traffic never matches.
// What a route cannot express: a different CASE ("/DATA/PARTY.JSON"): rules are case-sensitive and a case-insensitive pattern needs one rule per spelling. Those are left to the asset layer, which is
// case-sensitive and was measured to 404 them (tests/unit/pages-worker.test.mjs, MEASURED_ASSET_404). A "/data/*" rule would add every public data file (2 to 6 static requests per cold visit, measured)
// and, ending in "/*", could not coexist with other /data/ rules.
export function privateRoutes() {
  const include = [];
  for (const f of PRIVATE_DATA_FILES) include.push("/" + f, "/" + f.replace(/\.json$/, ""), `/*${f.replace(/^data\//, "")}*`);
  include.push("/*%*");
  return { version: 1, include, exclude: [] };
}
