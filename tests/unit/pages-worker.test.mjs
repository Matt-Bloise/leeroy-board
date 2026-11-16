// The Pages Function that answers 404 for the private member data paths (pages-worker/index.js, staged as <bundle>/_worker.js/) and the path rules it shares with the bundler and the probe
// (pages-worker/private-paths.mjs). Why it exists: docs/runbooks/member-data-worker-only.md ("The stale copy"). What is pinned:
//   - every private variant answers 404 + Cache-Control: no-store with a body that says nothing, on every hostname, for every method, WITHOUT asking the asset layer;
//   - everything else is handed to env.ASSETS.fetch unchanged (the very same request, the very same response object), public data files included;
//   - the canonical form matches the bundler's isPrivatePath wherever that one says private (same file, same list, no copy), and extends it to what only a URL can carry
//     (percent-encoding, double encoding, ".." and "//" segments, a query, a trailing slash, the optional ".json");
//   - _routes.json sends exactly the private paths to the Function and nothing else (so ordinary asset requests never invoke it);
//   - a failure of the check itself is a 404, not an asset.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler, { handle, notFound } from "../../pages-worker/index.js";
import { PRIVATE_DATA_FILES, canonPath, isPrivatePath, canonRequestPath, isPrivateRequestPath, privateRoutes, MAX_DECODE_ROUNDS } from "../../pages-worker/private-paths.mjs";
import * as bundle from "../../tools/pages-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOSTS = ["https://leeroy.party", "https://www.leeroy.party", "https://leeroy-board.pages.dev", "https://3f9a1c2b.leeroy-board.pages.dev", "https://pr-12.leeroy-board.pages.dev"];
const NAMES = PRIVATE_DATA_FILES.map((f) => f.replace(/^data\//, "").replace(/\.json$/, ""));

// The fake asset layer: remembers what it was asked and answers with bytes that must never reach a visitor on a private path.
function fakeEnv(body = "STALE-PRIVATE-BYTES") {
  const calls = [];
  const response = new Response(body, { status: 200, headers: { "content-type": "application/json", etag: '"stale"', age: "31170", "cache-control": "public, max-age=300, stale-while-revalidate=3600" } });
  return { calls, response, ASSETS: { fetch: async (req) => { calls.push(req); return response; } } };
}
const req = (url, method = "GET") => ({ url, method });

// Every way found or imagined to name one of the six files. {n} is replaced by each name. A path here is what follows the host.
const PRIVATE_VARIANTS = [
  "/data/{n}.json", "/data/{n}", "/data/{n}/", "/data/{n}.json/", "/DATA/{N}.JSON", "/Data/{n}.Json", "/data/{n}.json?x=1", "/data/{n}.json?", "/data/{n}.json#frag", "/data/{n}.json?cb=1&v=2",
  "//data//{n}.json", "/data/./{n}.json", "/data/x/../{n}.json", "/data/%2e%2e/data/{n}.json", "/data/{n}.json/.", "/./data/{n}.json",
  "/%64ata/{n}.json", "/data%2F{n}.json", "/data%2f{n}%2ejson", "/data/{n}%2Ejson", "/data/{n}.json%20", "/data/{n}.json.", "/data/{n}.json ", "/data/{n}.json%00", "/data/{n}.json%09",
  "/data/{n}.json::$DATA", "/data/{n}.json;v=1", "/data/{n}.json%3Fx=1", "/data/{n}.json%23x", "/data\\{n}.json", "/data%5C{n}.json",
  "/data/./{n}", "/data/../data/{n}", "/data/.%2e/data/{n}.json",
];
// Each variant is { t: its template (the key in MEASURED_ASSET_404), p: the path }.
const variantsOf = (n) => PRIVATE_VARIANTS.map((v) => ({ t: v, p: v.replaceAll("{n}", n).replaceAll("{N}", n.toUpperCase()) })).concat([
  { t: "percent-encoded first letter", p: `/data/%${n.charCodeAt(0).toString(16)}${n.slice(1)}.json` }, // %70arty.json
  { t: "double encoding", p: `/data/${n.replace(/^./, (c) => "%25" + c.charCodeAt(0).toString(16))}.json` }, // %2570arty.json
  { t: "triple encoding", p: `/data/${n.replace(/^./, (c) => "%2525" + c.charCodeAt(0).toString(16))}.json` },
  { t: "every letter encoded", p: `/data/${[...n].map((c) => "%" + c.charCodeAt(0).toString(16)).join("")}.json` },
  { t: "full-width letters", p: `/data/${[...n].map((c) => c.replace(/[a-z]/, (x) => String.fromCharCode(x.charCodeAt(0) + 0xfee0))).join("")}.json` }, // NFKC folds them
]);

test("every private variant of every private file is recognised by the canonical request check", () => {
  let n = 0;
  for (const name of NAMES) for (const { p } of variantsOf(name)) { n++; assert.equal(isPrivateRequestPath(p), true, `${p} must be private (canon: ${canonRequestPath(p)})`); }
  assert.ok(n > 200, `${n} variants tried`);
});

// ---- Which variants can reach the Function at all (docs/runbooks/member-data-worker-only.md, "The stale copy") ----
// The Function only sees a request when a _routes.json include rule matches its path. This is the rule matcher of wrangler's `pages dev` (templates/pages-dev-util.ts isRoutingRuleMatch, wrangler 4.148.0),
// the reference implementation of the documented syntax: case-sensitive, `*` is any run of characters (slashes included) anywhere in the rule, a rule that does not end in `*` also matches with one trailing slash.
function ruleMatches(pathname, rule) {
  let r;
  if (rule === "/" || rule === "/*") r = rule;
  else if (rule.endsWith("/*")) r = `${rule.slice(0, -2)}(/*)?`;
  else if (rule.endsWith("/")) r = `${rule.slice(0, -1)}(/)?`;
  else if (rule.endsWith("*")) r = rule;
  else r = `${rule}(/)?`;
  return new RegExp(`^${r.replaceAll(/\./g, "\\.").replaceAll(/\*/g, ".*")}$`).test(pathname);
}
const routed = (pathname, routes = privateRoutes()) => routes.include.some((rule) => ruleMatches(pathname, rule)) && !routes.exclude.some((rule) => ruleMatches(pathname, rule));
// wrangler's validateRoutes (routes-validation.ts): at most 100 rules, 100 characters each, every rule starts with "/", a rule ending in "/*" may not overlap another rule of the same list.
function routesProblems(r) {
  const out = [];
  if (r.version !== 1 || !Array.isArray(r.include) || !Array.isArray(r.exclude) || !r.include.length) out.push("not a version 1 spec with at least one include rule");
  const all = [...r.include, ...r.exclude];
  if (all.length > 100) out.push("more than 100 rules");
  for (const x of all) { if (x.length > 100) out.push(`${x}: over 100 characters`); if (!x.startsWith("/")) out.push(`${x}: does not start with /`); }
  for (const list of [r.include, r.exclude]) for (const splat of list.filter((x) => x.endsWith("/*"))) for (const other of list) if (other !== splat && other.startsWith(splat.slice(0, -1))) out.push(`${splat} overlaps ${other}`);
  return out;
}
// What goes over the wire: a request target cannot hold a raw space, control character or non-ASCII character, so those travel percent-encoded (the URL parser of every client does that).
const wire = (p) => p.replace(/[\u0000-\u0020\u007f-\uffff]/gu, (c) => encodeURIComponent(c));
// Variants no include rule can express, with what the asset layer answered when they were requested on https://leeroy.party and https://leeroy-board.pages.dev (curl --path-as-is, 2026-11-16, for party.json):
// the current deployment's 404, text/html, no Age header. They matter only if the asset layer ever serves a private file under a different case or spelling; it is case-sensitive and did not.
// A 404 from one edge node is not proof for every node (the stale exact path itself answered 404 on some pages.dev nodes), which is why every class a route CAN express is routed instead of listed here.
const MEASURED_ASSET_404 = {
  "/DATA/{N}.JSON": 404, // case: rules are case-sensitive, a pattern per spelling is not possible
  "/Data/{n}.Json": 404,
  "/data/./{n}": 404, // extensionless dot-segment forms: no asset exists at the extensionless name, the stale copy is the .json one (those forms are routed by /*{n}.json*)
  "/data/../data/{n}": 404,
};

test("every variant the Function treats as private is either matched by a _routes.json include rule or listed as a measured asset-layer 404", () => {
  const uncovered = new Map();
  let routedCount = 0;
  for (const name of NAMES) for (const { t, p } of variantsOf(name)) {
    const path = wire(p.replace(/[?#].*$/, "")); // a query or fragment is not part of the route match
    if (routed(path)) { routedCount++; continue; }
    uncovered.set(t, [...(uncovered.get(t) || []), p]);
  }
  for (const [t, ps] of uncovered) assert.ok(t in MEASURED_ASSET_404, `${t} (for example ${ps[0]}) is private to the Function but no _routes.json rule matches it and no measured 404 is recorded: route it or measure it`);
  for (const t of Object.keys(MEASURED_ASSET_404)) assert.ok(uncovered.has(t), `MEASURED_ASSET_404 lists ${t} but a route now matches it: remove the entry`);
  for (const [t, st] of Object.entries(MEASURED_ASSET_404)) assert.equal(st, 404, t);
  assert.ok(routedCount > 200, `${routedCount} variants are routed`);
});

test("the stale-copy classes measured on 2026-11-16 are all routed: exact, dot segments, parent segments, backslash, a trailing slash, any percent-encoding, a suffix, //", () => {
  for (const name of NAMES) for (const p of [
    `/data/${name}.json`, `/data/./${name}.json`, `/./data/${name}.json`, `/data/x/../${name}.json`, `/data/../data/${name}.json`, "/data\\" + `${name}.json`, `/data/${name}.json/`, `//data//${name}.json`,
    `/data/%70${name.slice(1)}.json`, `/data%2F${name}.json`, `/data/${name}.json;v=1`, `/data/${name}`,
  ]) assert.equal(routed(p), true, `${p} must reach the Function`);
  // and what must NOT: ordinary assets, other public data (so the Free plan's Function allowance is not spent on them)
  for (const p of ["/", "/index.html", "/js/board.js", "/css/board.css", "/scenes/sheet.js", "/img/tavern-plate.jpg", "/data/timeline.json", "/data/stats.json", "/data/library/glossary.json", "/data/atlas/links.json", "/data/trust.json", "/data/cta.json", "/data/launch.json", "/data/sheet-vocab.json", "/fonts/alegreya-latin.woff2"]) assert.equal(routed(p), false, `${p} must not invoke the Function`);
});

test("the matcher follows the documented rule syntax (a self-check of the test's own matcher)", () => {
  assert.equal(ruleMatches("/foo", "/foo"), true);
  assert.equal(ruleMatches("/foo/", "/foo"), true, "one trailing slash is optional");
  assert.equal(ruleMatches("/foo//", "/foo"), false);
  assert.equal(ruleMatches("/Foo", "/foo"), false, "case-sensitive");
  assert.equal(ruleMatches("/foo/bar/baz", "/foo/*"), true, "a wildcard spans segments");
  assert.equal(ruleMatches("/foo", "/foo/*"), true);
  assert.equal(ruleMatches("/a/b/party.json.bak", "/*party.json*"), true);
  assert.equal(ruleMatches("/a/b/party.jso", "/*party.json*"), false);
  assert.equal(ruleMatches("/x%y", "/*%*"), true);
  assert.equal(ruleMatches("/xy", "/*%*"), false);
  assert.equal(ruleMatches("/dataXjson", "/data.json"), false, "a dot in a rule is a dot");
});

test("more encoding layers than the check unwraps are treated as private (fail closed), and a malformed escape does not throw", () => {
  let layered = "%70arty";
  for (let i = 0; i < MAX_DECODE_ROUNDS + 2; i++) layered = layered.replaceAll("%", "%25");
  assert.equal(canonRequestPath(`/data/${layered}.json`), null);
  assert.equal(isPrivateRequestPath(`/data/${layered}.json`), true);
  assert.doesNotThrow(() => canonRequestPath("/data/%E0%A4%A.json"));
  assert.doesNotThrow(() => canonRequestPath("/data/%.json"));
  assert.equal(isPrivateRequestPath("/data/%70arty%zz.json"), false, "a malformed escape is left as it is: that is not the file");
  assert.equal(isPrivateRequestPath("/data/%70arty%.json"), false);
  assert.equal(isPrivateRequestPath("/data/%zz%70arty.json"), false);
  assert.equal(isPrivateRequestPath(undefined), false);
});

test("public and look-alike paths are not private", () => {
  for (const p of ["/", "/index.html", "/data", "/data/", "/data/timeline.json", "/data/stats.json", "/data/launch.json", "/data/library/glossary.json", "/data/library/classes.json", "/data/atlas/links.json",
    "/data/atlas/party.json", "/data/library/party.json", "/data/partyx.json", "/data/xparty.json", "/data/party.json.bak", "/data/party.jsonx", "/js/party.json", "/party.json", "/data/party/x.json", "/img/party.json",
    "/data/party-notes.json", "/data/clients.json", "/data/decides.json", "/data/signup.json"]) assert.equal(isPrivateRequestPath(p), false, `${p} is public`);
});

test("canonical form: parity with the bundler's isPrivatePath (the same list, no second copy)", () => {
  assert.equal(bundle.PRIVATE_DATA_FILES, PRIVATE_DATA_FILES, "the bundler re-exports the very same list");
  assert.equal(bundle.isPrivatePath, isPrivatePath);
  assert.equal(bundle.canonPath, canonPath);
  // wherever the repo-relative check says private, the request check says private for the same path with a leading slash, with and without the query and the extension
  const table = [];
  for (const rel of PRIVATE_DATA_FILES) for (const v of [rel, rel.toUpperCase(), rel.replace(/^data/, "Data").replace(/json$/, "JSON"), rel + ".", rel + " ", rel + "::$DATA", "./" + rel]) table.push(v);
  for (const v of table) {
    assert.equal(isPrivatePath(v), true, `isPrivatePath ${v}`);
    assert.equal(isPrivateRequestPath("/" + v), true, `isPrivateRequestPath /${v}`);
    assert.equal(isPrivateRequestPath("/" + v + "?x=1"), true, `isPrivateRequestPath /${v}?x=1`);
  }
  // and the other way round on the public side: everything the bundler publishes (every file of the repo's data folder that is not private) is public to the request check as well
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const published = walk(path.join(root, "data")).map((f) => path.relative(root, f).split(path.sep).join("/")).filter((rel) => !isPrivatePath(rel));
  assert.ok(published.length > 20, `${published.length} published data files`);
  for (const rel of published) assert.equal(isPrivateRequestPath("/" + rel), false, `/${rel} is published and must pass through`);
});

test("the Function source holds no list of its own (the one list is in private-paths.mjs)", () => {
  for (const f of ["pages-worker/index.js", "tools/pages-bundle.mjs"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const rel of PRIVATE_DATA_FILES) assert.ok(!src.includes(`"${rel}"`), `${f} must not spell out the string "${rel}" (a second list)`);
  }
});

test("a private path answers 404, no-store, no body leakage, on every hostname and method, without asking the asset layer", async () => {
  let tried = 0;
  for (const host of HOSTS) for (const name of NAMES) for (const method of ["GET", "HEAD", "POST", "OPTIONS", "PUT", "DELETE"]) for (const v of ["/data/{n}.json", "/data/{n}", "/data/{n}.json?cb=7", "/DATA/{N}.JSON", "/data%2F{n}.json", "//data//{n}.json/"]) {
    const env = fakeEnv();
    const p = v.replaceAll("{n}", name).replaceAll("{N}", name.toUpperCase());
    const res = await handle(req(host + p, method), env);
    tried++;
    assert.equal(res.status, 404, `${method} ${host}${p}`);
    assert.equal(res.headers.get("cache-control"), "no-store", `${method} ${host}${p}`);
    assert.equal(env.calls.length, 0, `${method} ${host}${p}: the asset layer must not be asked`);
    for (const h of ["etag", "age", "last-modified", "content-length"]) assert.equal(res.headers.get(h), null, `${h} must not be set`);
    assert.ok(!/json/i.test(res.headers.get("content-type")), "not a JSON answer");
    const text = await res.text();
    assert.equal(text, method === "HEAD" ? "" : "Not found\n", "the body says nothing");
    assert.ok(!text.includes("STALE"), "no byte of the asset layer's answer");
  }
  assert.ok(tried > 1000, `${tried} requests`);
});

test("everything else is handed to the assets unchanged: the same request in, the same response object out", async () => {
  for (const p of ["/", "/index.html", "/data/timeline.json", "/data/library/glossary.json", "/data/library/classes.json", "/data/atlas/links.json", "/data/atlas/party.json", "/js/brain.js?v=abc", "/img/x.png", "/data/partyx.json", "/data/party.json.bak"]) {
    for (const method of ["GET", "HEAD"]) {
      const env = fakeEnv("PUBLIC-BYTES");
      const r = req("https://leeroy.party" + p, method);
      const res = await handle(r, env);
      assert.equal(env.calls.length, 1, p);
      assert.equal(env.calls[0], r, `${p}: the very same request object`);
      assert.equal(res, env.response, `${p}: the very same response object`);
      assert.equal(res.headers.get("etag"), '"stale"', "headers untouched");
      assert.equal(await res.text(), "PUBLIC-BYTES");
    }
  }
});

test("a failure of the check itself is a 404, never an asset", async () => {
  const env = fakeEnv();
  const broken = { get url() { throw new Error("boom"); }, method: "GET" };
  const res = await handle(broken, env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(env.calls.length, 0);
  const notAUrl = await handle(req("not a url"), fakeEnv());
  assert.equal(notAUrl.status, 404);
});

test("the module's default export is the Pages Worker (fetch handler) and notFound() is a plain 404 for a missing request too", async () => {
  assert.equal(typeof handler.fetch, "function");
  const env = fakeEnv();
  const res = await handler.fetch(req("https://leeroy.party/data/party.json"), env);
  assert.equal(res.status, 404);
  assert.equal((await notFound()).status, 404);
});

test("_routes.json: the literal paths, the file-name wildcard and the percent class per private file; valid for wrangler; no catch-all", () => {
  const r = privateRoutes();
  assert.deepEqual(routesProblems(r), [], "the spec wrangler pages deploy validates");
  assert.deepEqual(r.exclude, []);
  const expected = PRIVATE_DATA_FILES.flatMap((f) => ["/" + f, "/" + f.replace(/\.json$/, ""), `/*${f.replace(/^data\//, "")}*`]).concat(["/*%*"]);
  assert.deepEqual([...r.include].sort(), expected.sort());
  assert.ok(!r.include.includes("/*") && !r.include.includes("/data/*") && !r.include.some((x) => x.endsWith("/*")), "no catch-all and no /data/*: public data files and assets never invoke the Function");
  for (const f of PRIVATE_DATA_FILES) for (const lit of ["/" + f, "/" + f.replace(/\.json$/, "")]) assert.ok(r.include.includes(lit), `${lit}: the literal path stays a rule of its own (certain to be understood even if wildcards were not)`);
  assert.deepEqual(routesProblems({ version: 1, include: ["/data/*", "/data/party.json"], exclude: [] }), ["/data/* overlaps /data/party.json"], "the self-check of routesProblems: wrangler refuses a /* rule next to a rule it covers");
  assert.ok(routesProblems({ version: 1, include: [], exclude: [] }).length > 0);
  assert.ok(routesProblems({ version: 1, include: ["data/x"], exclude: [] }).length > 0);
});

test("the wildcard rules cost nothing for the files the site really requests, except a public sample that shares a private file's name", () => {
  // every static path a visit was measured to request (first load and all 13 scenes, local fixture, 2026-11-16) plus the library and atlas files the code fetches
  const requested = ["/data/cta.json", "/data/trust.json", "/data/sheet-vocab.json", "/data/launch.json", "/data/stats.json", "/data/timeline.json", "/data/actions.json", "/data/foley.json", "/data/library/index.json", "/data/library/glossary.json",
    "/data/library/classes.json", "/data/atlas/marks.json", "/data/atlas/links.json", "/data/library/news.json", "/data/library/refresh.json"];
  for (const p of requested) assert.equal(routed(p), false, `${p} invokes the Function`);
  const sharing = ["/data/sample/party.json", "/data/sample/signups.json"];
  for (const p of sharing) assert.equal(routed(p), true, `${p}: the public sample shares a private file's name, so it is routed and handed through unchanged`);
  for (const p of sharing) assert.equal(isPrivateRequestPath(p), false, `${p} is public: the Function passes it to the assets`);
});

test("Cloudflare Pages: the repo has no functions/ folder next to the Pages Function (wrangler would build it as well and the two would conflict)", () => {
  for (const d of ["functions", "infrastructure/functions", "_worker.js", "_routes.json"]) assert.equal(fs.existsSync(path.join(root, d)), false, `${d} must not exist in the repository root: the bundler stages _worker.js and _routes.json`);
});
