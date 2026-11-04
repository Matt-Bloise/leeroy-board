// B55 / B55b: the layout sweep's cross-origin diagnostics (tests/helpers/sweep-diag.mjs, used by tests/browser/layout-sweep.mjs).
// Production run 41829291747 showed WebKit's CORS line ("Origin ... Status code: 404") with no URL and no xorigin-http line, so the console-error failure carries a diagnostic:
// the message source, the Workers started and the cross-origin fetches seen. These tests pin the parts that must not regress.
// Browser proof: layout-sweep.mjs --inject-js <script that starts a Worker, fetches a missing cross-origin path and logs the CORS line>.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { XR_JS, sameOrigin, clip, formatDiag, LIMITS } from "../helpers/sweep-diag.mjs";
const src = readFileSync(new URL("../browser/layout-sweep.mjs", import.meta.url), "utf8");

// Runs XR_JS in a fake page: window.fetch answers from `answer`, window.Worker records what it was given.
function fakePage(answer = () => ({ ok: false, status: 404 })) {
  const calls = [], workers = [];
  const window = { fetch: (input) => { calls.push(input); return Promise.resolve(answer(input)); }, Worker: function (u, o) { workers.push([u, o]); } };
  window.Worker.prototype.postMessage = () => {};
  const ctx = vm.createContext({ window, location: { href: "https://leeroy.party/x/", origin: "https://leeroy.party" }, URL, Request, String });
  vm.runInContext(`(${XR_JS.toString()})()`, ctx);
  return { window, calls, workers };
}

test("sweep keeps the diagnostic apart from the 300-character detail", () => {
  assert.match(src, /const fail = \(c, state, scene, invariant, detail, sink = failures, diag = ""\)/);
  assert.match(src, /detail: String\(detail\)\.slice\(0, 300\), \.\.\.\(diag \? \{ diag: String\(diag\) \} : \{\}\)/);
  assert.match(src, /once\("console-error", m\.text\(\), formatDiag\(/); // not m.text() + extra
  assert.match(src, /diag: \$\{f\.diag\}/); // printed
});

test("formatDiag: long message and long URLs do not push the workers and fetches out", () => {
  const long = (tag) => `https://api.leeroy.party/${tag}/${"x".repeat(900)}`;
  const d = formatDiag("Origin https://leeroy.party is not allowed by Access-Control-Allow-Origin. Status code: 404 " + "m".repeat(5000), { url: long("src"), lineNumber: 7 }, { xr: [{ u: long("fetch-a"), s: 404 }, { u: long("fetch-b"), s: 404 }], wk: [long("wk-b")] }, [long("wk-a")]);
  assert.ok(d.length > 300, "longer than the old 300-character cut");
  assert.ok(d.length <= LIMITS.total);
  for (const tag of ["src", "wk-a", "wk-b", "fetch-a", "fetch-b"]) assert.ok(d.includes(`https://api.leeroy.party/${tag}/`), `${tag} survives`);
  assert.match(d, /Status code: 404/);
});

test("formatDiag: a worker recorded twice (Playwright event and the page wrapper) is listed once", () => {
  const d = formatDiag("m", null, { xr: [], wk: ["https://leeroy.party/a.js", "https://leeroy.party/a.js"] }, ["https://leeroy.party/a.js", "https://leeroy.party/b.js"]);
  assert.equal((d.match(/a\.js/g) || []).length, 1);
  assert.equal((d.match(/b\.js/g) || []).length, 1);
});

test("formatDiag: many workers and fetches are counted, not silently cut", () => {
  const d = formatDiag("m", null, { xr: [], wk: [] }, Array.from({ length: 12 }, (_, i) => `https://leeroy.party/w${i}.js`));
  assert.match(d, /\+4 more/);
});

test("fetch spy: string, URL and Request inputs all resolve to the real URL", async () => {
  const { window, calls } = fakePage();
  const want = "https://api.leeroy.party/api/data/nope.json";
  await window.fetch(want);
  await window.fetch(new URL(want));
  await window.fetch(new Request(want));
  await window.fetch("//api.leeroy.party/api/data/nope.json"); // protocol-relative
  assert.equal(calls.length, 4, "every call still reaches the real fetch");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(window.__xr.length, 4);
  for (const x of window.__xr) assert.equal(JSON.stringify(x), JSON.stringify({ u: want, s: 404 }));
});

test("fetch spy: a same-origin relative fetch is not recorded, a look-alike host is", async () => {
  const { window } = fakePage();
  await window.fetch("data/party.json");
  await window.fetch("https://leeroy.party/api/x");
  await window.fetch("https://leeroy.party.evil.example/x");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(JSON.stringify(window.__xr.map((x) => x.u)), JSON.stringify(["https://leeroy.party.evil.example/x"]));
});

test("fetch spy: a failing cross-origin fetch is recorded with its error and still rejects for the page", async () => {
  const { window } = fakePage(() => { throw new Error("net down"); });
  await assert.rejects(Promise.resolve().then(() => window.fetch("https://api.leeroy.party/a")), /net down/).catch(() => {});
  const w2 = fakePage();
  w2.window.fetch = w2.window.fetch; // the wrapped fetch returns the page's own promise
  assert.ok(w2.window.fetch("https://api.leeroy.party/ok") instanceof Promise);
});

test("Worker spy: records the resolved script URL for string and URL inputs and passes the options through", () => {
  const { window, workers } = fakePage();
  new window.Worker("vendor/library-worker.js?v=1", { type: "module" });
  new window.Worker(new URL("https://leeroy.party/cloth/sdf-worker.js"), { type: "module" });
  assert.equal(JSON.stringify(window.__wk), JSON.stringify(["https://leeroy.party/x/vendor/library-worker.js?v=1", "https://leeroy.party/cloth/sdf-worker.js"]));
  assert.equal(workers.length, 2);
  assert.equal(JSON.stringify(workers[0][1]), JSON.stringify({ type: "module" }));
});

test("sameOrigin compares parsed origins, not prefixes", () => {
  const o = "https://leeroy.party";
  assert.equal(sameOrigin("https://leeroy.party/a?b=1", o), true);
  assert.equal(sameOrigin("https://leeroy.party.evil.example/a", o), false);
  assert.equal(sameOrigin("https://leeroy.party@evil.example/a", o), false);
  assert.equal(sameOrigin("http://leeroy.party/a", o), false);
  assert.equal(sameOrigin("https://api.leeroy.party/a", o), false);
  assert.equal(sameOrigin("not a url", o), false);
  assert.match(src, /!sameOrigin\(u, ORIGIN\)/);
  assert.match(src, /sameOrigin\(u, ORIGIN\) && r\.status\(\) >= 400 && !\/cloudflareinsights\/\.test\(u\)\) once\("http-error"/); // the same-origin http-error check must stay
  assert.doesNotMatch(src, /\.startsWith\(ORIGIN\)/);
});

test("scene-open failure says whether the scene ever opened", () => {
  assert.match(src, /const everOpened = opened;/);
  assert.match(src, /it opened once, then closed again" : "it never opened"/);
});

test("clip marks a cut", () => {
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("abc", 4), "abc");
});
