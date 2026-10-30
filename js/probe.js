/* M0 (2026-10-30): the capability probe (notes/VISION-MOBILE.md section 3). #probe opens a full-screen sheet over the board, not a
   scene tab. It tells a friend in plain words what their device and app support, and every measurement runs live, only after the
   tap on "Check my phone": the vibration call and a test buzz, the iPhone switch tick (iOS 18 and later), the motion sensors
   (the permission step on iPhone is asked from that same tap, then 3 seconds of events are counted), touch, screen and page area,
   safe-area insets, pixel ratio, reduced motion, data saver, battery status, the engine, and whether the page runs inside Discord.
   "Send to Bloise" posts one closed-shape report (yes/no answers, bounded numbers, the engine and platform family, nothing
   typed, no name, no id, no user agent text) through js/brain.js sendProbe; against a brain without the route it says "saved on
   this device" and keeps the result in localStorage (board-probe). The shape table lives in js/brain.js (BoardBrain._probeShape),
   so this file has no copy of it: every report is coerced through that table before it is shown or sent.
   Informs, never instructs. Sound off, no autoplay of anything, keyboard reachable, 44 px targets, 16 px text. Fake-DOM safe: no
   :scope, no child combinators, no Element.after, no MutationObserver, handlers never read event.target. */
(() => {
"use strict";
if (typeof window === "undefined" || typeof document === "undefined" || typeof navigator === "undefined" || typeof addEventListener !== "function") return; /* a bare script host (a test harness) gets nothing */
const B = window.BoardBrain;
const SHAPE = B && B._probeShape;
if (!SHAPE) return; /* the shape lives in js/brain.js; without it there is nothing safe to build or send */
const SAVE_KEY = "board-probe";
const CFG = { windowMs: 3000 };

/* ---------- small helpers ---------- */
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
};
const mq = (q) => { try { return !!matchMedia(q).matches; } catch (e) { return false; } };
const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; };
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const k in attrs || {}) { const v = attrs[k]; if (v === null || v === undefined || v === false) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : String(v)); }
  for (const c of kids) if (c) e.append(c);
  return e;
};
const $ = (id) => document.getElementById(id);
const yn = (b) => (b ? "yes" : "no");

/* ---------- what the report holds: coerced through the brain's table ---------- */
/* Any object in, an object of exactly the fixed shape out: a flag is true only when it was true, a number is rounded and clamped
   into its range, a word is kept only when it is on its list (else the list's last word: "other" for engine and platform). */
function coerce(raw) {
  const r = raw && typeof raw === "object" ? raw : {}, out = {};
  for (const k of Object.keys(SHAPE)) {
    const spec = SHAPE[k], v = r[k];
    if (spec === "bool") out[k] = v === true;
    else if (typeof spec[0] === "string") out[k] = typeof v === "string" && spec.includes(v) ? v : spec[spec.length - 1];
    else out[k] = clampInt(v, spec[0], spec[1]);
  }
  return out;
}
const ua = () => { try { return String(navigator.userAgent || ""); } catch (e) { return ""; } };
/* iPadOS 13 and later says Macintosh and is told apart by its touch points */
function platformOf(u, touch) {
  if (/iP(hone|ad|od)/.test(u) || (/Macintosh/.test(u) && touch > 1)) return "ios";
  if (/Android/.test(u)) return "android";
  if (/Windows/.test(u)) return "windows";
  if (/Macintosh|Mac OS X/.test(u)) return "mac";
  if (/Linux|X11|CrOS/.test(u)) return "linux";
  return "other";
}
/* every browser on iPhone is WebKit underneath; Firefox on iPhone says FxiOS, so "Firefox/" means Gecko */
function engineOf(u, platform) {
  if (platform === "ios") return "webkit";
  if (/Firefox\//.test(u)) return "gecko";
  if (/Chrome\/|Chromium\/|Edg\/|EdgA\/|OPR\/|SamsungBrowser\//.test(u)) return "blink";
  if (/AppleWebKit\//.test(u)) return "webkit";
  return "other";
}
const switchSupport = () => { try { return !!(window.CSS && CSS.supports && (CSS.supports("appearance", "switch") || CSS.supports("-webkit-appearance", "switch"))); } catch (e) { return false; } };
const permissionOwner = () => {
  const O = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
  return O && typeof O.requestPermission === "function" ? O : M && typeof M.requestPermission === "function" ? M : null;
};
const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
/* env(safe-area-inset-*) read through a padded probe element; a host without computed padding reads zeros */
function insets() {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  try {
    const d = document.createElement("div");
    d.setAttribute("aria-hidden", "true");
    d.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
    document.body.append(d);
    const c = getComputedStyle(d);
    out.top = px(c.paddingTop); out.right = px(c.paddingRight); out.bottom = px(c.paddingBottom); out.left = px(c.paddingLeft);
    d.remove();
  } catch (e) {}
  return out;
}
/* what can be read without asking anything of the person: no sensor starts, nothing buzzes */
function facts() {
  const touch = clampInt(navigator.maxTouchPoints || 0, 0, 32), u = ua(), host = String(location.hostname || "");
  const platform = platformOf(u, touch), engine = engineOf(u, platform), vv = window.visualViewport, ins = insets();
  let framed = false; try { framed = window.top !== window; } catch (e) { framed = true; }
  return {
    kind: "probe", v: 1, engine, platform,
    discordHost: /(^|\.)discordsays\.com$/i.test(host), discordUa: /Discord/i.test(u), framed, standalone: mq("(display-mode: standalone)") || navigator.standalone === true,
    vibrateApi: typeof navigator.vibrate === "function", switchHaptic: switchSupport(),
    orientationApi: typeof window.DeviceOrientationEvent !== "undefined", motionApi: typeof window.DeviceMotionEvent !== "undefined", motionNeedsPermission: !!permissionOwner(),
    touchPoints: touch, coarsePointer: mq("(pointer: coarse)"), hoverNone: mq("(hover: none)"), pointerEvents: typeof window.PointerEvent !== "undefined",
    screenW: typeof screen !== "undefined" ? screen.width : 0, screenH: typeof screen !== "undefined" ? screen.height : 0,
    viewW: vv ? vv.width : window.innerWidth, viewH: vv ? vv.height : window.innerHeight, dpr100: (window.devicePixelRatio || 1) * 100, visualViewportApi: !!vv,
    safeTop: ins.top, safeRight: ins.right, safeBottom: ins.bottom, safeLeft: ins.left,
    reducedMotion: mq("(prefers-reduced-motion: reduce)"), saveData: !!(navigator.connection && navigator.connection.saveData),
    hdrScreen: mq("(dynamic-range: high)"), wideGamut: mq("(color-gamut: p3)"), batteryApi: typeof navigator.getBattery === "function", wakeLock: !!navigator.wakeLock,
  };
}

/* ---------- the test buzz: runs inside the tap, on the routes this phone has ---------- */
let sw = null;
function tickSwitch() {
  if (!sw) {
    const l = el("label", { "aria-hidden": "true" }); l.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    const i = el("input", { type: "checkbox", switch: true, tabindex: "-1" }); l.append(i); document.body.append(l); sw = l;
  }
  sw.click();
}
/* -> { route: 0 none, 1 vibration call, 2 switch control, 3 both, ran: the vibration call answered true } */
function buzz() {
  let route = 0, ran = false;
  try { if (typeof navigator.vibrate === "function" && navigator.vibrate([40])) { route |= 1; ran = true; } } catch (e) {}
  /* the switch is clicked wherever it is supported and on every iPhone and iPad, so a support test that is wrong on one OS version
     still gets its answer from the person: switchHaptic reports the test, the felt answer reports the truth */
  try { if (switchSupport() || platformOf(ua(), clampInt(navigator.maxTouchPoints || 0, 0, 32)) === "ios") { tickSwitch(); route |= 2; } } catch (e) {}
  return { route, ran };
}
/* the permission step (iPhone): the call is made inside the tap; 1 granted, 2 declined, 4 failed. null when this browser has no such step */
function askPermission() {
  const owner = permissionOwner(); if (!owner) return null;
  try { return Promise.resolve(owner.requestPermission()).then((r) => (r === "granted" ? 1 : 2), () => 4); } catch (e) { return Promise.resolve(4); }
}
/* counts the events that carry real readings (a desktop browser may fire one with every value null) */
const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
function listen(ms) {
  return new Promise((resolve) => {
    let o = 0, d = 0;
    const onO = (e) => { if (e && (has(e.alpha) || has(e.beta) || has(e.gamma))) o++; };
    const onD = (e) => {
      const g = e && e.accelerationIncludingGravity, a = e && e.acceleration, r = e && e.rotationRate;
      if ((g && (has(g.x) || has(g.y) || has(g.z))) || (a && (has(a.x) || has(a.y) || has(a.z))) || (r && (has(r.alpha) || has(r.beta) || has(r.gamma)))) d++;
    };
    addEventListener("deviceorientation", onO); addEventListener("devicemotion", onD);
    setTimeout(() => { removeEventListener("deviceorientation", onO); removeEventListener("devicemotion", onD); resolve({ o, d }); }, ms);
  });
}

/* ---------- state ---------- */
const S = { open: false, ui: null, report: null, at: null, sent: false, running: false, sending: false, back: null, say: "", sayIt: "", phase: "" };
function load() {
  try {
    const j = JSON.parse(store.get(SAVE_KEY) || "null");
    if (j && typeof j === "object" && j.report && typeof j.report === "object") { S.report = coerce(j.report); S.at = typeof j.at === "string" ? j.at : null; S.sent = j.sent === true; }
  } catch (e) {}
}
const save = () => { if (S.report) store.set(SAVE_KEY, JSON.stringify({ at: S.at, report: S.report, sent: S.sent })); };

/* ---------- the rows: every line is read from the report that would be sent ---------- */
const PLAT = { ios: "iPhone or iPad", android: "Android", windows: "Windows", mac: "Mac", linux: "Linux or ChromeOS", other: "A platform the board does not name" };
const ENG = { webkit: "WebKit engine (the Safari family)", blink: "Blink engine (the Chrome family)", gecko: "Gecko engine (Firefox)", other: "an engine the board does not name" };
const VIA = ["", "the vibration call", "the switch control", "both the vibration call and the switch control"];
const FELT = ["Whether it was felt is the question below.", "You felt it.", "You did not feel it.", "You were not sure."];
const PERM = [["Not asked.", "wait"], ["Granted.", "yes"], ["Declined, or blocked by the app that opened this page.", "no"], ["Not needed: this browser has no permission step for the sensors.", "yes"], ["The permission request failed.", "no"]];
const rate = (n) => `about ${Math.round(n / 3)} a second (${n} in 3 seconds)`;
const ROWS = [
  ["Device and browser", (r) => [`${PLAT[r.platform]}, ${ENG[r.engine]}, ${r.standalone ? "added to the home screen" : "not added to the home screen"}.`, "yes"]],
  ["Inside Discord", (r) => {
    const p = [];
    if (r.discordHost) p.push(r.framed ? "Yes: the page sits inside Discord's frame (the Activity)." : "Opened on Discord's web address, outside a frame.");
    if (r.discordUa) p.push("The browser string names Discord.");
    return p.length ? [p.join(" "), "yes"] : ["No: this is a plain browser page.", "yes"];
  }],
  ["Vibration call", (r) => (r.vibrateApi ? ["The browser has the vibration call.", "yes"] : [r.platform === "ios" ? "Not offered. iPhone browsers do not have the vibration call." : "Not offered by this browser.", "no"])],
  ["iPhone switch tick", (r) => (r.switchHaptic ? ["The switch control is supported. On iOS 18 and later, flipping it can tick; the test buzz shows whether this phone does.", "yes"] : ["Not supported here.", "no"])],
  ["Test buzz", (r) => (r.buzzRoute === 0 ? ["Nothing was sent: neither route exists here.", "no"] : [`Sent through ${VIA[r.buzzRoute]}. ${FELT[r.buzzFelt]}`, r.buzzFelt === 1 ? "yes" : r.buzzFelt === 0 ? "wait" : "no"])],
  ["Motion sensors", (r) => [`Orientation events: ${r.orientationApi ? "present" : "absent"}. Motion events: ${r.motionApi ? "present" : "absent"}.`, r.orientationApi || r.motionApi ? "yes" : "no"]],
  ["Motion permission", (r) => PERM[r.motionPermission]],
  ["Sensor rate", (r) => (r.orientationCount3s || r.motionCount3s ? [`Orientation: ${rate(r.orientationCount3s)}. Motion: ${rate(r.motionCount3s)}.`, "yes"] : ["No readings arrived in 3 seconds.", "no"])],
  ["Touch", (r) => [`${r.touchPoints} touch point${r.touchPoints === 1 ? "" : "s"}. Pointer: ${r.coarsePointer ? "coarse (a finger)" : "fine (a mouse or pen)"}. Hover: ${r.hoverNone ? "not available" : "available"}.`, r.touchPoints > 0 ? "yes" : "no"]],
  ["Screen and page area", (r) => [`Screen ${r.screenW} by ${r.screenH}; page area ${r.viewW} by ${r.viewH} (CSS pixels); pixel ratio ${r.dpr100 / 100}.`, "yes"]],
  ["Safe areas", (r) => [r.safeTop || r.safeRight || r.safeBottom || r.safeLeft ? `Top ${r.safeTop}, right ${r.safeRight}, bottom ${r.safeBottom}, left ${r.safeLeft} pixels.` : "None reported: no notch or home bar to keep clear, or the page is not drawn edge to edge.", "yes"]],
  ["Reduced motion and data saver", (r) => [`Reduced motion: ${r.reducedMotion ? "on" : "off"}. Data saver: ${r.saveData ? "on" : "off"}.`, "yes"]],
  ["Battery saver", (r) => [r.batteryApi ? "A battery status call exists here; it reports charge, not the battery saver switch." : "A web page cannot read it here.", "no"]],
  ["Display", (r) => [`High dynamic range screen: ${yn(r.hdrScreen)}. Wide colour (Display P3): ${yn(r.wideGamut)}.`, "yes"]],
  ["Other pieces", (r) => [`Pointer events: ${yn(r.pointerEvents)}. Visual viewport: ${yn(r.visualViewportApi)}. Screen wake lock: ${yn(r.wakeLock)}.`, "yes"]],
];
const SEND_SAY = {
  ok: "Sent to Bloise. A copy stays on this device.",
  nowhere: "Saved on this device. This address has no brain to send to.",
  route: "Saved on this device. The brain does not have the probe route yet.",
  busy: "Saved on this device. The brain is busy; it takes a report again after a while.",
  refused: "Saved on this device. The brain turned it down.",
  offline: "Saved on this device. The brain could not be reached.",
  shape: "Saved on this device. The report did not match its fixed shape.",
};

/* ---------- the sheet ---------- */
function build() {
  const ui = {};
  ui.root = el("div", { id: "probe-sheet", class: "probe", role: "dialog", "aria-modal": "true", "aria-labelledby": "probe-title", hidden: true });
  ui.title = el("h2", { id: "probe-title", class: "probe-title", text: "What this phone can do" });
  ui.close = el("button", { id: "probe-close", type: "button", class: "probe-x", "aria-label": "Close and go back to the board", text: "Close" });
  ui.run = el("button", { id: "probe-run", type: "button", class: "probe-btn", text: "Check my phone" });
  ui.status = el("p", { id: "probe-status", class: "probe-status", role: "status", "aria-live": "polite" });
  ui.list = el("ul", { id: "probe-list", class: "probe-list", "aria-label": "What was found" });
  ui.feelQ = el("p", { id: "probe-feel-q", class: "probe-q", text: "Did you feel the tap?" });
  ui.yes = el("button", { id: "probe-feel-yes", type: "button", class: "probe-btn alt", "aria-pressed": "false", "data-felt": "1", text: "Yes, I felt it" });
  ui.no = el("button", { id: "probe-feel-no", type: "button", class: "probe-btn alt", "aria-pressed": "false", "data-felt": "2", text: "No" });
  ui.unsure = el("button", { id: "probe-feel-unsure", type: "button", class: "probe-btn alt", "aria-pressed": "false", "data-felt": "3", text: "Not sure" });
  ui.again = el("button", { id: "probe-buzz-again", type: "button", class: "probe-btn alt", text: "Buzz again" });
  ui.feel = el("section", { id: "probe-feel", class: "probe-feel", "aria-labelledby": "probe-feel-q", hidden: true }, ui.feelQ, el("div", { class: "probe-row" }, ui.yes, ui.no, ui.unsure, ui.again));
  ui.json = el("pre", { id: "probe-json", class: "probe-json" });
  ui.sent = el("details", { id: "probe-sent", class: "probe-sent" }, el("summary", { text: "What would be sent" }), el("p", { class: "probe-note", text: "Yes/no answers and numbers, three fixed words, nothing typed. No name, no id, no browser string." }), ui.json);
  ui.send = el("button", { id: "probe-send", type: "button", class: "probe-btn", "aria-disabled": "true", text: "Send to Bloise" });
  ui.forget = el("button", { id: "probe-forget", type: "button", class: "probe-btn alt", text: "Forget the saved result" });
  ui.say = el("p", { id: "probe-say", class: "probe-status", role: "status", "aria-live": "polite" });
  const lede = el("p", { class: "probe-lede", text: "The board asks this phone or browser what it can do, so each screen can be built around what really works there. Nothing is measured until Check my phone is pressed, and nothing leaves this device until Send to Bloise is pressed." });
  ui.card = el("div", { class: "probe-card" },
    el("div", { class: "probe-top" }, ui.title, ui.close), lede,
    el("div", { class: "probe-row" }, ui.run), ui.status, ui.list, ui.feel, ui.sent,
    el("div", { class: "probe-row" }, ui.send, ui.forget), ui.say);
  ui.root.append(ui.card);
  document.body.append(ui.root);
  ui.close.addEventListener("click", () => close(false));
  ui.run.addEventListener("click", () => check());
  ui.send.addEventListener("click", () => send());
  ui.forget.addEventListener("click", () => forget());
  ui.again.addEventListener("click", () => again());
  for (const b of [ui.yes, ui.no, ui.unsure]) b.addEventListener("click", () => felt(Number(b.getAttribute("data-felt"))));
  return ui;
}
function render() {
  const ui = S.ui; if (!ui) return;
  const r = S.report;
  ui.list.replaceChildren(...ROWS.map(([label, fn]) => {
    const [text, state] = r ? fn(r) : ["Not checked yet.", "wait"];
    return el("li", { "data-state": state }, el("b", { class: "probe-k", text: label }), el("span", { class: "probe-v", text: text }));
  }));
  ui.json.textContent = r ? JSON.stringify(r, null, 1) : "Nothing yet: the list appears after the check.";
  ui.feel.hidden = !(r && r.buzzRoute > 0);
  const k = r ? r.buzzFelt : 0;
  [[ui.yes, 1], [ui.no, 2], [ui.unsure, 3]].forEach(([b, n]) => b.setAttribute("aria-pressed", String(k === n)));
  ui.run.textContent = S.running ? "Checking" : r ? "Check again" : "Check my phone";
  ui.run.setAttribute("aria-disabled", String(S.running));
  const can = !!r && !S.running && !S.sending && !S.sent;
  ui.send.setAttribute("aria-disabled", String(!can));
  ui.send.textContent = S.sent ? "Sent" : S.sending ? "Sending" : "Send to Bloise";
  ui.forget.hidden = !store.get(SAVE_KEY);
  ui.status.textContent = S.running ? (S.phase === "listen" ? `Listening to the motion sensors for ${Math.max(1, Math.round(CFG.windowMs / 1000))} seconds.` : S.phase === "permission" ? "Waiting for the answer to the motion permission." : "Checking.") : S.say;
  ui.say.textContent = S.sayIt || "";
}
function stamp() { try { return new Date().toISOString(); } catch (e) { return null; } }

/* "Check my phone": the buzz and the permission call happen first, inside the tap; the rest is read or timed after */
function check() {
  if (S.running) return;
  S.running = true; S.sayIt = ""; S.sent = false;
  const f = facts();
  const b = buzz();
  const permP = askPermission(); /* called now, in the tap: iPhone only accepts the request from a gesture */
  S.report = coerce({ ...f, vibrateRan: b.ran, buzzRoute: b.route, buzzFelt: 0, motionPermission: f.motionNeedsPermission ? 0 : 3 });
  S.say = ""; S.phase = permP ? "permission" : ""; render();
  (async () => {
    let perm = f.motionNeedsPermission ? 0 : 3;
    if (permP) { try { perm = await permP; } catch (e) { perm = 4; } }
    let counts = { o: 0, d: 0 };
    if (perm !== 2 && perm !== 4 && (f.orientationApi || f.motionApi)) { S.phase = "listen"; render(); counts = await listen(CFG.windowMs); }
    S.report = coerce({ ...S.report, motionPermission: perm, orientationCount3s: counts.o, motionCount3s: counts.d });
  })().catch(() => {}).then(() => {
    S.running = false; S.phase = ""; S.at = stamp(); S.say = "Check finished. Nothing has been sent."; save(); render();
  });
}
function again() {
  if (!S.report || S.running) return;
  const b = buzz();
  S.report = coerce({ ...S.report, vibrateRan: S.report.vibrateRan || b.ran, buzzRoute: b.route || S.report.buzzRoute, buzzFelt: 0 });
  S.sent = false; S.sayIt = ""; save(); render();
}
function felt(n) {
  if (!S.report || S.running) return;
  S.report = coerce({ ...S.report, buzzFelt: n }); S.sent = false; S.sayIt = ""; save(); render();
}
async function send() {
  if (!S.report || S.running || S.sending || S.sent) return;
  S.sending = true; S.sayIt = ""; render();
  let res; try { res = await B.sendProbe(S.report); } catch (e) { res = { ok: false, local: true, why: "offline" }; }
  S.sending = false; S.sent = !!res.ok; S.sayIt = SEND_SAY[res.ok ? "ok" : res.why] || SEND_SAY.offline; save(); render();
}
function forget() {
  store.set(SAVE_KEY, null); S.report = null; S.at = null; S.sent = false; S.say = ""; S.sayIt = "The saved result on this device is gone."; render();
}

/* ---------- open, close, the hash ---------- */
const focusables = () => {
  const root = S.ui && S.ui.root; if (!root) return [];
  const shown = (n) => { for (let x = n; x && x !== root; x = x.parentNode) if (x.hidden) return false; return true; };
  return Array.from(root.querySelectorAll("button, summary")).filter((n) => !n.disabled && shown(n));
};
function lastLine() {
  let when = "date unknown"; try { if (S.at) when = new Date(S.at).toLocaleString(); } catch (e) {}
  return `Last check on this device: ${when}.${S.sent ? " It was sent." : " It has not been sent."}`;
}
function open() {
  if (S.open) return;
  if (!S.ui) { S.ui = build(); load(); }
  if (S.report && !S.running) { S.say = lastLine(); S.sayIt = ""; }
  S.open = true; S.back = document.activeElement || null;
  S.ui.root.hidden = false; render();
  try { S.ui.run.focus({ preventScroll: true }); } catch (e) {}
}
function close(fromHash) {
  if (!S.open) return;
  S.open = false; S.ui.root.hidden = true;
  if (!fromHash && isProbeHash()) { try { history.replaceState(history.state, "", `${location.pathname}${location.search || ""}`); } catch (e) {} }
  const back = S.back; S.back = null;
  try { if (back && back !== document.body && typeof back.focus === "function") back.focus({ preventScroll: true }); } catch (e) {}
}
function isProbeHash() { try { return decodeURIComponent(String(location.hash || "").replace(/^#/, "")) === "probe"; } catch (e) { return false; } }
const sync = () => { if (isProbeHash()) open(); else close(true); };
document.addEventListener("keydown", (e) => {
  if (!S.open) return;
  if (e.key === "Escape") { e.preventDefault(); close(false); return; }
  if (e.key === "Tab") {
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1], a = document.activeElement, inside = S.ui.root.contains(a);
    if (e.shiftKey && (a === first || !inside)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && (a === last || !inside)) { e.preventDefault(); first.focus(); }
    return;
  }
  /* a typed letter, digit or ? / must not reach the board's shortcuts behind the sheet (T opens Next steps, S the Sensory panel) */
  if (e.key && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); }
}, true);
addEventListener("hashchange", sync);
addEventListener("popstate", sync);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync); else sync();

window.BoardProbe = Object.freeze({
  open: () => open(), close: () => close(false), isOpen: () => S.open, report: () => (S.report ? { ...S.report } : null),
  build: coerce, facts, platformOf, engineOf, rows: ROWS.map(([label]) => label),
  status: () => ({ open: S.open, running: S.running, sending: S.sending, sent: S.sent, at: S.at, report: !!S.report }),
  _cfg: CFG,
});
})();
