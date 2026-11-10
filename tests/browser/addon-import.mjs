// Import from game panel (scenes/import.js, js/addon-import.js): own sheet only; nothing read before a paste, nothing sent before the Send tap,
// the summary shows before and after, a field is sent only when it changes, per-field success and failure, no overlap at 390x844 and 1440x900, zero console errors.
//   node addon-import.mjs --url http://127.0.0.1:8080/   (or env PREVIEW_PAGES)
// Everything under /api/ is stubbed by interception with a made-up member key; nothing real is sent. Exit 0 when every check passes, 1 otherwise.
import { pageUrl } from "../helpers/page-url.mjs";
import { stubbed } from "../helpers/browser-stub.mjs";
const pw = await import("playwright").catch(() => { console.error("playwright not found; run npm install in tests/"); process.exit(2); });
const argv = process.argv.slice(2), ui = argv.indexOf("--url");
const BASE = (ui >= 0 && argv[ui + 1]) || process.env.PREVIEW_PAGES;
if (!BASE) { console.error("usage: node addon-import.mjs --url <pages origin>"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };
const KEY = "TestKeyTestKeyTestKey123456";
const SIZES = [["390x844", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ["1440x900", { viewport: { width: 1440, height: 900 } }]];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });

async function run(browser, [label, opts]) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce" }), page = await ctx.newPage(), errors = [], posts = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/^\[Report Only\]|^Failed to load resource|cloudflareinsights|net::ERR|WebSocket connection/.test(m.text())) errors.push(m.text()); });
  await ctx.addInitScript(([key]) => { try { localStorage.setItem("board-journey", "everything"); localStorage.setItem("board-walked", "1"); localStorage.setItem("board-me", "bloise"); localStorage.setItem("board-key", key); } catch (e) {} }, [KEY]);
  await ctx.route("**/api/**", async (route) => {
    const u = new URL(route.request().url()), m = route.request().method();
    if (m === "GET" && u.pathname.endsWith("/api/me")) return json(route, { slug: "bloise", name: "Bloise" });
    if (m === "GET" && u.pathname.endsWith("/api/sheet")) return json(route, { sheet: { fields: {}, updated: null }, party: [] });
    if (m === "POST" && u.pathname.endsWith("/api/sheet")) {
      const b = route.request().postDataJSON(); posts.push(b); await new Promise((r) => setTimeout(r, 400));
      if (b.field === "level" && !globalThis.__lvOk) return json(route, { error: "busy" }, 429);
      return json(route, { ok: true, value: b.value, visible: true, at: new Date().toISOString() });
    }
    return route.abort();
  });
  await page.goto(pageUrl(BASE, { params: { preview: "1" }, defaults: { brain: "local" } }), { waitUntil: "load" });
  await page.waitForFunction(() => window.__scenes && window.__boardKit && window.__boardKit.D && window.__boardKit.D.party, null, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => window.__scenes.load("sheet")).catch(() => {});
  await page.evaluate(() => window.__sheet.openSheet("bloise", true));
  await page.waitForTimeout(1500);
  ok(`${label}: Import from game button is on your own sheet`, await page.locator("#ps-imp-btn").count() === 1);
  await page.locator("#ps-imp-btn").evaluate((e) => e.scrollIntoView({ block: "center" })); await page.locator("#ps-imp-btn").click();
  await page.locator("#imp-text").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => /Nothing is read until/.test(document.querySelector("#imp-out").innerText), null, { timeout: 8000 }).catch(() => {});
  ok(`${label}: panel opens empty and sends nothing`, (await page.locator("#imp-out").innerText()).includes("Nothing is read until you paste") && posts.length === 0);
  const now = Math.floor(Date.now() / 1000);
  const { encode } = await import("../../js/addon-import.js");
  const s = encode({ v: 1, iface: 16001, t: now - 60, name: "Secretname", class: "WARRIOR", race: "Troll", level: 33, prof: "164:300,185:100", zone: "Elwynn Forest" }).full;
  await page.locator("#imp-text").fill(s.slice(0, 40) + "\n" + s.slice(40));
  await page.locator(".imp-row").first().waitFor({ timeout: 5000 });
  const txt = await page.locator("#imp-out").innerText();
  ok(`${label}: summary names what was found and what will change`, /level 33/.test(txt) && /Will change/.test(txt) && /Secretname/.test(txt) && /never sent/.test(txt) && /Profession skill 185: not on the board's list, skipped/.test(txt), txt.slice(0, 300));
  ok(`${label}: nothing sent before the tap`, posts.length === 0);
  ok(`${label}: nothing about the import in localStorage`, await page.evaluate(() => !Object.entries(localStorage).some(([k, v]) => /LEEROY1|Secretname/.test(k + v))));
  const bad = await page.locator("#imp-text").fill(s.replace("level=33", "level=34")).then(() => page.locator(".imp-bad").innerText());
  ok(`${label}: a tampered string is refused in plain words`, /check does not match/.test(bad), bad);
  /* one operation token: the latest of several reads or a paste wins, and an older read that fails later shows nothing */
  const X = encode({ v: 1, iface: 16001, t: now - 60, class: "MAGE", race: "Gnome", level: 12 }).full, Y = encode({ v: 1, iface: 16001, t: now - 60, class: "ROGUE", race: "Orc", level: 7 }).full;
  const drop = (text, ms, reject) => page.evaluate(([o, d, rj]) => { const slow = { size: 10, text: () => new Promise((res, rej) => setTimeout(() => (rj ? rej(new Error("x")) : res(o)), d)) }; const ev = new DragEvent("drop", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: { files: [slow], getData: () => "" } }); document.getElementById("imp-drop").dispatchEvent(ev); }, [text, ms, reject]);
  const val = () => page.locator("#imp-text").inputValue();
  await drop(X, 700); await drop(Y, 150); await page.waitForTimeout(1100);
  ok(`${label}: two reads, the older finishing last: the newer one wins`, (await val()) === Y, (await val()).slice(0, 60));
  await page.locator("#imp-text").fill(""); await drop(X, 150); await drop(Y, 700); await page.waitForTimeout(1100);
  ok(`${label}: two reads, the newer finishing last: the newer one wins`, (await val()) === Y && /level 7/.test(await page.locator("#imp-out").innerText()), (await val()).slice(0, 60));
  await drop(X, 500, true); await page.locator("#imp-text").fill(s); await page.waitForTimeout(900);
  ok(`${label}: an older read that fails after a newer paste shows no error and keeps the preview`, (await page.locator(".imp-bad").count()) === 0 && (await val()) === s && (await page.locator(".imp-row").count()) > 0 && !/could not be read/.test(await page.locator("#imp-out").innerText()));
  await drop(X, 100, true); await page.waitForTimeout(500);
  ok(`${label}: the latest read failing does say so`, /could not be read/.test(await page.locator("#imp-out").innerText()));
  await page.locator("#imp-text").fill(s);
  await page.locator(".imp-row").first().waitFor({ timeout: 5000 });
  /* one size limit: an oversized file or paste is refused out loud, never cut */
  await page.evaluate(() => { const big = { size: 400001, text: () => Promise.resolve("x") }; const ev = new DragEvent("drop", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: { files: [big], getData: () => "" } }); document.getElementById("imp-drop").dispatchEvent(ev); });
  await page.waitForTimeout(150);
  ok(`${label}: an oversized file is refused with the explicit reason`, /larger than the add-on ever writes; paste only the export string/.test(await page.locator("#imp-out").innerText()), await page.locator("#imp-out").innerText());
  await page.evaluate(() => { const big = { size: 10, text: () => Promise.resolve("y".repeat(400001)) }; const ev = new DragEvent("drop", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: { files: [big], getData: () => "" } }); document.getElementById("imp-drop").dispatchEvent(ev); });
  await page.waitForTimeout(300);
  ok(`${label}: a file that is longer than it claimed is refused too, not cut`, /larger than the add-on ever writes/.test(await page.locator("#imp-out").innerText()));
  await page.locator("#imp-text").fill(s);
  await page.locator(".imp-row").first().waitFor({ timeout: 5000 });
  const geo = await page.evaluate(() => {
    const sc = document.documentElement.scrollWidth - window.innerWidth;
    const boxes = [...document.querySelectorAll(".imp-row, .imp-text, .imp-drop, .imp-send, .imp-note")].map((e) => e.getBoundingClientRect());
    const over = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) over.push([i, j]); }
    const panel = document.querySelector(".imp").getBoundingClientRect();
    return { sc, over, panelRight: panel.right, vw: window.innerWidth, short: [...document.querySelectorAll(".imp-send, .imp-choose, .imp-toggle")].filter((e) => e.offsetHeight < 44).length };
  });
  ok(`${label}: no horizontal scroll, no overlap, controls 44px`, geo.sc <= 1 && geo.over.length === 0 && geo.panelRight <= geo.vw + 1 && geo.short === 0, JSON.stringify(geo));
  if (label === "1440x900") await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/import-${label}-before.png` : undefined }).catch(() => {});
  /* file-read race: a read that finishes while sending must not touch the text box */
  await page.evaluate((o) => { const f = new File([o], "late.lua"); const slow = { size: f.size, text: () => { window.__readStarted = Date.now(); return new Promise((r) => setTimeout(() => { window.__readDone = Date.now(); r(o); }, 900)); } }; const dt = new DataTransfer(); window.__slowFile = slow; const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }); Object.defineProperty(ev, "dataTransfer", { value: { files: [slow], getData: () => "" } }); document.getElementById("imp-drop").dispatchEvent(ev); }, encode({ v: 1, iface: 16001, t: now - 60, class: "MAGE", race: "Gnome", level: 12 }).full);
  await page.locator("#imp-send").evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.evaluate((o) => { const slow = { size: o.length, text: () => new Promise((r) => setTimeout(() => r(o), 3000)) }; const ev = new DragEvent("drop", { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: { files: [slow], getData: () => "" } }); window.__lateStart = Date.now(); document.getElementById("imp-drop").dispatchEvent(ev); }, encode({ v: 1, iface: 16001, t: now - 60, class: "ROGUE", race: "Orc", level: 7 }).full).catch(() => {});
  await page.locator("#imp-send").click();
  await page.waitForFunction(() => window.__readDone, null, { timeout: 5000 });
  const midSend = await page.evaluate(() => ({ v: document.getElementById("imp-text").value, sending: document.getElementById("imp-send").textContent }));
  ok(`${label}: a file read that finished mid-send did not replace the text box`, midSend.v === s && /Sending/.test(midSend.sending), JSON.stringify(midSend).slice(0, 120));
  const during = await page.evaluate(() => ({ ta: document.getElementById("imp-text").disabled, file: document.getElementById("imp-file").disabled, choose: document.querySelector(".imp-choose").disabled, send: document.getElementById("imp-send").getAttribute("aria-disabled"), label: document.getElementById("imp-send").textContent }));
  ok(`${label}: while sending, the text box, file picker and Send are locked`, during.ta && during.file && during.choose && during.send === "true" && /Sending/.test(during.label), JSON.stringify(during));
  /* an edit attempt during submission (an input event, and a drop of other text) must change nothing */
  const other = encode({ v: 1, iface: 16001, t: now - 60, class: "MAGE", race: "Gnome", level: 12 }).full;
  await page.evaluate((o) => { const ta = document.getElementById("imp-text"); ta.value = o; ta.dispatchEvent(new Event("input", { bubbles: true })); const dt = new DataTransfer(); dt.setData("text/plain", o); document.getElementById("imp-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); }, other);
  await page.locator('.imp-row[data-state="failed"], .imp-row[data-state="sent"]').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);
  const fields = posts.map((p) => p.field).sort();
  ok(`${label}: only changed fields were sent, one at a time, and never the name`, JSON.stringify(fields) === JSON.stringify(["class", "level", "professions", "race"]) && !JSON.stringify(posts).includes("Secretname") && !JSON.stringify(posts).includes("Elwynn"), JSON.stringify(posts));
  ok(`${label}: values sent are board slugs`, posts.some((p) => p.field === "class" && p.value === "warrior") && posts.some((p) => p.field === "race" && p.value === "troll") && posts.some((p) => p.field === "professions" && JSON.stringify(p.value) === '["blacksmithing"]'), JSON.stringify(posts));
  const states = await page.locator(".imp-row").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.field, e.dataset.state])));
  ok(`${label}: a failed line says so and the others say Sent`, states.level === "failed" && states.race === "sent" && states.class === "sent" && states.professions === "sent", JSON.stringify(states));
  ok(`${label}: the failure is in words`, /Level\s*[\s\S]*Not sent: busy/.test(await page.locator("#imp-out").innerText()));
  /* retry: the failed line (level) can be sent again, only that one, against the current sheet */
  const before = posts.length;
  ok(`${label}: the button now offers Retry for the failed line`, /Retry 1 failed line/.test(await page.locator("#imp-send").innerText()) && (await page.locator("#imp-send").getAttribute("aria-disabled")) !== "true");
  globalThis.__lvOk = true;
  await page.locator("#imp-send").click();
  await page.waitForFunction(() => document.querySelector('.imp-row[data-field="level"]').dataset.state === "sent", null, { timeout: 8000 }).catch(() => {});
  const again = posts.slice(before);
  ok(`${label}: retry sent only the failed line and it succeeded`, again.length === 1 && again[0].field === "level" && again[0].value === 33, JSON.stringify(again));
  ok(`${label}: after a clean retry every line says Sent and the button is Done`, (await page.locator('.imp-row[data-state="sent"]').count()) === 4 && /Done/.test(await page.locator("#imp-send").innerText()));
  globalThis.__lvOk = false;
  ok(`${label}: Send cannot run twice`, (await page.locator("#imp-send").getAttribute("aria-disabled")) === "true");
  const rd = await page.evaluate(() => [window.__readStarted, window.__readDone]);
  ok(`${label}: the slow read did run and finish before the results came back`, !!rd[0] && !!rd[1], JSON.stringify(rd));
  await page.waitForTimeout(3200);
  ok(`${label}: a read that finishes after submission does not replace the export or clear its results`, (await page.locator("#imp-text").inputValue()) === s && (await page.locator(".imp-row[data-state=sent]").count()) === 4, (await page.locator("#imp-text").inputValue()).slice(0, 70));
  const after = await page.locator("#imp-out").innerText();
  ok(`${label}: results stay with the export that was sent (the edit during sending was ignored)`, /Level 33/.test(after) && !/Level 12|Gnome/i.test(after) && posts.every((p) => !(p.field === "class" && p.value === "mage")), JSON.stringify(after));
  ok(`${label}: boxes unlock after sending`, await page.evaluate(() => !document.getElementById("imp-text").disabled));
  await page.locator("#imp-text").fill(other);
  await page.locator(".imp-row").first().waitFor({ timeout: 5000 });
  const fresh = await page.evaluate(() => [...document.querySelectorAll(".imp-row")].map((e) => e.dataset.state));
  ok(`${label}: a new export starts clean, no Sent left over from the old one`, fresh.length > 0 && fresh.every((x) => x === "change" || x === "same"), JSON.stringify(fresh));
  await page.locator("#imp-text").fill(s);
  await page.locator(".imp-row").first().waitFor({ timeout: 5000 });
  if (label === "1440x900") await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/import-${label}-after.png` : undefined }).catch(() => {});
  ok(`${label}: zero console errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
const browser = stubbed(await pw.chromium.launch());
for (const sz of SIZES) await run(browser, sz);
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
