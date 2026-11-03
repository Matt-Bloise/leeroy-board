// h() in js/board.js drops unsafe href/src from data. This runs the real filter lines (SAFE_URL, IMG_DATA, okSrc) from board.js against hostile and legitimate values,
// with the real js/crest.js providing the one svg exception (the board's own crest medallions, matched exactly).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const board = fs.readFileSync(path.join(root, "js/board.js"), "utf8");
const crest = fs.readFileSync(path.join(root, "js/crest.js"), "utf8");
const lines = board.split("\n").filter((l) => /^const (SAFE_URL|IMG_DATA|ownSvg|okSrc) =/.test(l));
assert.equal(lines.length, 4, "the four filter lines are still in js/board.js");
const win = {}; vm.runInNewContext(crest, { window: win, document: undefined }); // crest.js only needs window
const ctx = { window: win }; vm.createContext(ctx);
vm.runInContext(`${lines.join("\n")}\nglobalThis.okSrc = okSrc;`, ctx);
const ok = (tag, k, v) => ctx.okSrc(tag, k, v);

test("links: http(s), absolute path, hash and folder-relative values pass", () => {
  for (const v of ["https://discord.com/channels/1/2/3", "http://127.0.0.1:8787/x", "/library/x", "#five", "data/party.json", "img/crests/mage.png", "../x/y"]) assert.equal(ok("a", "href", v), true, v);
});
test("links: javascript:, vbscript:, data:, protocol-relative and bare values are dropped", () => {
  for (const v of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "vbscript:x", "data:text/html,<script>1</script>", "data:image/svg+xml,%3Csvg%2F%3E", "data:image/png;base64,AAAA",
    "//evil.example/x", "///evil.example", "/\\evil.example/x", "http:evil", "x.png", ""]) assert.equal(ok("a", "href", v), false, JSON.stringify(v));
});
test("img/source src: a base64 png, webp, jpeg or gif is allowed; nothing else with data:", () => {
  for (const t of ["png", "webp", "jpeg", "gif"]) for (const tag of ["img", "source"]) assert.equal(ok(tag, "src", `data:image/${t};base64,iVBORw0KGgo=`), true, `${tag} ${t}`);
  for (const v of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/svg+xml,%3Csvg%20onload%3D%22alert(1)%22%2F%3E", "data:image/png,rawbytes", "data:text/html;base64,PHNjcmlwdD4=", "data:image/png;base64,AA AA", "data:image/png;base64,AAAA\"onerror=\"x", "javascript:alert(1)"])
    assert.equal(ok("img", "src", v), false, v);
});
test("a data: picture is never allowed on a link, a script or an iframe", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  for (const [tag, k] of [["a", "href"], ["a", "src"], ["script", "src"], ["iframe", "src"], ["embed", "src"], ["img", "href"], ["source", "href"]]) assert.equal(ok(tag, k, png), false, `${tag}.${k}`);
});
test("the board's own crest medallions pass on <img src> and <image href>, and only those exact strings", () => {
  const keys = [...win.BoardCrest.CLASS_KEYS, "zz-unknown-class"];
  for (const k of keys) { const f = win.BoardCrest.fallback(k); assert.equal(ok("img", "src", f), true, `img ${k}`); assert.equal(ok("image", "href", f), true, `image ${k}`); assert.equal(ok("a", "href", f), false, `a ${k}`); assert.equal(ok("script", "src", f), false, `script ${k}`); }
  const f = win.BoardCrest.fallback("mage");
  for (const v of [`${f}%20`, f.replace("%3Csvg", "%3Csvg%20onload%3D%22x%22"), f + "x", f.slice(0, -3), "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')]) assert.equal(ok("img", "src", v), false, v.slice(0, 60));
});
test("crest.js: isOwn rejects non-strings and other data: types", () => {
  for (const v of [null, undefined, 5, {}, "", "data:text/html,x", "data:image/svg+xml,"]) assert.equal(win.BoardCrest.isOwn(v), false, String(v));
});
