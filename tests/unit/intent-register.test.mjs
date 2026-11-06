// Slice 0: docs/cinematic/intent.json is the intent register for the table (home board) and the Next steps scene.
// Static checks always run. The coverage check opens both views in Chromium at 390x844 (static server, no API, no network beyond 127.0.0.1)
// and fails if a visible region or visible text, image or control has no entry. It is skipped, with a printed reason, when no Chromium is installed
// (the CI unit job installs the npm packages but not the browser): run it locally with `node --test tests/unit/intent-register.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reg = JSON.parse(fs.readFileSync(path.join(root, "docs/cinematic/intent.json"), "utf8"));
const TIERS = ["hero", "context", "periphery"];
const css = fs.readdirSync(path.join(root, "css")).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(root, "css", f), "utf8")).join("\n")
  + fs.readdirSync(path.join(root, "scenes")).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(root, "scenes", f), "utf8")).join("\n");

test("the register has both views, and every entry states an intent, a tier and its motions", () => {
  assert.deepEqual(Object.keys(reg.views).sort(), ["next-steps", "table"]);
  const ids = new Set();
  for (const [view, v] of Object.entries(reg.views)) {
    assert.ok(v.describe && v.entries.length > 0, view);
    for (const e of v.entries) {
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`); ids.add(e.id);
      assert.ok(Array.isArray(e.selector) && e.selector.length > 0 && e.selector.every((s) => typeof s === "string" && s), `${e.id}: selector`);
      assert.ok(typeof e.intent === "string" && e.intent.trim().length >= 12, `${e.id}: intent`);
      assert.ok(TIERS.includes(e.tier), `${e.id}: tier`);
      assert.ok(Array.isArray(e.motion), `${e.id}: motion list`);
      for (const m of e.motion) for (const k of ["name", "trigger", "purpose", "reducedMotion"]) assert.ok(typeof m[k] === "string" && m[k].trim(), `${e.id}: motion ${m.name} needs ${k}`);
    }
  }
});
test("a view has no more than three hero entries", () => {
  for (const [view, v] of Object.entries(reg.views)) assert.ok(v.entries.filter((e) => e.tier === "hero").length <= 3, view);
});
test("every named keyframe motion exists in the stylesheets", () => {
  for (const v of Object.values(reg.views)) for (const e of v.entries) for (const m of e.motion) {
    for (const k of m.name.split("+").map((s) => s.trim()).filter((s) => /^[a-z][\w-]*$/.test(s))) if (/^[a-z0-9]+-[a-z0-9-]+$|^candle$/.test(k) && k !== "clock") assert.ok(css.includes(`@keyframes ${k}`), `${e.id}: @keyframes ${k} not found`);
  }
});

async function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); }); }

test("every visible element on both views is covered by an entry", async (t) => {
  let pw;
  try { pw = await import("playwright"); } catch { t.skip("playwright is not installed"); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { t.skip(`no Chromium to launch (${String(e.message).split("\n")[0]})`); return; }
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(root, "tools/static-server.mjs"), String(port), root], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 800));
    const base = `http://127.0.0.1:${port}/?preview=1`;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await ctx.route((u) => u.hostname !== "127.0.0.1", (r) => r.abort());
    // find uncovered visible elements: own text, controls, images, canvases, or a background image
    const uncovered = (page, entries) => page.evaluate((selectors) => {
      const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
      const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && opacityOf(el) > 0.05 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
      const label = (el) => (el.id ? `#${el.id}` : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => "." + c).join("")) + ` "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24)}"`;
      const out = [];
      document.body.querySelectorAll("*").forEach((el) => {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|PATH|SOURCE|G|DEFS)$/i.test(el.tagName) || !vis(el)) return;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
        const interactive = el.matches("a,button,input,select,textarea,summary,img,canvas,video,[role],[tabindex]");
        if (!(own || interactive || getComputedStyle(el).backgroundImage !== "none")) return;
        if (!selectors.some((s) => { try { return el.matches(s); } catch { return false; } })) out.push(label(el));
      });
      return out;
    }, entries.flatMap((e) => e.selector));

    const fresh = await ctx.newPage();
    await fresh.goto(base, { waitUntil: "load" });
    await fresh.waitForTimeout(3500);
    assert.equal(await fresh.evaluate(() => location.hash), "#tonight", "first visit opens on Next steps");
    const a = await uncovered(fresh, reg.views["next-steps"].entries);
    await fresh.close();

    const member = await ctx.newPage();
    await member.addInitScript(() => { try { localStorage.setItem("board-as", "Santa"); localStorage.setItem("board-hinted", "1"); } catch { /* storage blocked */ } });
    await member.goto(base, { waitUntil: "load" });
    await member.waitForTimeout(3500);
    await member.click("#scene-close");
    await member.waitForTimeout(2500);
    const b = await uncovered(member, reg.views.table.entries);
    assert.deepEqual(a, [], `Next steps: visible elements with no intent entry:\n  ${a.join("\n  ")}`);
    assert.deepEqual(b, [], `table: visible elements with no intent entry:\n  ${b.join("\n  ")}`);
    console.log("intent-register: 0 uncovered visible elements on next-steps and table");
  } finally { await browser.close(); srv.kill(); }
});
