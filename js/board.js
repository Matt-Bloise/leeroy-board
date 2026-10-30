
(() => {
"use strict";
const LT = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) LT.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ type: "longtask", buffered: true }); } catch (e) {}
const $ = (s, r = document) => r.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
function h(tag, attrs, ...kids) {
  const svg = attrs && attrs.svg; const n = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "svg" || v === null || v === undefined || v === false) continue;
    if (k === "class") n.setAttribute("class", v);
    else if (k === "text") n.textContent = v;
    else if (k === "style") n.setAttribute("style", v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const s = (tag, attrs, ...kids) => h(tag, Object.assign({ svg: true }, attrs), ...kids);
/* V11 emblems: */
const ring = (cx, cy, r) => `M${cx} ${cy - r}a${r} ${r} 0 1 1-.01 0z`;
const scallop = (cx, cy, r, n, amp) => { let d = ""; for (let i = 0; i <= n * 2; i++) { const a = (i * Math.PI) / n - Math.PI / 2, rr = i % 2 ? r - amp : r; d += `${i ? "L" : "M"}${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)}`; } return d + "z"; };
const gear = (cx, cy, r1, r2, n) => { let d = ""; for (let i = 0; i < n * 4; i++) { const a = (i * Math.PI * 2) / (n * 4), rr = (i % 4) < 2 ? r2 : r1; d += `${i ? "L" : "M"}${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)}`; } return d + "z"; };
const STAR5 = (cx, cy, r) => { let d = ""; for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5 - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; d += `${i ? "L" : "M"}${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)}`; } return d + "z"; };
const EMB = {
  scroll: [["b", "M6 4.5h11.5a2 2 0 0 1 2 2V18H8a2 2 0 0 1-2-2z"], ["d", "M6 4.5a2 2 0 0 0-2 2v1.4h4V6.5a2 2 0 0 0-2-2z"], ["l", "M8.6 8.8h8.2M8.6 11.4h6M8.6 14h3.6"], ["a", "M14.4 19.6l.9-2.8h2l.9 2.8-1.9-.9z"], ["a", ring(16.2, 16.4, 3.3)], ["h", STAR5(16.2, 16.4, 1.5)]],
  hourglass: [["b", "M7.5 4c0 4.2 3.2 5.6 3.2 8s-3.2 3.8-3.2 8h9c0-4.2-3.2-5.6-3.2-8s3.2-3.8 3.2-8z"], ["a", "M9 7h6c-.7 1.7-2.3 2.6-3 4.2C11.3 9.6 9.7 8.7 9 7z"], ["a", "M8.4 19.6c.3-2 1.8-3.3 3.6-4.2 1.8.9 3.3 2.2 3.6 4.2z"], ["s", "M11.65 11.2h.7v4.6h-.7z"], ["l", "M6.8 3.5v17M17.2 3.5v17"], ["k", "M5.6 3.5h12.8M5.6 20.5h12.8"]],
  horn: [["b", "M3 14.2C8.5 14.6 13.6 12.4 16.6 6.6l4.4 2.6c-3.4 5.6-9.4 8.2-18 7.1z"], ["a", "M16.4 6.5c.6-1 2.8-.8 4.6.3s2.9 2.8 2.3 3.8-2.8.8-4.6-.3-2.9-2.8-2.3-3.8z"], ["d", "M17.3 7.4c.4-.5 1.7-.3 2.8.4s1.7 1.6 1.4 2.1-1.7.3-2.8-.4-1.7-1.6-1.4-2.1z"], ["lb", "M7.6 14.4l.5 2.1M11.6 13.2l.9 2.1M14.8 10.8l1.4 1.6"], ["l", "M4.6 16.6c3 2.6 9.6 2.6 13.6-2"]],
  skull: [["a", "M6.6 6.2L2.2 2.6l1.6 5.2zM17.4 6.2l4.4-3.6-1.6 5.2z"], ["b", "M12 3.6c4.3 0 7.4 2.8 7.4 6.6 0 2.1-.9 3.6-2.4 4.5v3.1l-1.8 1.6-1-1.3-1.1 1.6-1.1-1.6-1.1 1.6-1.1-1.6-1 1.3L7 17.8v-3.1C5.5 13.8 4.6 12.3 4.6 10.2c0-3.8 3.1-6.6 7.4-6.6z"], ["d", "M7.4 9.6l3.2 1.3-2.6 1.6zM16.6 9.6l-3.2 1.3 2.6 1.6z"], ["e", "M8.3 10.6l1 .5-.8.5zM15.7 10.6l-1 .5.8.5z"], ["l", "M11.2 14.4l.8-.9.8.9M9 5.6c1.8-.8 4.2-.8 6 0"]],
  ticket: [["b", "M3 7h18v3.1a1.9 1.9 0 0 0 0 3.8V17H3v-3.1a1.9 1.9 0 0 0 0-3.8z"], ["dl", "M15.6 7.8v8.4"], ["a", STAR5(9.2, 12, 3.4)], ["l", "M18 10v4"]],
  pin: [["b", "M12 21.5s-6.6-6.5-6.6-11.2a6.6 6.6 0 0 1 13.2 0c0 4.7-6.6 11.2-6.6 11.2z"], ["a", ring(12, 10.3, 2.6)], ["hl", "M8.2 9.2a4 4 0 0 1 2.4-3"]],
  voice: [["b", "M3.5 9.5h3.2L15 4.6v14.8l-8.3-4.9H3.5z"], ["d", "M3.5 9.5h3.2v5H3.5z"], ["lb", "M9 9.4v5.2M12 7.6v8.8"], ["l", "M17.6 9.2a4 4 0 0 1 0 5.6M19.8 6.8a7.4 7.4 0 0 1 0 10.4"]],
  clock: [["a", "M10.6 1.8h2.8v2.6h-2.8z"], ["b", ring(12, 12.8, 8.2)], ["h", ring(12, 12.8, 6.3)], ["l", "M12 7.4v1M17.4 12.8h-1M12 18.2v-1M6.6 12.8h1M12 12.8V9.2M12 12.8l2.6 1.6"]],
  seal: [["a", scallop(12, 12, 9.4, 14, 1.2)], ["l", ring(12, 12, 5.6)], ["h", STAR5(12, 12, 3.4)]],
  speech: [["b", "M4.5 4.5h15a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H11l-5 4v-4H4.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"], ["d", "M7.6 8.2h2.8v2.6c0 1.7-.9 2.8-2.4 3.2l-.4-1c.8-.3 1.1-.9 1.1-1.5H7.6zM13.4 8.2h2.8v2.6c0 1.7-.9 2.8-2.4 3.2l-.4-1c.8-.3 1.1-.9 1.1-1.5h-1.1z"], ["a", "M19 17.4c.7 1.3 1.2 2.1 1.2 2.8a1.2 1.2 0 0 1-2.4 0c0-.7.5-1.5 1.2-2.8z"]],
  ribbon: [["a", "M8.2 13l-2.4 8 3.1-1.3 1.9 2.5 1.4-7.2zM15.8 13l2.4 8-3.1-1.3-1.9 2.5-1.4-7.2z"], ["b", scallop(12, 9.4, 7, 12, 0.9)], ["h", ring(12, 9.4, 3.6)], ["l", STAR5(12, 9.4, 1.8)]],
  lock: [["k", "M8 11V7.4a4 4 0 0 1 7.8-1.3"], ["b", "M5.5 11h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"], ["d", "M12 13.4a1.5 1.5 0 0 1 .8 2.8v2.4h-1.6v-2.4a1.5 1.5 0 0 1 .8-2.8z"], ["lb", "M6.6 12.8v6.6"]],
  classes: [["k", "M5 20.5L17.4 5.2"], ["a", ring(18.4, 4.2, 2.3)], ["b", "M4 4l3.8.8L18.6 15.6l-2.9 2.9L4.8 7.8z"], ["d", "M14.4 20.6l6.2-6.2 1 1-6.2 6.2zM18.6 19.4l2.2 2.2-1.2 1.2-2.2-2.2z"]],
  tradeskills: [["b", "M3 9h13c0 1.8 1.6 2.8 4.5 2.8v1.4c-3.2 0-4.4 1-4.8 3H17v2.3H7v-2.3h1.4C8 14.3 6.4 12.8 3 12z"], ["k", "M15.4 4.6l4.4-2.6"], ["d", "M11.4 2.2l3.6 3.6-1.7 1.7-3.6-3.6z"], ["lb", "M5 6.6l-.6-1.6M7.6 6.2l.2-1.8M3.4 7.6l-1.2-.6"]],
  pvp: [["b", "M3.5 3.5l3.4.6 9.4 9.4-2.8 2.8-9.4-9.4zM20.5 3.5l-.6 3.4-9.4 9.4-2.8-2.8 9.4-9.4z"], ["a", "M12.4 17.6l5.2-5.2 1.2 1.2-5.2 5.2zM11.6 17.6L6.4 12.4l-1.2 1.2 5.2 5.2z"], ["d", "M16.2 17.6l3 3 1.4-1.4-3-3zM7.8 17.6l-3 3-1.4-1.4 3-3z"]],
  dungeons: [["b", "M4 21V10.5a8 8 0 0 1 16 0V21z"], ["d", "M6.8 21v-9.8a5.2 5.2 0 0 1 10.4 0V21z"], ["lb", "M9.2 7.2V21M12 6V21M14.8 7.2V21M6.8 13.6h10.4M6.8 17.4h10.4"], ["k", "M3 21h18"]],
  adventure: [["b", "M12 2.2l2.3 7.5 7.5 2.3-7.5 2.3-2.3 7.5-2.3-7.5-7.5-2.3 7.5-2.3z"], ["a", "M12 2.2l2.3 7.5H9.7z"], ["d", ring(12, 12, 1.6)], ["l", "M6.2 6.2l2.4 2.4M17.8 6.2l-2.4 2.4M6.2 17.8l2.4-2.4M17.8 17.8l-2.4-2.4"]],
  cal: [["b", "M4 5.5h16v15H4z"], ["d", "M4 5.5h16v3.6H4z"], ["k", "M8 3.4v4M16 3.4v4"], ["l", "M7 12.2h2M11 12.2h2M7 15.6h2M11 15.6h2M7 18.6h2"], ["a", "M14.6 14.2h3.6v3.8h-3.6z"]],
  book: [["b", "M3.6 5.2c3-1.2 6-1.2 8.4.6 2.4-1.8 5.4-1.8 8.4-.6v14c-3-1.2-6-1.2-8.4.6-2.4-1.8-5.4-1.8-8.4-.6z"], ["k", "M12 5.8v14"], ["l", "M6 8.8c1.7-.4 3.3-.3 4.4.3M6 11.6c1.7-.4 3.3-.3 4.4.3M13.6 9.1c1.1-.6 2.7-.7 4.4-.3M13.6 11.9c1.1-.6 2.7-.7 4.4-.3"], ["a", "M15.4 14.6h2.4v6.2l-1.2-1-1.2 1z"]],
  leveling: [["b", "M12 2.8l7.5 2.8v6c0 4.8-3.2 8.2-7.5 10-4.3-1.8-7.5-5.2-7.5-10v-6z"], ["d", "M12 5.4l5 1.9v4.3c0 3.3-2 5.8-5 7.2z"], ["lb", "M8 12.4l4-3.4 4 3.4M8 16.2l4-3.4 4 3.4"]],
  races: [["a", "M5.8 9.4C3.6 8.6 2.6 6.4 3 4c1 1.8 2.4 2.8 4.2 3zM18.2 9.4c2.2-.8 3.2-3 2.8-5.4-1 1.8-2.4 2.8-4.2 3z"], ["b", "M5.5 12c0-4 2.9-7 6.5-7s6.5 3 6.5 7v7.5H15V15H9v4.5H5.5z"], ["d", "M7.8 10.6h8.4v2.2H7.8z"], ["k", "M12 10.6v6.4"]],
  systems: [["b", gear(12, 12, 7, 9.4, 8)], ["d", ring(12, 12, 3.2)], ["lb", ring(12, 12, 5.2)]],
  ui: [["b", "M3.5 5h17v14h-17z"], ["d", "M3.5 5h17v3h-17z"], ["a", "M6 10.5h5v2.6H6zM6 14.7h5v2.6H6z"], ["l", "M13.2 11h4.8M13.2 14h4.8M13.2 17h3"]],
  tankard: [["b", "M5 6.5h10v13.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"], ["k", "M15 9h2.6a1.8 1.8 0 0 1 1.8 1.8v3.6a1.8 1.8 0 0 1-1.8 1.8H15"], ["lb", "M5 10.5h10M5 17h10"], ["h", "M4.4 6.8c0-1.8 1.6-2.8 3-2.4.6-1.2 2.4-1.6 3.6-.8 1.2-.8 3-.2 3.6 1.2 1 .2 1.4 1 1.4 2z"]],
  quill: [["b", "M20.5 3.2c-5.2.6-9.8 3.6-12.2 8.6l-1.4 3.6 3.2-1c4.8-2.2 8.2-6.2 10.4-11.2z"], ["l", "M4 20.5l8.6-9.6M11.4 10.4l2.6.2M13.6 8.2l2.4.2"], ["d", "M3.2 21.2l1.6-3.2 1.4 1.2z"]],
  candle: [["b", "M9 9.5h6v11H9z"], ["h", "M9 9.5h6v1.4c-.6 0-.8 1.8-1.4 1.8s-.6-1-1.2-1-.8 2.2-1.6 2.2-.6-2-1.8-2.2z"], ["f", "M12 2.4c1.8 2.2 2.4 3.6 2.4 4.6a2.4 2.4 0 0 1-4.8 0c0-1 .6-2.4 2.4-4.6z"], ["d", "M11.8 8h.4v1.5h-.4z"], ["k", "M6 20.8h12"]],
  banner: [["k", "M6 2.5v19"], ["b", "M6 4h12l-2.6 4.6L18 13.2H6z"], ["a", STAR5(11, 8.6, 2.8)]],
  laurel: [["l", "M12 21c-4.8-1.6-7.6-5.6-7.2-11.4M12 21c4.8-1.6 7.6-5.6 7.2-11.4"], ["a", "M5 9.6c-1.2-1.6-.8-3.4.6-4.4.8 1.6.4 3.2-.6 4.4zM5.4 13.4c-1.8-.8-2.4-2.6-1.6-4.2 1.4.9 2 2.6 1.6 4.2zM7.6 16.8c-2 0-3.2-1.4-3-3.2 1.6.4 2.8 1.6 3 3.2zM19 9.6c1.2-1.6.8-3.4-.6-4.4-.8 1.6-.4 3.2.6 4.4zM18.6 13.4c1.8-.8 2.4-2.6 1.6-4.2-1.4.9-2 2.6-1.6 4.2zM16.4 16.8c2 0 3.2-1.4 3-3.2-1.6.4-2.8 1.6-3 3.2z"], ["h", STAR5(12, 9.6, 3.6)]],
  rune: [["b", "M12 2.5l8 9.5-8 9.5L4 12z"], ["d", "M12 6l5 6-5 6-5-6z"], ["lb", "M12 8v8M9.8 10.2L12 12l2.2-1.8M9.8 13.8L12 12l2.2 1.8"]],
  moon: [["b", "M15.5 3.2a8.8 8.8 0 1 0 5.3 13.6A7.2 7.2 0 0 1 15.5 3.2z"], ["h", STAR5(6.4, 5.6, 2.2)], ["h", STAR5(19.6, 6.6, 1.4)]],
  question: [["b", "M12 2.8l8.4 4.6v9.2L12 21.2l-8.4-4.6V7.4z"], ["d", "M12 5.4l6.2 3.4v6.4L12 18.6l-6.2-3.4V8.8z"], ["lb", "M9.8 10.2a2.2 2.2 0 1 1 3.4 1.8c-.8.5-1.2 1-1.2 1.9M12 15.8v.2"]],
};
const EMB_LABEL = { names_open: "scroll", sub_active: "hourglass", launch: "horn", raids: "skull" };
/* emb(name, cls, label): the ChatGPT-painted emblem as an <img>. The inline SVG built from EMB stays as the onerror fallback only (emb.svg).
   chips and library are 128 px sets, dates is 192 px; names with no painted file (moon, adventure, tankard, candle, banner, laurel, rune, gear) keep the SVG glyph. */
const EMB_FILE = {};
for (const k of ["pin", "voice", "clock", "seal", "quill", "speech", "lock", "ribbon", "question"]) EMB_FILE[k] = ["chips", 128];
for (const k of ["ticket", "cal", "book", "classes", "dungeons", "leveling", "tradeskills", "pvp", "races", "skull", "systems", "ui"]) EMB_FILE[k] = ["library", 128];
for (const k of ["hourglass", "scroll", "horn"]) EMB_FILE[k] = ["dates", 192];
const EMB_DATES = new Set(["hourglass", "scroll", "horn", "skull", "seal"]);
const EMB_IN_SVG = /(^|\s)(viz-gate|spark-quill)(\s|$)/; /* these sit inside a map or chart svg and get positioned by x/y, so they are an svg <image> */
function embSvg(name, cls, label) {
  const parts = EMB[name] || EMB.seal;
  return s("svg", { class: `emb emb-${name}${cls ? ` ${cls}` : ""}`, viewBox: "0 0 24 24", ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true", focusable: "false" }) }, ...parts.map(([c, d]) => s("path", { class: `e${c}`, d })));
}
function emb(name, cls, label, dates) {
  let spec = EMB_FILE[name];
  if (dates && EMB_DATES.has(name)) spec = ["dates", 192];
  if (!spec || /(^|\s)map-mark(\s|$)/.test(cls || "")) return embSvg(name, cls, label);
  const [set, px] = spec, src = `img/emblems/${set}/${name}.webp`, klass = `emb emb-${name}${cls ? ` ${cls}` : ""}`;
  if (cls && EMB_IN_SVG.test(cls)) return s("image", { class: klass, href: src, width: px, height: px, ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }) });
  const img = h("img", { class: klass, src, width: px, height: px, alt: label || "", loading: "lazy", decoding: "async", ...(label ? {} : { "aria-hidden": "true" }) });
  /* a painted file that fails to load falls back, once, to the drawn glyph */
  img.addEventListener("error", () => { try { if (img.parentNode) img.parentNode.replaceChild(embSvg(name, cls, label), img); } catch (e) {} }, { once: true });
  return img;
}
emb.svg = embSvg;
emb.dates = (name, cls, label) => emb(name, cls, label, true);
/* a person's mark: their class crest, sized to the text, with the name for screen readers when it stands alone */
const crestMark = (m, cls = "crest-mark") => h("img", { class: cls, src: `img/crests/${m.class_key}.png`, alt: "", width: 56, height: 56, decoding: "async", title: m.name });
const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
const roomHas = (c) => document.documentElement.classList.contains(c);
/* V7: the room's state, read by window.__board.room() and written by room/tier.js */
const RS = { tier: "low", why: "not started" };
/* a new sign-up since the last look: the lantern's door latch and a murmur swelling; launch night: a cheer */
const ROOM_CUES = { signup: false, launch: false, played: false };
function roomCues() {
  if (ROOM_CUES.played || !AU.on || !(ROOM_CUES.signup || ROOM_CUES.launch)) return;
  const S = window.BoardSound; if (!S || !S.running()) return;
  ROOM_CUES.played = true;
  if (ROOM_CUES.signup) { sfx("latch", { delay: 500 }); sfx("swell", { delay: 700 }); }
  if (ROOM_CUES.launch) sfx("cheer", { delay: 1200 });
}
function startRoomLadder() {
  const launch = D.timeline && D.timeline.events.find((e) => e.key === "launch");
  const seen = MEM.seenMap(), S = D.signups;
  const host = { state: RS, motion: MOTION, launchEpoch: launch ? launch.epoch : null, newSignup: !!(S && S.updated && seen.signups && Date.parse(S.updated) > seen.signups), select: $("#room-pick"), moreButton: $("#more-room"),
    /* V13b: the room's key light and the page's card highlights are one light (LB); the room reads the aim and the shared
       flicker, and hands its eased key light position back */
    aim: () => LB, signal: flickAt, tiltOn: () => LB.tilt,
    onLight: (nx, ny, n) => { LB.x = (nx * 0.5 + 0.5) * innerWidth; LB.y = (ny * 0.5 + 0.5) * innerHeight; LB.rn = n; LB.roomAt = performance.now(); } };
  /* V13c (craft 22): the room's two story beats are heard as well as seen, once a visit, when sound runs */
  ROOM_CUES.signup = host.newSignup; ROOM_CUES.launch = !!(launch && launch.epoch && Date.now() / 1000 >= launch.epoch); roomCues();
  /* the tier module's first run blocked the main thread for about 0.8 s (long-frame trace), which would stutter the wall's entrance: it starts after the entrance.
     2026-10-30: the room now draws in a Web Worker where the browser has OffscreenCanvas (room/tier.js), so that cost is off this thread; the page path is the fallback */
  const bootRoom = () => import("../room/tier.js?v=c458b2b929").then((m) => m.startTier(host)).catch((e) => { RS.tier = "low"; RS.why = `ladder did not load: ${e && e.message}`; });
  const later = () => setTimeout(bootRoom, 1500);
  if (document.readyState === "complete") later(); else addEventListener("load", later, { once: true });
}
const MOTION = Object.freeze({ micro: 160, move: 520, hero: 900, stagger: 70, count: 600, digit: 240, close: 540, oak: "cubic-bezier(.2, .8, .2, 1)", fade: "cubic-bezier(.45, 0, .55, 1)", spring: "cubic-bezier(.34, 1.4, .64, 1)", shut: "cubic-bezier(.55, 0, .75, .2)" });
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const classVar = (key) => key ? `var(--c-${key})` : "var(--c-none)";
const andList = (xs) => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join("");

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function fmtMs(ms) {
  if (ms >= 3600000) return `${nf.format(ms / 3600000)} hr`;
  if (ms >= 60000) return `${nf.format(ms / 60000)} min`;
  return `${nf.format(ms / 1000)} sec`;
}
function fmtSecs(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return Math.round(sec % 60) ? `${Math.floor(sec / 60)} m ${Math.round(sec % 60)} s` : `${Math.floor(sec / 60)} m`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} m`;
}
function fmtVal(v, durMs) {
  const amount = v.min !== undefined ? `${nf.format(v.min)} to ${nf.format(v.max)}` : nf.format(v.n);
  const text = v.label.startsWith("%") ? `${amount}%${v.label.slice(1)}` : `${amount} ${v.label}`;
  return v.mode === "total" && durMs ? `${text} (${fmtMs(durMs)})` : text;
}
function fmtCost(c) {
  if (!c) return null;
  if (c.pct) return `${c.pct}% base mana`;
  if (c.type === "rage") return `${nf.format(c.amount / 10)} rage`; /* rage costs are stored in tenths */
  return `${nf.format(c.amount)} ${c.type}`;
}
const dtFull = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const dtDay = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const dtDayUTC = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function rel(epoch) {
  const d = epoch - Date.now() / 1000, a = Math.abs(d);
  if (a < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (a < 172800) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}
/* V13c (spec 7.2): */
const ET_ZONE = "America/New_York";
const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ET_ZONE; } catch (e) { return ET_ZONE; } };
const rtfEn = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
function relWhen(epoch, now) {
  const d = epoch - (now === undefined ? Date.now() / 1000 : now), a = Math.abs(d);
  if (a < 60) return "now";
  if (a < 3600) return rtfEn.format(Math.round(d / 60), "minute");
  if (a < 86400 * 2) return rtfEn.format(Math.round(d / 3600), "hour");
  return rtfEn.format(Math.trunc(d / 86400), "day"); /* whole days, as the countdown counts them */
}
function fmtWhen(epoch, o = {}) {
  if (!Number.isFinite(epoch)) return "";
  const d = new Date(epoch * 1000), tz = o.tz || viewerZone(), time = o.time !== false;
  const one = (zone) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", ...(time ? { hour: "numeric", minute: "2-digit" } : {}) }).formatToParts(d).map((x) => [x.type, x.value])); return `${p.weekday}, ${p.month} ${p.day}${time ? `, ${p.hour}${p.minute !== "00" ? `:${p.minute}` : ""} ${p.dayPeriod}` : ""}`; };
  const et = one(ET_ZONE), mine = one(tz);
  const s = mine === et ? `${et} ET` : `${mine} your time (${et} ET)`;
  return o.rel ? `${s}, ${relWhen(epoch, o.now)}` : s;
}
function eventWhen(e) {
  if (e.epoch === null) return dtDayUTC.format(new Date(`${e.date}T12:00:00Z`));
  return e.format === "D" ? dtDay.format(new Date(e.epoch * 1000)) : dtFull.format(new Date(e.epoch * 1000));
}

const D = {};
/* V13d: */
const KIT = { hooks: {}, on(n, f) { (this.hooks[n] ||= []).push(f); }, emit(n, ...a) { for (const f of this.hooks[n] || []) { try { f(...a); } catch (e) { console.error(n, e); } } }, lander: null };
const JR = () => document.documentElement.dataset.journey || "curious";
/* The data files start loading as soon as this script runs, while the rest of the page parses and the gate decides (V6-SPEC 3.3: */
const DATA_NAMES = ["party", "timeline", "client", "stats"];
const dataGet = (n) => fetch(`data/${n}.json`, { cache: "no-store" });
const DATA_P = { need: DATA_NAMES.map((n) => dataGet(n).then((r) => { if (!r.ok) throw new Error(`data/${n}.json answered ${r.status}`); return r.json(); })), opt: ["signups", "tonight"].map((n) => dataGet(n).then((r) => (r.ok ? r.json() : null)).catch(() => null)) };
DATA_P.need.forEach((p) => p.catch(() => {}));
const RT = { db: null, user: null, room: null, myId: null, readOnly: true, signups: new Map(), mine: {}, peers: [] };
function memberByKey(key) { return (D.party && D.party.members.find((m) => m.class_key === key)) || null; }
function memberByName(name) { return (D.party && D.party.members.find((m) => m.name === name)) || null; }

const GLYPH = { tank: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z", healer: "M12 5v14M5 12h14", damage: "M5 19L17 7M14 4h6v6M7 15l2 2M4 20l2-2" };
const roleGlyph = (role) => s("svg", { class: "glyph", viewBox: "0 0 24 24", role: "img", "aria-label": role }, s("path", { d: GLYPH[role] || GLYPH.damage }));

let clockTimer = null;
/* The launch date is always on the wall (V5 Track A): a second line from timeline.json, in Eastern time. */
function launchLine() {
  const e = D.timeline && D.timeline.events.find((x) => x.key === "launch");
  if (!e || !e.epoch) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).formatToParts(new Date(e.epoch * 1000)).map((p) => [p.type, p.value]));
  return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.hour}${parts.minute !== "00" ? `:${parts.minute}` : ""} ${parts.dayPeriod} ET`;
}
const SUBTITLE = { timeline: "Dates and countdown", five: "Who plays what", roads: "Where each character starts", racials: "Each race's special abilities", legacy: "Points your whole account earns", buffs: "Spells that help the whole party", ledger: "Decisions and polls", signups: "Who is coming on launch night", librarian: "Our Discord helper bot", library: "Every fact, searchable", decide: "Still open, by Blizzard's dates" }; /* integrator pass 3: short enough for one line at 1280 (it read "Still open for each of us, by Bli...") */
function startSubtitles() {
  for (const [k, sub] of Object.entries(SUBTITLE)) {
    const title = document.querySelector(`#board [data-scene="${k}"] .tile-title`);
    if (title && !title.parentNode.querySelector(".tile-sub")) title.parentNode.insertBefore(h("span", { class: "tile-sub", text: sub }), title.nextSibling);
    const tab = $(`#tab-${k}`); if (tab) tab.title = sub;
  }
}
function startFirstHint() {
  let seen = false; try { seen = localStorage.getItem("board-hinted") === "1"; } catch (e) {}
  const hint = $("#clock-hint"); if (!hint || seen) return;
  hint.hidden = false;
  const done = () => { hint.hidden = true; try { localStorage.setItem("board-hinted", "1"); } catch (e) {} };
  setTimeout(done, 8000);
  sceneHooks.push((on) => { if (on) done(); });
}
function startMiniClock() {
  const mc = $("#mini-clock"), clock = $("#clock");
  if (!mc || !clock || typeof IntersectionObserver !== "function") return;
  new IntersectionObserver((es) => { for (const en of es) mc.hidden = en.isIntersecting || innerWidth >= 700; }).observe(clock);
}
function renderHero() {
  const p = D.party;
  $("#kicker").textContent = `The Living Board · ${p.faction} · ${p.ruleset} ruleset`;
  const ll = launchLine(); $("#clock-launch").textContent = ll ? `Launch: ${ll}` : "";
  renderTimeline();
  tick();
  if (!clockTimer) clockTimer = setInterval(tick, 1000);
}
function nextEvent(now) { const t = D.timeline; return t.countdown_order.map((k) => t.events.find((e) => e.key === k)).find((e) => e && e.epoch > now) || null; }
const eventTs = (e) => (e.epoch === null ? Date.parse(`${e.date}T23:59:59Z`) / 1000 : e.epoch);
let shownNext;
/* V11: */
function eventState(e, now, next) {
  const ts = eventTs(e);
  if (e.until_epoch && ts <= now && now < e.until_epoch) return ["open", `Open now, until the end of ${e.until}, ${e.until_zone || "Pacific"} time`];
  if (e.until_epoch && now >= e.until_epoch) return ["past", `Closed ${e.until}`];
  if (ts < now) return ["past", "Passed"];
  const relText = e.epoch === null ? rel(Date.parse(`${e.date}T12:00:00Z`) / 1000) : rel(e.epoch);
  return next && e.key === next.key ? ["next", `Next on the board, ${relText}`] : ["", relText];
}
/* a lit hourglass glows in CSS (.stop.next/.open .emb-hourglass); the stop uses the 192 px dates set */
function stopEmblem(name) { return [emb.dates(name)]; }
function renderTimeline() {
  const t = D.timeline, tl = $("#rail"); tl.replaceChildren();
  const now = Date.now() / 1000;
  const next = nextEvent(now);
  shownNext = next ? next.key : null;
  const starts = t.events.map(eventTs);
  let i = -1; starts.forEach((x, k) => { if (x <= now) i = k; });
  const prog = i < 0 ? 0 : i >= starts.length - 1 ? 1 : (i + Math.min(1, (now - starts[i]) / (starts[i + 1] - starts[i]))) / (starts.length - 1);
  tl.style.setProperty("--prog", `${Math.round(prog * 1000) / 10}%`);
  t.events.forEach((e, di) => {
    const [cls, label] = eventState(e, now, next);
    const lit = cls === "next" || cls === "open";
    tl.append(h("li", { class: `stop ${cls}`.trim(), style: `--di: ${di}`, "data-ev": e.key, ...(cls === "past" ? { "data-j": "c e" } : {}) },
      h("span", { class: "stop-mark", "aria-hidden": "true" }, ...stopEmblem(EMB_LABEL[e.key] || "seal"), cls === "past" ? emb.dates("seal", "stop-seal") : null, lit ? h("i", { class: "stop-ember" }) : null, lit ? h("i", { class: "stop-ember" }) : null),
      h("div", { class: "stop-body" },
        h("div", { class: "when", text: eventWhen(e) }),
        h("h3", { text: e.label }),
        e.detail ? h("p", { text: e.detail }) : null,
        h("p", { class: "label state", text: label }))));
  });
  renderCalendar(now);
  KIT.emit("timeline");
}
function renderCalendar(now) {
  const box = $("#cal-col"); if (!box) return;
  const t = D.timeline, dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const local = (e) => (e.epoch === null ? new Date(`${e.date}T12:00:00`) : new Date(e.epoch * 1000));
  const marks = {}; for (const e of t.events) marks[dayKey(local(e))] = e;
  const win = t.events.find((e) => e.until_epoch);
  const inWin = (d) => win && d.getTime() + 864e5 > local(win).getTime() && d.getTime() + 432e5 < win.until_epoch * 1000; /* the day counts when its noon falls in the window */
  const launch = t.events.find((e) => e.key === "launch") || t.events[0];
  const mid = local(launch), first = new Date(mid.getFullYear(), mid.getMonth(), 1), last = new Date(mid.getFullYear(), mid.getMonth() + 1, 0);
  /* weeks start on Sunday, as US calendars do (the owner, 2026-10-29); when today falls in the week before the month, the grid
     starts on that week's Sunday so today stays on it (Nov 2026 begins on a Sunday, which would drop Oct 29 to 31) */
  const nowD = new Date(now * 1000), from = nowD < first && first - nowD < 7 * 864e5 ? new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()) : first;
  const start = new Date(from); start.setDate(from.getDate() - from.getDay());
  const end = new Date(last); end.setDate(last.getDate() + (6 - last.getDay()));
  const today = dayKey(new Date(now * 1000));
  const cells = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const e = marks[dayKey(d)], w = inWin(d);
    const prev = new Date(d); prev.setDate(d.getDate() - 1);
    /* V13d (interaction 6): a day with a date on it is a button that lights its stop on the rail (js/v13d.js links them) */
    const isToday = dayKey(d) === today;
    cells.push(h(e || isToday ? "button" : "div", { class: `cal-day${d.getMonth() !== mid.getMonth() ? " out" : ""}${w ? " win" : ""}${w && !inWin(prev) ? " first" : ""}${isToday ? " today" : ""}${e ? " has-emb" : ""}`, ...(e || isToday ? { type: "button", "data-ev": e ? e.key : "today", "data-day": dayKey(d), "aria-label": `${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(d)}${e ? `: ${e.label}` : ", today"}` } : { "data-day": dayKey(d) }), title: e ? e.label : null },
      e ? emb(EMB_LABEL[e.key] || "seal") : null, h("span", { text: String(d.getDate()) })));
  }
  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(mid);
  const later = t.events.filter((e) => local(e) > end);
  /* V13e retest-10: */
  const wideCal = matchMedia("(min-width: 1100px)").matches, wasOpen = box.querySelector("details.cal-wrap");
  const calOpen = wideCal || !!(wasOpen && wasOpen.open);
  const fmtDay = (d) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(d);
  box.replaceChildren(h("details", { class: "cal-wrap", ...(calOpen ? { open: "" } : {}) }, h("summary", { class: "cal-sum" }, "The month on a calendar"), h("div", { class: "cal", role: "group", "aria-label": `${month}, with the board's dates marked` },
    h("h4", { text: month }),
    h("div", { class: "cal-grid" }, ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((x) => h("span", { class: "dow", text: x })), ...cells)),
    h("div", { class: "cal-key" }, win ? h("span", {}, h("i", { class: "sw-win" }), `${win.label.split(":")[0]}, the window`) : null, h("span", {}, h("i", { class: "today-k" }), "today"),
      ...later.map((e) => h("button", { type: "button", class: "cal-day cal-later", "data-ev": e.key, "data-day": dayKey(local(e)), "aria-label": `${fmtDay(local(e))}: ${e.label}` }, emb(EMB_LABEL[e.key] || "seal"), h("span", { text: `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(local(e))}: ${e.label}` }))))));
}
function setClockLabel(kicker, event) {
  if ($("#clock-kicker").textContent !== kicker) $("#clock-kicker").textContent = kicker;
  if ($("#clock-event").textContent !== event) $("#clock-event").textContent = event;
}
const localDay = (ms) => { const d = new Date(ms); return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000); };
function setDigits(b, str) {
  const old = b.dataset.v || "";
  if (old === str) return;
  b.dataset.v = str;
  if (old.length !== str.length) { b.replaceChildren(...[...str].map((c) => h("span", { class: "dg" }, h("span", { class: "dg-now", text: c }), h("span", { class: "dg-old", "aria-hidden": "true" })))); return; }
  [...b.children].forEach((d, i) => {
    if (old[i] === str[i]) return;
    const [now, was] = d.children;
    was.textContent = old[i]; now.textContent = str[i];
    clockTick();
    if (reduceMQ.matches || roomHas("play") || typeof now.animate !== "function") return; /* companion N4: Play mode rolls no digit */
    /* V13c (craft 30): the old half falls first (0 to 120 ms, accelerating, darkening to 70% edge-on), then the new half
       settles (120 to 240 ms) with a small overshoot */
    const half = MOTION.digit / 2;
    was.animate([{ transform: "none", opacity: 1, filter: "brightness(1)" }, { transform: "rotateX(90deg)", opacity: 0.6, filter: "brightness(0.7)" }], { duration: half, easing: "cubic-bezier(.55, 0, 1, .45)", fill: "forwards" });
    now.animate([{ transform: "rotateX(-90deg)", filter: "brightness(0.7)" }, { transform: "rotateX(9deg)", offset: 0.7 }, { transform: "none", filter: "brightness(1)" }], { duration: half, delay: half, easing: MOTION.oak, fill: "backwards" });
  });
}
/* V13c (craft 29): the clock's sound is one tick or tock a second, never one per changed digit, and silent under a scene */
const CT = { last: 0, k: 0 };
function clockTick() { const n = performance.now(); if (n - CT.last < 500 || SC.open !== null) return; CT.last = n; CT.k ^= 1; sfx(CT.k ? "tick" : "tock"); }
function tick() {
  const t = D.timeline; if (!t) return;
  const now = Date.now() / 1000;
  const next = nextEvent(now);
  if ((next ? next.key : null) !== shownNext) renderTimeline();
  const digits = $("#clock-digits");
  if (!next) { setClockLabel("Every date on the board has passed", ""); digits.replaceChildren(); $("#clock-when").textContent = "Open the dates for the whole rail."; return; }
  const left = Math.max(0, Math.floor(next.epoch - now));
  /* integrator pass 3: Play drops the seconds (the wall idled at 0.35 to 0.5 s of main thread per 10 s repainting one glowing digit) */
  const play = roomHas("play"), parts = next.format === "D" ? [["days", localDay(next.epoch * 1000) - localDay(now * 1000)]] : [["days", Math.floor(left / 86400)], ["hours", Math.floor((left % 86400) / 3600)], ["minutes", Math.floor((left % 3600) / 60)], ...(play ? [] : [["seconds", left % 60]])];
  const sig = `${next.key}|${parts.map((x) => x.join(":")).join(",")}`; if (play && sig === CT.sig) return; CT.sig = sig;
  setClockLabel("Until", next.label);
  if (digits.childElementCount !== parts.length) digits.replaceChildren(...parts.map(([u]) => h("span", { class: "clock-unit" }, h("b", { "data-u": u }), h("span", { text: u }))));
  for (const [u, v] of parts) setDigits(digits.querySelector(`[data-u="${u}"]`), String(v).padStart(u === "days" ? 1 : 2, "0"));
  /* Screen readers get the countdown as words, once a minute, not digit by digit. */
  const leftText = parts.filter(([u]) => u !== "seconds").map(([u, v]) => `${v} ${v === 1 ? u.replace(/s$/, "") : u}`).join(", ") + " left";
  const cl = $("#clock-left"); if (cl && cl.textContent !== leftText) { cl.textContent = leftText; $("#clock").setAttribute("aria-label", `Dates. ${next.label}: ${leftText}. Launch: ${launchLine()}. Open all the dates.`); }
  $("#clock-when").textContent = next.format === "D" ? `${eventWhen(next)}. The board has the date only, no start time.` : fmtWhen(next.epoch, { rel: false }); /* V13c (consistency 10): the one formatter */
  const mc = $("#mini-clock");
  /* V12: the phone bar fits 375 px: the countdown, then the launch in the viewer's own time, short (no repeated "Launch", no zone) */
  if (mc) { const t = next.format === "D" ? `${parts[0][1]} days` : `${parts[0][1]} d ${parts[1][1]} h ${parts[2][1]} m`; const l = D.timeline.events.find((x) => x.key === "launch"); const lw = l && l.epoch ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(l.epoch * 1000)).replace(":00", "") : ""; const lbl = next.label.split(":")[0]; const txt = next.key === "launch" ? `${lbl} in ${t} · ${lw}` : `${lbl} in ${t} · Launch ${lw}`; if (mc.textContent !== txt) mc.textContent = txt; }
}

const minis = (pairs) => h("span", { class: "minis" }, pairs.map(([v, l]) => h("span", { class: "mini" }, h("b", { text: String(v) }), h("small", { text: l }))));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function fill(key, ...kids) { const el = $(`#ts-${key}`); if (el) el.replaceChildren(...kids.flat().filter(Boolean)); }
function renderTiles() {
  const p = D.party, c = D.client, L = c.legacy, st = D.stats, S = D.signups;
  const count = (role) => p.members.filter((m) => m.role === role).length;
  fill("five",
    /* V12: phones show race and class under each name too, as the laptop medallions do */
    h("span", { class: "five-row" }, p.members.map((m) => h("span", { class: "fm", "data-land": `five.${MEM.slug(m.name)}`, style: `--cc: ${classVar(m.class_key)}` }, roleGlyph(m.role), h("span", { class: "fm-n" }, m.name, h("small", { class: "fm-rc", text: `${m.race} ${m.class}` }))))),
    h("span", { class: "tile-viz list five-viz" }, p.members.map((m) => h("span", { class: "med", "data-k": m.class_key, "data-land": `five.${MEM.slug(m.name)}`, style: `--cc: ${classVar(m.class_key)}` }, h("span", { class: "med-ico" }, ART.crest[m.class_key] ? crestImg(m.class_key, "med-img") : h("i")), h("b", { text: m.name }), h("small", { text: `${m.race} ${m.class}` })))),
    h("span", { class: "tile-line five-strip" }, h("span", { class: "strip-k", text: "Roles:" }), " ", ...[["tank", "tank", "tanks"], ["healer", "healer", "healers"], ["damage", "damage", "damage"]].flatMap(([r, one, many]) => [h("span", {}, h("b", { text: String(count(r)) }), ` ${count(r) === 1 ? one : many}`), " "]),
      h("span", {}, (() => { const o = p.members.filter((m) => m.spec_status && m.spec_status.status === "open").map((m) => m.name); return o.length ? `· Still choosing a play style: ${andList(o)}` : "· All five have picked a play style"; })())));
  const zones = Object.keys(ZONES).map((z) => [z, p.members.filter((m) => m.start_zone === z)]).filter(([, ms]) => ms.length);
  fill("roads",
    h("span", { class: "tile-line" }, zones.flatMap(([z, ms], i) => [i ? ", " : "", h("b", { text: z }), `\u00a0${ms.length}`])),
    h("span", { class: "tile-line", text: `All ${zones.length === 3 ? "three" : zones.length} end in Orgrimmar.` }),
    h("span", { class: "tile-viz roads-viz" }, miniRoads()), h("span", { class: "viz-cap", text: "Where each of the five starts" }));
  const races = Object.entries(c.racials);
  const changed = races.reduce((n, [, list]) => n + list.filter((r) => r.changed_oct26).length, 0);
  fill("racials",
    races.map(([race, list]) => { const a = list.find((r) => r.kind === "active") || list[0]; return h("span", { class: "tile-line", "data-land": `racials.${MEM.slug(race)}` }, h("span", { class: "dots", "aria-hidden": "true" }, p.members.filter((m) => m.race === race).map((m) => crestMark(m))), " ", h("b", { text: race }), a ? `\u00a0· ${a.name}` : ""); }),
    changed ? h("span", { class: "tile-line", "data-land": "racials.changed", text: `${plural(changed, "racial", "racials")} changed since Oct 26` }) : null);
  fill("legacy",
    wallGloss(L.gloss || {}, [["Legacy points", "legacy points"], " come from ", ["challenges", "challenge"], ". They buy perks for every character, plus a pet, a ", ["tabard", "tabard"], " and a bear mount."]),
    h("span", { class: "tile-viz", "data-land": "legacy.ring" }, miniRing(L)), h("span", { class: "viz-cap", text: `${L.earned_now} of ${L.total} points: ${L.earned_now ? "earned so far" : "earning starts at launch"}` }));
  fill("buffs",
    /* consistency 5: the count the scene shows (every buff the five bring), not the wheel's links */
    minis([[p.members.length, "players"], [c.buffs ? c.buffs.list.filter((b) => !b.sixth).length : c.synergy.length, "buffs"]]),
    h("span", { class: "tile-viz" }, miniWheel()), h("span", { class: "viz-cap", text: "Buff links between the five" }));
  const settled = [...p.settled, ...p.settled_extra];
  const stillOpen = p.open.filter((o) => !p.polls.some((q) => q.title === o.title));
  fill("ledger",
    settled.length ? h("span", { class: "tile-line", "data-land": "ledger.settled" }, h("b", { text: "Last settled: " }), wholeClause(settled[settled.length - 1].text, 70)) : null,
    /* V13e retest-14: the "still open" count lands on the first open line, so the landing works where the list is hidden (1500 px and up) */
    (() => { const mm = minis([[stillOpen.length, "still open"], [p.polls.length, p.polls.length === 1 ? "poll" : "polls"]]); if (stillOpen.length && mm.firstChild) mm.firstChild.setAttribute("data-land", "ledger.open-0"); return mm; })(),
    h("span", { class: "tile-viz list" }, h("ul", { class: "viz-list" }, stillOpen.slice(0, 3).map((o, i) => h("li", { "data-land": `ledger.open-${i}`, text: o.title })))));
  if (S && S.tallies) {
    const T = S.tallies;
    const when = T.when ? h("span", { class: "tile-line su-when" }, [["6pm", "6 PM ET"], ["8pm", "8 PM ET"], ["later", "Later"]].filter(([k]) => T.when[k]).map(([k, l]) => h("span", { class: "su-slot" }, h("b", { text: l }), ` ${T.when[k].names.length ? T.when[k].names.map(cleanName).join(", ") : "nobody yet"}`))) : null;
    const cnt = (k) => (T.rsvp[k] ? T.rsvp[k].count : 0), none = Math.max(0, p.members.length - RSVP_KEYS.reduce((n, k) => n + cnt(k), 0));
    /* V13c (retest-3): a state shows only when someone holds it; in and no answer always do */
    const nums = [...RSVP_KEYS.filter((k) => k === "in" || cnt(k)).map((k) => [cnt(k), RSVP_SAY[k], k]), [none, "No answer", "none"]];
    fill("signups", h("span", { class: "su-nums" }, nums.map(([v, l, k]) => h("span", { class: "su-num", "data-land": `signups.${k}` }, h("b", { text: String(v) }), h("small", { text: l })))),
      h("span", { class: "rsvp-bar su-keg", "aria-hidden": "true" }, kegRow([...RSVP_KEYS.flatMap((k) => Array(cnt(k)).fill(k)), ...Array(none).fill("none")])), when);
  } else fill("signups", h("span", { class: "tile-line", text: "The Discord sign-ups did not load." }));
  fill("librarian",
    h("span", { class: "tile-line" }, "Leeroy answers questions. In any Discord channel here, type ", h("b", { text: "/ask" }), " and your question."),
    h("span", { class: "tile-line", text: "It reads the same library this board searches." }));
}
/* A wall line with dotted glossary words. */
function wallGloss(G, parts) {
  return h("span", { class: "tile-line" }, ...parts.map((x) => (Array.isArray(x) ? dotBtn(x[0], x[1]) : x)));
}
/* V12: */
const GL = { open: null, re: null };
function glDef(term) { const G = (D.party && D.party.glossary) || [], k = String(term).toLowerCase(); return G.find((g) => g.forms.some((f) => f.toLowerCase() === k)) || null; }
function dotBtn(word, term) { const g = glDef(term || word); return g ? h("button", { type: "button", class: "gl", "data-term": g.term, "aria-expanded": "false", "aria-controls": "glpop", text: word }) : word; }
function glShow(b) {
  const pop = $("#glpop"), g = glDef(b.dataset.term); if (!pop || !g) return;
  if (GL.open && GL.open !== b) GL.open.setAttribute("aria-expanded", "false");
  GL.open = b; b.setAttribute("aria-expanded", "true");
  pop.replaceChildren(h("b", { text: g.term.charAt(0).toUpperCase() + g.term.slice(1) }), h("span", { text: g.def }), h("button", { type: "button", class: "gl-x", "aria-label": "Close this card" }, "\u00d7"));
  pop.hidden = false;
  glPlace();
  pop.classList.remove("in"); void pop.offsetWidth; pop.classList.add("in");
  sfx("card");
}
/* the card follows its word while the page or a scene scrolls; it closes once the word leaves the screen */
function glPlace() {
  const pop = $("#glpop"), b = GL.open; if (!pop || !b || pop.hidden) return;
  if (KIT.placePop && b.isConnected) { const q = b.getBoundingClientRect(); if (q.bottom < 0 || q.top > innerHeight) { glClose(); return; } return KIT.placePop(pop, b); } /* js/place.js */
  const r = b.getBoundingClientRect(), m = 16, w = pop.offsetWidth, ht = pop.offsetHeight;
  if (!b.isConnected || r.bottom < 0 || r.top > innerHeight) { glClose(); return; }
  /* V14: */
  const own = b.closest(".card, li, .race, .tile") || b.parentElement;
  const hit = [...document.querySelectorAll("#scene .sheet .card, #scene .sheet button, #scene .sheet a[href], #scene .sheet .spell, #scene .sheet li")].filter((el) => el !== b && !pop.contains(el) && !b.contains(el) && el.offsetParent !== null);
  const rects = hit.map((el) => [el, el.getBoundingClientRect()]).filter(([, q]) => q.width > 0 && q.bottom > 0 && q.top < innerHeight);
  const clampX = (x) => Math.round(Math.max(m, Math.min(x, innerWidth - w - m))), clampY = (y) => Math.round(Math.max(m, Math.min(y, innerHeight - ht - m)));
  const cands = [[clampX(r.left), clampY(r.bottom + 8)], [clampX(r.left), clampY(r.top - ht - 8)], [clampX(r.right + 10), clampY(r.top - 4)], [clampX(r.left - w - 10), clampY(r.top - 4)]];
  let best = null;
  for (const [x, y] of cands) {
    if (x < r.right && x + w > r.left && y < r.bottom && y + ht > r.top) continue; /* never on top of its own word */
    let cost = 0; for (const [el, q] of rects) { const ox = Math.min(x + w, q.right) - Math.max(x, q.left), oy = Math.min(y + ht, q.bottom) - Math.max(y, q.top); if (ox > 0 && oy > 0) cost += ox * oy * (own && own.contains(el) ? 0.25 : 1); }
    if (!best || cost < best.cost - 400) best = { x, y, cost };
  }
  if (!best) best = { x: cands[0][0], y: cands[0][1] };
  pop.style.left = `${best.x}px`; pop.style.top = `${best.y}px`;
}
function glClose(focus) {
  const pop = $("#glpop"); if (!pop || pop.hidden) return false;
  pop.hidden = true; const b = GL.open; GL.open = null;
  if (b) { b.setAttribute("aria-expanded", "false"); if (focus && b.isConnected) b.focus({ preventScroll: true }); }
  return true;
}
function dotPanel(root) {
  const G = (D.party && D.party.glossary) || [];
  if (!root || !G.length || typeof document.createTreeWalker !== "function") return;
  if (!GL.re) { const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); GL.re = new RegExp(`(?<![A-Za-z0-9'])(${G.flatMap((g) => g.forms).sort((a, b) => b.length - a.length).map(esc).join("|")})(?![A-Za-z0-9'])`, "gi"); }
  const have = new Set([...root.querySelectorAll(".gl[data-term]")].map((b) => b.dataset.term));
  const skip = "a, button, label, input, select, textarea, summary, svg, h1, h2, h3, h4, .gl, .tt, .ttc, [aria-hidden=\"true\"], .lib, .tn-pick, .tn-chip, .tilt-note";
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), todo = [];
  /* text a reader cannot see yet (a shut details) waits until it opens, so the first dot is always on screen */
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.parentElement && !n.parentElement.closest(skip) && !n.parentElement.closest("details:not([open]), [inert]")) todo.push(n);
  for (let node of todo) {
    for (;;) {
      const text = node.nodeValue; GL.re.lastIndex = 0; let m, hit = null;
      /* a name, not the word: "Leader of the Pack" */
      while ((m = GL.re.exec(text))) { const g = glDef(m[1]); if (g && !have.has(g.term) && !/\bof the\s$/i.test(text.slice(0, m.index))) { hit = [m, g]; break; } }
      if (!hit) break;
      have.add(hit[1].term);
      const at = node.splitText(hit[0].index), rest = at.splitText(hit[0][1].length);
      at.replaceWith(dotBtn(hit[0][1], hit[1].term)); node = rest;
    }
  }
}
function startGloss() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".gl[data-term]");
    if (e.target.closest && e.target.closest(".gl-x")) { e.preventDefault(); e.stopPropagation(); glClose(true); return; }
    if (b) { e.preventDefault(); e.stopPropagation(); if (GL.open === b) glClose(); else glShow(b); return; }
    if (!(e.target.closest && e.target.closest("#glpop"))) glClose();
  }, true);
  addEventListener("scroll", () => glPlace(), { passive: true, capture: true });
  addEventListener("resize", () => glClose());
  sceneHooks.push(() => glClose());
  const sc = $("#scene"); if (!sc || typeof MutationObserver !== "function") return;
  let queued = false;
  const run = () => { queued = false; for (const p of sc.querySelectorAll(".panel:not([hidden]):not(#panel-library)")) { try { dotPanel(p); } catch (e) {} } };
  /* a re-render, a tab switch (a panel's hidden flips) or a details opening: */
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(run, 40); } }).observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open", "inert"] });
  sceneHooks.push((on) => { if (on) setTimeout(run, 40); });
}
/* Tile text never stops mid-sentence: whole sentences up to max, else whole clauses with an ellipsis. */
function wholeClause(t, max) {
  const text = String(t || "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(": "));
  if (end > max * 0.4) return text.slice(0, end + 1).replace(/[;:]$/, ".");
  const comma = cut.lastIndexOf(", ");
  if (comma > max * 0.4) return `${text.slice(0, comma)}…`;
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}
/* the sign-ups tile: one tankard per answer, poured full for in, half for maybe, a wax band for out, empty when nobody answered */
/* V13c (craft 15, spec 8): */
function kegRow(states) {
  const svg = s("svg", { viewBox: `0 0 ${states.length * 56} 48`, preserveAspectRatio: "xMinYMid meet" });
  states.forEach((st, i) => {
    const x = i * 56 + 2;
    const g = s("g", { class: `keg ${st}`, style: `--pi: ${i}`, "data-land": `signups.${st}` });
    g.append(s("image", { class: `keg-img ${st}`, href: `img/pints/${st}@2x.png`, x, y: 0, width: 48, height: 48 }), s("rect", { class: `keg-pint ${st} keg-fill`, x: x + 8, y: 10, width: 28, height: 34, "fill-opacity": 0, style: "fill: none" }));
    svg.append(g);
  });
  return svg;
}
/* V13b (spec 1.4): */
function miniRoads() {
  const svg = s("svg", { class: "mini-map", viewBox: "0 -10 600 420", "aria-hidden": "true", preserveAspectRatio: "xMidYMid meet" });
  svg.append(
    s("path", { class: "mm-land", d: "M0 30 C40 20 120 30 170 60 C190 110 160 170 110 190 C60 200 20 180 0 170 Z" }),
    s("path", { class: "mm-land", d: "M330 40 C400 30 470 50 540 80 C580 120 570 200 560 260 C540 320 470 360 390 380 C300 395 210 380 180 330 C170 280 220 230 260 200 C300 160 300 90 330 40 Z" }),
    ...ROADS.map((r) => s("path", { class: r.cls === "map-air" ? "mm-air" : "mm-road", d: r.d })), zeppelin(null));
  const gate = emb("dungeons", "viz-gate"); for (const [k, v] of Object.entries({ x: 444, y: 96, width: 52, height: 52 })) gate.setAttribute(k, v);
  svg.append(gate);
  const byZone = {};
  for (const m of D.party.members) (byZone[m.start_zone] ||= []).push(m);
  for (const [zone, ms] of Object.entries(byZone)) {
    const z = ZONES[zone]; if (!z) continue;
    ms.forEach((m, i) => {
      const tx = z.x + (i - (ms.length - 1) / 2) * 60, ty = z.y + 20;
      svg.append(s("g", { class: "mm-pin", transform: `translate(${tx} ${ty}) scale(1.7)`, style: `--cc: ${classVar(m.class_key)}`, "data-land": `roads.${MEM.slug(zone)}` },
        s("path", { class: "pin-body", d: "M0 0c-7-8-15-16-15-26a15 15 0 1 1 30 0c0 10-8 18-15 26z" }),
        s("image", { href: `img/crests/${m.class_key}.png`, x: -13, y: -39, width: 26, height: 26 })));
    });
  }
  return svg;
}
function miniRing(L) {
  const r = 38, C = 2 * Math.PI * r;
  const svg = s("svg", { viewBox: "-50 -50 100 100", "aria-hidden": "true" });
  let start = 0;
  L.categories.forEach((c, i) => {
    const len = (c.n / L.total) * C;
    svg.append(s("circle", { r, cx: 0, cy: 0, fill: "none", stroke: `var(--seg-${i + 1})`, "stroke-width": 8, "stroke-dasharray": `${Math.max(0, len - 1.5)} ${C}`, "stroke-dashoffset": -start, transform: "rotate(-90)" }));
    start += len;
  });
  svg.append(s("text", { class: "viz-ring-num", x: 0, y: 11, "text-anchor": "middle", text: String(L.earned_now) }));
  return svg;
}
function miniWheel() {
  const keys = D.party.members.map((m) => m.class_key), R = 40, pos = {};
  keys.forEach((k, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / keys.length; pos[k] = [Math.cos(a) * R, Math.sin(a) * R]; });
  const svg = s("svg", { viewBox: "-56 -56 112 112", "aria-hidden": "true" });
  for (const b of D.client.synergy) for (const to of b.to) {
    if (to === b.from || !pos[to] || !pos[b.from]) continue;
    svg.append(s("line", { class: "viz-thin", x1: pos[b.from][0], y1: pos[b.from][1], x2: pos[to][0], y2: pos[to][1], stroke: classVar(b.from) }));
  }
  for (const k of keys) svg.append(s("image", { href: `img/crests/${k}.png`, x: pos[k][0] - 10, y: pos[k][1] - 10, width: 20, height: 20, "data-land": `buffs.${k}` }));
  return svg;
}
function miniSpark(vals) {
  if (!vals.length) return null;
  const W = 200, H = 60, max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => `${(i * W) / Math.max(1, vals.length - 1)},${H - 4 - (v / max) * (H - 10)}`).join(" ");
  return s("svg", { viewBox: `-4 -4 ${W + 8} ${H + 8}`, "aria-hidden": "true", preserveAspectRatio: "none" }, s("polyline", { class: "viz-line", points: pts }));
}

function renderCards() {
  const wrap = $("#cards"); wrap.replaceChildren();
  const lvl = D.client.level;
  for (const m of D.party.members) {
    const spells = D.client.classes[m.class] || [];
    const card = h("article", { class: "card", "data-k": m.class_key, "data-slug": MEM.slug(m.name), style: `--cc: ${classVar(m.class_key)}`, "aria-label": `${m.name}, ${m.race} ${m.class}` });
    const flipBtn = (label) => h("button", { class: "flip", type: "button", "aria-pressed": "false", text: label, onclick: () => {
      const on = card.classList.toggle("flipped");
      sfx("flip", { delay: 120 });
      card.querySelectorAll(".flip").forEach((b) => b.setAttribute("aria-pressed", String(on)));
      card.querySelector(".front").inert = on; card.querySelector(".back").inert = !on;
      (on ? card.querySelector(".back .flip") : card.querySelector(".front .flip")).focus({ preventScroll: true });
    } });
    const profs = m.professions.map((p, pi) => h("span", {}, p.name, " ", h("span", { class: `chip stamp ${p.source}`, style: `--di: ${pi + 1}`, title: p.source === "board" ? "Written on the Party Board or in the group notes" : "Said in chat, not on the board yet" }, emb(p.source === "board" ? "seal" : "speech"), p.status ? `${SRC_WORD[p.source] || p.source}, ${p.status}` : SRC_WORD[p.source] || p.source)));
    const front = h("div", { class: "face front" },
      ART.crest[m.class_key] ? crestImg(m.class_key) : null,
      h("div", { class: "who", text: m.name }),
      h("div", { class: "what", text: `${m.race} ${m.class}` }),
      h("div", { class: "spec", text: m.spec }),
      h("dl", { "data-j": "g c e" },
        h("div", {}, h("dt", { text: "Role" }), h("dd", {}, h("span", { class: "role", text: m.role }), m.role_detail ? h("span", { class: "spec", text: m.role_detail }) : null)),
        h("div", { "data-j": "c e" }, h("dt", { text: "Spec" }), h("dd", {}, (m.spec_status.status === "open" ? h("span", { class: "chip stamp new open-lock" }, emb("lock"), "not chosen yet") : h("span", { class: "chip stamp board declared" }, emb("ribbon"), "chosen")))),
        h("div", {}, h("dt", { text: "Starts in" }), h("dd", { text: m.start_zone || "unknown" })),
        h("div", { "data-j": "c e" }, h("dt", { text: "Professions" }), h("dd", {}, profs.length ? profs : "none said yet"))),
      flipBtn(`${m.class} spells at ${lvl}`));
    const list = h("ul", { class: "spells" }, spells.map((sp) => {
      const vals = sp.values.map((v) => fmtVal(v, sp.duration_ms) + (v.basis === "base" && !v.label.startsWith("%") ? " (starting value; may grow with level)" : v.level != null && v.level < lvl ? ` (rank caps at ${v.level})` : "")).join(" · ");
      const meta = [fmtCost(sp.cost), sp.cast_ms ? `${fmtMs(sp.cast_ms)} cast` : "instant", sp.cooldown ? `${fmtMs(sp.cooldown.ms)} cooldown` : null,
        sp.duration_ms && !sp.values.some((v) => v.mode === "total") ? `lasts ${fmtMs(sp.duration_ms)}` : null, sp.learned ? `learned at ${sp.learned}` : null].filter(Boolean).join(" · ");
      return h("li", { class: "spell" }, h("div", { class: "spell-name" }, sp.name, sp.rank ? h("small", { text: ` ${sp.rank}` }) : null), vals ? h("div", { class: "spell-vals", text: vals }) : null, h("div", { class: "spell-meta", text: meta }));
    }));
    /* V13d (interaction 8): the back is a list of spell names; a tap opens the game-style card (js/v13d.js). Everything shows
       every row with its numbers, as V13c did. */
    list.setAttribute("data-j", "e");
    const names = h("ul", { class: "sp-names", "data-j": "g c", "aria-label": `${m.class} spells at ${lvl}` }, spells.map((sp, si) => h("li", {}, h("button", { type: "button", class: "sp-tt", "data-cls": m.class, "data-sp": si, "aria-expanded": "false", "aria-controls": "ttc" }, sp.name, sp.rank ? h("small", { text: ` ${sp.rank}` }) : null))));
    const back = h("div", { class: "face back" },
      h("div", { class: "back-head" }, h("h3", { text: `${m.class} at ${lvl}` }), h("span", { class: "label", text: `client ${D.client.build}` })),
      names, list, flipBtn(`Back to ${m.name}`));
    back.inert = true;
    card.append(h("div", { class: "card-inner" }, front, back));
    wrap.append(card);
  }
  const cards = [...wrap.querySelectorAll(".card")];
  const dots = D.party.members.map((m, i) => h("button", { class: "pager-crest", type: "button", "aria-label": `${m.name}'s card`, "aria-current": String(!i), style: `--cc: ${classVar(m.class_key)}`, onclick: () => cards[i].scrollIntoView({ behavior: reduceMQ.matches ? "auto" : "smooth", block: "nearest", inline: "center" }) }));
  dots.forEach((d, i) => d.append(crestMark(D.party.members[i])));
  $("#five-pager").replaceChildren(...dots);
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) dots.forEach((d, i) => d.setAttribute("aria-current", String(cards[i] === en.target))); }), { root: wrap, threshold: 0.6 });
    cards.forEach((c) => io.observe(c));
  }
}

const ZONES = {
  "Tirisfal Glades": { x: 92, y: 96, label: [60, 150] },
  "Mulgore": { x: 268, y: 318, label: [214, 372] },
  "Durotar": { x: 508, y: 238, label: [470, 292] },
};
const ROADS = [
  { key: "air", zone: "Tirisfal Glades", cls: "map-air", d: "M128 110 C 220 30, 360 30, 456 112", how: "the Undercity zeppelin" },
  { key: "mulgore", zone: "Mulgore", cls: "map-road", d: "M268 318 C 290 290, 330 250, 392 222 C 430 200, 455 160, 468 128", how: "the road past the Crossroads" },
  { key: "durotar", zone: "Durotar", cls: "map-road", d: "M508 238 C 520 210, 512 170, 478 130", how: "the Durotar road" },
];
/* SMIL on the map pauses while the page is hidden; the map redraws when the phone type ramp switches */
/* V13b: */
const MAPW = { drawn: 0 };
function mapWidth() {
  const b = $("#map"), w = b && b.clientWidth;
  /* the wide layout (js/wide.js): the box is the map's viewport and the map is what fits in it, no padding */
  if (w > 40) return Math.max(200, b.closest(".wide-map") ? Math.min(w, b.clientHeight * 1.5) : w - 20);
  if (innerWidth >= 700 && innerHeight >= 501) {
    const sw = innerWidth * (innerWidth >= 1100 && innerHeight <= 960 ? 0.9 : 0.85), bh = innerHeight * (innerWidth >= 1100 && innerHeight <= 960 ? 0.88 : 0.85) - 140, rm = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.max(200, sw / bh < 1.3 ? Math.min(sw, (bh - 230) * 1.5) : Math.min(bh * 1.5, sw - 19 * rm));
  }
  const sheet = innerWidth < 600 || innerHeight <= 500 ? innerWidth * 0.94 : innerWidth * 0.85;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, side = innerWidth >= 1300 && innerWidth / innerHeight >= 4 / 3;
  const H = innerHeight * 0.85, tall = side ? (H - 300 - 3 * rem + 20) * 1.5 : innerWidth >= 1300 ? (H - 470 - 6 * rem + 20) * 1.5 : 960;
  return Math.max(200, Math.min(side ? tall : Math.max(960, tall), sheet - 36 - (side ? 26 * rem + 28 : 0)) - 20);
}
/* V13b (owner-8): */
function mapUntangle() {
  /* in map units, from the drawing's own attributes and getBBox, so the pins' and plates' drop-in motion never skews it */
  const sv = $("#map svg"); if (!sv) return;
  MC.untangled = (MC.untangled || 0) + 1;
  const pad = 1.5, num = (e, a) => Number(e.getAttribute(a)) || 0;
  const hits = (a, b) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const fixed = [...sv.querySelectorAll(".banner-cloth")].map((r) => ({ x: num(r, "x"), y: num(r, "y"), w: num(r, "width"), h: num(r, "height") }));
  for (const p of sv.querySelectorAll(".map-pin")) { const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(p.getAttribute("transform") || ""); if (m) fixed.push({ x: +m[1] - 15, y: +m[2] - 42, w: 30, h: 42 }); }
  for (const e of sv.querySelectorAll(".map-mark")) fixed.push({ x: num(e, "x"), y: num(e, "y"), w: num(e, "width"), h: num(e, "height") });
  const placed = [];
  for (const t of sv.querySelectorAll(".map-text")) {
    let r; try { const b = t.getBBox(); r = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) { continue; }
    if (!r.w) continue;
    const ok = (b) => b.x >= 2 && b.y >= 2 && b.x + b.w <= 598 && b.y + b.h <= 398 && !fixed.some((o) => hits(b, o)) && !placed.some((o) => hits(b, o));
    let best = ok(r) ? [0, 0] : null;
    /* the nearest clear spot anywhere on the map (a scan in 3-unit steps; a few thousand box tests, once per opening) */
    if (!best) { let d0 = Infinity; for (let y = 2; y + r.h <= 398; y += 3) for (let x = 2; x + r.w <= 598; x += 3) { const d = (x - r.x) ** 2 + (y - r.y) ** 2; if (d < d0 && ok({ ...r, x, y })) { d0 = d; best = [x - r.x, y - r.y]; } } }
    if (best && (best[0] || best[1])) { MC.moved = (MC.moved || 0) + 1; t.setAttribute("x", (num(t, "x") + best[0]).toFixed(1)); t.setAttribute("y", (num(t, "y") + best[1]).toFixed(1)); }
    placed.push(best ? { ...r, x: r.x + best[0], y: r.y + best[1] } : r);
  }
}
function mapFit() { if (!D.party || !MAPW.drawn) return; const w = mapWidth(); if (Math.abs(w - MAPW.drawn) / MAPW.drawn > 0.16) renderMap(); }
/* a banner whose name runs longer than its cloth (a wide display name) is squeezed to fit, never clipped */
function fitBanners() { document.querySelectorAll("#map .banner-text").forEach((t) => { const max = Number(t.dataset.fit); t.querySelectorAll("tspan").forEach((l) => { try { if (l.getComputedTextLength() > max) { l.setAttribute("textLength", max); l.setAttribute("lengthAdjust", "spacingAndGlyphs"); } } catch (e) {} }); }); }
let mapVis = false;
function mapVisibility() {
  if (!mapVis) {
    mapVis = true;
    document.addEventListener("visibilitychange", mapClock);
    addEventListener("board-mode", mapClock); addEventListener("board-atlas", mapClock);
    window.matchMedia("(max-width: 699px)").addEventListener("change", () => { if (D.party) renderMap(); });
    sceneHooks.push(() => mapClock());
    if (typeof IntersectionObserver === "function") new IntersectionObserver((es) => { for (const en of es) MC.onScreen = en.isIntersecting; mapClock(); }).observe($("#map"));
  }
  mapClock();
}
/* V13a: */
const MAP_FPS = 30, MC = { timer: 0, raf: 0, last: 0, t: 0, onScreen: true };
/* integrator pass 3: the sketch stands still in Play and under the Atlas (it ran 30 frames a second behind the open Atlas) */
const mapLive = () => SC.open === "roads" && !document.hidden && !reduceMQ.matches && MC.onScreen && !roomHas("play") && !document.querySelector("#map.atlas-on");
function mapClock() {
  const svg = $("#map svg");
  if (!svg || typeof svg.pauseAnimations !== "function") return;
  try { svg.pauseAnimations(); svg.setCurrentTime(MC.t / 1000); } catch (e) {}
  if (!mapLive()) { clearTimeout(MC.timer); cancelAnimationFrame(MC.raf); MC.timer = MC.raf = 0; MC.last = 0; return; }
  if (!MC.timer && !MC.raf) MC.raf = requestAnimationFrame(mapStep);
}
function mapStep(now) {
  MC.raf = 0;
  const svg = $("#map svg");
  if (!svg || !mapLive()) { MC.last = 0; return; }
  if (MC.last) MC.t += Math.min(100, now - MC.last);
  MC.last = now;
  try { svg.setCurrentTime(MC.t / 1000); } catch (e) {}
  MC.timer = setTimeout(() => { MC.timer = 0; MC.raf = requestAnimationFrame(mapStep); }, Math.max(0, 1000 / MAP_FPS - 8));
}
/* an eight-point compass star, centre (x, y), long and short radii */
function STAR8(x, y, r1, r2) { let d = ""; for (let i = 0; i < 16; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 8, r = i % 2 ? r2 : i % 4 ? r1 * 0.7 : r1; d += `${i ? "L" : "M"}${(x + Math.cos(a) * r).toFixed(1)} ${(y + Math.sin(a) * r).toFixed(1)}`; } return `${d}Z`; }
/* V13b (owner-10): */
function zeppelin(am) {
  const g = s("g", { class: "map-zep-g", ...(am ? {} : { transform: "translate(292 52)" }) },
    s("ellipse", { class: "zep-shadow", cx: 3, cy: 20, rx: 17, ry: 4.2 }));
  /* V13c: the painted top-down zeppelin (generated art), nose along its route; the drawn hull stays as the fallback */
  if (ART.zep) { g.append(s("image", { class: "zep-img", href: "img/map/zeppelin.png", x: -20, y: -20, width: 40, height: 40, transform: "rotate(90)" })); if (am) g.append(am); return g; }
  g.append(
    s("path", { class: "zep-fin", d: "M-14 -1l-8-7h5l6 4zM-14 1l-8 7h5l6-4z" }),
    s("ellipse", { class: "zep-hull", rx: 17, ry: 7 }),
    s("path", { class: "zep-rib", d: "M-9 -6.2c1.4 4 1.4 8.4 0 12.4M0 -7c1.6 4.6 1.6 9.4 0 14M9 -6.2c1.4 4 1.4 8.4 0 12.4" }),
    s("path", { class: "zep-shine", d: "M-12 -3.6C-6 -6.4 6 -6.4 12 -3.6" }),
    s("path", { class: "zep-rope", d: "M-4 6.4l-1.2 2.4M4 6.4l1.2 2.4" }),
    s("rect", { class: "zep-gondola", x: -6, y: 8.6, width: 12, height: 4, rx: 1.4 }),
    s("path", { class: "zep-pole", d: "M12 -5.4v-8" }),
    s("path", { class: "zep-flag", d: "M12 -13.4h8l-2.2 2.4 2.2 2.4h-8z" }));
  if (am) g.append(am);
  return g;
}
function renderMap() {
  const box = $("#map"); box.replaceChildren();
  const svg = s("svg", { class: "map-svg", viewBox: "0 0 600 400", role: "img", "aria-label": "Map of the three Horde starting zones with paths to Orgrimmar" });
  const defs = s("defs", {});
  ROADS.forEach((r, i) => defs.append(s("mask", { id: `mask-${r.key}`, class: "draw-mask", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 600, height: 400 },
    s("path", { class: "draw", d: r.d, pathLength: 1, style: `--di: ${i}` }))));
  svg.append(defs,
    s("rect", { class: "map-sea", x: 0, y: 0, width: 600, height: 400 }),
    s("path", { class: "map-land", d: "M0 30 C40 20 120 30 170 60 C190 110 160 170 110 190 C60 200 20 180 0 170 Z" }),
    s("path", { class: "map-land", d: "M330 40 C400 30 470 50 540 80 C580 120 570 200 560 260 C540 320 470 360 390 380 C300 395 210 380 180 330 C170 280 220 230 260 200 C300 160 300 90 330 40 Z" }));
  const byZone = {};
  for (const m of D.party.members) (byZone[m.start_zone] ||= []).push(m);
  /* paint order is document order: the road lines, their trail prints, the walkers and the zeppelin (the "lines" layer) come
     first, then the town and crossroads marks and the place names, then the pins (the road-g groups), then the plates. So a
     line never runs over an icon. Each road has a lines group and a pin group, both keyed by data-road. */
  const lines = ROADS.map((r) => {
    const g = s("g", { class: "road-line", "data-road": r.key });
    /* V13a: the march is SMIL on the map's own clock (mapClock), not a CSS animation that repainted the page every refresh */
    const dur = r.cls === "map-air" ? "3.2s" : "2.4s", march = () => (reduceMQ.matches ? null : s("animate", { attributeName: "stroke-dashoffset", from: "0", to: "-36", dur, repeatCount: "indefinite" }));
    g.append(s("path", { class: `map-road-halo ${r.cls}`, d: r.d, mask: `url(#mask-${r.key})` }, march()),
      s("path", { id: `path-${r.key}`, class: r.cls, d: r.d, mask: `url(#mask-${r.key})` }, march()));
    svg.append(g); return g;
  });
  const groups = [];
  /* V11: each of the five is a pin carrying their class crest, with a name banner. Labels never collide: every banner tries
     a ladder of spots around its pin against the boxes already placed (fixed place names, other pins, other banners) and
     takes the first clear one, with a leader line when it had to move. Sizes follow the phone type ramp (26/24 units). */
  /* V13b (spec 1.5): a name is a small label (12.5 px on screen at any map size) on a quiet plate beside its pin, and place
     names 14 px, so the pins carry the map. The sizes are in map units for the map's drawn width; the map draws again when
     that width changes by more than a sixth (mapFit). */
  /* a larger map carries larger names (up to 1.8 times at 1400 px and more), so they stay readable at arm's length */
  const phone = innerWidth < 700, mw = mapWidth(), u = 600 / mw, tiny = mw < 330, bump = mw > 600 ? Math.min(1.8, 1 + (mw - 600) / 1000) : 1, FS = 13 * u * bump, BIG = (tiny ? 13 : 14.5) * u * bump, SMALL = 13 * u * bump /* mobile build (2026-10-30): 13 px on screen at least, the phone floor for labels (was 12.5, 11 on a tiny map) */, CH = 0.6;
  MAPW.drawn = mw;
  svg.style.setProperty("--fs", `${FS.toFixed(2)}px`); svg.style.setProperty("--fb", `${BIG.toFixed(2)}px`); svg.style.setProperty("--fsm", `${SMALL.toFixed(2)}px`);
  const boxes = [];
  const hit = (b) => b.x < 4 || b.y < 4 || b.x + b.w > 596 || b.y + b.h > 396 || boxes.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
  const textBox = (x, y, txt, fs, anchor) => { const w = txt.length * fs * 0.95 + fs * 0.6; /* small caps with tracking run wider than the banners; the outline stroke adds a little all round */ return { x: (anchor === "middle" ? x - w / 2 : x) - fs * 0.15, y: y - fs * 0.98, w, h: fs * 1.3 }; };
  const fixedText = (x, y, txt, cls, fs, anchor = "middle") => { boxes.push(textBox(x, y, txt, fs, anchor)); return s("text", { class: cls, x, y, "text-anchor": anchor, text: txt }); };
  svg.append(
    emb("dungeons", "map-mark"),
    fixedText(470, 88, "Orgrimmar", "map-text", BIG),
    ...(tiny ? [] : [fixedText(470, 122 + 26 + SMALL, "Valley of Strength", "map-text small", SMALL)]),
    ...(tiny ? [] : [fixedText(380, 250, "the Crossroads", "map-text small", SMALL)]),
    );
  const gate = svg.querySelector(".map-mark"); for (const [k, v] of Object.entries({ x: 456, y: 104, width: 28, height: 28 })) gate.setAttribute(k, v);
  if (ART.town) { const town = s("image", { class: "map-town", href: "img/map/town.png", x: 448, y: 98, width: 44, height: 44 }); const pa = gate.parentNode; pa.insertBefore(town, gate); pa.removeChild(gate); }
  const cross = emb("pin", "map-mark"); for (const [k, v] of Object.entries({ x: 382, y: 200, width: 20, height: 22 })) cross.setAttribute(k, v);
  svg.append(cross);
  boxes.push({ x: 454, y: 102, w: 32, h: 32 }, { x: 380, y: 198, w: 24, h: 26 });
  for (const r of ROADS) { const g = s("g", { class: "road-g", "data-road": r.key }); svg.append(g); groups.push(g); }
  const banners = [], zoneNames = [];
  let zi = 0;
  for (const [zone, ms] of Object.entries(byZone)) {
    const z = ZONES[zone]; if (!z) continue;
    const road = ROADS.find((r) => r.zone === zone);
    const g = road ? groups[ROADS.indexOf(road)] : svg;
    /* a starting zone flares once as the map opens: a drawn compass star, not a plain ring (owner-10) */
    g.append(s("path", { class: "zone-ring", d: STAR8(z.x, z.y, 20, 7), style: `--di: ${zi++}` }));
    zoneNames.push({ g, zone, x: z.label[0], y: z.label[1] + (phone ? 6 : 0) });
    /* V13b (owner-8): */
    const plates = ms.map((m) => { const nm = m.name, sp = nm.length > 12 ? [...nm.matchAll(/ /g)].map((x) => x.index).sort((p, q) => Math.abs(p - nm.length / 2) - Math.abs(q - nm.length / 2))[0] : undefined; const lines = sp === undefined ? [nm] : [nm.slice(0, sp), nm.slice(sp + 1)]; return { lines, w: Math.max(...lines.map((l) => l.length)) * FS * CH + FS * 1.2, h: lines.length * FS * 1.05 + FS * 0.75 }; });
    const maxw = Math.max(...plates.map((p) => p.w)), stagger = ms.length > 2 && ms.length * (maxw + 6) > 210;
    const step = Math.max(36, stagger ? (maxw + 8) / 2 : maxw + 8), span = step * (ms.length - 1);
    const x0 = Math.max(18 + maxw / 2 - (stagger ? 0 : 0), Math.min(582 - maxw / 2 - span, z.x - span / 2));
    ms.forEach((m, i) => {
      const tx = x0 + i * step, ty = z.y + 12;
      const pin = s("g", { class: "map-pin", transform: `translate(${tx} ${ty})`, style: `--cc: ${classVar(m.class_key)}; --di: ${zi + i}` },
        s("path", { class: "pin-body", d: "M0 0c-7-8-15-16-15-26a15 15 0 1 1 30 0c0 10-8 18-15 26z" }),
        s("image", { href: `img/crests/${m.class_key}.png`, x: -13, y: -39, width: 26, height: 26 }),
        s("title", { text: `${m.name}, ${m.race} ${m.class}` }));
      g.append(pin);
      boxes.push({ x: tx - 15, y: ty - 42, w: 30, h: 42 });
      banners.push({ g, m, tx, ty, plate: plates[i], row: stagger ? i % 2 : 0 });
    });
  }
  /* the plates last, so they keep clear of every pin and place name: */
  const labels = s("g", { class: "map-labels" }); /* drawn last, over the roads and the walkers */
  const clear = (b) => b.x >= 3 && b.y >= 3 && b.x + b.w <= 597 && b.y + b.h <= 397 && !boxes.some((o) => b.x < o.x + o.w + 2 && o.x < b.x + b.w + 2 && b.y < o.y + o.h + 2 && o.y < b.y + b.h + 2);
  for (const b of banners) {
    const { lines, w, h: hh } = b.plate;
    const x = Math.max(4, Math.min(596 - w, b.tx - w / 2));
    let at = null;
    for (let k = b.row; k < b.row + 8 && !at; k++) { const box = { x, y: b.ty + 4 + k * (hh + 3), w, h: hh }; if (clear(box)) at = box; }
    for (let k = 0; k < 6 && !at; k++) { const box = { x, y: b.ty - 46 - hh - k * (hh + 3), w, h: hh }; if (clear(box)) at = box; }
    /* still nothing: the nearest clear spot on a grid around the pin, rows below and above, steps sideways */
    for (let k = 0; k < 10 && !at; k++) for (const dy of [k, -k - 1]) for (const dx of [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65, 2.2, -2.2]) {
      if (at) break; const y = dy >= 0 ? b.ty + 4 + dy * (hh + 3) : b.ty - 46 - hh + (dy + 1) * (hh + 3); const box = { x: Math.max(4, Math.min(596 - w, x + dx * w)), y, w, h: hh }; if (clear(box)) at = box; }
    /* last: the nearest clear spot anywhere on the map, so a plate never lands on another */
    if (!at) { let d0 = Infinity; for (let y = 4; y + hh <= 396; y += 3) for (let x2 = 4; x2 + w <= 596; x2 += 3) { const d = (x2 - x) ** 2 + (y - b.ty) ** 2; if (d < d0 && clear({ x: x2, y, w, h: hh })) { d0 = d; at = { x: x2, y, w, h: hh }; } } }
    if (!at) at = { x, y: Math.min(396 - hh, b.ty + 4), w, h: hh };
    boxes.push(at);
    const mid = at.x + w / 2;
    if (at.y > b.ty + 8 || at.y + hh < b.ty - 40 || Math.abs(mid - b.tx) > w / 2) labels.append(s("path", { class: "pin-lead", d: `M${b.tx} ${at.y > b.ty ? b.ty + 1 : b.ty - 42}L${Math.max(at.x + 4, Math.min(at.x + w - 4, b.tx))} ${at.y > b.ty ? at.y : at.y + hh}` }));
    b.box = at; plateAt(at, lines, `--cc: ${classVar(b.m.class_key)}`);
  }
  /* the zone names, then the zeppelin's route card, each at its own spot if clear, else the nearest clear spot around it */
  const spotFor = (bx) => { for (let k = 0; k < 40; k++) for (const [dx, dy] of [[0, k], [0, -k], [k, 0], [-k, 0], [k, k], [-k, k], [k, -k], [-k, -k]]) { const b2 = { ...bx, x: Math.max(3, Math.min(597 - bx.w, bx.x + dx * 6)), y: Math.max(3, Math.min(397 - bx.h, bx.y + dy * 6)) }; if (clear(b2)) return b2; } let best = null, d0 = Infinity; for (let y = 3; y + bx.h <= 397; y += 3) for (let x = 3; x + bx.w <= 597; x += 3) { const d = (x - bx.x) ** 2 + (y - bx.y) ** 2; if (d < d0 && clear({ ...bx, x, y })) { d0 = d; best = { ...bx, x, y }; } } return best || bx; };
  for (const zn of zoneNames) {
    /* a zone's name sits under its pins' plates, centred on them, unless that is taken */
    const mine = banners.filter((b) => b.m.start_zone === zn.zone).map((b) => b.box).filter(Boolean);
    const tb0 = textBox(zn.x, zn.y, zn.zone, BIG, "start");
    const tb = mine.length ? { ...tb0, x: (Math.min(...mine.map((b) => b.x)) + Math.max(...mine.map((b) => b.x + b.w))) / 2 - tb0.w / 2, y: Math.max(...mine.map((b) => b.y + b.h)) + 4 } : tb0;
    const at = spotFor(tb); boxes.push(at);
    zn.g.append(s("text", { class: "map-text", x: zn.x + (at.x - tb0.x), y: zn.y + (at.y - tb0.y), "text-anchor": "start", text: zn.zone }));
  }
  /* the zeppelin's card: its full name, else "Zeppelin", else none on a map too small to hold it clear (the legend names it) */
  for (const name of ["Undercity zeppelin", "Zeppelin"]) {
    const lines = [name], w = name.length * FS * CH + FS * 1.2, hh = FS * 1.8, want = { x: 290 - w / 2, y: 6, w, h: hh }, at = spotFor(want);
    if (at === want && !clear(want)) continue;
    boxes.push(at); plateAt(at, lines, "--cc: var(--wax)", "route-plate"); break;
  }
  function plateAt(at, lines, style, extra) {
    const w = at.w, hh = at.h, mid = at.x + w / 2;
    labels.append(s("g", { class: `pin-banner${extra ? ` ${extra}` : ""}`, style },
      s("rect", { class: "banner-cloth", x: at.x, y: at.y, width: w, height: hh, rx: FS * 0.18 }),
      s("rect", { class: "banner-stripe", x: at.x + FS * 0.3, y: at.y + FS * 0.16, width: w - FS * 0.6, height: Math.max(1.2, FS * 0.12) }),
      s("text", { class: "banner-text", x: mid, y: at.y + FS * 0.42 + FS * 0.86, "text-anchor": "middle", "data-fit": Math.round(w - FS * 0.8) }, lines.map((l, li) => s("tspan", { x: mid, dy: li ? FS * 1.05 : 0, text: l })))));
  }
  if (!reduceMQ.matches) {
    /* a walking trail: the traveller's crest walks each road, leaving prints that fade at Orgrimmar; the zeppelin flies */
    const walk = (g, r, k, dur, begin) => {
      const ms = byZone[r.zone] || []; if (!ms.length) return;
      defs.append(s("mask", { id: `walk-${r.key}`, class: "draw-mask", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 600, height: 400 },
        s("path", { class: "walk-reveal", d: r.d, pathLength: 1 }, s("animate", { attributeName: "stroke-dashoffset", values: "1;0;0", keyTimes: "0;0.8;1", dur, begin, repeatCount: "indefinite" }))));
      const ln = lines[ROADS.indexOf(r)];
      ln.append(s("path", { class: "map-trail", d: r.d, pathLength: 1, mask: `url(#walk-${r.key})` }));
      const walker = s("g", { class: "map-walker" }, s("image", { href: `img/crests/${ms[k % ms.length].class_key}.png`, x: -11, y: -11, width: 22, height: 22 }));
      const am = s("animateMotion", { dur, begin, repeatCount: "indefinite", keyPoints: "0;1;1", keyTimes: "0;0.8;1", calcMode: "linear" }); am.append(s("mpath", { href: `#path-${r.key}` }));
      walker.append(am); ln.append(walker);
    };
    const am = s("animateMotion", { dur: "16s", repeatCount: "indefinite", rotate: "auto" }); am.append(s("mpath", { href: "#path-air" }));
    lines[0].append(zeppelin(am));
    walk(groups[1], ROADS[1], 0, "8s", "0s");
    walk(groups[2], ROADS[2], 0, "6s", "1s");
    /* nothing moves on a hidden page */
  }
  if (reduceMQ.matches) lines[0].append(zeppelin(null)); /* reduced motion: the zeppelin holds still at the top of its route */
  svg.append(labels);
  mapVisibility();
  if (SC.open === "roads") requestAnimationFrame(() => { fitBanners(); mapUntangle(); }); /* drawn again while open (a resize): measured again */
  const panel = h("div", { class: "road-panel", "aria-hidden": "true" });
  box.append(svg, panel);
  mapClock(); /* integrator pass 3: the new drawing is paused here too (mapVisibility above ran before it was in the page, so its marching roads ran 60 frames a second behind a closed scene and in Play) */
  const legend = $("#roads-legend"); legend.replaceChildren();
  let sticky = null;
  const btns = [];
  const light = (key) => {
    const k = key || sticky;
    svg.classList.toggle("focusing", !!k);
    groups.concat(lines).forEach((g) => g.classList.toggle("on", g.dataset.road === k));
    btns.forEach((b) => { b.classList.toggle("on", b.dataset.road === k); b.setAttribute("aria-pressed", String(b.dataset.road === sticky)); });
    const r = ROADS.find((x) => x.key === k);
    panel.classList.toggle("open", !!r);
    if (!r) return;
    const ms = byZone[r.zone] || [];
    panel.style.setProperty("--rc", classVar(ms[0] && ms[0].class_key));
    panel.replaceChildren(h("h3", { text: r.zone }), h("ol", {}, h("li", { text: ms.length ? `${andList(ms.map((m) => m.name))} wake${ms.length === 1 ? "s" : ""} here` : "Nobody starts here" }), h("li", { text: r.how.replace(/^the /, "The ") }), h("li", { text: "Orgrimmar" })));
  };
  const toggle = (key) => { sticky = sticky === key ? null : key; light(null); };
  for (const r of ROADS) {
    const ms = byZone[r.zone] || [];
    const b = h("button", { class: "road-btn", type: "button", "aria-pressed": "false", "data-road": r.key, style: `--rc: ${classVar(ms[0] && ms[0].class_key)}`,
      onclick: () => toggle(r.key), onpointerenter: () => light(r.key), onpointerleave: () => light(null), onfocus: () => light(r.key), onblur: () => light(null) },
      h("b", { text: r.zone }), h("span", { text: `${ms.length ? andList(ms.map((m) => m.name)) : "Nobody"} · ${r.how} to Orgrimmar` }));
    btns.push(b); legend.append(h("li", {}, b));
  }
  groups.concat(lines).forEach((g) => { g.addEventListener("pointerenter", () => light(g.dataset.road)); g.addEventListener("pointerleave", () => light(null)); });
  /* a tap on a road line (under the pins now) does what a tap on its zone does: the zone group takes it */
  lines.forEach((l, i) => l.addEventListener("click", (e) => { e.stopPropagation(); if (typeof groups[i].click === "function") groups[i].click(); }));
  /* V13d (interaction 4): zones are buttons; a click or Enter zooms the map to the zone (js/v13d.js), the road stays lit */
  KIT.emit("map", { svg, groups, lines, byZone, roads: ROADS, zones: ZONES, pick: (key) => { sticky = key; light(null); } });
  const meet = D.party.open.find((o) => /meeting point/i.test(o.title));
  const names = Object.entries(byZone).map(([z, ms]) => `${andList(ms.map((m) => m.name))} in ${z}`);
  $("#map-lede").textContent = `${names.join("; ")}. The Undercity zeppelin and two roads all end in Orgrimmar.`;
  $("#map-caption").replaceChildren(...(meet ? meetLine(meet) : []));
}

/* V11: a meeting point nobody chose reads as a step with the Sign-ups card link; the Classic-habit hint stays */
const unchosen = (o) => /nothing chosen|not chosen/i.test(o.status || "");
function meetLine(meet) {
  const url = D.party.signup_url;
  if (!unchosen(meet)) return [`${meet.title}: ${meet.status}. ${meet.detail || ""}`];
  return [h("b", { text: `${meet.title}: ` }), "Not chosen yet. ", url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: "Answer on the Sign-ups card" }) : "Answer on the Sign-ups card", ". ", meet.detail || ""];
}
function splitNotes(text) {
  const notes = [];
  let now = text.replace(/\s*\(([^()]*\b(?:Sep|Oct|Nov) \d[^()]*)\)/g, (m, x) => { notes.push(x); return ""; });
  now = now.split(/;\s*/).filter((c) => { if (/\b(?:Sep|Oct|Nov) \d/.test(c) && !/\bsince\b/.test(c)) { notes.push(c); return false; } return true; }).join("; ");
  return { now, notes: notes.flatMap((n) => n.split(/;\s*/)).filter(Boolean) };
}
function raceRow(r, i) {
  const { now, notes } = splitNotes(r.wiki ? r.wiki.replace(/^(active|passive),\s*/, "") : "Not on the wiki page yet.");
  const client = (r.client.values.length || r.client.cooldown_ms) ? `client ${r.client.build}: ${[...r.client.values.map((v) => fmtVal(v)), r.client.cooldown_ms ? `${fmtMs(r.client.cooldown_ms)} cooldown` : null].filter(Boolean).join(" · ")}${r.changed_oct26 ? " (this build predates the Oct 26 notes)" : ""}` : null;
  const head = [h("span", { class: "rname", text: r.name }), r.kind ? h("span", { class: "chip", text: r.kind }) : null, r.changed_oct26 ? h("span", { class: "chip new", text: `changed ${r.changed_on || "Oct 26"}` }) : null];
  const li = h("li", { class: "rrow", style: `--di: ${i}`, "data-key": MEM.slug(r.name), ...(r.changed_oct26 ? { "data-changed": r.changed_on || "Oct 26" } : {}) });
  /* V13d (interaction 3): closed by default, one plain line each (the first clause); the whole line, the dated notes and the
     client numbers open on tap. Everything opens every row. */
  const plain = wholeClause(now.split(/;\s*/)[0].replace(/\s*\([^)]*\)/g, ""), 90);
  const open = JR() === "everything";
  if (!notes.length && !client && plain === now) { li.append(h("div", { class: "rhead" }, ...head), h("div", { class: "rwiki", text: now })); return li; }
  if (open) li.classList.add("open");
  const btn = h("button", { class: "rhead", type: "button", "aria-expanded": String(open), onclick: () => { const on = li.classList.toggle("open"); btn.setAttribute("aria-expanded", String(on)); sfx("paper"); } }, ...head, h("span", { class: "rcaret", "aria-hidden": "true" }));
  li.append(btn, h("div", { class: plain === now ? "rwiki" : "rplain", text: plain }), h("div", { class: "rmore" }, h("div", {}, plain !== now ? h("p", { class: "rwiki rfull", text: now }) : null, notes.length ? h("ul", { class: "rnotes", "aria-label": "Dev notes" }, notes.map((n) => h("li", { text: n }))) : null, client ? h("div", { class: "rclient", text: client }) : null)));
  return li;
}
const wideMQ = window.matchMedia("(min-width: 900px)");
function renderRaces() {
  const wrap = $("#races"); wrap.replaceChildren();
  Object.entries(D.client.racials).forEach(([race, list], idx) => {
    const ms = D.party.members.filter((m) => m.race === race);
    wrap.append(h("details", { class: "slip race", "data-race": MEM.slug(race), open: wideMQ.matches || idx === 0 || JR() === "everything" },
      h("summary", {}, h("h3", {}, race, h("span", { class: "dots", "aria-hidden": "true" }, ms.map((m) => crestMark(m))), h("span", { class: "label", text: ms.map((m) => m.name).join(", ") }))),
      h("ul", {}, list.map((r, i) => raceRow(r, i)))));
  });
}
wideMQ.addEventListener("change", () => document.querySelectorAll("#races details").forEach((d, i) => { d.open = wideMQ.matches || i === 0; }));

const KIND_WORD = { toy: "a fun item with no stats", tabard: "a cloth crest worn over armor", pet: "a pet that follows you", mount: "a mount to ride" };
function renderLegacy() {
  const L = D.client.legacy, wrap = $("#legacy-ring"); wrap.replaceChildren();
  $("#legacy-lede").textContent = `${L.total} account-wide challenges, one point each. A character spends up to ${L.spend_cap} at launch, and one character can earn ${L.solo_cap} alone.`;
  const r = 84, C = 2 * Math.PI * r;
  const svg = s("svg", { viewBox: "-130 -130 260 260", role: "img", "aria-label": `Legacy: ${L.earned_now} of ${L.total} points` });
  svg.append(s("defs", {}, s("mask", { id: "mask-ring", class: "draw-mask", maskUnits: "userSpaceOnUse", x: -130, y: -130, width: 260, height: 260 },
    s("circle", { class: "draw", r, cx: 0, cy: 0, pathLength: 1, transform: "rotate(-90)", style: "stroke-width: 44; stroke-linecap: butt" }))));
  const ring = s("g", { mask: "url(#mask-ring)" });
  let start = 0;
  L.categories.forEach((c, i) => {
    const len = (c.n / L.total) * C;
    ring.append(s("circle", { class: "ring-seg", "data-cat": c.key, r, cx: 0, cy: 0, fill: "none", stroke: `var(--seg-${i + 1})`, "stroke-width": 16, "stroke-dasharray": `${Math.max(0, len - 2)} ${C}`, "stroke-dashoffset": -start, transform: "rotate(-90)" }, s("title", { text: `${c.key}: ${c.n}` })));
    start += len;
  });
  ring.append(s("circle", { r: r - 14, cx: 0, cy: 0, fill: "none", stroke: "var(--brass)", "stroke-width": 4, "stroke-dasharray": `${(L.earned_now / L.total) * C} ${C}`, transform: "rotate(-90)", opacity: 0.9 }));
  svg.append(ring);
  for (const t of L.thresholds) {
    const a = (t.n / L.total) * 2 * Math.PI - Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    svg.append(s("line", { class: "ring-tick", x1: ca * (r - 12), y1: sa * (r - 12), x2: ca * (r + 12), y2: sa * (r + 12) }));
    svg.append(s("text", { class: "ring-tlabel", x: ca * (r + 26), y: sa * (r + 26) + 4, "text-anchor": "middle", text: String(t.n) }));
  }
  svg.append(s("text", { class: "ring-num", x: 0, y: 8, "text-anchor": "middle", text: String(L.earned_now) }),
    s("text", { class: "ring-sub", x: 0, y: 28, "text-anchor": "middle", text: `OF ${L.total} POINTS` }));
  const legend = h("ul", { class: "legend", "data-j": "c e" }, L.categories.map((c, i) => h("li", { "data-cat": c.key, style: `--sw: var(--seg-${i + 1})` }, emb(EMB[c.key] ? c.key : c.key === "raids" ? "skull" : "seal", "cat-emb"), h("b", { class: "num", text: String(c.n) }), h("span", { text: `${c.key}: ${c.text.replace(/^\d+:\s*/, "")}` }))));
  const rewards = h("ul", { class: "rewards" }, L.thresholds.map((t) => h("li", { "data-n": t.n }, h("b", { text: t.alt ? `${t.n} (${t.alt})` : String(t.n) }), h("span", { text: `${t.reward}, ${KIND_WORD[t.kind] || t.kind}` }))));
  wrap.append(h("div", { class: "ring-box", "data-land-to": "ring" }, svg),
    h("div", { class: "stack" },
      h("p", { text: `Earned so far: ${L.earned_now}, because ${L.earned_note}.` }),
      h("div", {}, h("div", { class: "label", text: `Reward track, ${L.thresholds_label}` }), rewards),
      h("p", { class: "label", "data-j": "c e", text: `Claimed from ${L.claim}.` }),
      legend));
  KIT.emit("legacy", { svg, r, C, L, rewards, legend });
}

function renderWheel() {
  const wrap = $("#wheel"); wrap.replaceChildren();
  const keys = D.party.members.map((m) => m.class_key);
  const R = 112, pos = {};
  keys.forEach((k, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / keys.length; pos[k] = [Math.cos(a) * R, Math.sin(a) * R]; });
  const svg = s("svg", { viewBox: "-178 -178 356 356", role: "group", "aria-label": "Buff wheel between the five classes" });
  const edges = [];
  D.client.synergy.forEach((b, bi) => {
    const delay = `--di: ${Math.max(0, keys.indexOf(b.from))}`;
    for (const to of b.to) {
      if (to === b.from || !pos[to] || !pos[b.from]) continue;
      const [x1, y1] = pos[b.from], [x2, y2] = pos[to];
      const off = ((bi % 4) - 1.5) * 10;
      const cx = (x1 + x2) * 0.22 + off, cy = (y1 + y2) * 0.22 - off;
      const path = s("path", { class: "wheel-edge", d: `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`, style: `--ec: ${classVar(b.from)}; ${delay}`, "data-from": b.from, "data-b": bi, tabindex: 0, role: "img", "aria-label": `${(memberByKey(b.from) || {}).class || b.from} brings ${b.what} to ${(memberByKey(to) || {}).name || to}` });
      const tx = 0.12 * x1 + 0.88 * x2, ty = 0.12 * y1 + 0.88 * y2;
      const tip = s("circle", { class: "wheel-tip", cx: (tx * 0.85 + cx * 0.15), cy: (ty * 0.85 + cy * 0.15), r: 3.2, style: `--ec: ${classVar(b.from)}; ${delay}`, "data-from": b.from, "data-b": bi });
      edges.push(path, tip); svg.append(path, tip);
    }
  });
  const nodes = keys.map((k) => {
    const m = memberByKey(k), [x, y] = pos[k];
    const g = s("g", { class: `wheel-node${ART.crest[k] ? " has-crest" : ""}`, tabindex: 0, role: "button", "aria-pressed": "false", "aria-label": `${m.name}, ${m.class}: show buffs`, style: `--nc: ${classVar(k)}`, "data-k": k, "data-x": x, "data-y": y },
      s("circle", { cx: x, cy: y, r: 26 }), ART.crest[k] ? crestSvg(k, x, y) : null, s("text", { x, y: y + 44, text: m.name }), s("text", { x, y: y + 60, style: "font-size:16.5px;fill:var(--l-text)", text: m.class }));
    svg.append(g); return g;
  });
  const meKey = (MEM.member() || {}).class_key;
  const items = [...D.client.synergy].sort((a, b) => (b.from === meKey) - (a.from === meKey)).map((b) => {
    const nums = b.refs.filter((r) => r.kind === "client").map((r) => `${fmtVal(r)} (${r.name})`).join(" · ");
    const src = b.refs.filter((r) => r.kind !== "client").map((r) => h("div", { class: "buff-src" }, r.kind === "memory" ? h("span", { class: "chip memory", text: "from memory" }) : h("span", { class: "chip board", text: "wiki" }), " ", r.text));
    const giver = memberByKey(b.from), to = b.to.filter((k) => k !== b.from).map((k) => (memberByKey(k) || {}).name).filter(Boolean);
    return h("li", { class: `buff${b.from === meKey ? " me" : ""}`, style: `--bc: ${classVar(b.from)}`, "data-from": b.from },
      h("div", { class: "buff-what" }, `${giver ? giver.class : b.from} brings ${b.what} (${b.lands_on})`),
      h("div", { class: "label", text: `${giver ? `${giver.name} · ` : ""}reaches ${b.to.includes(b.from) ? "everyone" : to.join(", ")}` }),
      nums ? h("div", { class: "buff-nums", text: nums }) : null, src);
  });
  let active = null;
  const setActive = (k) => {
    active = active === k ? null : k;
    edges.forEach((e) => e.classList.toggle("on", active !== null && e.dataset.from === active));
    nodes.forEach((n) => { n.classList.toggle("on", n.dataset.k === active); n.setAttribute("aria-pressed", String(n.dataset.k === active)); });
    items.forEach((i) => i.classList.toggle("dim", active !== null && i.dataset.from !== active));
  };
  nodes.forEach((n) => { n.addEventListener("click", () => setActive(n.dataset.k)); n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive(n.dataset.k); } }); });
  const wide = !window.matchMedia || window.matchMedia("(min-width: 700px)").matches;
  wrap.append(h("details", { class: "wheel-svg", ...(wide ? { open: "" } : {}) }, h("summary", { text: "The wheel between the five" }), svg), h("details", { class: "wheel-links", id: "wheel-links" }, h("summary", { text: `The wheel's ${D.client.synergy.length} links, with sources` }), h("ul", { class: "buffs" }, items)));
}
/* V8: */
const BUFF_STATUS = { forever: "Forever", classic: "Classic baseline", unknown: "Unknown" };
/* V13c (owner-6, spec 6): every buff carries a painted emblem of what it gives (assets/board/generated, generated with ChatGPT) */
const BUFF_CAT = { arcane_intellect: "intellect", conjure: "mana", fortitude: "stamina", shadow_protection: "resistance", divine_spirit: "spirit", pw_shield: "armor", kings: "allstats", might: "attackpower", wisdom: "mana", salvation: "spirit", devotion: "armor", retribution: "thorns", concentration: "intellect", mark: "allstats", thorns: "thorns", innervate: "mana", rebirth: "healing", leader: "attackpower", soulstone: "healing", healthstone: "healing", summoning: "spirit", blood_pact: "stamina", strength_earth: "attackpower", grace_air: "attackpower", windfury: "attackpower", mana_spring: "mana", healing_stream: "healing" };
const buffCat = (b) => BUFF_CAT[b.key] || (/intellect/i.test(b.name) ? "intellect" : /stamina|fortitude/i.test(b.name) ? "stamina" : /mana/i.test(b.name) ? "mana" : /heal/i.test(b.name) ? "healing" : "allstats");
const buffEmb = (b) => h("img", { class: "bq-emb", src: `img/buffs/${buffCat(b)}.png`, alt: "", width: 96, height: 96, loading: "lazy", decoding: "async" });
/* the animated link: pointing at a buff (or focusing it) draws a moving thread from its giver to each receiver on the wheel */
function wheelFlow(b) {
  const edges = document.querySelectorAll("#wheel .wheel-edge");
  edges.forEach((e) => { const s = D.client.synergy[Number(e.dataset.b)]; e.classList.toggle("flow", !!b && !!s && (s.what === b.name || (s.from === b.class && !D.client.synergy.some((x) => x.what === b.name)))); });
  const w = $("#wheel"); if (w) w.classList.toggle("flowing", !!b);
}
const BD = { level: 60, sixth: false };
const buffTok = (key) => `buffs.${key.replace(/_/g, "-")}`;
function buffWho(b, m) { /* does member m receive buff b */
  if (b.lands === "tank") return m.role === "tank";
  if (b.lands === "healer") return m.role === "healer";
  if (b.lands === "melee") return m.class_key === "druid" || m.class_key === "paladin";
  return true;
}
function renderBuffsDeep() {
  const box = $("#buffs-deep"), B = D.client && D.client.buffs; if (!box || !B) return;
  try { const v = Number(localStorage.getItem("board-buff-level")); if (v >= 1 && v <= 60) BD.level = v; } catch (e) {}
  const P = D.party, me = MEM.member(), L = BD.level;
  const giverOf = (cls) => P.members.find((m) => m.class_key === cls);
  const fmtN = (v) => `${nf.format(Math.round(v.n))}${v.max !== undefined ? ` to ${nf.format(Math.round(v.max))}` : ""}${/^%/.test(v.label) ? "" : " "}${v.label}`;
  const first = (b) => (b.ranks.length ? Math.min(...b.ranks.map((r) => r.learned)) : null);
  const ranksAt = (b) => { const a = b.at[L - 1]; return a ? a.r.filter((i) => i >= 0).map((i) => b.ranks[i]) : []; };
  /* the short answer: the value at this level, or when it arrives */
  const short = (b) => {
    const a = b.at[L - 1];
    if (!b.ranks.length) return b.classic ? "numbers not out yet" : "no numbers yet";
    if (!a) return `arrives at ${first(b)}`;
    return a.v.length ? a.v.map(fmtN).join(", ") : `${ranksAt(b).map((r) => r.rank || "one rank").join(" and ")}`;
  };
  const sources = (b) => {
    const rk = ranksAt(b), a = b.at[L - 1], extra = [];
    if (a && rk[0] && rk[0].mana != null) extra.push(`${nf.format(rk[0].mana)} mana on return`);
    if (a && rk[0] && rk[0].cooldown_ms) extra.push(`cooldown ${Math.round(rk[0].cooldown_ms / 60000)} min`);
    if (b.group && b.group_from) extra.push(L >= b.group_from ? `the group version, ${b.group}, covers everyone` : `the group version, ${b.group}, comes at ${b.group_from}`);
    const rankLine = !b.ranks.length ? null : !a ? `Not yet: learned at ${first(b)}` : a.v.length ? `${rk.map((r) => r.rank || "One rank").join(" and ")}: ${a.v.map(fmtN).join(", ")}` : `${rk.map((r) => `${rk.length > 1 ? `${r.name.replace(/^Conjure /, "")} ` : ""}${r.rank || "one rank"}`).join(", ")} (learned at ${rk.map((r) => r.learned).join(" and ")})`;
    const own = rulesFor(b);
    const notes = [...b.wiki.map((w) => h("li", {}, h("span", { class: "st forever", text: "Forever" }), ` ${w.text}`)), b.classic ? h("li", {}, h("span", { class: "st classic", text: "Classic baseline" }), ` ${b.classic.replace(/^Classic baseline: /, "")}`) : null].filter(Boolean);
    return (line) => h("details", { class: "bsrc" }, h("summary", { class: "bq-line" }, h("span", { class: "bq-what" }, ...line.slice(0, -1)), h("span", { class: "bq-who" }, line[line.length - 1], h("span", { class: "bq-src", text: "Details" }))),
      rankLine ? h("div", { class: "deep-val", text: rankLine }) : null,
      own.length ? h("div", { class: "deep-stack" }, h("b", { text: "How it stacks: " }), own.some((r) => /newer cast replaces the older/i.test(r.text)) ? h("p", { class: "deep-plain", text: "In short: two of the same buff do not stack; the newer cast replaces the older." }) : null, h("ul", { class: "deep-notes" }, own.map((r) => h("li", {}, h("span", { class: `st st-${r.status}`, text: BUFF_STATUS[r.status] }), ` ${r.text}`)))) : null,
      h("div", { class: "deep-meta", text: [b.lands_text, ...extra].join(" · ") }),
      b.ranks.length ? h("div", { class: "deep-src", text: `Client table ${B.build.split(".").pop()}, spell ${rk.length ? rk.map((r) => r.spell).join(", ") : b.ranks[0].spell}` }) : null,
      notes.length ? h("ul", { class: "deep-notes" }, notes) : null);
  };
  /* one buff on one line: name, value at this level, giver; its Sources toggle under it */
  const row = (b, own, noFrom) => { /* own: the giver group copy carries the id, so ids stay unique; noFrom: a heading already names the giver */
    const giver = giverOf(b.class), later = !b.at[L - 1];
    return h("li", { class: `bq${later ? " later" : ""}`, style: `--bc: ${classVar(b.class === "shaman" ? null : b.class)}`, "data-key": b.key, ...(own === true ? { id: `buff-${b.key}` } : {}) },
      sources(b)([buffEmb(b), h("b", { text: b.name }), h("span", { class: "bq-val", text: short(b) }), noFrom ? null : h("span", { class: "bq-from", text: giver ? giver.name : b.class === "shaman" ? "a shaman" : "" })]));
  };
  /* the group rules that name this buff, its group version, or (for Blessings and auras) its kind */
  function rulesFor(b) {
    const words = [b.name, b.group, /^Blessing/.test(b.name) ? "Blessing" : null, b.aura ? "aura" : null].filter(Boolean);
    return B.rules.filter((r) => words.some((w) => r.text.includes(w)));
  }
  const shown = B.list.filter((b) => !b.sixth || BD.sixth);
  const classes = [...P.members.map((m) => m.class_key), ...(BD.sixth ? ["shaman"] : [])];
  const slider = h("input", { type: "range", id: "deep-level", min: 1, max: 60, step: 1, value: L, "aria-label": "Character level", "aria-valuetext": `Level ${L}` });
  const marks = h("div", { class: "deep-marks", role: "group", "aria-label": "Jump to a level" }, B.marks.map((k) => h("button", { type: "button", class: "lib-tool", "aria-pressed": String(L === k), "aria-label": `Level ${k}`, text: String(k) })));
  const six = h("label", { class: "deep-six" }, h("input", { type: "checkbox", id: "deep-sixth", ...(BD.sixth ? { checked: "" } : {}) }), " Show what a Shaman would add");
  let answer;
  if (me) {
    const give = shown.filter((b) => b.class === me.class_key);
    const get = shown.filter((b) => b.class !== me.class_key && buffWho(b, me) && (giverOf(b.class) || (b.sixth && BD.sixth)));
    answer = h("div", { class: "deep-cols foryou" },
      h("div", { class: "deep-col get" }, h("h4", { text: `You get (${get.length})` }),
        ...classes.map((cls) => [cls, get.filter((b) => b.class === cls)]).filter(([, l]) => l.length).map(([cls, l]) => {
          const g = giverOf(cls);
          return h("section", { class: "bq-giver", "aria-label": g ? `From ${g.name}` : "From a shaman", style: `--bc: ${classVar(cls === "shaman" ? null : cls)}` },
            h("h5", { text: g ? `From ${g.name}, ${g.class}` : "From a sixth player, Shaman" }), h("ul", { class: "bq-list" }, l.map((b) => row(b, false, true))));
        })),
      h("div", { class: "deep-col" }, h("h4", { text: `You give, ${me.name}` }), h("ul", { class: "bq-list" }, give.map((b) => row(b, false, true)))));
  } else answer = null; /* who gives what: the giver groups below, each naming its buffs, one tap from the numbers */
  const groups = classes.map((cls) => {
    const g = giverOf(cls), list = shown.filter((b) => b.class === cls);
    return h("details", { class: "bclass", "data-class": cls, style: `--bc: ${classVar(cls === "shaman" ? null : cls)}` },
      h("summary", {}, h("b", { text: g ? `${g.name}, ${g.class}` : "A sixth player, Shaman" }), h("span", { class: "bclass-names" }, list.flatMap((b, i) => [h("span", { class: "bn" }, buffEmb(b), b.name, i < list.length - 1 ? h("span", { class: "bc", text: "," }) : null), i < list.length - 1 ? " " : null]).filter(Boolean))),
      h("ul", { class: "bq-list" }, list.map((b) => row(b, true))));
  });
  const rules = ["forever", "classic", "unknown"].map((st) => {
    const list = B.rules.filter((r) => r.status === st);
    return h("details", { class: `brules ${st}` }, h("summary", {}, emb({ forever: "seal", classic: "book", unknown: "question" }[st]), h("span", { class: `st st-${st}`, text: BUFF_STATUS[st] }), ` ${plural(list.length, "rule", "rules")}`),
      h("ul", { class: "deep-rules" }, list.map((r) => h("li", { text: r.text }))));
  });
  box.replaceChildren(...[
    h("h3", { id: "deep-h", text: me ? "For you" : "Who gives what" }),
    /* V12: with a name picked, a plain "Change person" control brings the picker back */
    me && !BD.pick ? h("div", { class: "deep-who", role: "group", "aria-label": "Whose buffs are shown" }, h("b", { class: "deep-me", text: `Showing ${me.name}, ${me.race} ${me.class}.` }), h("button", { type: "button", class: "lib-tool", id: "deep-change", onclick: () => { BD.pick = true; renderBuffsDeep(); const x = $("#buffs-deep .deep-who button"); if (x) x.focus({ preventScroll: true }); } }, "Change person"))
      : h("div", { class: "deep-who", role: "group", "aria-label": "Who are you? Pick a name to see what you get" }, h("b", { text: "Who are you? " }), D.party.members.map((m) => h("button", { type: "button", class: "lib-tool", "aria-pressed": String(!!me && me.name === m.name), style: `--cc: ${classVar(m.class_key)}`, onclick: () => { BD.pick = false; MEM.setMe(MEM.slug(m.name)); try { renderTonight(); markMe(); renderWheel(); } catch (e) {} renderBuffsDeep(); const x = $("#deep-change"); if (x) x.focus({ preventScroll: true }); } }, crestMark(m), m.name))),
    h("div", { class: "deep-ctl" }, h("label", { for: "deep-level", class: "deep-l" }, "Level ", h("b", { id: "deep-l", text: String(L) })), slider, marks, six),
    /* V12: the stat words the buffs use, in plain words */
    h("p", { class: "deep-key", text: "Stamina adds health, Intellect adds mana, Spirit refills health and mana faster." }),
    answer,
    me ? h("h4", { class: "bgroup-h", text: `Every buff, by giver (${shown.length})` }) : null, h("div", { class: "bclasses" }, groups),
    h("h4", { class: "bgroup-h", text: `Rules in a group (${B.rules.length})` }), h("div", { class: "brules-row" }, rules)].filter(Boolean));
  const set = (v) => { BD.level = v; try { localStorage.setItem("board-buff-level", String(v)); } catch (e) {} renderBuffsDeep(); const el = $("#deep-level"); if (el) el.focus({ preventScroll: true }); };
  slider.addEventListener("input", () => set(Number(slider.value)));
  marks.querySelectorAll("button").forEach((b, i) => b.addEventListener("click", () => { set(B.marks[i]); const x = $("#buffs-deep .deep-marks button[aria-pressed=\"true\"]"); if (x) x.focus(); }));
  six.querySelector("input").addEventListener("change", (e) => { sfx("latch"); BD.sixth = e.target.checked; renderBuffsDeep(); const x = $("#deep-sixth"); if (x) x.focus(); });
  /* V13c: the level slider clicks into its detents at the marks */
  slider.addEventListener("input", () => { if (B.marks.includes(Number(slider.value))) sfx("detent"); });
  const rowOf = (e) => { const li = e.target.closest && e.target.closest("li.bq[data-key]"); return li ? B.list.find((x) => x.key === li.dataset.key) : null; };
  box.addEventListener("pointerover", (e) => wheelFlow(rowOf(e)));
  box.addEventListener("pointerleave", () => wheelFlow(null));
  box.addEventListener("focusin", (e) => wheelFlow(rowOf(e)));
  box.addEventListener("focusout", () => wheelFlow(null));
}
/* #buffs.<key>: open that buff's giver group and its sources, and light it */
function focusBuff(tokKey) {
  const key = String(tokKey).replace(/-/g, "_"), B = D.client && D.client.buffs;
  const b = B && B.list.find((x) => x.key === key); if (!b) return false;
  if (b.sixth && !BD.sixth) { BD.sixth = true; renderBuffsDeep(); }
  const grp = document.querySelector(`#buffs-deep .bclass[data-class="${b.class}"]`); if (grp) grp.open = true;
  const li = grp && grp.querySelector(`li[data-key="${key}"]`); if (!li) return false;
  const src = li.querySelector("details.bsrc"); if (src) src.open = true;
  document.querySelectorAll("#buffs-deep li.lit").forEach((x) => x.classList.remove("lit"));
  li.classList.add("lit");
  try { li.scrollIntoView({ block: "center" }); } catch (e) {}
  return true;
}
function setBuffView(v) {
  $("#wheel").classList.toggle("list-view", v === "list");
  const wl = $("#wheel-links"); if (wl) wl.open = v === "list";
  $("#view-wheel").setAttribute("aria-pressed", String(v !== "list"));
  $("#view-list").setAttribute("aria-pressed", String(v === "list"));
  try { localStorage.setItem("board-buff-view", v); } catch (e) {}
}

const ART = { crest: {}, seal: false, beam: false, zep: false, town: false };
const seal = () => h("span", { class: `seal${ART.seal ? " art" : ""}`, "aria-hidden": "true" }, ART.seal ? h("img", { src: "img/seal.png", alt: "", width: 64, height: 64, decoding: "async" }) : emb("seal"));
/* where a ledger line was written: the Party Board under a wax seal, the group notes under a quill */
const srcTag = (src) => h("span", { class: `label srctag ${src === "board" ? "board" : "notes"}` }, emb(src === "board" ? "seal" : "quill"), SRC_WORD[src] || src);
const SRC_WORD = { board: "on the Party Board", chat: "said in chat", "group notes": "in the group notes" };
/* V12: a time in the viewer's own zone, short ("Thu, Oct 29, 1:37 PM"); with a zone, that zone's clock instead */
function whenLocal(epoch, tz) { return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) }).format(new Date(epoch * 1000)).replace(":00", ""); }
function renderLedger() {
  const p = D.party, wrap = $("#ledger-slip"); wrap.replaceChildren();
  const link = (l, o) => h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer", text: /discord\.com\/events\//.test(l.url) ? "the launch-night event in Discord" : `${l.label}${o ? ` for ${o.title.toLowerCase()}` : ""} in Discord` });
  const pollNames = p.polls.map((q) => q.title.toLowerCase());
  $("#ledger-lede").textContent = p.polls.length
    ? `What is settled, what is open, and ${p.polls.length === 1 ? "a poll" : `${p.polls.length} polls`} to vote in: ${andList(pollNames)}.`
    : "Settled things and open things. No poll is taking votes right now.";
  wrap.append(h("div", { class: "ledger-col" },
    h("h3", { "data-j": "c e", text: "Settled" }),
    /* V12: the Party Board's "Next up" line on what it takes to play closes the Settled list */
    h("ul", { "data-j": "c e" }, [...p.settled, ...p.settled_extra].map((x, i, all) => h("li", { class: "settled-li", style: `--di: ${i}`, ...(i === all.length - 1 ? { "data-land-to": "settled" } : {}) }, h("span", {}, seal(), x.text), srcTag(x.source))),
      p.play ? h("li", { class: "settled-li next-li", style: `--di: ${p.settled.length + p.settled_extra.length}` }, h("span", {}, seal(), p.play.text), srcTag(p.play.source)) : null),
    p.polls.length ? h("h3", { text: "Polls taking votes" }) : null,
    ...p.polls.map((q) => h("div", { class: "poll" }, h("strong", { text: q.title }), q.closes_epoch ? h("span", {}, `Closes ${whenLocal(q.closes_epoch)} your time`, h("small", { class: "et-anchor", text: ` (${whenLocal(q.closes_epoch, "America/New_York").replace(whenLocal(q.closes_epoch).replace(/,[^,]*$/, ""), "").replace(/^,\s*/, "")} ET)` }), `. ${q.text.replace(/^poll closes on [^.]*?ET\.\s*/i, "")}`) : h("span", { text: q.text }), h("a", { href: q.url, target: "_blank", rel: "noopener noreferrer", text: `Open the ${q.title.toLowerCase()} poll in Discord` })))),
    h("div", { class: "ledger-col" }, h("h3", { text: "Still open" }),
    h("ul", {}, p.open.filter((o) => !p.polls.some((q) => q.title === o.title)).map((o, i) => h("li", { class: "open-li", style: `--di: ${i}`, "data-land-to": `open-${i}`, "data-title": o.title },
      h("strong", { text: o.title }),
      h("span", { "data-j": "c e" }, ...(unchosen(o) ? meetLine(o).slice(1) : linkify((o.status ? `${o.status}. ${o.detail || ""}` : o.text || "").replace(/\(Pacific\)/g, "(Pacific time)"), o.links || [], (l) => link(l, o))),
        /* V16: the professions item opens the decision view, where each option's facts are */
        /profession/i.test(o.title) ? [" ", h("a", { class: "tn-link ledger-decide", href: "#decide", text: "The options, by person." })] : null),
      srcTag(o.source))))));
  KIT.emit("ledger");
}

function linkify(text, ls, link) {
  const out = []; let rest = text;
  for (const l of ls) {
    const i = rest.indexOf(l.label);
    if (i < 0) { out.push(rest, " "); rest = ""; out.push(link(l)); continue; }
    out.push(rest.slice(0, i), link(l)); rest = rest.slice(i + l.label.length);
  }
  out.push(rest);
  return out;
}

function renderLibrarian() {
  const st = D.stats, wrap = $("#lib-box"); wrap.replaceChildren();
  const stat = (label, value) => h("div", { class: "stat" }, h("b", { text: value }), h("span", { class: "label", text: label }));
  const vals = st.last7.map((x) => x.seconds);
  const W = 260, H = 70, pad = 10, max = Math.max(...vals, 1);
  const xs = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, vals.length - 1), ys = (v) => H - pad - (v / max) * (H - 2 * pad - 10);
  const pts = vals.map((v, i) => `${xs(i)},${ys(v)}`).join(" ");
  const spark = s("svg", { viewBox: `0 0 ${W} ${H + 14}`, role: "img", "aria-label": `Last ${vals.length} answer times in seconds: ${vals.join(", ")}` },
    s("line", { class: "spark-grid", x1: pad, x2: W - pad, y1: H - pad, y2: H - pad }),
    s("line", { class: "spark-grid", x1: pad, x2: W - pad, y1: ys(max), y2: ys(max), "stroke-dasharray": "2 4" }),
    s("polygon", { class: "spark-area", points: `${xs(0)},${H - pad} ${pts} ${xs(vals.length - 1)},${H - pad}` }),
    s("polyline", { class: "spark-line", points: pts, pathLength: 1 }),
    ...vals.slice(0, -1).map((v, i) => s("path", { class: "spark-dot", d: `M${xs(i)} ${ys(v) - 3}l3 3-3 3-3-3z` })),
    s("path", { class: "spark-drop", d: `M${xs(vals.length - 1)} ${ys(vals[vals.length - 1]) - 8}c3 4 5 6.6 5 9.2a5 5 0 0 1-10 0c0-2.6 2-5.2 5-9.2z` }, s("title", { text: `The red wax drop marks his newest answer: ${vals[vals.length - 1]} seconds` })),
    (() => { const q = emb("quill", "spark-quill"); for (const [k, v] of Object.entries({ x: xs(vals.length - 1) - 34, y: ys(vals[vals.length - 1]) - 2, width: 22, height: 22 })) q.setAttribute(k, v); q.append(s("title", { text: "The quill draws the line, newest answer last" })); return q; })(),
    ...vals.map((v, i) => s("text", { class: "spark-text", x: xs(i), y: H + 10, "text-anchor": "middle", text: String(v) })),
    s("text", { class: "spark-text", x: W - pad, y: ys(max) - 4, "text-anchor": "end", text: `${max} s` }));
  wrap.append(
    h("div", { class: "stack" },
      h("div", { class: "stats" }, stat("answers", String(st.answers)), stat("median reply", fmtSecs(st.median_s)), stat("slowest 1 in 20", fmtSecs(st.p95_s)), stat("wiki pages", String(st.wiki_pages)), stat("wiki facts", nf.format(st.wiki_facts))),
      h("p", { class: "lib-note", text: `Reply time runs from a question being filed to Leeroy's answer. ${st.misses} of ${st.answers} took longer than ${fmtSecs(st.miss_threshold_s)}.${st.p95_s > st.miss_threshold_s ? " Those slow ones set the slowest 1 in 20." : ""}` })),
    h("div", { class: "spark" }, h("div", { class: "label", text: `Last ${vals.length} answers, seconds` }), spark, h("p", { class: "spark-key", text: `The wax drop marks his newest answer. The line is seconds to answer over his last ${vals.length}; the quill draws it.` })));
}

function renderFooter() {
  const stamp = ["party", "timeline", "client", "stats", "signups"].filter((k) => D[k]).map((k) => D[k].generated).sort().pop();
  const when = fmtWhen(Date.parse(stamp) / 1000); /* V13c (consistency 10): the one formatter, not a UTC stamp */
  $("#footer").replaceChildren(
    h("span", {}, "Generated from the group's own records on ", h("span", { class: "num", text: when }), "."),
    /* V12: touch wording on touch screens; keys only where there is a keyboard and mouse */
    h("span", { text: window.matchMedia("(hover: hover) and (pointer: fine)").matches ? "Click a tile to open it. Escape or the browser's back button returns to the wall. Press ? for keys." : "Tap a tile to open it. The X at the top, or your phone's back gesture, returns to the wall." }));
  $("#lib-sources").replaceChildren(
    h("p", {}, "Generated from the group's own records on ", h("span", { class: "num", text: when }), "."),
    h("p", { text: `Read from ${D.signups ? "five" : "four"} places: the Party Board, the game's client tables (build ${D.client.build.split(".").pop()}), Blizzard's dates, ${D.signups ? "the bot's log, and the Discord sign-up card" : "and the bot's log"}.` }),
    h("p", { text: "Tavern paintings generated on 2026-10-26 for this board. Scene, buff, pint and map emblems generated with ChatGPT on 2026-10-28." }),
    h("p", { text: "Spell numbers are the game's own values at the level cap and can move with Blizzard's hotfixes. A wax seal marks what is written on the Party Board; a quill, what the group has noted down; a speech bubble, what was said in chat." }));
}

const Q = {
  pack: [["yes", "Yes"], ["no", "No"]],
  meet: [["valley", "Valley of Strength"], ["crossroads", "the Crossroads"], ["other", "Write-in"]],
  rsvp: [["in", "I'm in"], ["maybe", "Tentative"], ["late", "Running late"], ["out", "Out"]],
};
function buildSignupControls() {
  for (const [q, opts] of Object.entries(Q)) {
    $(`#opts-${q}`).replaceChildren(...opts.map(([v, label]) => h("span", { class: "opt" },
      h("input", { type: "radio", name: q, id: `${q}-${v}`, value: v, disabled: true, onchange: () => { RT.mine[q] = v; save(q); } }),
      h("label", { for: `${q}-${v}`, text: label }))));
  }
  const sel = $("#as");
  sel.replaceChildren(h("option", { value: "", text: "Not saying" }), ...D.party.members.map((m) => h("option", { value: m.name, text: `${m.name}, ${m.class}` })));
  sel.addEventListener("change", () => { RT.mine.as = sel.value || null; try { localStorage.setItem("board-as", sel.value); } catch (e) {} save("as"); pushPresence(); });
  const other = $("#meet-place"); /* not "meet-other": that id belongs to the Write-in radio */
  let pause = 0;
  const commit = (typing) => {
    clearTimeout(pause); pause = 0;
    const v = cleanText(other.value);
    if (!typing && other.value !== v) other.value = v;
    if (v === (RT.mine.meet_other || "")) return;
    RT.mine.meet_other = v;
    if (v) { RT.mine.meet = "other"; applyMine(); }
    save(["meet", "meet_other"]);
  };
  other.addEventListener("input", () => { clearTimeout(pause); pause = setTimeout(() => commit(true), 1200); });
  other.addEventListener("change", () => commit(false));
  other.addEventListener("blur", () => commit(false));
  other.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(false); } });
  RT.writeInPending = () => pause !== 0;
  $("#signup").addEventListener("submit", (e) => e.preventDefault());
  try { const as = localStorage.getItem("board-as"); if (as && memberByName(as)) { sel.value = as; RT.mine.as = as; } } catch (e) {}
  renderTallies();
}
function cleanText(t) { return String(t || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim().slice(0, 40).replace(/[\ud800-\udbff]$/, ""); }
function setStatus(text) { $("#signup-status").textContent = text; }
function setEnabled(on) {
  document.querySelectorAll("#signup input, #signup select").forEach((x) => { x.disabled = !on; });
}
function applyMine() {
  for (const q of Object.keys(Q)) for (const [v] of Q[q]) { const el = $(`#${q}-${v}`); if (el) el.checked = RT.mine[q] === v; }
  if (document.activeElement !== $("#meet-place")) $("#meet-place").value = RT.mine.meet_other || "";
  if (RT.mine.as !== undefined && document.activeElement !== $("#as")) $("#as").value = RT.mine.as || "";
}
let writeChain = Promise.resolve();
function save(field) {
  if (RT.readOnly || !RT.db || !RT.myId || !RT.ready) return;
  const patch = { updated: Date.now() };
  for (const k of [].concat(field)) patch[k] = k === "meet_other" ? (RT.mine.meet_other || "") : (RT.mine[k] || null);
  const ref = RT.db.doc(`signups/${RT.myId}`);
  /* Merge: update only the fields this click changed. The first write creates the document from everything picked so far. */
  const full = () => ({ pack: RT.mine.pack || null, meet: RT.mine.meet || null, meet_other: RT.mine.meet_other || "", rsvp: RT.mine.rsvp || null, as: RT.mine.as || null, updated: patch.updated });
  const create = () => ref.set(full()).then(() => { RT.created = true; });
  /* update rejects invalid_argument when the document is gone (deleted elsewhere); write it whole instead. */
  const attempt = () => (RT.signups.has(RT.myId) || RT.created ? ref.update(patch).catch((err) => { if (err && err.code === "invalid_argument") return create(); throw err; }) : create());
  RT.pending = (RT.pending || 0) + 1;
  writeChain = writeChain.then(() => attempt().catch((err) => {
    const code = err && err.code;
    if (code === "unavailable") return new Promise((r) => setTimeout(r, 400 + Math.random() * 600)).then(attempt);
    throw err;
  })).then(() => setStatus("Saved. Everyone who opens the board sees it.")).catch((err) => {
    const code = err && err.code;
    if (code === "quota_exceeded") setStatus("The board's storage is full, so this answer was not saved.");
    else if (code === "invalid_argument" || code === "not_granted" || code === "revoked" || code === "capability_disabled" || code === "capability_removed") { RT.readOnly = true; RT.blocked = true; setEnabled(false); setStatus("This board is read-only for you, so answers can't be saved here. Ask in chat instead."); }
    else setStatus("That answer did not save. Try once more in a moment.");
  }).then(() => { RT.pending -= 1; });
}
let tallyToken = 0;
async function renderTallies() {
  const token = ++tallyToken;
  const ids = [...RT.signups.keys()];
  if (token !== tallyToken) return;
  /* Display rule: a person shows only as the party member they picked, otherwise "a guest". No profile names. */
  const nameOf = (id) => { const d = RT.signups.get(id) || {}; const base = (typeof d.as === "string" && memberByName(d.as) && d.as) || "a guest"; return id === RT.myId ? `${base} (you)` : base; };
  for (const [q, opts] of Object.entries(Q)) {
    const box = $(`#tally-${q}`);
    const rows = opts.map(([v, label]) => {
      const who = ids.filter((id) => (RT.signups.get(id) || {})[q] === v);
      if (!who.length) return null;
      const names = who.map((id) => q === "meet" && v === "other" ? `${nameOf(id)}: ${cleanText((RT.signups.get(id) || {}).meet_other) || "no place given"}` : nameOf(id));
      return h("div", {}, h("b", { text: String(who.length) }), ` ${label}: `, names.join(", "));
    }).filter(Boolean);
    box.replaceChildren(...(rows.length ? rows : [h("span", { text: RT.db ? (RT.loaded ? "No answers yet." : "Loading answers.") : RT.tried ? "Answers are not visible on this view." : "Answers show here once the board is open inside Claude." })]));
  }
  renderPresence();
}

function pushPresence() {
  if (!RT.room) return;
  RT.room.presence({ as: RT.mine.as || null }).catch(() => {});
}
async function renderPresence() {
  const wrap = $("#peers");
  if (!RT.room) return;
  const peers = RT.peers.filter((p) => p.kind === "viewer");
  wrap.replaceChildren(...peers.map((p) => {
    const as = p.presence && typeof p.presence.as === "string" ? memberByName(p.presence.as) : null;
    const name = as ? as.name : "a guest";
    const who = p.isMe ? (p.sameTab ? `${name} (you)` : `${name} (you, another tab)`) : name;
    return h("span", { class: `peer${p.isMe && p.sameTab ? " me" : ""}`, style: `--pc: ${classVar(as && as.class_key)}`, title: who, role: "img", "aria-label": who });
  }));
  const me = peers.find((p) => p.isMe && p.sameTab) || peers.find((p) => p.isMe);
  $("#presence-text").replaceChildren(peers.length === 1 ? "At the board now: just you" : `At the board now: ${peers.length}`, me ? h("span", { class: "peer-you", text: " · ringed dot is you" }) : "");
}

/* SDK 2.5.0: */
let discordPoll = 0;
function startDiscordPresence(sdk) {
  const warned = new Set();
  const warn = (where, e) => {
    const text = `${where}: ${e && e.code !== undefined ? `code ${e.code}, ` : ""}${(e && (e.message || e.toString())) || String(e)}`;
    if (warned.has(text)) return;
    warned.add(text);
    console.warn(`[board] presence ${text}`, e);
  };
  const render = (list, source) => {
    const wrap = $("#peers");
    if (!list || !list.length) {
      wrap.replaceChildren(h("span", { class: "peer me", style: `--pc: ${classVar(null)}`, title: "you", role: "img", "aria-label": "you" }));
      $("#presence-text").replaceChildren("In this Activity now: ", h("span", { class: "peer-you", text: "you" }));
      return;
    }
    wrap.replaceChildren(...list.map((p) => {
      const name = String(p.nickname || p.global_name || p.username || "someone");
      const m = memberByName(name);
      return h("span", { class: "peer", style: `--pc: ${classVar(m && m.class_key)}`, title: name, role: "img", "aria-label": name });
    }));
    $("#presence-text").textContent = list.length === 1 ? "In this Activity now: one person" : `In this Activity now: ${list.length}`;
    $("#peers").dataset.source = source;
  };
  const cmd = sdk.commands.getActivityInstanceConnectedParticipants || sdk.commands.getInstanceConnectedParticipants;
  let viaEvent = false, eventTried = false;
  const subscribe = async () => {
    if (eventTried) return;
    eventTried = true;
    try {
      await sdk.subscribe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", (data) => {
        const list = (data && data.participants) || [];
        viaEvent = true;
        render(list, "event");
      });
    } catch (e) { warn("subscribe ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", e); }
  };
  const poll = async () => {
    if (viaEvent) return;
    if (typeof cmd !== "function") { warn("command", new Error("no participants command on this SDK")); render([], "none"); subscribe(); return; }
    try {
      const r = await cmd.call(sdk.commands);
      const list = (r && r.participants) || [];
      render(list, "command");
      if (!list.length) subscribe();
    } catch (e) {
      warn("getActivityInstanceConnectedParticipants", e);
      render([], "none");
      subscribe();
    }
  };
  render([], "none");
  poll();
  clearInterval(discordPoll);
  discordPoll = setInterval(() => { if (!document.hidden) poll(); }, 15000);
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || !/^https?:/i.test(a.getAttribute("href"))) return;
    e.preventDefault();
    sdk.commands.openExternalLink({ url: a.href }).catch((err) => warn("openExternalLink", err));
  });
}

/* V13c (spec 8): the four answers in the bot's calendar words; "late" exists once the bot's states are on */
const RSVP_KEYS = ["in", "maybe", "late", "out"];
const RSVP_SAY = { in: "I'm in", maybe: "Tentative", late: "Running late", out: "Out" };
/* Discord display names sometimes carry decoration ("=Name="); the board shows the name inside it. */
const cleanName = (n) => String(n).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || String(n);
/* the launch-night table: one seat per member with their crest, a tankard full when they are in, and their answer */
/* V11: one clear way to answer: the Sign-ups card in Discord */
function actRow() {
  const url = D.party && D.party.signup_url; if (!url) return;
  $("#dsu-act").replaceChildren(h("a", { class: "act-btn", href: url, target: "_blank", rel: "noopener noreferrer" }, emb("speech"), "Answer in Discord"), h("p", { class: "act-how", text: "Open #wow-forever in Discord and tap I'm in, Tentative, Running late or Out on the Sign-ups card." }));
}
function renderSeats(S) {
  const box = $("#dsu-seats"); if (!box) return;
  const ms = D.party.members, W = 640, step = (W - 80) / ms.length;
  const ans = (m) => (S.entries || []).find((e) => cleanName(e.name).toLowerCase() === m.name.toLowerCase()) || null;
  const WHEN = { "6pm": "6 PM ET", "8pm": "8 PM ET", later: "later" }, SAY = RSVP_SAY;
  const svg = s("svg", { viewBox: `0 0 ${W} 236`, role: "img", "aria-label": `Launch-night table: ${ms.map((m) => { const a = ans(m); return `${m.name} ${a && a.rsvp ? SAY[a.rsvp] || a.rsvp : "no answer yet"}`; }).join(", ")}` },
    s("image", { class: "seat-table-img", href: "img/seats/table.webp", x: 0, y: 58, width: W, height: 135, preserveAspectRatio: "none" }));
  ms.forEach((m, i) => {
    const x = 40 + step * (i + 0.5), a = ans(m), state = a && a.rsvp ? a.rsvp : "none";
    /* V13c: the painted pint for the answer (full, half, late with its watch, empty); no answer is a faint outline */
    const mug = s("image", { class: `seat-mug ${state}`, href: `img/pints/${state}@2x.png`, x: x - 18, y: 78, width: 36, height: 36 });
    svg.append(s("image", { href: `img/crests/${m.class_key}.png`, x: x - 24, y: 14, width: 48, height: 48 }), mug,
      s("text", { class: "seat-name", x, y: 192, text: m.name }),
      s("text", { class: `seat-ans ${state}`, x, y: 214, text: a && a.rsvp ? `${SAY[a.rsvp] || a.rsvp}${a.when ? `, ${WHEN[a.when] || a.when}` : ""}` : "no answer yet" }));
  });
  box.replaceChildren(h("h4", { class: "seats-cap", text: launchWhen() ? `The table on launch night: ${launchWhen().replace(/^Launch: /, "")}` : "The table on launch night" }), svg);
}
function renderDiscordSignups() {
  const S = D.signups, body = $("#dsu-body");
  if (!S) { body.replaceChildren(h("p", { text: "The Discord sign-ups did not load." })); $("#dsu-stamp").textContent = ""; return; }
  const T = S.tallies;
  const meName = (MEM.member() || {}).name;
  const mineFirst = (names) => names.map(cleanName).sort((a, b) => (b.toLowerCase() === String(meName).toLowerCase()) - (a.toLowerCase() === String(meName).toLowerCase()));
  /* V11: a name carries its crest when it is one of the five; the count fills a row of five pennants */
  const who = (n) => { const m = memberByName(cleanName(n)); return h("span", { class: "who" }, m ? crestMark(m) : emb("speech"), cleanName(n)); };
  let ri = 0;
  const row = (slot, label, extra, key) => h("div", { class: `trow${slot.count ? "" : " zero"}`, style: `--ri: ${ri++}`, ...(key ? { "data-land-to": key } : {}) },
    h("span", { class: "trow-n" }, h("b", { "data-n": slot.count, text: String(slot.count) }), h("span", { class: "pips", "aria-hidden": "true" }, Array.from({ length: Math.max(D.party.members.length, slot.count) }, (_, k) => h("i", { class: k < slot.count ? "on" : null, style: `--pi: ${k}` })))),
    h("span", { class: "trow-who" }, h("span", { text: `${label}:` }), ...(slot.count ? (extra ? [extra] : mineFirst(slot.names).map(who)) : ["nobody yet"])));
  const groups = [
    ["Pack", "ticket", [row(T.pack.yes, "I hold a pack"), row(T.pack.no, "No pack")]],
    ["Meeting point", "pin", [...S.options.meet.map((m) => row(T.meet[m], m)), row(T.meet.other, "Somewhere else", T.meet.other.places.map((x) => `${x.name} (${x.place})`).join(", "))]],
    ["Launch night", "voice", RSVP_KEYS.filter((k) => T.rsvp[k]).map((k) => row(T.rsvp[k], RSVP_SAY[k], null, k))],
    ...(T.when ? [["When they get on", "clock", [row(T.when["6pm"], "6 PM ET, at launch"), row(T.when["8pm"], "Around 8 PM ET"), row(T.when.later, "Later than that")]]] : []),
  ];
  /* V13e: each question is one ledger line (label, the answers with names, then the empty answers as quiet "0" chips) */
  body.replaceChildren(...groups.map(([title, icon, rows], gi) => h("div", { class: "tally", "data-q": ["pack", "meet", "rsvp", "when"][gi] }, h("h4", {}, emb(icon), title), ...rows)));
  renderSeats(S); actRow();
  $("#dsu-stamp").textContent = S.updated ? `Last change on Discord: ${fmtWhen(Date.parse(S.updated) / 1000, { rel: true })}.` : "Nobody has clicked the card yet.";
  KIT.emit("signups");
}

/* V11: the board opens in any browser from the web link; nobody needs Discord's Activity to read it */
const PRESENCE_WEB = "Open in any browser, no sign-in";
async function startRuntime() {
  const c = window.claude;
  if (!c || typeof c.use !== "function") return;
  const use = (n) => Promise.resolve().then(() => c.use(n)).catch(() => null);
  const [db, user, room] = await Promise.all([use("db"), use("user"), use("room")]);
  RT.db = db; RT.user = user; RT.room = room; RT.tried = true;
  if (db) $("#signup").hidden = false;
  if (room) {
    room.onPeers((ch) => { RT.peers = ch.peers; renderPresence(); }, () => { RT.room = null; $("#peers").replaceChildren(); $("#presence-text").textContent = PRESENCE_WEB; });
    pushPresence();
  } else $("#presence-text").textContent = PRESENCE_WEB;
  if (user) { try { RT.myId = await user.id(); } catch (e) { RT.myId = null; } }
  if (!db) { setStatus("Sign-ups are read-only on this view: the shared store is not available here."); renderTallies(); return; }
  setStatus(RT.myId ? "Loading saved answers." : "Sign-ups are read-only for you: this view has no signed-in identity. Answers from others still show.");
  const fromDoc = (d) => ({ pack: d.pack, meet: d.meet, meet_other: d.meet_other, rsvp: d.rsvp, as: d.as || RT.mine.as || null });
  db.collection("signups").onSnapshot((snap) => {
    RT.signups = new Map(snap.docs.filter((d) => d.exists).map((d) => [d.id, d.data() || {}])); RT.loaded = true;
    if (RT.myId && RT.signups.has(RT.myId)) {
      RT.seenMine = true;
      if (RT.ready && !RT.pending && !(RT.writeInPending && RT.writeInPending())) { RT.mine = fromDoc(RT.signups.get(RT.myId)); applyMine(); }
    }
    else if (RT.seenMine) {
      RT.seenMine = false; RT.created = false; RT.mine = { as: RT.mine.as || null }; applyMine();
    }
    if (!RT.ready && RT.myId && !RT.blocked) {
      const d = RT.signups.get(RT.myId);
      if (d) RT.mine = fromDoc(d);
      RT.ready = true; RT.readOnly = false; setEnabled(true); applyMine(); pushPresence();
      setStatus("Pick an answer and it saves on its own. Only the person who wrote an answer can change it.");
    }
    renderTallies();
  }, (err) => { RT.readOnly = true; RT.blocked = true; setEnabled(false); setStatus(err && err.code === "revoked" ? "Sign-ups are read-only now." : "Sign-ups stopped updating. Reload the board to see the latest."); });
}

/* V16 (2026-10-30): "decide" (What to decide) sits before Next steps, which stays last; js/decide.js adds its tab and panel at load */
const SCENES = ["timeline", "five", "roads", "racials", "legacy", "buffs", "ledger", "signups", "librarian", "library", "decide", "tonight"];
/* V13c (spec 7.1, NORTH-STAR "One vocabulary"): one name per thing; tiles, tabs, sheet titles, the bar, the menu, the key list
   and the page title all read this table */
const TITLES = { tonight: "Next steps", timeline: "Dates", five: "The five", roads: "Three roads", racials: "Race skills", legacy: "Bonuses", buffs: "Who buffs whom", ledger: "Ledger", signups: "Sign-ups", librarian: "Leeroy", library: "Library", decide: "What to decide" };
const PAGE_TITLE = { base: "" };
/* spec 7.4: the document title follows the open scene */
function setPageTitle(key) { if (!PAGE_TITLE.base) PAGE_TITLE.base = document.title || "Dungeons and Drinking Board"; document.title = key ? `${TITLES[key]}: ${PAGE_TITLE.base}` : PAGE_TITLE.base; }
const PLAY = { roads: ["#map", "drawing"], legacy: ["#legacy-ring", "filling"], buffs: ["#wheel", "lighting"], ledger: ["#ledger-slip", "stamping"] };
const SC = { open: null, want: null, closeTimer: 0, fadeTimer: 0, flipTimer: 0, anim: null, token: 0 };
const motionMs = (k) => (reduceMQ.matches ? 0 : typeof k === "number" ? k : MOTION[k]);
const sceneHooks = [];
const sceneState = (on) => sceneHooks.forEach((f) => { try { f(on); } catch (e) { console.error(e); } });
/* V13d (interaction 1): "<scene>.<thing>" lands on that thing inside the scene (#five.santa, #roads.durotar, #signups.in) */
const LAND_RE = /^(timeline|five|roads|racials|legacy|ledger|signups|librarian|decide)\.([a-z0-9][a-z0-9_-]{0,40})$/;
const sceneFromHash = () => { const k = decodeURIComponent(location.hash.replace(/^#/, "")); return SCENES.includes(k) ? k : /^atlas(?:\.|$)/.test(k) ? "roads" : /^library\./.test(k) ? "library" : /^tonight\./.test(k) ? "tonight" : /^buffs\.[a-z_-]{1,40}$/.test(k) ? "buffs" : LAND_RE.test(k) ? k.split(".")[0] : null; };
function setHash(key, push) {
  const url = location.pathname + location.search + (key ? `#${key === "library" ? LIBUI.token() : key}` : "");
  /* pushed marks an entry over the wall's own, the only kind back may pop; since V13b a landing scene gets one too (route) */
  try { if (push) history.pushState({ boardScene: key, pushed: true }, "", url); else history.replaceState(key ? { boardScene: key, pushed: !!(history.state && history.state.pushed) } : null, "", url); return true; } catch (e) { return false; }
}
function replay(el, cls) { if (!el) return; el.classList.remove(cls); void el.getBoundingClientRect(); el.classList.add(cls); }
/* one frame (2026-10-30): a panel on its way out leaves the layout where it stood (absolute in the body, which contains it), so the new one
   lays out alone, centres and fits as it will stay, and the body never holds two panels one under the other during the cross-fade */
function liftPanel(p) {
  const b = $("#sheet-body"); if (!b || p.hidden || !b.getBoundingClientRect) return;
  b.scrollTop = 0;
  const r = p.getBoundingClientRect(), br = b.getBoundingClientRect(), z = parseFloat(p.style.zoom) || 1;
  if (!r.width) return;
  const st = p.style; st.position = "absolute"; st.margin = "0"; st.left = `${((r.left - br.left - (b.clientLeft || 0)) / z).toFixed(1)}px`; st.top = `${((r.top - br.top - (b.clientTop || 0)) / z).toFixed(1)}px`; st.width = `${(r.width / z).toFixed(1)}px`; st.height = `${(r.height / z).toFixed(1)}px`;
}
function dropPanel(p) { const st = p.style; if (st.position) { st.position = ""; st.margin = ""; st.left = ""; st.top = ""; st.width = ""; st.height = ""; } }
function selectPanel(key, crossFade) {
  warmStop();
  MEM.set("depth", key === "tonight" ? "tonight" : key === "library" ? "library" : "wall");
  MEM.seen(key);
  markDepth();
  const prev = SC.open; SC.open = key;
  $("#sheet-title").textContent = TITLES[key];
  setPageTitle(key);
  $("#sheet-sub").textContent = SUBTITLE[key] || "";
  setSheetEmblem(key);
  placeOrnament(key);
  for (const k of SCENES) {
    const t = $(`#tab-${k}`), on = k === key;
    t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
    const p = $(`#panel-${k}`);
    if (k !== key && k !== prev) { p.hidden = true; p.classList.remove("entering", "leaving"); dropPanel(p); }
  }
  if (key === "timeline" && D.timeline) renderTimeline();
  const next = $(`#panel-${key}`);
  /* V13b (craft 20): a tab change slides a little in its direction of travel (the shorter way round the ring) */
  const di = prev ? (SCENES.indexOf(key) - SCENES.indexOf(prev) + SCENES.length) % SCENES.length : 0, dir = !di ? 0 : di <= SCENES.length / 2 ? 1 : -1;
  next.style.setProperty("--dir", String(dir)); next.style.transform = "";
  if (prev && prev !== key) {
    const old = $(`#panel-${prev}`);
    old.style.setProperty("--dir", String(dir)); old.style.transform = ""; old.classList.remove("spring");
    if (crossFade) {
      liftPanel(old);
      old.classList.remove("entering", "again"); old.classList.add("leaving"); /* "again" (the short fade of a later open) is declared after .leaving and would keep the old panel at full opacity until it is hidden */
      clearTimeout(SC.fadeTimer);
      SC.fadeTimer = setTimeout(() => { if (SC.open !== prev) old.hidden = true; old.classList.remove("leaving"); dropPanel(old); }, (parseFloat(cssVar("--t-leave")) || 220) + 30); /* the CSS fade runs --t-leave; hiding the panel earlier cut it short in one frame */
    } else { old.hidden = true; old.classList.remove("entering", "leaving"); dropPanel(old); }
  }
  dropPanel(next); next.hidden = false; next.classList.remove("leaving");
  if (crossFade) { replay(next, "entering"); sfx("tab"); }
  $("#sheet-body").scrollTop = 0;
  /* V13c (craft 21): a scene's entrance choreography plays in full on its first open of the visit; later opens are a short fade.
     2026-10-30: only on a tab change. An open already fades the whole sheet (the view transition, the FLIP, the rise, the
     reduced-motion fade); a second fade on the panel under it put the bright paper on screen before its cards, a 22 luma hump
     on a phone (board/qa/2026-10-30-render.md) */
  const first = !PLAYED.has(key); PLAYED.add(key);
  if (first) { if (PLAY[key]) replay($(PLAY[key][0]), PLAY[key][1]); if (ON_FIRST[key]) ON_FIRST[key](); }
  else if (crossFade) replay(next, "again");
  if (ON_OPEN[key]) ON_OPEN[key]();
  mapClock();
  const tabs = $("#tabs"), tab = $(`#tab-${key}`);
  if (tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = Math.max(0, tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2);
  moveInd(); markBar(key);
  KIT.emit("scene", key, prev);
  /* one frame (2026-10-30): the fit is measured after the scene event (the coin's class sets the head's height, a panel may fill its rows) and
     checked again once the frame has painted and the fonts are in */
  fitScene();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(() => { if (SC.open === key) { fitScene(); moveInd(); } }));
  /* the rail's bar is measured again once the fonts are in (a first open at load measured the tabs in the fallback font) */
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (SC.open !== key) return; moveInd(); const t = $("#tabs"); if (t && typeof Event === "function") t.dispatchEvent(new Event("scroll")); /* the rail arrows look again */ }).catch(() => {});
}
/* V13c (spec 2, retest-10): */
const FIT_SKIP = ["roads", "library"];
const FIT_MIN_W = 900, FIT_MIN = 0.86, FIT_OVER = 0.15; /* 2026-10-30: from 900 px up; a panel up to 15 percent too tall zooms down to fit, never under 0.86 */
const FIT = {};
const fitKey = (key) => `${key}:${innerWidth}x${innerHeight}`;
/* one frame (2026-10-30): the room a panel has is the body's own height inside its padding, whatever the frame is at this size */
/* the panel's height as it shows: offsetHeight is in the panel's own (zoomed) units and ignores the transforms the open and close
   animations put on the sheet, which getBoundingClientRect() would count */
const fitTall = (p) => p.offsetHeight * (parseFloat(p.style.zoom) || 1);
function fitRoom(body) { const cs = getComputedStyle(body); return body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 4; }
function fitScene(want) {
  const key = want || SC.open, p = key && $(`#panel-${key}`), body = $("#sheet-body"), sheet = $(".sheet");
  if (!p || !body || !sheet) return;
  const k = fitKey(key);
  /* a remembered zoom is checked against the panel as it is now (2026-10-30): the warm-up can measure before the fonts and rows
     land, and a zoom that no longer fits is measured again, never trusted */
  if (!want && FIT[k] !== undefined) {
    p.style.zoom = FIT[k];
    const room = fitRoom(body);
    if (room < 120 || FIT_SKIP.includes(key) || innerWidth < FIT_MIN_W) return;
    const tall = fitTall(p);
    if (tall <= room + 1 || (FIT[k] === "" && tall > room * (1 + FIT_OVER))) return;
  }
  const done = (z) => { if (D.party) FIT[k] = z; p.style.zoom = z; };
  p.style.zoom = "";
  if (FIT_SKIP.includes(key) || innerWidth < FIT_MIN_W || typeof CSS === "undefined" || !CSS.supports || !CSS.supports("zoom", "1.2")) return;
  const cs = getComputedStyle(body), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), maxH = fitRoom(body);
  if (maxH < 120) return;
  /* a zoomed panel lays out in a narrower width, so its text wraps more: step the zoom down until the content fits */
  /* at most three layouts: the natural height, a first guess, one correction (a zoom costs a layout of the whole panel) */
  const wide = innerWidth < 1100 ? 1 : Math.min(1.45, (body.clientWidth - padX) / 1150);
  const tall0 = fitTall(p);
  /* a panel that overflows the frame by up to FIT_OVER is zoomed down to fit, never under FIT_MIN; a longer one scrolls in the body */
  if (tall0 > maxH && tall0 <= maxH * (1 + FIT_OVER)) {
    let z = Math.max(FIT_MIN, Math.min(1, (maxH * 0.99) / tall0));
    for (let i = 0; i < 3; i++) {
      p.style.zoom = z.toFixed(3);
      const tall = fitTall(p);
      if (tall <= maxH || z <= FIT_MIN) break;
      z = Math.max(FIT_MIN, z * (maxH * 0.99) / tall);
    }
    done(p.style.zoom); return;
  }
  if (wide < 1.04) { done(""); return; }
  let z = Math.min(wide, (maxH * 0.95) / Math.max(1, tall0));
  for (let i = 0; i < 2 && z >= 1.04; i++) {
    p.style.zoom = z.toFixed(3);
    const tall = fitTall(p);
    if (tall <= maxH * 0.98) { done(z.toFixed(3)); return; }
    z = z * Math.pow((maxH * 0.94) / tall, 1.6); /* narrower columns wrap more: step down harder than the ratio */
  }
  done("");
}
function moveInd() { const t = SC.open && $(`#tab-${SC.open}`), ind = $("#tab-ind"); if (t && ind) ind.style.transform = `translateX(${t.offsetLeft}px) scaleX(${Math.max(1, t.offsetWidth)})`; }
const BAR = ["tonight", "signups", "five", "buffs"], MORE = SCENES.filter((k) => !BAR.includes(k));
const BAR_LABEL = { tonight: "Next steps" };
function markBar(key) { document.querySelectorAll("#bottombar [data-go]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.go === key || (b.dataset.go === "search" && key === "library") || (b.dataset.go === "more" && MORE.includes(key))))); }
function startBar() {
  const label = (k) => $(`#tab-${k}`).textContent.trim(), bar = $("#bottombar"), menu = $("#more-menu");
  const more = h("button", { class: "bb", type: "button", "data-go": "more", "aria-expanded": "false", "aria-controls": "more-menu", text: "More" });
  bar.replaceChildren(...BAR.map((k) => h("button", { class: "bb", type: "button", "data-go": k, "aria-label": BAR_LABEL[k] ? label(k) : null, text: BAR_LABEL[k] || label(k) })), more);
  menu.replaceChildren(h("button", { type: "button", "data-go": "wall", text: "The wall" }), ...MORE.map((k) => h("button", { type: "button", "data-go": k, text: label(k) })), h("button", { type: "button", "data-go": "sound", "aria-pressed": String(AU.on), text: "Sound" }), h("button", { type: "button", "data-go": "room", id: "more-room", text: "Room: auto" }));
  const setMore = (on) => { menu.hidden = !on; more.setAttribute("aria-expanded", String(on)); };
  closeMore = (back) => { if (menu.hidden) return false; setMore(false); if (back !== false) more.focus(); return true; };
  const go = (e) => {
    const b = e.target.closest && e.target.closest("[data-go]"); if (!b) return;
    const k = b.dataset.go;
    if (k === "more") { setMore(menu.hidden); if (!menu.hidden) menu.querySelector("button").focus(); return; }
    setMore(false);
    if (k === "room") return; /* room/tier.js cycles it */
    if (k === "sound") setSound(!AU.on); else if (k === "wall") requestClose(); else if (k === "search") LIBUI.focusSearch(); else { switchTab(k); b.focus(); }
  };
  bar.addEventListener("click", go); menu.addEventListener("click", go);
  /* V13b (mobile 13): a tap anywhere outside the menu and its button closes it */
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !more.contains(e.target)) setMore(false); }, true);
}
/* The swipe hint fades after the first swipe and stays gone (localStorage, inside try). */
function swiped() { const hint = $("#scene-hint"); if (hint) hint.classList.add("used"); try { localStorage.setItem("board-swiped", "1"); } catch (e) {} }
/* V13b: */
const SWIPE_EDGE = 20;
function startLibBar() {
  const body = $("#sheet-body"), bar = document.querySelector(".lib-bar"); if (!body || !bar) return;
  let on = false, raf = 0;
  body.addEventListener("scroll", () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; const st = SC.open === "library" && body.scrollTop > 48; if (st !== on) { on = st; bar.classList.toggle("stuck", st); } }); }, { passive: true });
}
let swipeBound = false;
function startSwipe() {
  /* mobile build: the phone shell's swipe.js owns scene swipes on a phone. The listeners always bind and every pointerdown asks
     shellOwns() (BoardShell.phone()), so the two engines never both move a panel and a page whose shell switches off at run time
     (widened past 700, or shell.js missing) keeps this swipe; a return here at boot left that page with no swipe at all */
  if (swipeBound) return; swipeBound = true;
  const shellOwns = () => !!(window.BoardShell && window.BoardShell.phone());
  try { if (localStorage.getItem("board-swiped") === "1") { const hint = $("#scene-hint"); if (hint) hint.classList.add("used"); } } catch (e) {}
  const body = $("#sheet-body"); let s = null;
  const panel = () => (SC.open ? $(`#panel-${SC.open}`) : null);
  const give = (dx) => { const a = Math.abs(dx), d = a <= 80 ? a : 80 + (a - 80) * 0.35; return Math.sign(dx) * d * 0.85; };
  const back = (p) => { if (!p) return; if (reduceMQ.matches) { p.style.transform = ""; return; } p.classList.add("spring"); p.style.transform = ""; setTimeout(() => p.classList.remove("spring"), MOTION.micro + 40); };
  const atEnd = (c, dx) => (dx > 0 ? c.scrollLeft <= 2 : c.scrollLeft >= c.scrollWidth - c.clientWidth - 2);
  /* V13e touch pass: a second finger (a pinch on the map) is never a swipe; nor is any touch that starts on the map */
  let fingers = 0;
  body.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") fingers++; }, true);
  for (const t of ["pointerup", "pointercancel"]) body.addEventListener(t, (e) => { if (e.pointerType === "touch") fingers = Math.max(0, fingers - 1); }, true);
  body.addEventListener("pointerdown", (e) => {
    s = null;
    if (e.pointerType === "mouse" || SC.open === null || shellOwns()) return;
    if (fingers > 1 || (e.target.closest && e.target.closest("#map"))) return;
    if (e.clientX < SWIPE_EDGE || e.clientX > innerWidth - SWIPE_EDGE) return;
    if (e.target.closest && e.target.closest("input, select, textarea, .lib-rail, .lib-examples, .lib-tools, .bottombar")) return;
    const car = e.target.closest && e.target.closest(".cards");
    s = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId, car: car && car.scrollWidth > car.clientWidth + 2 ? car : null, sl: car ? car.scrollLeft : 0, live: false, dx: 0 };
  });
  body.addEventListener("pointermove", (e) => {
    if (s && fingers > 1) { if (s.live) back(panel()); s = null; return; }
    if (!s || e.pointerId !== s.id || s.car) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.live) { if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { s = null; return; } if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return; s.live = true; }
    s.dx = dx; const p = panel(); if (p && !reduceMQ.matches) { p.classList.remove("spring"); p.style.transform = `translateX(${give(dx).toFixed(1)}px)`; }
  }, { passive: true });
  body.addEventListener("pointercancel", () => { if (s && s.live) back(panel()); s = null; });
  const release = (x, y, ts, id) => {
    if (!s || (id !== undefined && id !== s.id)) return;
    const dx = x - s.x, dy = y - s.y, v = Math.abs(dx) / Math.max(1, ts - s.t), st = s; s = null;
    if (st.car && !(st.car.scrollLeft === st.sl && atEnd(st.car, dx))) return; /* the carousel moved: its own swipe */
    if (Math.abs(dx) < Math.abs(dy) * 1.5 || !(Math.abs(dx) >= 40 || (v > 0.5 && Math.abs(dx) >= 20))) { if (st.live) back(panel()); return; }
    stepTab(dx < 0 ? 1 : -1); swiped();
  };
  body.addEventListener("pointerup", (e) => release(e.clientX, e.clientY, e.timeStamp, e.pointerId));
  /* a carousel's own pan cancels the pointer; its touch end still says where the finger went */
  body.addEventListener("touchend", (e) => { if (!s || !s.car || !e.changedTouches || !e.changedTouches[0]) return; const t = e.changedTouches[0]; release(t.clientX, t.clientY, e.timeStamp); }, { passive: true });
}
let countToken = 0;
function countUp(box) {
  const els = [...box.querySelectorAll("b[data-n]")], tok = ++countToken;
  if (reduceMQ.matches || !els.length) return;
  /* 2026-10-30: the count's clock starts at the first frame it paints, not when it is called. An open that kept the thread busy for
     50 ms after this call (a slow phone, a loaded machine) let the first frame land past the ease's steep start, so some tallies
     showed their numbers at once instead of counting up from 0 (harness3 "tallies start at 0" failed on master and the branch alike) */
  let t0 = null;
  const step = (t) => { if (tok !== countToken) return; if (t0 === null) t0 = t; const k = Math.min(1, Math.max(0, t - t0) / MOTION.count), e = 1 - Math.pow(1 - k, 3); for (const el of els) el.textContent = String(Math.round(Number(el.dataset.n) * e)); if (k < 1) requestAnimationFrame(step); };
  for (const el of els) el.textContent = "0";
  sfx("tick");
  requestAnimationFrame(step);
}
/* V13c (craft 6): one soft stamp per seal as it lands (its press animation runs 320 ms; the seal meets the paper at 70%) */
function ledgerStamps() {
  const box = $("#ledger-slip") || $("#panel-ledger"); if (!box) return;
  const seals = [...box.querySelectorAll(".label.srctag .emb")].slice(0, 6), t0 = performance.now();
  seals.forEach((el, i) => { const di = Number(getComputedStyle(el).getPropertyValue("--di")) || i; const at = MOTION.move + di * MOTION.stagger + 0.7 * MOTION.move; sfx("stamp", { delay: at, gain: i ? 0.7 : 1 }); });
  if (!seals.length) sfx("stamp", { delay: MOTION.move * 1.7 });
  return t0;
}
const PLAYED = new Set();
const ON_FIRST = { signups: () => { countUp($("#dsu-body")); replay($("#dsu-body"), "filling"); }, ledger: () => ledgerStamps(), timeline: () => replay($("#rail"), "pressing"), five: () => replay($("#cards"), "stamping"), librarian: () => replay($("#lib-box .spark"), "drawing") };
const ON_OPEN = { library: () => LIBUI.open(), roads: () => { mapFit(); KIT.emit("roads-open"); /* the Atlas hook opens on #atlas or ATLAS_DEFAULT */ requestAnimationFrame(() => { fitBanners(); mapUntangle(); }); if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(() => { fitBanners(); mapUntangle(); })); /* the map's small caps may land after the first measure */ } };
/* V11: every scene has its own ornament, its emblem engraved large in the parchment's corner with its own small motion */
const ORN = { timeline: "hourglass", five: "banner", roads: "compass", racials: "skull", legacy: "laurel", buffs: "compass", ledger: "quill", signups: "tankard", librarian: "candle", library: "book", tonight: "moon", decide: "scroll" };
function placeOrnament(key) {
  const sheet = document.querySelector("#scene .sheet"); if (!sheet) return;
  const old = $("#sheet-orn"); if (old && old.parentNode) old.parentNode.removeChild(old);
  /* buffs shares the compass: ornaments/rune.webp reads as the letter R (see the regenerate note in img/emblems/ornaments/CREDITS.md) */
  const still = h("img", { class: "orn-art", src: `img/emblems/ornaments/${ORN[key] || "book"}.webp`, width: 400, height: 400, alt: "", loading: "lazy" }), move = h("div", { class: "orn-in" }, still);
  const o = h("div", { id: "sheet-orn", class: `sheet-orn orn-${key}`, "aria-hidden": "true" }, move);
  sheet.append(o); replay(o, "drawing");
}
/* the wall's photograph decodes late and used to pop in on the first paint; the plate fades in once the image is decoded (a 1.8 s fallback shows it anyway) */
(function wallFade() {
  const mark = (el, src) => {
    if (!el) return;
    let done = false; const show = () => { if (done) return; done = true; el.classList.add("ready"); };
    try { const im = new Image(); im.src = src; if (im.decode) im.decode().then(show, show); else im.onload = show; } catch (e) { show(); }
    setTimeout(show, 1800);
  };
  mark(document.querySelector(".wall-plate"), "img/board-wall.jpg");
  mark(document.querySelector(".hero-art img"), "img/tavern-hero.jpg");
})();
/* V13e: */
const WEBKIT_ENGINE = typeof navigator !== "undefined" && /AppleWebKit\//.test(navigator.userAgent || "") && !/(Chrome|Chromium|Edg|HeadlessChrome)\//.test(navigator.userAgent || "");
const hasVT = () => typeof document.startViewTransition === "function" && !WEBKIT_ENGINE;
const canFlip = () => typeof $(".sheet").animate === "function";
function morphBand(key) {
  if (reduceMQ.matches) return null;
  const t = document.querySelector(`#board [data-scene="${key}"]`);
  const band = t && (t.querySelector(".tile-band") || t);
  if (!band) return null;
  const r = band.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight ? band : null;
}
/* V13b (craft 11, 12): */
/* V13d: the marks that fly with a morph (a crest from its tile to its card) are named here and cleared with the band */
const VTX = [];
function viewMorph(from, to, update, closing) {
  const layer = $("#scene"), root = document.documentElement;
  const clear = () => { from.style.viewTransitionName = ""; to.style.viewTransitionName = ""; VTX.splice(0).forEach((e) => { e.style.viewTransitionName = ""; }); layer.classList.remove("morph"); root.classList.remove("vt-close"); };
  layer.classList.add("morph"); root.classList.toggle("vt-close", !!closing);
  from.style.viewTransitionName = "scene-band";
  try {
    const vt = document.startViewTransition(() => { from.style.viewTransitionName = ""; if (update()) to.style.viewTransitionName = "scene-band"; });
    vt.finished.then(clear, clear);
    /* a newer transition skips this one: its ready and update promises reject, which surfaced as uncaught errors (release gate 2026-10-29) */
    if (vt.ready && vt.ready.catch) vt.ready.catch(() => {});
    if (vt.updateCallbackDone && vt.updateCallbackDone.catch) vt.updateCallbackDone.catch(() => {});
  } catch (e) { clear(); update(); }
}
function stopFlip() { clearTimeout(SC.flipTimer); if (SC.anim2) { try { SC.anim2.cancel(); } catch (e) {} SC.anim2 = null; } if (SC.anim) { try { SC.anim.cancel(); } catch (e) {} SC.anim = null; } }
function flipSheet(band, opening, done) {
  const layer = $("#scene"), sheet = $(".sheet");
  stopFlip();
  const a = band.getBoundingClientRect(), b = sheet.getBoundingClientRect();
  if (!a.width || !b.width || !b.height) return false;
  const from = `translate(${(a.left - b.left).toFixed(1)}px, ${(a.top - b.top).toFixed(1)}px) scale(${(a.width / b.width).toFixed(4)}, ${(a.height / b.height).toFixed(4)})`;
  const kf = [{ transform: from }, { transform: "none" }];
  layer.classList.add("flip");
  let an = null, ended = false;
  const end = () => { if (ended) return; ended = true; clearTimeout(SC.flipTimer); if (opening) { layer.classList.remove("flip"); if (SC.anim === an) stopFlip(); } if (done) done(); };
  try {
    const dur = opening ? MOTION.move : MOTION.close, fill = opening ? "backwards" : "forwards";
    an = sheet.animate(opening ? kf : kf.reverse(), { duration: dur, easing: opening ? MOTION.oak : MOTION.shut, fill });
    /* the opacity rides its own symmetric ease: on the move's ease a bright sheet reached most of its opacity in two frames */
    SC.anim2 = sheet.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: MOTION.fade, fill });
  }
  catch (e) { layer.classList.remove("flip"); return false; }
  SC.anim = an;
  if (an && an.finished) an.finished.then(end, end);
  SC.flipTimer = setTimeout(end, (opening ? MOTION.move : MOTION.close) + 120);
  return true;
}
function showScene(key) {
  warmStop();
  const layer = $("#scene");
  if (SC.want) { SC.want = key; return; } /* a morph is in flight; it opens whatever was asked for last */
  clearTimeout(SC.closeTimer); SC.token++;
  const wasOpen = !layer.hidden && !layer.classList.contains("closing") && SC.open !== null;
  if (SC.anim) { stopFlip(); layer.classList.remove("flip"); }
  layer.classList.remove("closing");
  if (wasOpen) { if (SC.open !== key) { selectPanel(key, true); if (document.activeElement && document.activeElement.closest("#tabs")) focusScene(key); } landing(key); return; }
  const open = (k, how) => {
    layer.classList.remove("rise", "flip", "closing", "fade");
    closeMore(false);
    if (how) layer.classList.add(how);
    layer.hidden = false;
    $("#board").inert = true;
    document.documentElement.classList.add("scene-open");
    selectPanel(k, false);
    focusScene(k);
    /* V13e: WebKit drops a focus set while the page is still loading (a deep link); put it back once the frame has painted */
    const refocus = () => { if (SC.open === k && (!document.activeElement || document.activeElement === document.body)) focusScene(k); };
    requestAnimationFrame(() => setTimeout(refocus, 60)); if (document.readyState !== "complete") addEventListener("load", () => setTimeout(refocus, 30), { once: true });
    sceneState(true);
    sfx("open", { delay: motionMs("move") * 0.7 });
    return landing(k);
  };
  const band = layer.hidden ? morphBand(key) : null;
  /* V13d: the clicked mark (a crest, a pin) flies to the thing it names, as a second shared element of the same morph */
  const fl = !reduceMQ.matches && SC.land && SC.land.key === key && SC.land.from && document.contains(SC.land.from) ? SC.land.from : null;
  if (band && hasVT()) {
    SC.want = key;
    if (fl) { fl.style.viewTransitionName = "land-flight"; VTX.push(fl); }
    viewMorph(band, $(".sheet-head"), () => { const k = SC.want; SC.want = null; if (!k) return false; const got = open(k, ""); if (fl) fl.style.viewTransitionName = ""; if (got && fl) { got.style.viewTransitionName = "land-flight"; VTX.push(got); } return true; });
    return;
  }
  if (band && canFlip()) { const got = open(key, ""); if (!flipSheet(band, true)) layer.classList.add("rise"); if (got && fl) KIT.emit("fly", fl, got); return; }
  const got = open(key, reduceMQ.matches ? "fade" : "rise"); /* reduced motion: a short cross-fade, no move */
  if (got && fl) KIT.emit("fly", fl, got);
}
/* V13d: the thing a deep link names, found, scrolled to and lit by js/v13d.js (KIT.lander); null when there is none */
function landing(k) {
  const L = SC.land; if (!L || L.key !== k) return null;
  SC.land = null;
  if (k === "buffs" && focusBuff(L.sub)) return document.querySelector("#buffs-deep li.lit");
  return KIT.lander ? KIT.lander(k, L.sub) || null : null;
}
/* The library tile is a div holding a link and a search field; focus returns to its link. */
/* 2026-10-30 (integration review 7): a scene opened by a link at load (Next steps, What to decide) has no tile to go back to, or its tile is hidden
   (display none, so the focus call is dropped and the document body keeps focus): the wall itself takes it */
const tileFocus = (t) => {
  let f = t.matches("a, button, main") ? t : t.querySelector("a[href]");
  if (f && f.getClientRects && !f.getClientRects().length) f = $("#main");
  if (!f) f = $("#main");
  if (f) f.focus({ preventScroll: true });
};
function hideScene() {
  warmStop();
  if (SC.want) { SC.want = null; return; }
  if (SC.open === null) return;
  MEM.set("depth", "wall"); markDepth();
  const layer = $("#scene"), key = SC.open, token = ++SC.token;
  SC.open = null;
  setPageTitle(null);
  KIT.emit("closed", key);
  const tile = document.querySelector(`#board [data-scene="${key}"]`) || document.querySelector(`#board a[href="#${key}"]`) || $("#main"); /* V16: a scene with no tile (What to decide) hands focus to the wall itself */
  const unlock = () => { $("#board").inert = false; document.documentElement.classList.remove("scene-open"); sceneState(false); sfx("close", { delay: motionMs("close") * 0.9 }); unflip(); };
  const finish = () => {
    if (token !== SC.token) return;
    clearTimeout(SC.closeTimer); stopFlip();
    layer.hidden = true; layer.classList.remove("closing", "flip", "rise", "fade");
    for (const k of SCENES) { const p = $(`#panel-${k}`); p.hidden = true; p.classList.remove("entering", "leaving"); }
  };
  const band = morphBand(key);
  if (band && hasVT()) {
    viewMorph($(".sheet-head"), band, () => { if (token !== SC.token) return false; unlock(); finish(); if (tile) tileFocus(tile); return true; }, true);
    return;
  }
  unlock();
  layer.classList.remove("rise");
  layer.classList.add("closing");
  clearTimeout(SC.closeTimer);
  if (!(band && canFlip() && flipSheet(band, false, finish))) SC.closeTimer = setTimeout(finish, reduceMQ.matches ? MOTION.micro : motionMs("close")); /* reduced motion: the same short fade as the open, not a cut */
  if (tile) tileFocus(tile);
}
/* V13b (craft 31): a card turned over in The five is face up again the next time the scene opens */
function unflip() { document.querySelectorAll("#cards .card.flipped").forEach((c) => { c.classList.remove("flipped"); c.querySelectorAll(".flip").forEach((b) => b.setAttribute("aria-pressed", "false")); const f = c.querySelector(".front"), b = c.querySelector(".back"); if (f) f.inert = false; if (b) b.inert = true; }); }
/* owner-12b: */
function startPeek() {
  const btn = $("#scene-peek"), layer = $("#scene"), sheet = $(".sheet"); if (!btn || !sheet) return;
  let held = false, timer = 0;
  const on = () => { if (held || SC.open === null) return; held = true; layer.classList.add("peek"); btn.setAttribute("aria-pressed", "true"); };
  const off = () => { clearTimeout(timer); if (!held) return; held = false; layer.classList.remove("peek"); btn.setAttribute("aria-pressed", "false"); };
  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); on(); });
  btn.addEventListener("click", (e) => { if (e.detail === 0) { held ? off() : on(); } }); /* a keyboard click (Enter) toggles */
  btn.addEventListener("keydown", (e) => { if (e.key === " " && !e.repeat) { e.preventDefault(); on(); } });
  btn.addEventListener("keyup", (e) => { if (e.key === " ") off(); });
  sheet.addEventListener("pointerdown", (e) => { if (e.target === btn) return; const r = sheet.getBoundingClientRect(), edge = 18; if (e.clientX - r.left < edge || r.right - e.clientX < edge || e.clientY - r.top < edge || r.bottom - e.clientY < edge) timer = setTimeout(on, 380); });
  for (const t of ["pointerup", "pointercancel", "blur"]) addEventListener(t, off, true);
  btn.addEventListener("pointerleave", off);
  sceneHooks.push((open) => { if (!open) off(); });
}
function requestClose() {
  if (SC.open === null) return;
  if (history.state && history.state.pushed) { history.back(); return; } /* opened from the wall: back pops it */
  setHash(null, false); hideScene();
}
function switchTab(key, crossFade = true) { if (key === SC.open) return; setHash(key, false); selectPanel(key, crossFade); swiped(); }
/* Phones have no tab rail (v4 stage 9): focus goes to the panel when the tab is not rendered. */
function focusScene(k) { const t = $(`#tab-${k}`); if (t && t.getClientRects().length) t.focus({ preventScroll: true }); else { const p = $(`#panel-${k}`); if (p) p.focus({ preventScroll: true }); } }
function stepTab(d) { const i = SCENES.indexOf(SC.open); if (i < 0) return; const k = SCENES[(i + d + SCENES.length) % SCENES.length]; switchTab(k); focusScene(k); }
function goScene(k) {
  if (SC.open !== null) { switchTab(k); focusScene(k); return; }
  setHash(k, true); showScene(k);
}

/* V16 (2026-10-30): a details' summary is focusable on its own, so Tab from one stays in the scene instead of wrapping to the top */
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
function shown(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (n.hidden || n.inert) return false;
  return !el.getClientRects || el.getClientRects().length > 0;
}
const focusables = (box) => [...box.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.getAttribute("tabindex") !== "-1" && shown(el));
/* the Sensory button and its panel sit outside the scene layer: they join the scene's Tab loop so a keyboard user can reach them */
const senseBox = () => ["#sense-btn", "#sense-panel"].map((q) => $(q)).filter(Boolean);
function trapFocus(e) {
  const box = $("#scene"), list = [...focusables(box), ...senseBox().flatMap((n) => (n.matches(FOCUSABLE) ? (shown(n) ? [n] : []) : focusables(n)))];
  if (!list.length) { e.preventDefault(); return; }
  const first = list[0], last = list[list.length - 1], at = document.activeElement;
  if (!list.includes(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
}

function showKeys(on) {
  const box = $("#keys");
  if (on && !$("#keys-list").childElementCount) {
    /* the ten digits open the ten scenes before What to decide (V16: D) and Next steps (T) */
    const rows = [...SCENES.filter((k) => k !== "tonight" && k !== "decide").map((k, i) => [String((i + 1) % 10), `open ${$(`#tab-${k}`).textContent.trim()}`]), ["D", "open What to decide"], ["T", "open Next steps"], ["\u2190 \u2192", "previous or next tab"], ["/", "search the library"], ["Esc", "back out, then close the scene"], ["M", "sound on or off"], ["P", "Play mode: text only, nothing moves"], ["?", "show or hide this list"]];
    $("#keys-list").replaceChildren(...rows.flatMap(([k, what]) => [h("dt", {}, h("kbd", { text: k })), h("dd", { text: what })]));
  }
  box.hidden = !on;
}
function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape") {
    if (senseBox().some((n) => n.id === "sense-panel" && !n.hidden)) return; /* the Sensory panel's own Escape closes it first */
    if (glClose(true)) { e.preventDefault(); sfx("esc"); return; }
    if (!$("#keys").hidden) { e.preventDefault(); showKeys(false); sfx("esc"); return; }
    if (closeMore()) { e.preventDefault(); sfx("esc"); return; }
    if (SC.open === "library" && LIBUI.escape()) { e.preventDefault(); return; }
    if (SC.open !== null) { e.preventDefault(); requestClose(); }
    return;
  }
  if (e.key === "Tab") { if (SC.open !== null) trapFocus(e); return; }
  const t = e.target || {}, tag = t.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t.isContentEditable) return;
  if (e.key === "?") { e.preventDefault(); showKeys($("#keys").hidden); return; }
  if (e.key === "m" || e.key === "M") { e.preventDefault(); setSound(!AU.on); return; }
  if (e.key === "t" || e.key === "T") { e.preventDefault(); goScene("tonight"); return; }
  if (e.key === "d" || e.key === "D") { e.preventDefault(); goScene("decide"); return; } /* V16 */
  if (e.key === "/") { e.preventDefault(); LIBUI.focusSearch(); return; }
  if (/^[0-9]$/.test(e.key)) { const k = SCENES[(Number(e.key) + 9) % 10]; if (k) { e.preventDefault(); goScene(k); } return; }
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && SC.open !== null && !(t.closest && t.closest("#tabs, .cards, .opts"))) { e.preventDefault(); stepTab(e.key === "ArrowRight" ? 1 : -1); }
}
let closeMore = () => false;
function route() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
  /* V13e retest-6: #dates (the scene's name everywhere) is the Dates scene, whose key is timeline */
  if (/^dates(?:\.|$)/.test(raw)) { try { history.replaceState(history.state, "", `${location.pathname}${location.search}#${raw.replace(/^dates/, "timeline")}`); } catch (e) { return; } return route(); }
  const tm = raw.match(/^tonight\.([a-z0-9-]{1,40})$/); if (tm && MEM.setMe(tm[1]) && D.party) { renderTonight(); markMe(); }
  /* #wall: the wall at its top (the token names the <ul id="wall">, so the browser would scroll to it). */
  if (raw === "wall") { MEM.set("depth", "wall"); try { history.replaceState(history.state, "", `${location.pathname}${location.search}`); } catch (e) {} scrollTo(0, 0); if (document.readyState !== "complete") addEventListener("load", () => scrollTo(0, 0), { once: true }); }
  const key = sceneFromHash();
  /* V13b (mobile 5): */
  if (key && !(history.state && history.state.pushed)) { const url = location.pathname + location.search + location.hash; try { history.replaceState(null, "", location.pathname + location.search); history.pushState({ boardScene: key, pushed: true }, "", url); } catch (e) {} }
  /* V13d: a "<scene>.<thing>" hash lands on the thing (the wall's own clicks set SC.land with the mark that flies) */
  const lm = key && key !== "library" && key !== "tonight" && !/^atlas(?:\.|$)/.test(raw) ? raw.match(/^([a-z]+)\.([a-z0-9_-]{1,40})$/) : null;
  if (lm && !(SC.land && SC.land.key === key && SC.land.sub === lm[2])) SC.land = { key, sub: lm[2], from: null };
  if (key) { showScene(key); if (key === "library") LIBUI.fromHash(); } else hideScene();
}
function startScenes() {
  $("#board").addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".tile-search, .gl, .gl-def")) return;
    const a = e.target.closest && e.target.closest("[data-scene]");
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    /* V13d (interaction 1): a crest, a pin, a pint or a line inside a tile lands on that very thing, and its mark flies there */
    const land = e.target.closest("[data-land]"), tok = land && land.getAttribute("data-land"), lk = tok && tok.split(".")[0];
    if (tok && a.contains(land) && lk === a.dataset.scene) {
      SC.land = { key: lk, sub: tok.slice(lk.length + 1), from: land };
      KIT.emit("tap", land);
      if (SC.open !== null) { switchTab(lk); landing(lk); return; }
      setHash(tok, true); showScene(lk); return;
    }
    if (!setHash(a.dataset.scene, true)) { showScene(a.dataset.scene); return; }
    showScene(a.dataset.scene);
  });
  $("#tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) switchTab(t.dataset.tab); });
  $("#tabs").addEventListener("keydown", (e) => {
    const i = SCENES.indexOf(SC.open); if (i < 0) return;
    const j = e.key === "ArrowRight" ? (i + 1) % SCENES.length : e.key === "ArrowLeft" ? (i - 1 + SCENES.length) % SCENES.length : e.key === "Home" ? 0 : e.key === "End" ? SCENES.length - 1 : null;
    if (j === null) return;
    e.preventDefault(); switchTab(SCENES[j]); $(`#tab-${SCENES[j]}`).focus();
  });
  $("#scene-close").addEventListener("click", requestClose);
  startPeek();
  $("#scene-veil").addEventListener("click", requestClose);
  $("#keys-close").addEventListener("click", () => showKeys(false));
  document.addEventListener("keydown", onKey);
  document.addEventListener("focusin", (e) => {
    if (SC.open === null || !e.target || $("#scene").contains(e.target) || $("#keys").contains(e.target) || senseBox().some((n) => n.contains(e.target))) return;
    const first = focusables($("#scene"))[0]; if (first) first.focus();
  });
  addEventListener("popstate", route);
  addEventListener("hashchange", route);
  $("#view-wheel").addEventListener("click", () => setBuffView("wheel"));
  $("#view-list").addEventListener("click", () => setBuffView("list"));
  $("#skip").addEventListener("click", (e) => { e.preventDefault(); $("#main").focus(); });
  startBar();
  startSwipe();
  startLibBar();
  startLibrary();
  let mf = 0;
  addEventListener("resize", () => { if (SC.open) { moveInd(); clearTimeout(SC.fitT); SC.fitT = setTimeout(() => fitScene(), 200); } clearTimeout(mf); mf = setTimeout(() => { if (SC.open === "roads") mapFit(); }, 250); }, { passive: true });
}

const ICONS = {}, GLYPHS = {};
const iconImg = (key) => h("img", { class: "emblem-img", src: `img/icons/${key}.png`, alt: "", width: 192, height: 192, decoding: "async" });
/* V13c: tabs show a 48 px coin cut to the emblem's motif and sharpened, not the 192 px medallion shrunk to a blur */
const tabImg = (key) => h("img", { class: "emblem-img tab-img", src: `img/icons/tab-${key}.png`, alt: "", width: 48, height: 48, decoding: "async" });
const emblemFor = (key) => (ICONS[key] ? iconImg(key) : GLYPHS[key] ? GLYPHS[key].cloneNode(true) : null);
function setSheetEmblem(key) { const box = $("#sheet-emblem"); if (box) box.replaceChildren(...[emblemFor(key)].filter(Boolean)); placeSideMedal(key); }
/* V14: */
const MEDAL = { tonight: "Next steps", timeline: "Dates", five: "The five", roads: "Three roads", racials: "Race skills", legacy: "Bonuses", buffs: "Who buffs whom", ledger: "Ledger", signups: "Sign-ups", librarian: "Leeroy", library: "Library", decide: "What to decide" };
const MEDAL_BACK = { tonight: "Your next step, the next date and who is coming.", timeline: "Every date that matters, from the Blizzard calendar.", five: "Who plays what, straight from the group's own words.", roads: "Where each character starts and how the roads meet.", racials: "What each race brings, from the game client.", legacy: "The bonuses Forever carries over.", buffs: "Every buff by level, who gives it, who gets it.", ledger: "Every decision, in order, with the date.", signups: "Who is in for which night.", librarian: "Leeroy: ask in chat or ask here.", library: "Every fact the group has researched, searchable.", decide: "What is still open for each of us, by Blizzard's dates, and what each option changes." };
const medalImg = (key, cls) => h("img", { class: cls || "medal-img", src: `img/medal/${key}.webp`, alt: "", width: 640, height: 640, decoding: "async", loading: "lazy" });
/* frame leftovers (2026-10-30): every medal (640 px webp: the coin's face, the side medal) is fetched and decoded in idle time after load,
   one at a time, and an img takes a medal only once it is decoded, keeping what it shows until then. A first open never decodes one
   mid-transition (the owner's Edge, Oct 29: frames of 315 to 455 ms on the first open, then the coin popped in on an empty disc) */
const MEDALS = {};
function medalLoad(key) {
  let m = MEDALS[key]; if (m) return m;
  m = MEDALS[key] = { ok: false, p: null, im: null };
  if (typeof Image !== "function") { m.ok = true; m.p = Promise.resolve(); return m; }
  const im = new Image(); m.im = im; im.decoding = "async";
  const loaded = new Promise((r, j) => { im.onload = r; im.onerror = j; });
  im.src = `img/medal/${key}.webp`;
  m.p = (typeof im.decode === "function" ? im.decode() : loaded).then(() => { m.ok = true; }, () => { m.ok = true; m.failed = true; });
  return m;
}
function medalSet(img, key) {
  if (!img) return;
  const src = `img/medal/${key}.webp`; img.setAttribute("data-medal", key);
  if (img.getAttribute("src") === src) return;
  const m = medalLoad(key), put = () => { if (img.getAttribute("data-medal") === key && img.getAttribute("src") !== src) img.setAttribute("src", src); };
  if (m.ok) put(); else m.p.then(put);
}
function medalsIdle() {
  if (typeof navigator !== "undefined" && navigator.connection && navigator.connection.saveData) return; /* data saver: each medal loads on its first open instead */
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300)), keys = Object.keys(MEDAL);
  const step = () => { const k = keys.shift(); if (k) medalLoad(k).p.then(() => idle(step, { timeout: 2000 })); };
  idle(step, { timeout: 2000 });
}
function placeSideMedal(key) {
  const layer = $("#scene"); if (!layer || !MEDAL[key]) return;
  let m = $("#medal-side");
  if (!m) { m = h("div", { class: "medal-side", id: "medal-side", "aria-hidden": "true" }, h("span", { class: "coin" }, h("span", { class: "coin-in" }, h("img", { class: "medal-img", alt: "", width: 640, height: 640, decoding: "async" })), h("span", { class: "coin-shine" }))); layer.appendChild(m); }
  const img = m.querySelector("img"); medalSet(img, key);
  img.onerror = () => { m.hidden = true; };
  sizeSideMedal();
}
function sizeSideMedal() {
  const m = $("#medal-side"), sheet = document.querySelector("#scene .sheet"); if (!m || !sheet) return;
  const r = sheet.getBoundingClientRect(), room = Math.floor(r.left);
  const size = Math.min(room - 72, 360, innerHeight * 0.5);
  if (size < 150 || !SC.open) { m.hidden = true; return; }
  m.hidden = false; m.style.setProperty("--ms", `${Math.round(size)}px`); m.style.left = `${Math.round((r.left - size) / 2)}px`;
}
function openMedal(key, opener) {
  if (!MEDAL[key] || $("#medal-lb")) return;
  const flipped = { v: false };
  const coin = h("button", { class: "lb-coin", type: "button", "aria-label": `${MEDAL[key]} medallion. Press to turn it over.`, "aria-pressed": "false" },
    h("span", { class: "lb-face lb-front" }, medalImg(key, "medal-img"), h("span", { class: "coin-shine" })),
    h("span", { class: "lb-face lb-back" }, h("span", { class: "lb-back-in" }, h("b", { text: MEDAL[key] }), h("i", { text: MEDAL_BACK[key] || "" }))));
  const close = h("button", { class: "lb-close close", type: "button", "aria-label": "Close the medallion" }, s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: "M6 6l12 12M18 6L6 18" })));
  const lb = h("div", { class: "medal-lb", id: "medal-lb", role: "dialog", "aria-modal": "true", "aria-label": `${MEDAL[key]} medallion` }, h("div", { class: "lb-stage" }, coin, h("p", { class: "lb-hint", text: "Press the coin to turn it over. Esc closes." })), close);
  const done = () => { document.removeEventListener("keydown", onKey, true); lb.classList.add("out"); setTimeout(() => lb.remove(), reduceMQ.matches ? 0 : 180); try { (opener || $("#scene-close")).focus(); } catch (e) {} };
  const turn = () => { flipped.v = !flipped.v; coin.classList.toggle("turned", flipped.v); coin.setAttribute("aria-pressed", String(flipped.v)); try { sfx && sfx("flip"); } catch (e) {} };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); } else if (e.key === "Tab") { e.preventDefault(); (document.activeElement === coin ? close : coin).focus(); } };
  coin.addEventListener("click", turn); close.addEventListener("click", done); lb.addEventListener("click", (e) => { if (e.target === lb || e.target.classList.contains("lb-stage")) done(); });
  coin.addEventListener("pointermove", (e) => { if (reduceMQ.matches || e.pointerType === "touch") return; const r = coin.getBoundingClientRect(); coin.style.setProperty("--rx", `${(((e.clientY - r.top) / r.height) - 0.5) * -14}deg`); coin.style.setProperty("--ry", `${(((e.clientX - r.left) / r.width) - 0.5) * 14}deg`); coin.style.setProperty("--sx", `${Math.round(((e.clientX - r.left) / r.width) * 100)}%`); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(lb); coin.focus();
}
document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("#sheet-emblem"); if (b && SC.open) { e.preventDefault(); openMedal(SC.open, b); } });
addEventListener("resize", () => { if (SC.open) sizeSideMedal(); });
function placeIcon(key) {
  const slot = document.querySelector(`#board [data-scene="${key}"] .emblem-slot`);
  if (slot) slot.replaceChildren(iconImg(key));
  const tab = $(`#tab-${key} .tab-ico`);
  if (tab) tab.replaceChildren(tabImg(key));
  if (SC.open === key) setSheetEmblem(key);
}
function startEmblems() {
  for (const key of SCENES) {
    const g = document.querySelector(`#board [data-scene="${key}"] .emblem-slot .emblem`) || document.querySelector(`#tab-${key} .emblem`);
    if (g) GLYPHS[key] = g.cloneNode(true);
    const tab = $(`#tab-${key} .tab-ico`);
    if (tab && GLYPHS[key]) tab.replaceChildren(GLYPHS[key].cloneNode(true));
    const im = new Image();
    im.onload = () => { ICONS[key] = true; placeIcon(key); };
    im.src = `img/icons/${key}.png`;
  }
}
function pinTiles() {
  const LEAN = { roads: ["-1.4deg", "-6px", "4px"], legacy: ["1.2deg", "8px", "-3px"], ledger: ["-1.5deg", "-5px", "6px"] };
  document.querySelectorAll("#wall .tile").forEach((t) => {
    const l = LEAN[t.dataset.scene];
    /* V13b (craft 32): the lean and the grain are seeded by the tile's own key, so the wall hangs the same on every visit */
    const k = t.dataset.scene || "", r = (i) => { let x = 7 + i; for (const c of k) x = (x * 31 + c.charCodeAt(0)) % 2147483647; const v = Math.sin(x) * 43758.5453; return v - Math.floor(v); };
    t.style.setProperty("--rot", l ? l[0] : `${(Math.round((r(1) * 1.2 - 0.6) * 10) / 10).toFixed(1)}deg`);
    if (l) { t.style.setProperty("--sx", l[1]); t.style.setProperty("--sy", l[2]); }
    t.style.setProperty("--gx", `${Math.round(r(2) * 100)}%`); t.style.setProperty("--gy", `${Math.round(r(3) * 100)}%`);
  });
}

function startParallax() {
  const hoverMQ = window.matchMedia("(hover: hover) and (pointer: fine)");
  const img = $("#hero-art img"); if (!img) return;
  let raf = 0, tx = 0, ty = 0;
  addEventListener("pointermove", (e) => {
    if (!hoverMQ.matches || reduceMQ.matches || e.pointerType !== "mouse") return;
    tx = -(e.clientX / innerWidth - 0.5) * 24; ty = -(e.clientY / innerHeight - 0.5) * 24;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; img.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`; });
  }, { passive: true });
  reduceMQ.addEventListener("change", () => { if (reduceMQ.matches) img.style.transform = ""; });
}

const LIGHT_VS = "attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}";
const LIGHT_FS = `precision mediump float;
uniform sampler2D tex;uniform vec2 texel,res,cover,lpos;uniform float lint,bump,lh;uniform vec3 warm,cool,shade;varying vec2 uv;
float L(vec2 q){return dot(texture2D(tex,q).rgb,vec3(.299,.587,.114));}
void main(){
vec2 q=.5+(uv-.5)*cover;
vec3 base=texture2D(tex,q).rgb;
vec3 n=normalize(vec3((L(q-vec2(texel.x,0.))-L(q+vec2(texel.x,0.)))*bump,(L(q-vec2(0.,texel.y))-L(q+vec2(0.,texel.y)))*bump,1.));
vec3 d=vec3(lpos-uv*res,lh);float dist=length(d);
float r=dist/(.75*max(res.x,res.y));
float lit=max(dot(n,d/dist),0.)/(1.+3.*r*r);
vec3 col=base*(cool*2.4+warm*lit*lint*1.3);
float v=length((uv-vec2(.5,.46))/vec2(.5,.46))/1.542;
float a=v<.42?.22*v/.42:v<.76?.22+.4*(v-.42)/.34:.62+.32*clamp((v-.76)/.24,0.,1.);
gl_FragColor=vec4(mix(col,shade,a),1.);}`;
const LIGHT = { bump: 2.5, ease: 0.08, candle: [0.06, 0.1], flicker: 0.1, jitter: 6 };
const hexVec = (v, d) => { const m = /^#?([0-9a-f]{6})$/i.exec(v || ""); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) : d; };
const LS = { state: "off", draws: 0, why: "", n: 0 };
/* V13b: */
const flickHash = (i) => { const v = Math.sin(i * 127.1 + 311.7 * 7.31) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
const flickOct = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return flickHash(i) * (1 - u) + flickHash(i + 1) * u; };
const flickBase = (s) => 1.25 * (0.55 * flickOct(s * 1.9) + 0.3 * flickOct(s * 4.3 + 17) + 0.15 * flickOct(s * 9.7 + 41));
/* V13c: a fire crackle heard in the sound (js/sound.js) adds a short pop, so the light jumps with the sound it makes */
const FLICK_POP = { t: -1, amp: 0, ms: 75 };
const flickPop = (s) => { if (FLICK_POP.t < 0) return 0; const d = s * 1000 - FLICK_POP.t; return d < 0 || d > FLICK_POP.ms ? 0 : FLICK_POP.amp * (1 - d / FLICK_POP.ms); };
const flickAt = (s) => Math.max(-1, Math.min(1, flickBase(s) + flickPop(s)));
/* V13b: */
const LB = { tx: null, ty: null, x: 0, y: 0, rn: 0, roomAt: 0, tilt: false, frames: 0, running: false };
const LIGHT_REST = [0.08, 0.16]; /* the candle's corner of the viewport, as a share of its width and height */
const pageX = () => window.scrollX || 0, pageY = () => window.scrollY || 0;
function aimAt(x, y) { LB.tx = x; LB.ty = y; if (LB.wake) LB.wake(); }
function lightCore(cv, o, say) {
  let gl = null, u = {}, ready = false, img = null;
  try { gl = cv.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" }) || cv.getContext("experimental-webgl"); } catch (e) { gl = null; }
  if (!gl) { say("absent"); return null; }
  const api = {
    start(bmp) {
      img = bmp; ready = false;
      let prog, ext;
      try {
        ext = gl.getExtension("KHR_parallel_shader_compile"); prog = gl.createProgram();
        for (const [t, src] of [[gl.VERTEX_SHADER, o.VS], [gl.FRAGMENT_SHADER, o.FS]]) { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); gl.attachShader(prog, x); }
        gl.linkProgram(prog);
      } catch (e) { say("fallback", "init failed"); return; }
      const poll = () => {
        try {
          if (gl.isContextLost()) { say("fallback", "context lost"); return; }
          if (ext && !gl.getProgramParameter(prog, ext.COMPLETION_STATUS_KHR)) { setTimeout(poll, 16); return; }
          if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
          gl.useProgram(prog);
          gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
          const at = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
          for (const k of ["tex", "texel", "res", "cover", "lpos", "lint", "bump", "lh", "warm", "cool", "shade"]) u[k] = gl.getUniformLocation(prog, k);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          for (const [p, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
          gl.uniform1i(u.tex, 0); gl.uniform2f(u.texel, 1 / img.width, 1 / img.height); gl.uniform1f(u.bump, o.bump);
          gl.uniform3f(u.warm, ...o.warm); gl.uniform3f(u.cool, ...o.cool); gl.uniform3f(u.shade, ...o.shade);
        } catch (e) { say("fallback", "init failed"); return; }
        ready = true; say("lit");
      };
      poll();
    },
    size(W, H, cw, ch) {
      if (!ready) return;
      cv.width = cw; cv.height = ch; gl.viewport(0, 0, cw, ch);
      const ac = W / H, ai = img.width / img.height;
      gl.uniform2f(u.cover, ac > ai ? 1 : ac / ai, ac > ai ? ai / ac : 1); gl.uniform2f(u.res, W, H); gl.uniform1f(u.lh, 0.42 * Math.min(W, H));
    },
    draw(x, y, i) {
      if (!ready) return;
      if (gl.isContextLost()) { ready = false; say("fallback", "context lost"); return; }
      try { gl.uniform2f(u.lpos, x, y); gl.uniform1f(u.lint, i); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); } catch (e) { ready = false; say("fallback", "draw failed"); }
    },
  };
  cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); ready = false; say("fallback", "context lost"); });
  cv.addEventListener("webglcontextrestored", () => { if (img) api.start(img); });
  return api;
}
function startLight() {
  /* companion N4 (integrator): Play mode makes no WebGL context; the plate stays its painted still until Lounge */
  if (roomHas("play")) { const later = () => { if (roomHas("play")) return; removeEventListener("board-mode", later); startLight(); }; addEventListener("board-mode", later); return; }
  const cv = $("#light"), plate = cv && cv.parentNode;
  if (!cv || typeof cv.getContext !== "function") return;
  const S = { core: null, worker: null, iw: 1, ih: 1, W: 0, H: 0, raf: 0, onScreen: true, scene: SC.open !== null /* V13a: a scene open before the light starts (Tonight at a first visit) already covers it */, lx: 0, ly: 0, tx: null, ty: null, px: 0, py: 0, last: 0 };
  const opts = { VS: LIGHT_VS, FS: LIGHT_FS, bump: LIGHT.bump, warm: hexVec(cssVar("--light-warm"), [1, 0.82, 0.55]), cool: hexVec(cssVar("--light-cool"), [0.18, 0.2, 0.28]), shade: hexVec(cssVar("--oak-0"), [0.07, 0.05, 0.03]) };
  const call = (k, ...a) => { if (S.worker) S.worker.postMessage({ k, a }); else if (S.core) S.core[k](...a); };
  const say = (state, why) => {
    if (state === "lit") { LS.state = "lit"; plate.classList.add("lit"); size(); still(); run(); return; }
    stop(); plate.classList.remove("lit"); LS.state = state; LS.why = why || "";
  };
  const size = () => {
    const r = plate.getBoundingClientRect();
    S.px = r.left + pageX(); S.py = r.top + pageY(); /* the plate in page pixels: the shared aim is turned into plate pixels per frame without a layout read */
    S.W = Math.max(1, Math.round(r.width)); S.H = Math.max(1, Math.round(r.height));
    const k = Math.max(0.5, Math.min(2, window.devicePixelRatio || 1, S.iw / S.W));
    call("size", S.W, S.H, Math.round(S.W * k), Math.round(S.H * k));
    if (S.tx === null) { S.lx = S.W * LIGHT.candle[0]; S.ly = S.H * LIGHT.candle[1]; }
  };
  const draw = (t) => {
    const calm = reduceMQ.matches, s = t / 1000;
    /* the shared aim (viewport pixels) in plate pixels */
    S.tx = LB.tx === null ? null : LB.tx - (S.px - pageX()); S.ty = LB.ty === null ? null : LB.ty - (S.py - pageY());
    const tx = S.tx === null ? S.W * LIGHT.candle[0] : S.tx, ty = S.ty === null ? S.H * LIGHT.candle[1] : S.ty;
    /* V13b: eased by elapsed time, so the 30 fps cap moves the light as fast as the old 60 fps loop did */
    const e = 1 - Math.pow(1 - LIGHT.ease, Math.min(6, Math.max(1, (t - (S.drawn || t - 16.7)) / 16.7))); S.drawn = t;
    if (calm) { S.lx = tx; S.ly = ty; } else { S.lx += (tx - S.lx) * e; S.ly += (ty - S.ly) * e; }
    const n = LS.n = calm ? 0 : flickAt(s);
    const jx = calm ? 0 : LIGHT.jitter * (0.6 * Math.sin(s * 2.3 + 0.4) + 0.4 * Math.sin(s * 4.7 + 1.9));
    const jy = calm ? 0 : LIGHT.jitter * (0.6 * Math.sin(s * 1.9 + 2.2) + 0.4 * Math.sin(s * 5.3 + 0.7));
    call("draw", S.lx + jx, S.ly + jy, 1 - LIGHT.flicker / 2 + (LIGHT.flicker / 2) * n);
    LS.draws++;
  };
  /* V13b: */
  const frame = (t) => { S.raf = 0; if (LS.state !== "lit") return; if (t - S.last >= 1000 / 30 - 3) { S.last = t; draw(t); } if (live()) S.raf = requestAnimationFrame(frame); };
  const live = () => LS.state === "lit" && !reduceMQ.matches && !document.hidden && S.onScreen && !S.scene && !roomHas("room-on") && !roomHas("play");
  addEventListener("board-room", () => (live() ? run() : stop()));
  const run = () => { if (!S.raf && live()) S.raf = requestAnimationFrame(frame); };
  function stop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  const still = () => { if (LS.state === "lit") draw(performance.now()); };
  const onPage = (img) => { LS.via = "page"; S.core = lightCore(cv, opts, say); if (S.core) S.core.start(img); };
  const img = new Image();
  img.decoding = "async";
  img.onerror = () => { LS.state = "absent"; };
  img.onload = () => {
    S.iw = img.width; S.ih = img.height;
    if (!(cv.transferControlToOffscreen && window.Worker && window.createImageBitmap && window.URL && window.Blob)) { onPage(img); return; }
    let w, url, timer = 0;
    try { url = URL.createObjectURL(new Blob([`const core=${lightCore};let c=null;onmessage=(e)=>{const m=e.data;if(m.cv){c=core(m.cv,m.o,(s,w)=>postMessage([s,w]));if(c)c.start(m.bmp)}else if(c)c[m.k](...m.a)};postMessage(["up"])`], { type: "text/javascript" })); w = new Worker(url); }
    catch (e) { onPage(img); return; }
    const fail = () => { clearTimeout(timer); try { w.terminate(); } catch (e) {} if (!S.worker) onPage(img); };
    timer = setTimeout(fail, 3000);
    w.onerror = fail;
    w.onmessage = async (e) => {
      const [s, why] = e.data;
      if (s !== "up") { say(s, why); return; }
      clearTimeout(timer); URL.revokeObjectURL(url);
      try {
        const bmp = await createImageBitmap(img), off = cv.transferControlToOffscreen();
        S.worker = w; LS.via = "worker"; w.onerror = () => say("fallback", "worker error");
        w.postMessage({ cv: off, o: opts, bmp }, [off, bmp]);
      } catch (x) { try { w.terminate(); } catch (y) {} if (!S.worker) onPage(img); }
    };
  };
  img.src = "img/board-wall.jpg";
  let rs = 0;
  const resize = () => { if (rs || LS.state !== "lit") return; rs = requestAnimationFrame(() => { rs = 0; size(); still(); }); };
  addEventListener("resize", resize, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(plate);
  if (typeof IntersectionObserver === "function") new IntersectionObserver((es) => { for (const en of es) S.onScreen = en.isIntersecting; S.onScreen ? run() : stop(); }).observe(cv);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
  reduceMQ.addEventListener("change", () => { stop(); still(); run(); });
  sceneHooks.push((on) => { S.scene = on; if (on) stop(); else run(); });
  /* the aim moved (pointer, touch, tilt): a light that is not looping draws once toward it */
  const prevWake = LB.wake; LB.wake = () => { if (prevWake) prevWake(); if (live()) run(); };
  tiltReady();
}
/* V13b: the pointer and a touch aim the shared light (LB); the light's own loops read it, so there is one input path */
function startAim() {
  addEventListener("pointermove", (e) => { if (LB.tilt) return; if (e.pointerType === "mouse" || e.buttons) aimAt(e.clientX, e.clientY); }, { passive: true });
  addEventListener("pointerdown", (e) => { if (!LB.tilt && e.pointerType !== "mouse") aimAt(e.clientX, e.clientY); }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { if (!LB.tilt) { LB.tx = LB.ty = null; } });
}
/* V13b tilt (phone-deep T2 to T8): */
const TILT = { b0: null, g0: null, got: 0, dog: 0, linked: false };
function tiltLabel(on) { const t = $("#tilt"); if (!t) return; t.setAttribute("aria-pressed", String(on)); t.replaceChildren(s("svg", { class: "tilt-ico", viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: "M12 3c2.6 3 4 5.3 4 7.6a4 4 0 0 1-8 0C8 8.3 9.4 6 12 3z" }), s("path", { d: "M10 14.5h4v6h-4zM8 20.5h8" })), on ? "The tavern leans with your phone" : "Let the tavern lean with your phone"); }
function tiltSay(msg) {
  let n = $("#tilt-note");
  if (!n) { const t = $("#tilt"); if (!t) return; n = h("span", { class: "tilt-note", id: "tilt-note", role: "status" }); t.parentNode.insertBefore(n, t.nextSibling); }
  n.textContent = msg || "";
}
function onTilt(e) {
  if (e.gamma == null || e.beta == null) return;
  TILT.got++;
  const so = window.screen && window.screen.orientation, a = so && typeof so.angle === "number" ? so.angle : (window.orientation || 0);
  let x = e.gamma, y = e.beta; /* portrait */
  if (a === 90) { x = e.beta; y = -e.gamma; } else if (a === 270 || a === -90) { x = -e.beta; y = e.gamma; } else if (a === 180) { x = -e.gamma; y = -e.beta; }
  if (TILT.b0 === null) { TILT.b0 = y; TILT.g0 = x; }
  const nx = Math.max(-1, Math.min(1, (x - TILT.g0) / 25)), ny = Math.max(-1, Math.min(1, (y - TILT.b0) / 20));
  aimAt(innerWidth * (0.5 + 0.5 * nx), innerHeight * (0.5 + 0.5 * ny));
}
function tiltOff(msg) {
  LB.tilt = false; clearTimeout(TILT.dog); removeEventListener("deviceorientation", onTilt); LB.tx = LB.ty = null; tiltLabel(false);
  if (msg) tiltSay(msg);
}
let tiltBound = false;
function tiltReady() {
  const tilt = $("#tilt");
  if (!tilt || typeof DeviceOrientationEvent === "undefined" || !window.matchMedia("(pointer: coarse)").matches) return;
  /* nothing to move under reduced motion: the light holds still there */
  tilt.hidden = reduceMQ.matches;
  if (tiltBound) return; tiltBound = true;
  tiltLabel(false);
  reduceMQ.addEventListener("change", () => { tilt.hidden = reduceMQ.matches; if (reduceMQ.matches && LB.tilt) tiltOff(); });
  if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) window.screen.orientation.addEventListener("change", () => { TILT.b0 = TILT.g0 = null; });
  /* mobile build: js/tilt.js (window.BoardTilt) is the one orientation source when it is on the page. The button toggles it and the
     light aim subscribes to it; the deviceorientation listener and the watchdog below stay only for a page without tilt.js. */
  const linkTilt = () => {
    const BT = window.BoardTilt; if (!BT || TILT.linked) return; TILT.linked = true;
    BT.on(({ x, y }) => { LB.tilt = !!BT.status().on; if (LB.tilt) aimAt(innerWidth * (0.5 + 0.5 * x), innerHeight * (0.5 + 0.5 * y)); });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", linkTilt); else linkTilt();
  tilt.addEventListener("click", async () => {
    const BT = window.BoardTilt;
    if (BT) {
      linkTilt(); await BT.toggle(); const st = BT.status(); LB.tilt = !!st.on; if (!st.on) LB.tx = LB.ty = null; tiltLabel(!!st.on);
      tiltSay(st.on ? "" : st.permission === "denied" ? "Motion access was declined; reload the page to be asked again." : st.why === "no motion" ? "Your browser is not sharing motion here." : "");
      if (st.on) setTimeout(() => { const s2 = BT.status(); if (!s2.on) { LB.tilt = false; LB.tx = LB.ty = null; tiltLabel(false); if (s2.why === "no motion") tiltSay("Your browser is not sharing motion here."); } }, 1700);
      return;
    }
    if (LB.tilt) { tiltOff(); tiltSay(""); return; }
    try { if (typeof DeviceOrientationEvent.requestPermission === "function" && (await DeviceOrientationEvent.requestPermission()) !== "granted") { tiltOff("Motion access was declined; reload the page to be asked again."); return; } }
    catch (e) { tiltOff("Motion access was declined; reload the page to be asked again."); return; }
    LB.tilt = true; TILT.b0 = TILT.g0 = null; TILT.got = 0; addEventListener("deviceorientation", onTilt); tiltLabel(true); tiltSay("");
    /* a browser that shares no motion (a blocked site setting, an app view) sends nothing: say so and step aside */
    clearTimeout(TILT.dog); TILT.dog = setTimeout(() => { if (LB.tilt && !TILT.got) { tiltOff("Your browser is not sharing motion here."); tilt.hidden = true; } }, 1500);
  });
}

/* V13b: */
const SHEEN = { items: [], raf: 0, last: 0, scene: false, onScreen: true, dirs: 0 };
function startSheen() {
  const els = [...document.querySelectorAll("#wall .tile, #clock")];
  SHEEN.items = els.map((t) => { const i = h("i"); t.append(h("span", { class: "tile-sheen", "aria-hidden": "true" }, i)); return { t, i, x: 0, y: 0, w: 0, h: 0, dx: 9, dy: 9 }; });
  const candle = document.querySelector(".candle");
  document.documentElement.classList.add("flick-js"); /* the CSS candle loops step aside: the shared signal drives them */
  SHEEN.scene = SC.open !== null;
  LB.x = innerWidth * LIGHT_REST[0]; LB.y = innerHeight * LIGHT_REST[1];
  const measure = () => { for (const it of SHEEN.items) { const r = it.t.getBoundingClientRect(); it.x = r.left + pageX(); it.y = r.top + pageY(); it.w = r.width; it.h = r.height; } };
  let mq = 0; const remeasure = () => { if (!mq) mq = requestAnimationFrame(() => { mq = 0; measure(); paint(performance.now(), true); }); };
  const live = () => !reduceMQ.matches && !document.hidden && !SHEEN.scene && SHEEN.onScreen && SHEEN.items.length && !roomHas("play");
  const paint = (t, force) => {
    const calm = reduceMQ.matches, s = t / 1000, n = calm ? 0 : flickAt(s);
    const roomLit = roomHas("room-on") && t - LB.roomAt < 400;
    if (!roomLit) {
      const tx = LB.tx === null ? innerWidth * LIGHT_REST[0] : LB.tx, ty = LB.ty === null ? innerHeight * LIGHT_REST[1] : LB.ty;
      const e = calm ? 1 : 1 - Math.pow(0.92, Math.min(6, Math.max(1, (t - (SHEEN.last || t - 16.7)) / 16.7)));
      LB.x += (tx - LB.x) * e; LB.y += (ty - LB.y) * e;
    }
    SHEEN.last = t;
    if (candle) candle.style.opacity = (0.955 + 0.045 * n).toFixed(3);
    const sx = pageX(), sy = pageY(), diag = Math.hypot(innerWidth, innerHeight), turn = force || t - SHEEN.dirs > 250;
    if (turn) SHEEN.dirs = t;
    for (const it of SHEEN.items) {
      const left = it.x - sx, top = it.y - sy;
      if (!force && (top > innerHeight + 40 || top + it.h < -40)) continue; /* off screen: nothing to light */
      const lx = Math.max(-80, Math.min(it.w + 80, LB.x - left)), ly = Math.max(-80, Math.min(it.h + 80, LB.y - top));
      const cx = left + it.w / 2, cy = top + it.h / 2, d = Math.hypot(LB.x - cx, LB.y - cy), near = 1 / (1 + Math.pow(d / (0.55 * diag), 2));
      it.i.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
      it.i.style.opacity = Math.max(0, Math.min(1, near * (0.86 + 0.14 * n))).toFixed(3);
      if (turn) {
        const ux = d ? (cx - LB.x) / d : 0.5, uy = d ? (cy - LB.y) / d : 0.7, qx = Math.round(ux * 4) / 4, qy = Math.round(uy * 4) / 4;
        if (qx !== it.dx || qy !== it.dy) { it.dx = qx; it.dy = qy; it.t.style.setProperty("--ldx", String(qx)); it.t.style.setProperty("--ldy", String(qy)); }
      }
    }
    LB.frames++;
  };
  const frame = (t) => { SHEEN.raf = 0; if (t - SHEEN.last >= 1000 / 30 - 3) paint(t); if (live()) SHEEN.raf = requestAnimationFrame(frame); LB.running = !!SHEEN.raf; };
  const run = () => { if (!SHEEN.raf && live()) { SHEEN.raf = requestAnimationFrame(frame); LB.running = true; } };
  const stop = () => { if (SHEEN.raf) cancelAnimationFrame(SHEEN.raf); SHEEN.raf = 0; LB.running = false; };
  const prevWake = LB.wake; LB.wake = () => { if (prevWake) prevWake(); if (live()) run(); else if (!SHEEN.scene && !document.hidden) requestAnimationFrame((t) => paint(t)); };
  measure(); paint(performance.now(), true);
  addEventListener("resize", remeasure, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(remeasure).observe($("#wall"));
  /* the wall settles in (tiles drop into place), the fonts land: measure again once it has */
  setTimeout(remeasure, MOTION.stagger * 8 + MOTION.move * 2 + 50);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure).catch(() => {});
  if (typeof IntersectionObserver === "function") new IntersectionObserver((es) => { for (const en of es) SHEEN.onScreen = en.isIntersecting; SHEEN.onScreen ? run() : stop(); }).observe($("#main"));
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
  reduceMQ.addEventListener("change", () => { stop(); paint(performance.now(), true); run(); });
  sceneHooks.push((on) => { SHEEN.scene = on; if (on) stop(); else { remeasure(); run(); } });
  addEventListener("board-room", () => { remeasure(); run(); });
  run();
  tiltReady();
}

const WS = { n: 0, frames: 0, running: false, near: 0 };
function startWisps() {
  const cv = $("#wisps"), ctx = cv && cv.getContext && cv.getContext("2d");
  if (!ctx) return;
  const GX = 32, GY = 18, REBUILD = 2000, REPEL = 120;
  const LAYERS = [{ r: 1.1, a: 0.3, v: 0.32 }, { r: 1.8, a: 0.48, v: 0.55 }, { r: 2.8, a: 0.72, v: 0.9 }];
  const COLORS = ["--c-mage", "--c-warlock", "--c-mage", "--c-warlock", "--c-mage", "--c-warlock", "--c-mage", "--brass"].map(cssVar);
  let W = 0, H = 0, dpr = 1, raf = 0, parts = [], trail = [], covered = SC.open !== null && innerWidth < 700 /* V13a: a landing scene already covers the phone */, fA = null, fB = null, built = -1e9, gen = 0;
  const seed = Math.random() * 1000, pointer = { x: -1e4, y: -1e4 };
  const hash = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
  const noise = (x, y, s) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const build = (s) => { const f = new Float32Array(GX * GY); for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) f[j * GX + i] = -Math.PI / 2 + (noise(i / 7, j / 7, s) * 2 - 1) * Math.PI * 0.9; return f; };
  const at = (f, gx, gy) => { const i = Math.min(GX - 2, gx | 0), j = Math.min(GY - 2, gy | 0), u = gx - i, v = gy - j, k = j * GX + i; return (f[k] * (1 - u) + f[k + 1] * u) * (1 - v) + (f[k + GX] * (1 - u) + f[k + GX + 1] * u) * v; };
  let sprites = [];
  const paint = () => {
    sprites = COLORS.map((c) => LAYERS.map((L) => {
      const R = Math.ceil(L.r * 9 * dpr), s = document.createElement("canvas"); s.width = s.height = R * 2;
      const g = s.getContext("2d"); if (!g) return null;
      const gr = g.createRadialGradient(R, R, 0, R, R, R);
      gr.addColorStop(0, c); gr.addColorStop(0.18, `${c}55`); gr.addColorStop(1, `${c}00`);
      g.fillStyle = gr; g.fillRect(0, 0, R * 2, R * 2);
      return { s, R: R / dpr };
    }));
  };
  const spawn = (x, y, life) => { const l = life ? 2 : (Math.random() * 3) | 0; return { x, y, vx: 0, vy: 0, l, c: (Math.random() * COLORS.length) | 0, ph: Math.random() * 6.28, life: life || 0, born: performance.now() }; };
  const size = () => {
    const d = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * d); cv.height = Math.round(H * d); ctx.setTransform(d, 0, 0, d, 0, 0);
    if (d !== dpr || !sprites.length) { dpr = d; paint(); }
    WS.n = Math.max(60, Math.min(120, Math.round((W * H) / 12000)));
    while (parts.length < WS.n) parts.push(spawn(Math.random() * W, Math.random() * H, 0));
    parts.length = WS.n;
  };
  const frame = (t) => {
    raf = 0;
    if (t - built > REBUILD || !fA) { fA = fB || build(seed + gen++); fB = build(seed + gen++); built = t; }
    const w = Math.min(1, (t - built) / REBUILD), sx = (GX - 1) / Math.max(1, W), sy = (GY - 1) / Math.max(1, H);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    let near = 0;
    const draw = (p, alpha) => { const sp = sprites[p.c] && sprites[p.c][p.l]; if (!sp) return; ctx.globalAlpha = alpha; ctx.drawImage(sp.s, p.x - sp.R, p.y - sp.R, sp.R * 2, sp.R * 2); };
    for (const p of parts) {
      const L = LAYERS[p.l], gx = Math.max(0, Math.min(GX - 1, p.x * sx)), gy = Math.max(0, Math.min(GY - 1, p.y * sy));
      const ang = at(fA, gx, gy) * (1 - w) + at(fB, gx, gy) * w;
      p.vx += (Math.cos(ang) * L.v - p.vx) * 0.04;
      p.vy += (Math.sin(ang) * L.v - 0.18 * L.v - p.vy) * 0.04;
      const dx = p.x - pointer.x, dy = p.y - pointer.y, d2 = dx * dx + dy * dy;
      if (d2 < REPEL * REPEL) { near++; const d = Math.sqrt(d2) + 0.01, f = (1 - d / REPEL) * 0.5; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
      p.x += p.vx; p.y += p.vy;
      if (p.y < -30) { p.y = H + 20; p.x = Math.random() * W; } else if (p.y > H + 30) p.y = -20;
      if (p.x < -30) p.x = W + 20; else if (p.x > W + 30) p.x = -20;
      draw(p, L.a * (0.55 + 0.45 * Math.sin(t / 900 + p.ph)));
    }
    trail = trail.filter((p) => t - p.born < p.life);
    for (const p of trail) { p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy = p.vy * 0.96 - 0.02; draw(p, 0.9 * (1 - (t - p.born) / p.life)); }
    ctx.globalAlpha = 1;
    WS.frames++; WS.near = near;
    if (live()) raf = requestAnimationFrame(frame);
  };
  const live = () => !reduceMQ.matches && !document.hidden && !covered && !roomHas("room-wisps") && !roomHas("room-off") && !roomHas("play"); /* companion N4: Play stops them before the ladder starts */
  addEventListener("board-room", () => { if (live()) run(); else { stop(); ctx.clearRect(0, 0, W, H); } });
  const run = () => { WS.running = live(); if (!raf && WS.running) raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; WS.running = false; };
  size();
  let rs = 0;
  addEventListener("resize", () => { if (!rs) rs = requestAnimationFrame(() => { rs = 0; size(); }); }, { passive: true });
  addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  addEventListener("pointerdown", (e) => {
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (e.pointerType !== "touch" || !raf) return;
    for (let i = 0; i < 6; i++) { const p = spawn(e.clientX, e.clientY, 700 + i * 60); const a = (i / 6) * 6.283; p.vx = Math.cos(a) * 1.4; p.vy = Math.sin(a) * 1.4 - 0.6; trail.push(p); }
    if (trail.length > 30) trail.splice(0, trail.length - 30);
  }, { passive: true });
  addEventListener("pointerup", (e) => { if (e.pointerType === "touch") pointer.x = pointer.y = -1e4; }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { pointer.x = pointer.y = -1e4; });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : run()));
  sceneHooks.push((on) => { covered = on && innerWidth < 700; if (covered) stop(); else run(); });
  reduceMQ.addEventListener("change", () => { if (reduceMQ.matches) { stop(); ctx.clearRect(0, 0, W, H); } else run(); if (D.party) renderMap(); });
  run();
}

const crestImg = (k, c = "crest") => h("img", { class: c, src: `img/crests/${k}.png`, alt: "", width: 56, height: 56, loading: "lazy", decoding: "async" });
const crestSvg = (k, x, y) => s("image", { class: "crest-node", href: `img/crests/${k}.png`, x: x - 28, y: y - 28, width: 56, height: 56 });
function placeCrest(k) {
  const front = document.querySelector(`#cards .card[data-k="${k}"] .front`);
  if (front && !front.querySelector(".crest")) front.prepend(crestImg(k));
  const med = document.querySelector(`#ts-five .med[data-k="${k}"] .med-ico`);
  if (med && !med.querySelector("img")) med.replaceChildren(crestImg(k, "med-img"));
  const node = document.querySelector(`#wheel .wheel-node[data-k="${k}"]`);
  if (node && !node.querySelector(".crest-node")) { node.classList.add("has-crest"); node.insertBefore(crestSvg(k, Number(node.dataset.x), Number(node.dataset.y)), node.querySelector("text")); }
}
function startArt() {
  const probe = (src, ok, bad) => { const im = new Image(); im.onload = ok; if (bad) im.onerror = bad; im.src = src; };
  for (const k of new Set(D.party.members.map((m) => m.class_key).filter(Boolean))) probe(`img/crests/${k}.png`, () => { ART.crest[k] = true; placeCrest(k); });
  probe("img/map/zeppelin.png", () => { ART.zep = true; if (MAPW.drawn) renderMap(); });
  probe("img/map/town.png", () => { ART.town = true; if (MAPW.drawn) renderMap(); });
  probe("img/seal.png", () => { ART.seal = true; try { renderLedger(); } catch (e) { console.error(e); } });
  probe("img/beam.png", () => {
    ART.beam = true;
    $("#main").classList.add("has-beam"); $("#main").classList.remove("beam-soon");
    $("#main").prepend(h("img", { class: "beam", src: "img/beam.png", alt: "", "aria-hidden": "true", decoding: "async" }));
  }, () => { $("#main").classList.remove("beam-soon"); }); /* CLS (2026-10-30): main.beam-soon (set in index.html) holds the beam's margin from the first paint; it was added by this probe about 0.5 s in and moved the whole wall 22 px */
}

/* Sound (V13c): */
const SND = () => window.BoardSound || null;
const AU = { on: false, vol: 0.7 };
try { AU.on = localStorage.getItem("board-sound") === "1"; const v = localStorage.getItem("board-vol"); if (v !== null && Number(v) >= 0 && Number(v) <= 1) AU.vol = Number(v); } catch (e) {}
/* the fire's crackle pops the shared flicker (FLICK_POP) for 60 to 90 ms: the wall light, the candles and the room's fire brighten with it */
function sfx(name, opt) { const S = SND(); return S ? S.play(name, opt) : false; }
/* wait: the toggle says on, the browser has not let the sound start yet (no gesture since load) */
function soundWaiting() { const S = SND(); return AU.on && !(S && S.running()); }
function soundLabel(on) {
  const wait = on && soundWaiting();
  return [s("svg", { class: "spk", viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: "M4 9h4l5-4v14l-5-4H4z" }), on ? s("path", { d: "M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" }) : s("path", { d: "M16.5 9.5l5 5M21.5 9.5l-5 5" })), wait ? "Sound: tap to start" : on ? "Sound: on" : "Sound: off"];
}
function soundButtons() { document.querySelectorAll("#sound, #bottombar [data-go=\"sound\"], #more-menu [data-go=\"sound\"]").forEach((b) => { b.setAttribute("aria-pressed", String(AU.on)); if (b.id === "sound") b.replaceChildren(...soundLabel(AU.on)); else b.textContent = AU.on ? (soundWaiting() ? "Sound: tap to start" : "Sound: on") : "Sound: off"; }); }
function setSound(on) {
  AU.on = on;
  try { localStorage.setItem("board-sound", on ? "1" : "0"); } catch (e) {}
  const S = SND();
  if (S) { S.setVol(AU.vol); if (!S.setOn(on)) AU.on = false; if (AU.on) { S.setFlick(flickAt); S.onCrackle(() => { if (!reduceMQ.matches) { FLICK_POP.t = performance.now(); FLICK_POP.amp = 0.35 + Math.random() * 0.3; if (RS.pop) RS.pop(FLICK_POP.t, FLICK_POP.amp, FLICK_POP.ms); /* the room's worker hears the same pop (room/tier.js) */ } }); S.setScene(SC.open !== null); } }
  else AU.on = false;
  soundButtons();
  setTimeout(() => { soundButtons(); roomCues(); }, 300);
}
function startSound() {
  const btn = $("#sound"), vol = $("#vol"), box = $("#sound-box");
  if (!btn) return;
  soundButtons();
  vol.value = String(Math.round(AU.vol * 100));
  let press = 0, held = false;
  btn.addEventListener("pointerdown", () => { held = false; press = setTimeout(() => { held = true; box.classList.add("show"); }, 500); });
  btn.addEventListener("pointerup", () => clearTimeout(press));
  btn.addEventListener("click", () => { if (held) { held = false; return; } setSound(soundWaiting() ? true : !AU.on); });
  vol.addEventListener("input", () => { AU.vol = Number(vol.value) / 100; try { localStorage.setItem("board-vol", String(AU.vol)); } catch (e) {} const S = SND(); if (S) S.setVol(AU.vol); });
  /* V13c (phone-deep 2.1): */
  const gesture = () => { if (!AU.on) return; const S = SND(); if (!S || S.running()) return; if (S.status().state === "none") setSound(true); else S.gesture(); setTimeout(soundButtons, 60); };
  for (const t of ["click", "touchend", "keydown"]) addEventListener(t, gesture, true);
  sceneHooks.push((on) => { const S = SND(); if (S && AU.on) S.setScene(on); });
  /* V13c (craft 27): */
  document.addEventListener("toggle", (e) => { if (e.target && e.target.tagName === "DETAILS" && e.target.closest("#scene")) sfx("paper", { gain: e.target.open ? 1 : 0.7 }); }, true);
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("button, a"); if (!t || !AU.on) return;
    if (t.matches(".tn-name, .deep-who .lib-tool, #tn-change, #deep-change")) sfx("chip");
    else if (t.matches("#view-wheel, #view-list, #lib-expert, .toggle button, .deep-marks button, .tilt")) sfx("latch");
    else if (t.matches(".road-btn, .map-pin, [data-road]")) sfx("pin");
    else if (t.matches('[data-go="more"]')) sfx("menu");
    else if (t.matches(".copy, .lib-copy")) sfx("copy");
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target && (e.target.id === "lib-q" || e.target.id === "tile-q")) sfx("quill"); }, true);
  document.addEventListener("submit", () => sfx("quill"), true);
}
function audioStatus() { const S = SND(); const st = S ? S.status() : { on: false, state: "none" }; return { ...st, on: AU.on, volume: AU.vol, measure: (ms) => (S ? S.measure(ms) : Promise.resolve(null)) }; }

/* The library (V4-SPEC 3.3): */
const LIBD = { index: null, indexP: null, head: {}, full: {}, catP: {}, tips: null, tipsP: null, tipRe: null, open: null, openP: null, news: null, newsP: null };
const LIBS = { state: "idle", via: "none", why: "", worker: null, core: null, coreP: null, ready: false, view: { kind: "shelf" }, cat: "", q: "", req: 0, res: null, shown: 60, ms: null, timer: 0, all: null, hays: null, back: null, searches: 0, rows: 0, token: 0, toastT: 0 };
const LIB_CAP = 60;
/* V13a: a search runs once typing pauses this long (Enter runs it at once); results then draw in one frame */
const LIB_TYPE_MS = 120;
/* V13a: result rows drawn in the first frame, then per later frame */
const LIB_FIRST_WIDE = 12, LIB_SLICE = 16;
const libFirst = () => (innerWidth < 700 ? 6 : LIB_FIRST_WIDE); /* a phone shows about six rows */
const dtShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const libDay = (d) => (d ? dtShort.format(new Date(`${d}T12:00:00Z`)) : "undated");
/* V11 cache stamps: index.json names each library file's stamp, so every other file loads as <file>?v=<stamp> */
const libStamped = (url) => { const v = LIBD.index && LIBD.index.stamps && LIBD.index.stamps[url.replace(/^data\/library\//, "")]; return v ? `${url}?v=${v}` : url; };
const libGet = (url) => libIndex().catch(() => null).then(() => fetch(libStamped(url))).then((r) => { if (!r.ok) throw new Error(`${url} answered ${r.status}`); return r.json(); });
const libTitle = (id) => (LIBD.head[id] ? LIBD.head[id].title : id);
const libCatTitle = (key) => { const c = LIBD.index && LIBD.index.categories.find((x) => x.key === key); return c ? c.title : key; };
function libIndex() {
  LIBD.indexP ||= fetch("data/library/index.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`the library index answered ${r.status}`); return r.json(); }).then((j) => {
    LIBD.index = j; for (const p of j.pages) LIBD.head[p.id] = p;
    try { renderLibTile(); } catch (e) { console.error(e); }
    return j;
  });
  return LIBD.indexP;
}
function libCat(key) {
  LIBD.catP[key] ||= libGet(`data/library/${key}.json`).then((j) => { for (const p of j.pages) LIBD.full[p.id] = p; return j; });
  return LIBD.catP[key];
}
function renderLibTile() {
  const ix = LIBD.index; if (!ix) return;
  const T = ix.totals, c = ix.changes[0], box = $("#ts-library-new");
  fill("library", minis([[nf.format(T.pages), "pages"], [nf.format(T.facts), "facts"], [nf.format(T.blizzard), "from Blizzard"], [nf.format(T.open), "open questions"]]));
  /* The date is the History line's own leading date (c.date), never a date inside the text. */
  if (box) box.replaceChildren(...(c && ix.changes.length >= 3 ? [h("small", { text: `Newest change, ${libDay(c.date)}` }), h("span", { text: wholeClause(`${libTitle(c.page)}: ${c.text}`, 64) })] : [h("small", { text: "Changes" }), h("span", { class: "clamp", text: libQuiet(ix) })]));
}
const libQuiet = (ix) => `No numbers have changed since ${libDay(ix.changes_since)}; ${plural(ix.rechecks, "recheck", "rechecks")} confirmed them.`;
function libPrefetch() { libIndex().catch(() => fill("library", h("span", { class: "tile-line", text: "The library did not load." }))); }

const libQTok = (q) => String(q).toLowerCase().replace(/[^a-z0-9.\s-]+/g, " ").trim().split(/[\s-]+/).filter(Boolean).join("-");
const libTok = (v) => v.kind === "page" ? `library.${v.id.replace("/", ".")}${v.fact ? `~${v.fact}` : ""}` : v.kind === "results" ? `library.q.${libQTok(v.q)}` : v.kind === "open" ? "library.open" : v.kind === "changes" ? "library.changes" : v.cat ? `library.c.${v.cat}` : "library";
function libViewOf(tok) {
  const t = String(tok || "").replace(/^library\.?/, "");
  if (!t) return { kind: "shelf" };
  const [head, ...rest] = t.split(".");
  if (head === "q") return { kind: "results", q: rest.join(".").split("-").join(" ") };
  if (head === "open") return { kind: "open" };
  if (head === "changes") return { kind: "changes" };
  if (head === "c") return { kind: "shelf", cat: rest[0] || "" };
  const [pid, fact] = t.split("~"), i = pid.indexOf(".");
  return { kind: "page", id: i > 0 ? `${pid.slice(0, i)}/${pid.slice(i + 1)}` : pid, fact: fact || null };
}
function libLink(v) {
  const tok = `#${libTok(v)}`, host = location.hostname;
  const framed = /claudeusercontent\.com$|claude\.ai$|discordsays\.com$/.test(host) || location.protocol === "file:";
  return { text: framed ? tok : `${location.origin}${location.pathname}${tok}`, framed };
}
function libToast(msg, sel) {
  const t = $("#toast"); if (!t) return;
  clearTimeout(LIBS.toastT);
  t.replaceChildren(h("span", { text: msg }), sel ? h("input", { value: sel, readonly: true, "aria-label": "Text to copy" }) : null);
  t.hidden = false;
  if (sel) { const i = t.querySelector("input"); try { i.focus({ preventScroll: true }); i.select(); } catch (e) {} }
  LIBS.toastT = setTimeout(() => { t.hidden = true; }, sel ? 9000 : 2600);
}
async function libCopy(text, done) {
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
  if (ok) libToast(done); else libToast("Copying was blocked here, so the text is selected below.", text);
}
const copyChip = (label, text, done) => h("button", { class: "copy", type: "button", onclick: () => libCopy(text, done) }, label);
const linkChip = (v) => { const l = libLink(v); return copyChip(v.kind === "page" ? "Copy link to this page" : v.kind === "results" ? "Copy link to this search" : "Copy link", l.text, l.framed ? "Copied the link token: add it after the board's address." : "Link copied."); };
const askChip = (q, label) => copyChip(label || "Ask Leeroy", `/ask ${q}`, "Copied the /ask line: paste it in #wow-forever.");

/* the ranker module, loaded once (Phase 0, 2026-10-30: the Leeroy chamber's follow-ups rank the library index with it too) */
function libCore() { if (!LIBS.coreP) LIBS.coreP = import("../vendor/rank-core.js?v=7f8514dc3a").then((m) => (LIBS.core = m)).catch(() => null); return LIBS.coreP; }
function libStart() {
  if (LIBS.state !== "idle") return;
  LIBS.state = "loading";
  libCore();
  libTips();
  let w = null;
  try { if (typeof Worker === "function") w = new Worker("vendor/library-worker.js?v=4430a39290", { type: "module" }); } catch (e) { w = null; }
  if (!w) { libFallback("no worker"); return; }
  LIBS.worker = w; LIBS.via = "worker";
  const timer = setTimeout(() => { if (!LIBS.ready) libFallback("worker timeout"); }, 8000);
  w.onmessage = (e) => {
    const m = e.data || {};
    if (m.ready) { clearTimeout(timer); LIBS.ready = true; LIBS.state = "ready"; libPending(); return; }
    if (m.error) { clearTimeout(timer); libFallback(m.error); return; }
    libResults(m);
  };
  w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); clearTimeout(timer); libFallback("worker error"); };
  w.postMessage({});
}
async function libFallback(why) {
  if (LIBS.via === "page") return;
  try { if (LIBS.worker) LIBS.worker.terminate(); } catch (e) {}
  LIBS.worker = null; LIBS.via = "page"; LIBS.why = why; LIBS.ready = false;
  try {
    const [core, ix] = await Promise.all([LIBS.coreP, libIndex()]);
    if (!core) throw new Error("the ranker did not load");
    await Promise.all(ix.categories.map((c) => libCat(c.key)));
    LIBS.all = ix.pages.map((x) => LIBD.full[x.id]).filter(Boolean).map((p) => ({ id: p.id, title: p.title, category: p.category, aliases: p.aliases, facts: p.facts, open: p.open }));
    LIBS.hays = core.factHays(LIBS.all);
    LIBS.ready = true; LIBS.state = "ready"; libPending();
  } catch (e) { LIBS.state = "failed"; LIBS.why = String((e && e.message) || e); libRender(); }
}
function libPending() { if (LIBS.view.kind === "results") libSearch(LIBS.view.q, true); else libRender(); }
function libSearch(q, keepView) {
  const t = String(q || "").trim();
  LIBS.q = t;
  if (!t) { LIBS.res = null; if (!keepView && LIBS.view.kind === "results") libGo({ kind: "shelf", cat: LIBS.cat }); return; }
  if (LIBS.view.kind !== "results") LIBS.back = null;
  LIBS.view = { kind: "results", q: t };
  libHash();
  if (!LIBS.ready) { libRender(); return; }
  const id = ++LIBS.req;
  if (LIBS.via === "worker" && LIBS.worker) { LIBS.worker.postMessage({ id, q: t, cap: 400, full: LIB_CAP, cat: LIBS.cat }); return; }
  const t0 = performance.now();
  const { words, hits } = LIBS.core.rank(t, LIBS.all, { hays: LIBS.hays });
  libResults({ id, q: t, words, total: hits.length, ms: Math.round((performance.now() - t0) * 10) / 10, hits: hits.slice(0, 400).map((x) => ({ score: x.score, page: x.page, title: x.p.title, category: x.p.category, key: x.key, value: x.value, open: x.open, refs: x.f ? x.f.refs : [] })) });
}
function libResults(m) {
  if (m.id !== LIBS.req) return;
  const more = !!m.more && !!LIBS.res && LIBS.res.q === m.q; /* the same search with more rows filled in keeps "Show more" */
  LIBS.res = m; if (!more) { LIBS.shown = LIB_CAP; LIBS.searches++; } LIBS.ms = m.ms;
  if (LIBS.view.kind === "results") libRenderSoon();
}
/* V13a: results render once per frame at most, with whatever answer is newest by then */
function libRenderSoon() {
  if (LIBS.raf) return;
  LIBS.raf = requestAnimationFrame(() => { LIBS.raf = 0; if (LIBS.view.kind === "results") libRender(); });
}
/* V13a: the worker sends text only for the rows the page can show; a wider view (Show more, a shelf) asks for its rows */
function libFill() {
  /* only for the answer on screen with nothing newer asked: a search typed meanwhile wins */
  if (LIBS.via !== "worker" || !LIBS.worker || !LIBS.res || LIBS.req !== LIBS.res.id || LIBS.filling === `${LIBS.res.q}|${LIBS.cat}|${LIBS.shown}`) return;
  LIBS.filling = `${LIBS.res.q}|${LIBS.cat}|${LIBS.shown}`;
  LIBS.worker.postMessage({ id: ++LIBS.req, q: LIBS.res.q, cap: 400, full: LIBS.shown, cat: LIBS.cat, more: true });
}
function libHash() { if (SC.open === "library") setHash("library", false); }
function libGo(v, from) {
  if (v.kind === "page" && LIBS.view.kind !== "page") LIBS.back = LIBS.view;
  if (v.kind !== "page" && v.kind !== "results") LIBS.back = null;
  if (v.kind === "shelf") { LIBS.cat = v.cat || ""; }
  if (v.kind === "results") { const box = $("#lib-q"); if (box && box.value !== v.q) box.value = v.q; libSearch(v.q); return; }
  if (v.kind !== "results") { const box = $("#lib-q"); if (box) { box.value = ""; LIBS.q = ""; } }
  LIBS.view = v;
  libHash();
  libRender(from !== "hash");
}

const libSrc = (r) => h("a", { class: `src t${r.tier}`, href: r.url, target: "_blank", rel: "noopener noreferrer", title: `${r.label}, ${r.host}` }, h("span", { class: "src-l", text: r.label }), h("span", { "aria-hidden": "true", text: "·" }), h("span", { class: "src-h", text: r.host }));
const TIER_WORD = ["client table", "Blizzard", "guide or wiki", "forum or datamine"];
const dtRead = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const libExpert = () => MEM.get("expert") === "1" || JR() === "everything"; /* V13d: the Everything journey reads the library as an expert */
const libXp = (refs) => h("span", { class: "xp" }, refs.map((r) => {
  const b = (String(r.url).match(/build=[\d.]*?(\d{5,})/) || [])[1];
  return h("span", {}, h("b", { text: `${r.id} ${r.host}` }), `: ${TIER_WORD[r.tier] || "source"} (tier ${r.tier})`, b ? `, build ${b}` : "", r.accessed ? `, read ${dtRead.format(new Date(`${r.accessed}T12:00:00Z`))} ` : " ", h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", "aria-label": `Verify at ${r.host}` }, "Verify"));
}));
let DIFF = null;
const libDiff = () => DIFF || (DIFF = libGet("data/library/diff.json").catch(() => null));
/* owners: null for the shelf (every owner), or the page: a class page takes its class, a race page every racial its text names. */
function libRibbon(page) {
  const box = h("div", { class: "ribbon-slot" });
  libDiff().then((d) => {
    if (!d) return;
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    const text = page ? page.facts.map((f) => `${f.key} ${f.value}`).join(" ").toLowerCase() : "";
    const owners = !page ? null : page.category === "classes" ? [cap(page.id.split("/")[1].split("-")[0])] : d.summary.map((s) => s.owner).filter((o) => o.startsWith("Racial: ") && text.includes(o.slice(8).toLowerCase()));
    if (owners && !owners.length) return;
    const short = (b) => b.split(".").pop();
    const rows = owners ? d.rows.filter((r) => owners.includes(r.owner)) : [];
    const sum = owners ? d.summary.filter((s) => owners.includes(s.owner)) : d.summary;
    const n = sum.reduce((a, s) => a + s.changed + s.added + s.removed, 0);
    if (!n) return;
    box.replaceChildren(h("details", { class: "ribbon" },
      h("summary", { text: `Changed since build ${short(d.from)}: ${plural(n, "spell row", "spell rows")} in build ${short(d.to)}` }),
      owners ? h("ul", {}, rows.map((r) => h("li", {}, h("b", { text: r.name }), ` (spell ${r.spell}, ${r.kind}): ${r.change}`)))
        : h("ul", {}, sum.filter((s) => s.changed + s.added + s.removed).map((s) => h("li", { text: `${s.owner}: ${s.changed} changed, ${s.added} added, ${s.removed} removed` }))),
      h("p", { text: `Source: ${d.source}.` })));
  });
  return box;
}
const libRead = (refs) => { const d = refs.map((r) => r.accessed).filter(Boolean).sort().pop(); return d ? h("span", { class: "read", text: `read ${libDay(d)}` }) : null; };
const libKey = (k) => k.replace(/_/g, " ").split(".").join(" · ");
/* A fact that is only an ISO date reads as a date; the ISO text stays beside it. */
const dtET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const libValue = (t, self) => { const iso = /^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z)$/.exec(String(t).trim()); if (iso) return [h("b", { class: "iso", text: dtET.format(new Date(iso[1])) }), h("span", { class: "read", text: ` ${iso[1]}` })]; const m = /^(\d{4}-\d\d-\d\d)$/.exec(String(t).trim()); return m ? [h("b", { class: "iso", text: dtDayUTC.format(new Date(`${m[1]}T12:00:00Z`)) }), h("span", { class: "read", text: ` ${m[1]}` })] : richText(t, self); };
const pageLink = (id, cls, kids, fact) => h("a", { class: cls, href: `#${libTok({ kind: "page", id, fact })}`, "data-lv": libTok({ kind: "page", id, fact }) }, ...[].concat(kids));
function libRenderHead() {
  const ix = LIBD.index, box = $("#lib-head"); if (!ix || !box) return;
  const T = ix.totals, st = D.stats;
  const stat = (v, l) => h("div", { class: "lib-stat" }, h("b", { text: v }), h("span", { text: l }));
  const extra = (el) => { el.classList.add("extra"); return el; };
  box.replaceChildren(stat(nf.format(T.pages), "pages"), stat(nf.format(T.facts), "facts"), stat(nf.format(T.blizzard), "from Blizzard"), stat(nf.format(T.open), "open questions"), extra(stat(nf.format(T.gaps), "researched gaps")),
    st ? extra(stat(String(st.answers), "answers by Leeroy")) : null, st ? extra(stat(fmtSecs(st.median_s), "median reply")) : null,
    extra(stat(libDay(ix.generated.slice(0, 10)), "as of")));
}
const CAT_EMB = { classes: "classes", dungeons: "dungeons", events: "cal", history: "book", leveling: "leveling", professions: "tradeskills", pvp: "pvp", races: "races", raids: "skull", systems: "systems", ui: "ui" };
function libRenderRail() {
  const ix = LIBD.index, rail = $("#lib-rail"); if (!ix || !rail) return;
  const counts = {};
  if (LIBS.view.kind === "results" && LIBS.res) for (const x of LIBS.res.hits) counts[x.category] = (counts[x.category] || 0) + 1;
  const res = LIBS.view.kind === "results" && LIBS.res;
  const btn = (key, label, n) => h("button", { class: "cat", type: "button", "data-cat": key, "aria-pressed": String(LIBS.cat === key) }, emb(CAT_EMB[key] || "classes", "cat-ico"), h("span", { text: label }), h("b", { text: nf.format(n) }));
  const want = [["", "All", res ? LIBS.res.hits.length : ix.totals.pages], ...ix.categories.map((c) => [c.key, c.title, res ? counts[c.key] || 0 : c.pages])];
  /* V13a: the shelf buttons stay; a keystroke only rewrites their counts and pressed state */
  const have = [...rail.children];
  if (have.length === want.length && want.every(([k], i) => have[i].dataset.cat === k)) {
    want.forEach(([k, , n], i) => { const b = have[i], v = nf.format(n), p = String(LIBS.cat === k), c = b.querySelector("b"); if (c && c.textContent !== v) c.textContent = v; if (b.getAttribute("aria-pressed") !== p) b.setAttribute("aria-pressed", p); });
    return;
  }
  rail.replaceChildren(...want.map(([k, l, n]) => btn(k, l, n)));
}
function libRender(fresh) {
  const main = $("#lib-main"); if (!main) return;
  const tok = ++LIBS.token;
  LIBS.glossSeen = new Set();
  libRenderRail();
  const v = LIBS.view, count = $("#lib-count");
  $("#panel-library").dataset.view = v.kind;
  if (count && v.kind !== "results") count.textContent = "";
  if (!LIBD.index) { main.replaceChildren(h("p", { class: "loading", text: LIBS.state === "failed" ? "The library did not load." : "Opening the stacks." })); return; }
  if (v.kind === "page") { libRenderPage(v, tok, fresh); return; }
  if (v.kind === "results") { const t0 = performance.now(); libRenderResults(main); LIBS.renderMs = Math.round((performance.now() - t0) * 10) / 10; return; }
  if (v.kind === "open") { libRenderOpen(main, tok); return; }
  if (v.kind === "changes") { libRenderChanges(main); return; }
  libRenderShelf(main);
}
function libRenderShelf(main) {
  const ix = LIBD.index, cats = ix.categories.filter((c) => !LIBS.cat || c.key === LIBS.cat);
  const card = (c) => {
    const pages = ix.pages.filter((p) => p.category === c.key), wide = !!LIBS.cat;
    return h("section", { class: `scroll${wide ? " wide" : ""}`, "aria-label": c.title },
      h("div", { class: "scroll-end" }, h("h3", { text: c.title }), h("span", { text: `${plural(c.pages, "page", "pages")}, ${plural(c.facts, "fact", "facts")}` })),
      h("ul", {}, pages.map((p) => h("li", {}, pageLink(p.id, "plink", [p.title, h("small", { text: nf.format(p.facts) }), isNewPage(p) ? h("span", { class: "new-badge", text: "New" }) : null, wide && p.blurb ? h("span", { text: p.blurb }) : null])))));
  };
  const seen = MEM.seenMap(), isNewPage = (p) => { const t = seen[`page:${p.id}`], d = p.checked || p.as_of; return !!t && !!d && Date.parse(`${d}T23:59:59Z`) > t; };
  const kids = [];
  if (LIBS.cat) { kids.push(h("h3", { class: "lib-title", text: libCatTitle(LIBS.cat) }), h("div", { class: "shelf" }, cats.map(card))); main.replaceChildren(...kids); return; }
  /* V9: */
  if (libExpert()) kids.push(libRibbon(null));
  kids.push(libDoors(),
    h("h3", { class: "lib-title catrows-h", text: "The shelves" }),
    h("div", { class: "catrows" }, ix.categories.map((c) => h("a", { class: "catrow", href: `#${libTok({ kind: "shelf", cat: c.key })}`, "data-lv": libTok({ kind: "shelf", cat: c.key }) },
      h("b", { text: c.title }), h("span", { text: `${plural(c.pages, "page", "pages")} · ${nf.format(c.facts)} facts` })))),
    h("details", { class: "allshelf", open: innerWidth >= 1800 && innerHeight >= 1200 ? "" : null /* integrator pass 3: a wide, tall frame shows every shelf (the front page left 40 percent of it empty) */ }, h("summary", { text: `Every page, shelf by shelf (${nf.format(ix.pages.length)})` }), h("div", { class: "shelf" }, cats.map(card))),
    h("details", { class: "allshelf", ...(wideLib() ? { open: "" } : {}) }, h("summary", { text: "The front page: what changed, what nobody knows, what Blizzard said" }), libFront(wideLib() ? 2 : 8)));
  main.replaceChildren(...kids.filter(Boolean));
}
function libRenderResults(main) {
  const count = $("#lib-count"), v = LIBS.view;
  if (!LIBS.ready || !LIBS.res || LIBS.res.q !== v.q) {
    if (count) count.textContent = LIBS.state === "failed" ? "Search is not available." : "Reading the shelves.";
    if (LIBS.state === "failed") main.replaceChildren(h("p", { text: `Search did not start: ${LIBS.why}.` }));
    return;
  }
  const hits = LIBS.res.hits.filter((x) => !LIBS.cat || x.category === LIBS.cat);
  const pages = new Map();
  for (const x of hits) { if (!pages.has(x.page)) pages.set(x.page, { id: x.page, title: x.title, category: x.category, hits: [] }); pages.get(x.page).hits.push(x); }
  if (count) count.textContent = hits.length ? `${plural(hits.length, "match", "matches")} on ${plural(pages.size, "page", "pages")}` : "No match";
  $("#panel-library").dataset.view = hits.length ? "results" : "zero";
  if (LIBS.lastQ !== v.q) { LIBS.lastQ = v.q; const sb = $("#sheet-body"); if (sb) sb.scrollTop = 0; }
  if (!hits.length) { main.replaceChildren(libZero(v.q)); return; }
  const max = hits[0].score || 1;
  let left = LIBS.shown, rows = 0;
  const groups = [];
  /* V13a: */
  { let need = LIBS.shown; for (const g of pages.values()) { for (const x of g.hits) { if (need-- <= 0) break; if (x.key === undefined) { libFill(); return; } } if (need <= 0) break; } }
  const plan = [];
  for (const g of pages.values()) {
    if (left <= 0) break;
    const list = g.hits.slice(0, left); left -= list.length; rows += list.length;
    plan.push([g, list]);
  }
  const groupFor = (g, list) => (h("section", { class: "group", "aria-label": g.title },
      h("div", { class: "group-head" }, pageLink(g.id, "", g.title), h("span", { class: "lib-sub", text: libCatTitle(g.category) })),
      h("ul", { class: "hits" }, list.map((x) => {
        const go = (() => { const a = pageLink(g.id, `hit-go${x.open ? " open-q" : ""}`, x.open ? "nobody knows yet" : libKey(x.key), x.open ? null : x.key); a.setAttribute("aria-label", x.open ? `Nobody knows yet, on ${g.title}: open the page` : `${libKey(x.key)}, on ${g.title}: open the page`); return a; })();
        /* V12: the plain sentence first; ids, builds and source sites wait behind Sources (Expert keeps them inline) */
        if (libExpert()) return h("li", { class: "hit" }, go, h("span", { class: "hit-val" }, ...libValue(x.value)), x.refs.length ? h("span", { class: "hit-meta" }, x.refs.map(libSrc), libRead(x.refs)) : null);
        const P = libPlain(x);
        return h("li", { class: "hit" }, h("span", { class: "hit-val hit-lead" }, ...P.lead), go, libSources(P.prov, x.refs));
      })),
      list.length > 1 ? h("button", { type: "button", class: "lib-btn more-hits-in", "aria-expanded": "false", onclick: (e) => { const sec = e.currentTarget.closest(".group"); const on = !sec.classList.contains("all"); sec.classList.toggle("all", on); e.currentTarget.setAttribute("aria-expanded", String(on)); e.currentTarget.textContent = on ? "Fewer" : `${list.length - 1} more on this page`; } }, `${list.length - 1} more on this page`) : null));
  LIBS.rows = rows;
  const defOnly = !!libGlossFor(String(v.q).trim().toLowerCase()) && LIBS.allFor !== v.q;
  if (defOnly) {
    main.replaceChildren(libAnswer(v.q, hits[0]), h("button", { class: "lib-btn", type: "button", onclick: () => { LIBS.allFor = v.q; libRender(); } }, `Show ${plural(hits.length, "match", "matches")} in the game's own words`), h("div", { class: "lib-row" }, linkChip(v), askChip(v.q, "Ask Leeroy this")));
    return;
  }
  /* V13a: */
  const answer = libAnswer(v.q, hits[0]);
  const first = []; let n = 0;
  const firstN = libFirst();
  while (plan.length && (n < firstN || !first.length)) { const [g, list] = plan.shift(); first.push(groupFor(g, list)); n += list.length; }
  const box = h("div", { class: "groups" }, first);
  const kids = [answer, h("p", { class: "lib-sub", text: "Every match, grouped by page, best first." }), box];
  if (hits.length > rows) kids.push(h("button", { class: "lib-btn more-hits", type: "button", onclick: () => { LIBS.shown += LIB_CAP; libRender(); } }, `Show ${Math.min(LIB_CAP, hits.length - rows)} more`));
  kids.push(h("div", { class: "lib-row" }, linkChip(v), askChip(v.q, "Ask Leeroy this")));
  main.replaceChildren(...kids);
  const tok = LIBS.token;
  const slice = () => {
    if (tok !== LIBS.token || !plan.length) return;
    const part = []; let m = 0;
    while (plan.length && m < LIB_SLICE) { const [g, list] = plan.shift(); part.push(groupFor(g, list)); m += list.length; }
    box.append(...part);
    if (plan.length) requestAnimationFrame(() => setTimeout(slice, 0));
  };
  if (plan.length) requestAnimationFrame(() => setTimeout(slice, 0));
}
/* The best answer leads the results: the game's own tooltip when the question names a spell or item, else the top fact. */
function libAnswer(q, best) {
  const T = LIBD.tips, key = String(q).trim().toLowerCase();
  const ti = T && !TT_SKIP.has(key) ? T.names[key] : undefined;
  const g = libGlossFor(key);
  if (g) return h("section", { class: "answer", "aria-label": "Best answer" }, h("span", { class: "answer-k", text: "In plain words" }), h("p", { class: "answer-v" }, h("b", { text: `${g.term}: ` }), g.def), h("span", { class: "lib-sub", text: "From the board's glossary." }));
  const buffs = libBuffAnswer(key);
  if (buffs) return buffs;
  if (ti !== undefined) return h("section", { class: "answer", "aria-label": "Best answer" }, h("span", { class: "answer-k", text: "From the game's tooltip" }), libTipLead(ti), h("div", { class: "ttc static", "data-static": "1" }, ttCard(ti)));
  if (libExpert()) return h("section", { class: "answer", "aria-label": "Best answer" },
    h("span", { class: "answer-k" }, "Best answer, from ", pageLink(best.page, "", best.title)),
    h("span", { class: "lib-sub", text: best.open ? "Nobody knows yet" : libKey(best.key) }),
    h("p", { class: "answer-v" }, ...libValue(best.value)),
    best.refs.length ? h("span", { class: "hit-meta" }, best.refs.map(libSrc), libRead(best.refs)) : null);
  const P = libPlain(best);
  return h("section", { class: "answer", "aria-label": "Best answer" },
    h("span", { class: "answer-k" }, "Best answer, from ", pageLink(best.page, "", best.title)),
    h("p", { class: "answer-v answer-lead" }, ...P.lead),
    libSources(P.prov, best.refs));
}
/* V12 (first-visitor test): */
const PROV_RE = /\s*\((?=[^()]*\b(?:client|build|spell \d|datamine|notes|deep dive|hotfix|forum|Wowhead|wiki|tier|source|cache|S\d+)\b)[^()]*\)/gi;
function libPlain(x) {
  const raw = String(x.value == null ? "" : x.value).trim(), prov = [];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const segs = String(x.key || "").split("."), subj = cap((segs.length <= 2 ? segs.join(" ") : segs[segs.length - 1]).replace(/_/g, " "));
  const iso = /^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z)$/.exec(raw), day = /^(\d{4}-\d\d-\d\d)$/.exec(raw);
  if (iso || day) { prov.push(raw); return { lead: [h("b", { text: `${subj}: ` }), iso ? dtET.format(new Date(iso[1])) : dtDayUTC.format(new Date(`${day[1]}T12:00:00Z`)), "."], prov }; }
  let v = raw.replace(PROV_RE, (m) => { prov.push(m.trim().replace(/^\(|\)$/g, "")); return ""; }).replace(/\s+([.,;:])/g, "$1").trim();
  if (!/[.!?"]$/.test(v)) v += ".";
  return { lead: [h("b", { text: x.open ? "Nobody knows yet: " : `${subj}: ` }), ...richText(v)], prov };
}
function libSources(prov, refs) {
  if (!prov.length && !refs.length) return null;
  return h("details", { class: "srcs" }, h("summary", { text: "Sources" }),
    prov.length ? h("span", { class: "srcs-note", text: `Where the numbers come from: ${prov.join("; ")}.` }) : null,
    refs.length ? h("span", { class: "hit-meta" }, refs.map(libSrc), libRead(refs)) : null);
}
/* a tooltip answer leads with who learns it and when, in words */
function libTipLead(i) {
  const t = LIBD.tips.tooltips[i], L = t.lines || [];
  const cls = (L.find((l) => /^(?:Requires|Classes:) [A-Z]/.test(l) && !/level/i.test(l)) || "").replace(/^(?:Requires|Classes:)\s*/, "");
  const lvl = (L.find((l) => /^Requires level \d+/i.test(l)) || "").replace(/\D+/g, "");
  const what = t.kind === "item" ? "an item" : `a${cls ? ` ${cls}` : ""} spell`;
  return h("p", { class: "answer-v answer-lead" }, `${t.name} is ${what}${lvl ? `, from level ${lvl}` : ""}. Here is what the game's own tooltip says.`);
}
/* "what does the priest give a mage", "what buff does Bible Boi give my class": the board's own buff table answers in one sentence */
const LIB_CLASSES = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];
function libBuffAnswer(key) {
  const B = D.client && D.client.buffs; if (!B || !/\bgives?\b|\bbuffs?\b/.test(key)) return null;
  const P = D.party, words = key.replace(/[?.!,']/g, " ").split(/\s+/).filter(Boolean);
  const asClass = (w) => { const c = w.replace(/s$/, ""); if (LIB_CLASSES.includes(c)) return { cls: c }; const m = P && P.members.find((x) => x.name.toLowerCase() === w || MEM.slug(x.name) === w); return m ? { cls: m.class_key, m } : null; };
  const found = []; words.forEach((w, i) => { const a = asClass(w); if (a) found.push({ ...a, i }); });
  const gi = words.indexOf("give") >= 0 ? words.indexOf("give") : words.indexOf("gives");
  const giver = found.find((f) => gi < 0 || f.i < gi); if (!giver) return null;
  let target = found.find((f) => f !== giver && (gi < 0 || f.i > gi)) || null;
  const mine = /\bmy\b|\bme\b/.test(key) && MEM.member(); if (!target && mine) target = { cls: mine.class_key, m: mine };
  const L = BD.level, mana = (c) => !["warrior", "rogue"].includes(c), melee = (c) => ["warrior", "rogue", "paladin", "druid", "shaman", "hunter"].includes(c);
  const list = B.list.filter((b) => b.class === giver.cls && (!target || b.lands === "all" || b.lands === "one" || b.lands === "dead" || (b.lands === "mana" && mana(target.cls)) || (b.lands === "melee" && melee(target.cls)) || (target.m ? buffWho(b, target.m) && ["tank", "healer"].includes(b.lands) : false)));
  if (!list.length) return null;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1), an = (c) => (/^[aeiou]/.test(c) ? "an" : "a");
  const name = (f) => (f.m ? `${f.m.name} (${cap(f.cls)})` : `${an(f.cls)} ${cap(f.cls)}`);
  const val = (b) => { const a = b.at && b.at[L - 1]; return a && a.v && a.v.length ? ` (${a.v.map((v) => `${nf.format(Math.round(v.n))}${/^%/.test(v.label) ? "" : " "}${v.label}`).join(", ")})` : ""; };
  const names = list.map((b) => `${b.name}${val(b)}`);
  const said = `${cap(name(giver))} can give ${target ? name(target) : "the party"} ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}, at level ${L}.`;
  return h("section", { class: "answer", "aria-label": "Best answer" }, h("span", { class: "answer-k", text: "From the board's buff table" }),
    h("p", { class: "answer-v answer-lead", text: said }),
    h("button", { type: "button", class: "lib-btn", onclick: () => goScene("buffs") }, "See every level in Who buffs whom"));
}
/* "what is a racial", "racials", "define cooldown": the glossary term the question asks about, if any. */
function libGlossFor(key) {
  if (!LIBD.gloss || !LIBD.glossForm) return null;
  const k = key.replace(/[?.!]+$/, "").replace(/^(?:what(?:'s| is| are)|whats|define|meaning of)\s+(?:an?\s+|the\s+)?/, "").trim();
  const i = LIBD.glossForm[k];
  return i === undefined ? null : LIBD.gloss[i];
}
function libNearest(q, n = 5) {
  const words = String(q).toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const grams = (w) => { const g = new Set(), s2 = ` ${w} `; for (let i = 0; i < s2.length - 1; i++) g.add(s2.slice(i, i + 2)); return g; };
  const dice = (a, b) => { const A = grams(a), B = grams(b); let k = 0; for (const x of A) if (B.has(x)) k++; return (2 * k) / (A.size + B.size); };
  const scored = LIBD.index.pages.map((p) => {
    const cand = [p.title, ...(p.aliases || []), p.id.split("/")[1].replace(/-/g, " ")].join(" ").toLowerCase().split(/[\s/']+/).filter(Boolean);
    const sc = words.length ? words.reduce((t, w) => t + Math.max(0, ...cand.map((c) => dice(w, c))), 0) / words.length : 0;
    return { p, sc };
  });
  return scored.filter((x) => x.sc >= 0.42).sort((a, b) => b.sc - a.sc).slice(0, n).map((x) => x.p);
}
function libZero(q) {
  const near = libNearest(q);
  const card = h("div", { class: "lib-empty" },
    h("h3", { class: "lib-title", text: `Nothing on the shelves for "${q}"` }),
    near.length ? h("p", { text: "Pages with a similar name:" }) : null,
    near.length ? h("ul", { class: "hits" }, near.map((p) => h("li", {}, pageLink(p.id, "plink", [p.title, h("small", { text: libCatTitle(p.category) })])))) : null,
    h("p", { text: "Leeroy can look it up. The button copies the question as a Discord command." }),
    h("div", { class: "lib-row" }, h("button", { class: "lib-btn strong", type: "button", onclick: () => libCopy(`/ask ${q}`, "Copied the /ask line: paste it in #wow-forever.") }, "Ask Leeroy"), linkChip(LIBS.view)));
  const ix = LIBD.index;
  const shelf = h("div", { class: "shelf" }, ix.categories.map((c) => h("section", { class: "scroll", "aria-label": c.title },
    h("div", { class: "scroll-end" }, h("h3", { text: c.title }), h("span", { text: `${plural(c.pages, "page", "pages")}, ${plural(c.facts, "fact", "facts")}` })),
    h("ul", {}, ix.pages.filter((p) => p.category === c.key).map((p) => h("li", {}, pageLink(p.id, "plink", [p.title, h("small", { text: nf.format(p.facts) })])))))));
  return h("div", { class: "lib-zero" }, card, h("h3", { class: "lib-title", text: near.length ? "Or browse a shelf" : "Browse a shelf instead" }), shelf);
}
async function libRenderPage(v, tok, fresh) {
  const main = $("#lib-main"), head = LIBD.head[v.id];
  const back = h("div", { class: "lib-row" }, h("button", { class: "lib-btn", type: "button", "data-back": "1" }, LIBS.back && LIBS.back.kind === "results" ? `Back to results for "${LIBS.back.q}"` : "Back to the shelf"));
  if (!head) { main.replaceChildren(back, h("p", { text: "That page is not on the shelves." })); return; }
  if (!LIBD.full[v.id]) { main.replaceChildren(back, h("p", { class: "loading", text: `Taking ${head.title} off the shelf.` })); try { await libCat(head.category); } catch (e) { if (tok === LIBS.token) main.replaceChildren(back, h("p", { text: "That shelf did not load." })); return; } }
  if (tok !== LIBS.token) return;
  const p = LIBD.full[v.id];
  const xp = libExpert(), hostOf = {};
  for (const f of p.facts) for (const r of f.refs) hostOf[r.id] = r.host;
  const SEAL = { confirmed: "--seal-confirmed", likely: "--seal-likely", speculative: "--seal-speculative", "classic-baseline": "--seal-baseline" };
  const facts = h("dl", { class: "facts" }, p.facts.map((f, i) => h("div", { class: "lf", "data-key": f.key, style: `--di: ${Math.min(i, 14)}` },
    h("dt", { text: libKey(f.key) }),
    h("dd", {}, h("span", { class: `lf-v${String(f.value).length > 170 ? " clamp3" : ""}` }, ...libValue(f.value)),
      String(f.value).length > 170 ? h("button", { type: "button", class: "lf-more", "aria-expanded": "false", onclick: (e) => { const v = e.currentTarget.previousElementSibling, on = v.classList.toggle("clamp3"); e.currentTarget.setAttribute("aria-expanded", String(!on)); e.currentTarget.textContent = on ? "more" : "less"; } }, "more") : null,
      f.refs.length ? h("span", { class: "hit-meta" }, f.refs.map(libSrc), libRead(f.refs), xp ? libXp(f.refs) : null) : null))));
  const hist = p.history || [];
  const histLi = (x) => h("li", {}, h("time", { datetime: x.date || "", text: libDay(x.date) }), h("span", { text: x.text }));
  const page = h("article", { class: "lib-page", "aria-labelledby": "lib-page-title" },
    h("div", { class: "page-head" },
      h("h3", { id: "lib-page-title", text: p.title }),
      h("div", { class: "page-meta" },
        h("span", {}, h("b", { text: libCatTitle(p.category) })),
        p.as_of ? h("span", {}, "as of ", h("b", { text: libDay(p.as_of) })) : null,
        p.checked ? h("span", {}, "checked ", h("b", { text: libDay(p.checked) })) : null,
        h("span", { class: "wax", style: `--sc: var(${SEAL[p.confidence] || "--wax"})` }, emb("seal"), h("b", { text: p.confidence || "unrated" })),
        p.status ? h("span", { text: p.status.replace(/-/g, " ") }) : null),
      xp ? h("p", { class: "xp-snap" }, h("span", { text: `${p.recheck_days ? `Sources re-read every ${plural(p.recheck_days, "day", "days")}` : "No re-read interval"}. Saved copies, first 8 characters of each sha256:` }), ...(p.snapshots || []).map((s) => h("span", {}, `${s.id} ${s.host || hostOf[s.id] || ""} `, s.sha8 ? h("code", { text: s.sha8 }) : "no copy yet"))) : null,
      h("div", { class: "lib-row" }, linkChip(v), askChip(p.title, `Ask Leeroy about ${p.title}`))),
    xp && (p.category === "classes" || p.category === "races") ? libRibbon(p) : null,
    p.blurb ? h("p", { class: "blurb", text: p.blurb }) : null,
    h("h4", { class: "lib-h", text: "Facts" }), facts,
    p.open.length ? h("div", { class: "unknown" }, h("h4", {}, emb("question", "pend"), "Nobody knows yet"), h("ul", {}, p.open.map((o) => h("li", {}, ...richText(o))))) : null,
    p.related.length ? h("div", {}, h("h4", { class: "lib-h", text: "Related" }), h("div", { class: "ptabs" }, p.related.filter((id) => LIBD.head[id]).map((id) => pageLink(id, "ptab", libTitle(id))))) : null,
    hist.length ? h("div", {}, h("h4", { class: "lib-h", text: "History" }), h("ol", { class: "hist" }, hist.slice(0, 5).map(histLi)),
      hist.length > 5 ? h("details", { class: "hist-more" }, h("summary", { text: `${plural(hist.length - 5, "older entry", "older entries")}` }), h("ol", { class: "hist" }, hist.slice(5).map(histLi))) : null) : null);
  main.replaceChildren(back, page);
  MEM.seen(`page:${v.id}`);
  try { MEM.set("left", JSON.stringify({ tok: libTok(v), title: p.title })); } catch (e) {}
  if (fresh) { sfx("page"); if (!reduceMQ.matches) { page.classList.add("revealing"); setTimeout(() => page.classList.remove("revealing"), MOTION.move + MOTION.stagger * 15); } }
  const body = $("#sheet-body");
  const row = v.fact && page.querySelector(`.lf[data-key="${v.fact.replace(/[^a-z0-9_.]/g, "")}"]`);
  if (row) { row.classList.add("lit"); const v = row.querySelector(".lf-v.clamp3"); if (v) { v.classList.remove("clamp3"); const b = row.querySelector(".lf-more"); if (b) { b.textContent = "less"; b.setAttribute("aria-expanded", "true"); } } row.scrollIntoView({ block: "center", behavior: "auto" }); }
  else if (fresh && body) { const top = $("#lib-main").offsetTop - 70; if (body.scrollTop > top) body.scrollTop = Math.max(0, top); }
}
const LIBUI = {
  open() {
    libIndex().then(() => { libRenderHead(); libRender(); }).catch((e) => { LIBS.state = "failed"; LIBS.why = e.message; libRender(); });
    libStart();
    libGloss();
    const lg = $("#lib-legend"); if (lg) lg.hidden = false;
    libExamples();
    libRailHint();
  },
  token: () => libTok(LIBS.view),
  fromHash() {
    const k = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!/^library(\.|$)/.test(k)) return;
    const v = libViewOf(k);
    if (libTok(v) === libTok(LIBS.view) && (v.kind !== "results" || LIBS.res)) return;
    if (v.kind === "results") { const box = $("#lib-q"); if (box) box.value = v.q; libSearch(v.q); return; }
    libGo(v, "hash");
  },
  escape() {
    if (ttClose("focus")) return true;
    const t = $("#toast"); if (t && !t.hidden) { t.hidden = true; return true; }
    const v = LIBS.view;
    if (v.kind === "page") { libGo(LIBS.back || { kind: "shelf", cat: LIBS.cat }); return true; }
    if (v.kind === "results" || v.kind === "open" || v.kind === "changes" || LIBS.cat) { const box = $("#lib-q"); if (box) box.value = ""; LIBS.q = ""; LIBS.cat = ""; libGo({ kind: "shelf" }); if (box && document.activeElement !== box) box.focus({ preventScroll: true }); return true; }
    return false;
  },
  searchFrom(q) {
    const t = String(q || "").trim(), box = $("#lib-q");
    if (box) box.value = t;
    LIBS.q = t;
    if (t) { LIBS.back = null; LIBS.view = { kind: "results", q: t }; }
    goScene("library");
    if (t) libSearch(t);
    LIBUI.focusSearch();
  },
  focusSearch() {
    if (SC.open !== "library") goScene("library");
    let n = 0;
    const tryFocus = () => { const box = $("#lib-q"); if (box && shown(box) && !$("#scene").hidden) { box.focus({ preventScroll: true }); if (box.select) box.select(); return; } if (++n < 20) setTimeout(tryFocus, 50); };
    tryFocus();
  },
  status: () => ({ state: LIBS.state, via: LIBS.via, why: LIBS.why, ready: LIBS.ready, view: LIBS.view.kind, cat: LIBS.cat, searches: LIBS.searches, ms: LIBS.ms, renderMs: LIBS.renderMs, rows: LIBS.rows, index: !!LIBD.index, tooltips: LIBD.tips ? LIBD.tips.tooltips.length : 0 }),
};
/* Tooltips (V4-SPEC 3.3): */
const TT = { open: false, pinned: false, i: -1, trigger: null, hideT: 0 };
const TT_SKIP = new Set(["blizzard"]);
function libTips() {
  LIBD.tipsP ||= libGet("data/library/tooltips.json").then((j) => {
    LIBD.tips = j;
    const names = Object.keys(j.names).filter((k) => !TT_SKIP.has(k)).map((k) => j.tooltips[j.names[k]].name).sort((a, b) => b.length - a.length);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    LIBD.tipRe = names.length ? new RegExp(`(?<![A-Za-z0-9'])(${names.map(esc).join("|")})(?![A-Za-z0-9'])`, "g") : null;
    if (SC.open === "library" && LIBS.view.kind !== "results") libRender(false);
    else if (LIBS.view.kind === "results" && LIBS.res) libRender(false);
    return j;
  }).catch(() => null);
  return LIBD.tipsP;
}
function tipFor(name, after, before) {
  const T = LIBD.tips, base = T.names[name.toLowerCase()];
  const m = (after.match(/^\s*\(?(?:rank|R)\s?(\d{1,2})\b/i) || before.match(/\brank\s?(\d{1,2})\s*$/i));
  if (m) { const j = T.tooltips.findIndex((t) => t.name === name && t.rank === `Rank ${m[1]}`); if (j >= 0) return j; }
  return base;
}
/* Glossary (V5 Track A): the first use of a term in a view gets a dotted underline and a plain sentence; never inside a tooltip card. */
function libGloss() {
  LIBD.glossP ||= libGet("data/library/glossary.json").then((j) => {
    LIBD.gloss = j.terms;
    const forms = j.terms.flatMap((t, i) => t.forms.map((f) => [f, i])).sort((a, b) => b[0].length - a[0].length);
    LIBD.glossForm = Object.fromEntries(forms.map(([f, i]) => [f.toLowerCase(), i]));
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    LIBD.glossRe = new RegExp(`(?<![A-Za-z0-9'])(${forms.map(([f]) => esc(f)).join("|")})(?![A-Za-z0-9'])`, "gi");
    if (SC.open === "library") libRender(false);
    return j;
  }).catch(() => null);
  return LIBD.glossP;
}
function glossText(text) {
  const re = LIBD.glossRe;
  if (!re || !LIBS.glossSeen) return [text];
  const out = []; let last = 0;
  for (const m of text.matchAll(re)) {
    const i = LIBD.glossForm[m[1].toLowerCase()];
    if (i === undefined || LIBS.glossSeen.has(i)) continue;
    LIBS.glossSeen.add(i);
    out.push(text.slice(last, m.index), h("button", { class: "gl", type: "button", "data-gl": i, "aria-expanded": "false" }, m[1]));
    last = m.index + m[1].length;
  }
  out.push(text.slice(last));
  return out.filter((x) => x !== "");
}
function richText(t, self) {
  const text = String(t ?? "");
  const re = LIBD.tipRe;
  if (!re) return self === undefined ? glossText(text) : [text];
  const out = []; let last = 0;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m[1] === self) continue;
    const i = tipFor(m[1], text.slice(m.index + m[1].length, m.index + m[1].length + 14), text.slice(Math.max(0, m.index - 12), m.index));
    if (i === undefined) continue;
    out.push(text.slice(last, m.index), h("button", { class: "tt", type: "button", "data-tt": i, "aria-expanded": "false" }, m[1]));
    last = m.index + m[1].length;
  }
  out.push(text.slice(last));
  const parts = out.filter((x) => x !== "");
  return self === undefined ? parts.flatMap((x) => (typeof x === "string" ? glossText(x) : [x])) : parts;
}
const TT_COST = /^(\d[\d,]* (?:Mana|Rage|Energy|Focus)|\d+% of base mana)/, TT_CAST = /(?:sec cast|^Instant|^Channeled)/, TT_RANGE = /(?:yd range|Melee Range|Unlimited range)$/i, TT_CD = /cooldown$/i;
function ttCard(i) {
  const T = LIBD.tips, t = T.tooltips[i];
  const Q = ["--q-poor", "--q-common", "--q-uncommon", "--q-rare", "--q-epic", "--q-legendary"];
  const lines = [...t.lines];
  const take = (re) => { const k = lines.findIndex((l) => re.test(l)); return k >= 0 ? lines.splice(k, 1)[0] : null; };
  const cost = take(TT_COST), cast = take(TT_CAST), range = take(TT_RANGE), cd = take(TT_CD);
  const row = (a, b) => (a || b ? h("div", { class: "ttc-row" }, h("span", { text: a || "" }), h("span", { text: b || "" })) : null);
  const green = (l) => /^(Equip:|Use:|Chance on hit:|Set\s*:|\(\d\) Set\s*:)/.test(l);
  const sibs = T.tooltips.map((x, j) => [x, j]).filter(([x]) => x.name === t.name && x.rank && x.url.includes(t.kind)).sort((a, b) => parseInt(a[0].rank.replace(/\D/g, ""), 10) - parseInt(b[0].rank.replace(/\D/g, ""), 10));
  return h("div", { class: "ttc-in", style: `--qc: var(${t.kind === "item" ? Q[t.quality] || "--q-common" : "--q-spell"})` },
    h("div", { class: "ttc-top" }, h("b", { class: "ttc-name", id: "ttc-name", text: t.name }), t.rank ? h("span", { class: "ttc-rank", text: t.rank }) : null),
    row(cost, cast), row(range, cd),
    ...lines.map((l) => {
      const two = l.split(/\s{2,}/);
      if (two.length === 2) return row(two[0], two[1]);
      const cls = green(l) ? "ttc-line g" : /^(Item Level|Requires|Sell Price|Durability|Classes:|Dropped by|Drop Chance|Binds|Unique)/.test(l) ? "ttc-line w" : t.kind === "spell" ? "ttc-line y" : "ttc-line w";
      return h("div", { class: cls }, ...richText(l, t.name));
    }),
    sibs.length > 1 ? h("div", { class: "ttc-ranks", role: "group", "aria-label": `${t.name} ranks` }, sibs.map(([x, j]) => h("button", { type: "button", class: "ttc-rk", "data-tt-rank": j, "aria-pressed": String(j === i), text: x.rank.replace("Rank ", "") }))) : null,
    h("div", { class: "ttc-src" }, h("a", { href: t.url, target: "_blank", rel: "noopener noreferrer", text: "Wowhead Forever" }), ` read ${libDay(T.captured)}`));
}
function ttPlace(card, trig) {
  if (KIT.placeCard) return KIT.placeCard(card, trig); /* js/place.js: one placing for every card */
  const sheet = $(".sheet"), sr = sheet.getBoundingClientRect();
  const sheetMode = innerWidth < 700 || window.matchMedia("(pointer: coarse)").matches;
  card.classList.toggle("sheetmode", sheetMode);
  if (sheetMode) { card.style.left = ""; card.style.top = ""; return; }
  const r = trig.getBoundingClientRect(), w = card.offsetWidth, hgt = card.offsetHeight;
  const bar = $("#lib-q"), floor = bar ? bar.closest(".lib-bar").getBoundingClientRect().bottom - sr.top + 6 : 10;
  let x = r.left - sr.left, y = r.bottom - sr.top + 8;
  x = Math.max(10, Math.min(x, sr.width - w - 10));
  if (y + hgt > sr.height - 10) { const up = r.top - sr.top - hgt - 8; y = up >= floor ? up : Math.max(floor, sr.height - hgt - 10); }
  card.style.left = `${Math.round(x)}px`; card.style.top = `${Math.round(y)}px`;
}
function ttShow(trig, pinned, idx) {
  const card = $("#ttc"); if (!card || !LIBD.tips) return;
  clearTimeout(TT.hideT);
  const gl = trig.classList.contains("gl");
  if (gl && !LIBD.gloss) return;
  const i = idx !== undefined ? idx : Number(gl ? trig.dataset.gl : trig.dataset.tt);
  const key = gl ? `g${i}` : i;
  if (TT.open && TT.i === key && !idx && TT.trigger === trig) { if (pinned) TT.pinned = true; return; }
  if (TT.trigger && TT.trigger !== trig) TT.trigger.setAttribute("aria-expanded", "false");
  TT.open = true; TT.i = key; TT.trigger = trig; TT.pinned = !!pinned;
  card.classList.toggle("gloss", gl);
  card.replaceChildren(gl ? h("div", { class: "ttc-in" }, h("div", { class: "ttc-top" }, h("b", { class: "ttc-name", id: "ttc-name", text: LIBD.gloss[i].term })), h("div", { class: "ttc-line w", text: LIBD.gloss[i].def }), h("div", { class: "ttc-src", text: "From the board's glossary" })) : ttCard(i), h("button", { class: "ttc-x", type: "button", "aria-label": "Close the card", text: "Close" }));
  card.hidden = false;
  trig.setAttribute("aria-expanded", "true");
  ttPlace(card, trig);
  card.classList.remove("flipin"); void card.offsetWidth; card.classList.add("flipin");
  if (pinned) sfx("card");
}
function ttClose(now) {
  const card = $("#ttc");
  if (!card || card.hidden) return false;
  clearTimeout(TT.hideT);
  card.hidden = true; TT.open = false; TT.pinned = false;
  if (TT.trigger) { TT.trigger.setAttribute("aria-expanded", "false"); if (now === "focus" && shown(TT.trigger)) TT.trigger.focus({ preventScroll: true }); }
  TT.trigger = null;
  return true;
}
function startTooltips() {
  const panel = $("#panel-library"), card = $("#ttc"), body = $("#sheet-body");
  if (!panel || !card) return;
  const hover = window.matchMedia("(hover: hover) and (pointer: fine)");
  /* hover intent: a card opens only when the pointer rests on a term for a moment, so sweeping across a page never throws cards over the text */
  panel.addEventListener("mouseover", (e) => { const t = e.target.closest && e.target.closest(".tt, .gl"); if (t && hover.matches) { clearTimeout(TT.intentT); TT.intentT = setTimeout(() => { if (t.isConnected && t.matches(":hover")) ttShow(t, false); }, TT.open ? 120 : 420); } });
  panel.addEventListener("mouseout", (e) => { const t = e.target.closest && e.target.closest(".tt, .gl"); if (t) clearTimeout(TT.intentT); if (t && !TT.pinned) TT.hideT = setTimeout(() => { if (!TT.pinned) ttClose(); }, 160); });
  card.addEventListener("mouseenter", () => clearTimeout(TT.hideT));
  card.addEventListener("mouseleave", () => { if (!TT.pinned) TT.hideT = setTimeout(() => { if (!TT.pinned) ttClose(); }, 160); });
  panel.addEventListener("focusin", (e) => { const t = e.target.closest && e.target.closest(".tt, .gl"); if (t) ttShow(t, false); });
  panel.addEventListener("focusout", (e) => { const t = e.target.closest && e.target.closest(".tt, .gl"); if (t && !TT.pinned && !card.contains(e.relatedTarget)) TT.hideT = setTimeout(() => { if (!TT.pinned) ttClose(); }, 160); });
  const onTap = (e) => { const t = e.target.closest && e.target.closest(".tt, .gl"); if (!t) return; e.preventDefault(); e.stopPropagation(); if (TT.open && TT.trigger === t && TT.pinned) ttClose(); else ttShow(t, true); };
  panel.addEventListener("click", onTap, true);
  card.addEventListener("click", (e) => {
    const rk = e.target.closest("[data-tt-rank]");
    if (rk) { ttShow(TT.trigger || rk, true, Number(rk.dataset.ttRank)); return; }
    const t = e.target.closest(".tt");
    if (t) { e.preventDefault(); ttShow(t, true); return; }
    if (e.target.closest(".ttc-x")) ttClose("focus");
  });
  document.addEventListener("pointerdown", (e) => { if (TT.open && !card.contains(e.target) && !(e.target.closest && e.target.closest(".tt, .gl"))) ttClose(); }, true);
  if (body) body.addEventListener("scroll", () => { if (TT.open && !card.classList.contains("sheetmode")) ttClose(); }, { passive: true });
  sceneHooks.push((on) => { if (!on) ttClose(); });
}

/* The shelf front: what changed, nobody knows yet, Blizzard said. */
const NEWS_LABEL = { "forum-tracker": "Blizzard forums", "forum-search": "Blizzard forums", "wowhead-blue": "Blizzard, via Wowhead", "wowhead-news": "Wowhead", icyveins: "Icy Veins", warcrafttavern: "Warcraft Tavern" };
const newsLabel = (s) => NEWS_LABEL[String(s).split("/")[1]] || String(s).split("/").pop();
function libAux() {
  LIBD.newsP ||= libGet("data/library/news.json").then((j) => { LIBD.news = j; if (LIBS.view.kind === "shelf" && !LIBS.cat) libRender(false); return j; }).catch(() => null);
  return LIBD.newsP;
}
function libOpenList() {
  LIBD.openP ||= libGet("data/library/open.json").then((j) => { LIBD.open = j; if (LIBS.view.kind === "open") libRender(false); return j; }).catch(() => null);
  return LIBD.openP;
}
/* A day's changes on one page fold into one row ("Mage spellbook: 18 numbers moved"), opened with a tap. */
function changeGroups(list) {
  const out = [];
  for (const c of list) { const g = out[out.length - 1]; if (g && g.date === c.date && g.page === c.page) g.items.push(c); else out.push({ date: c.date, page: c.page, items: [c] }); }
  return out;
}
const changeGroupLi = (g) => {
  if (g.items.length < 3) return g.items.map(changeLi);
  const list = h("ul", { hidden: true }, g.items.map((c) => h("li", { text: c.text })));
  return h("li", {}, h("time", { datetime: g.date, text: libDay(g.date) }), h("span", { class: "chg-box chg-group" },
    h("span", {}, pageLink(g.page, "", libTitle(g.page)), `: ${g.items.length} numbers moved, among them ${g.items[0].thing.toLowerCase()} and ${g.items[1].thing.toLowerCase()}.`),
    h("button", { class: "chg-more", type: "button", "aria-expanded": "false", "aria-label": `Show the ${g.items.length} changes on ${libTitle(g.page)}`, onclick: (e) => { list.hidden = !list.hidden; e.currentTarget.setAttribute("aria-expanded", String(!list.hidden)); e.currentTarget.textContent = list.hidden ? "Show them" : "Hide them"; } }, "Show them"), list));
};
const changeLi = (c) => {
  const body = h("span", { class: "chg" }, pageLink(c.page, "", libTitle(c.page)), ": ", c.text);
  const long = c.text.length > 110;
  if (long) body.classList.add("clamp");
  return h("li", {}, h("time", { datetime: c.date, text: libDay(c.date) }), h("span", { class: "chg-box" }, body,
    long ? h("button", { class: "chg-more", type: "button", "aria-expanded": "false", "aria-label": `Read the whole change on ${libTitle(c.page)}`, onclick: (e) => { const on = body.classList.toggle("clamp"); e.currentTarget.setAttribute("aria-expanded", String(!on)); e.currentTarget.textContent = on ? "More" : "Less"; } }, "More") : null));
};
function libDoors() {
  const ix = LIBD.index, T = ix.totals;
  const door = (tok, b, rest) => h("a", { class: "lib-door", href: `#${tok}`, "data-lv": tok }, h("b", { text: b }), h("span", { text: rest }));
  return h("div", { class: "lib-doors" },
    door(libTok({ kind: "changes" }), "What changed", `${plural(ix.changes.length, "number moved", "numbers moved")} since ${libDay(ix.changes_since)}`),
    door(libTok({ kind: "open" }), "Nobody knows yet", `${plural(T.open, "open question", "open questions")}, ${plural(T.gaps, "researched", "researched")}`));
}
/* at 900 px and up the category rail is a sidebar, so the shelf rows would repeat it: the front page shows open instead */
function wideLib() { return !!window.matchMedia && window.matchMedia("(min-width: 900px)").matches; }
function libFront(n = 8) {
  const ix = LIBD.index, T = ix.totals;
  libAux();
  /* the learn loop's applied edits (news.json updates, from wiki/CHANGELOG.md) lead the shelf: "Library updated: what, source, date" */
  const updates = LIBD.news && Array.isArray(LIBD.news.updates) ? LIBD.news.updates.slice(0, n < 8 ? 1 : 2) : [];
  const said = LIBD.news ? LIBD.news.items.filter((x) => /^BLIZZARD/i.test(x.source)).slice(0, Math.max(1, (n < 8 ? 2 : 6) - updates.length)) : null;
  const updateLi = (u) => h("li", { class: "updated" }, pageLink(u.page, "", `Library updated: ${u.what}`, u.key), h("small", { text: `${u.source}, ${libDay(u.date)}` }), h("a", { class: "upd-src", href: u.url, target: "_blank", rel: "noopener noreferrer", text: u.posted ? `Blizzard's post of ${libDay(u.posted)}` : "Blizzard's post" }));
  return h("div", { class: "lib-front" },
    h("div", { class: "lib-front-col" },
      h("h3", { class: "lib-title", text: "What changed" }),
      ix.changes.length >= 3 ? h("ol", { class: "ribbon" }, changeGroups(ix.changes).slice(0, 6).flatMap(changeGroupLi).slice(0, n)) : h("p", { class: "ribbon-quiet", text: libQuiet(ix) }),
      h("p", { class: "lib-sub", text: `Numbers that moved since ${libDay(ix.changes_since)}. ${plural(ix.rechecks, "other recheck", "other rechecks")} confirmed the rest.` }),
      ix.changes.length > n ? h("div", { class: "lib-row" }, h("a", { class: "lib-btn", href: `#${libTok({ kind: "changes" })}`, "data-lv": libTok({ kind: "changes" }) }, `All ${nf.format(ix.changes.length)} changes`)) : null),
    h("div", { class: "lib-front-col" },
      h("h3", { class: "lib-title", text: "Nobody knows yet" }),
      h("div", { class: "nk" },
        h("div", { class: "nk-nums" }, h("div", { class: "lib-stat" }, h("b", { text: nf.format(T.open) }), h("span", { text: "open questions on the pages" })), h("div", { class: "lib-stat" }, h("b", { text: nf.format(T.gaps) }), h("span", { text: "questions the library had to research" }))),
        h("p", { text: "An honest unknown is an answer too. These settle at launch, in game, or when Blizzard posts." }),
        h("div", { class: "lib-row" }, h("a", { class: "lib-btn strong", href: `#${libTok({ kind: "open" })}`, "data-lv": libTok({ kind: "open" }) }, "Open the list"))),
      h("h3", { class: "lib-title", text: "Blizzard said" }),
      said ? (said.length || updates.length ? h("ul", { class: "said" }, ...updates.map(updateLi), said.map((x) => h("li", {}, h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", text: x.title }), h("small", { text: `${newsLabel(x.source)}, ${libDay(x.stamp)}` }), x.snippet ? h("span", { class: "clamp", text: x.snippet }) : null))) : h("p", { text: "No Blizzard post in the news watch yet." })) : h("p", { class: "loading", text: "Reading the news watch." })));
}
function libRenderOpen(main, tok) {
  const back = h("div", { class: "lib-row" }, h("button", { class: "lib-btn", type: "button", "data-back": "1" }, "Back to the shelf"), linkChip(LIBS.view));
  if (!LIBD.open) { main.replaceChildren(back, h("p", { class: "loading", text: "Opening the list." })); libOpenList(); return; }
  const O = LIBD.open, byPage = new Map();
  for (const o of O.open) { if (!byPage.has(o.page)) byPage.set(o.page, []); byPage.get(o.page).push(o.text); }
  main.replaceChildren(back,
    h("h3", { class: "lib-title", text: "Nobody knows yet" }),
    h("p", { text: `${plural(O.open.length, "open question", "open questions")} written on the pages, page by page, then ${plural(O.gaps.length, "question", "questions")} the library had to research.` }),
    h("div", { class: "groups" }, [...byPage.entries()].filter(([id]) => !LIBS.cat || (LIBD.head[id] && LIBD.head[id].category === LIBS.cat)).map(([id, list]) => h("section", { class: "group", "aria-label": libTitle(id) },
      h("div", { class: "group-head" }, pageLink(id, "", libTitle(id)), h("span", { class: "lib-sub", text: LIBD.head[id] ? libCatTitle(LIBD.head[id].category) : "" })),
      h("ul", { class: "hits" }, list.map((t) => h("li", { class: "hit" }, h("span", { class: "hit-val" }, emb("question", "pend"), " ", ...richText(t)))))))),
    h("section", { class: "group", "aria-label": "Researched questions" }, h("div", { class: "group-head" }, h("span", { class: "lib-title", text: "Researched questions" })),
      /* V12: the question and its plain answer; the research log's own words stay out (build-data readerGaps), links behind Sources */
      O.gaps.map((g) => h("div", { class: "gap" }, h("h4", {}, g.question), h("span", { class: "lib-sub", text: `${g.status}, ${libDay(g.date)}` }),
        h("ul", {}, (g.answer || []).map((f) => h("li", {}, h("span", {}, ...richText(f))))),
        g.links.length ? h("details", { class: "srcs" }, h("summary", { text: "Sources" }), h("span", { class: "hit-meta" }, g.links.map((u) => h("a", { class: "src", href: u, target: "_blank", rel: "noopener noreferrer", text: (() => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } })() })))) : null))));
}
function libRenderChanges(main) {
  const ix = LIBD.index;
  main.replaceChildren(h("div", { class: "lib-row" }, h("button", { class: "lib-btn", type: "button", "data-back": "1" }, "Back to the shelf"), linkChip(LIBS.view)),
    h("h3", { class: "lib-title", text: "Every change, newest first" }),
    h("p", { class: "lib-sub", text: `Numbers that moved since ${libDay(ix.changes_since)}. ${plural(ix.rechecks, "other recheck", "other rechecks")} confirmed the rest.` }),
    ix.changes.length ? h("ol", { class: "ribbon" }, changeGroups(ix.changes.filter((c) => !LIBS.cat || (LIBD.head[c.page] && LIBD.head[c.page].category === LIBS.cat))).flatMap(changeGroupLi)) : h("p", { text: libQuiet(ix) }));
}
/* Phones: the category chips scroll sideways; say so once, until the row is scrolled. */
function libRailHint() {
  const hint = $("#rail-hint"), rail = $("#lib-rail"); if (!hint || !rail) return;
  let seen = false; try { seen = localStorage.getItem("board-railhint") === "1"; } catch (e) {}
  if (seen) return;
  hint.hidden = false;
  rail.addEventListener("scroll", () => { hint.hidden = true; try { localStorage.setItem("board-railhint", "1"); } catch (e) {} }, { once: true, passive: true });
}
const LIB_EXAMPLES = ["onyxia open", "frost blast", "name reservation", "what do packs give"];
function libExamples() {
  const box = $("#lib-examples"); if (!box || box.childElementCount) return;
  box.replaceChildren(...LIB_EXAMPLES.map((q) => h("button", { class: "ex", type: "button", onclick: () => { const i = $("#lib-q"); i.value = q; libSearch(q); } }, q)));
}
function startLibrary() {
  const box = $("#lib-q"), panel = $("#panel-library"), tform = $("#tile-search");
  if (tform) tform.addEventListener("submit", (e) => { e.preventDefault(); LIBUI.searchFrom($("#tile-q").value); $("#tile-q").value = ""; });
  if (!box || !panel) return;
  startTooltips();
  box.addEventListener("input", () => { const lg = $("#lib-legend"); if (lg && box.value) lg.hidden = true; clearTimeout(LIBS.timer); LIBS.timer = setTimeout(() => libSearch(box.value), LIB_TYPE_MS); });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(LIBS.timer); libSearch(box.value); } });
  panel.addEventListener("click", (e) => {
    const rk = e.target.closest && e.target.closest("[data-static] [data-tt-rank]");
    if (rk) { rk.closest("[data-static]").replaceChildren(ttCard(Number(rk.dataset.ttRank))); return; }
    const t = e.target.closest && e.target.closest("[data-lv], [data-cat], [data-back]");
    if (!t || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (t.dataset.lv !== undefined) { e.preventDefault(); libGo(libViewOf(t.dataset.lv)); const m = $("#lib-main"); if (m && !(LIBS.view.fact)) m.focus({ preventScroll: true }); return; }
    if (t.dataset.back !== undefined) { libGo(LIBS.back || { kind: "shelf", cat: LIBS.cat }); return; }
    const key = t.dataset.cat;
    LIBS.cat = key === LIBS.cat ? "" : key;
    if (LIBS.view.kind === "results") libRender(); else libGo({ kind: "shelf", cat: LIBS.cat });
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = [...$("#lib-main").querySelectorAll(".hit-go, .plink, .group-head a")].filter((x) => shown(x));
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    if (document.activeElement === box) { if (e.key === "ArrowDown") { e.preventDefault(); list[0].focus(); } return; }
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) { box.focus(); return; }
    list[Math.max(0, Math.min(list.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  });
}
/* Discord launch parameter (activities link ?custom_id=<token>, read by the SDK as customId): */
const LAUNCH_LIB = /^library(?:\.(?:q\.[a-z0-9][a-z0-9.-]{0,90}|open|changes|c\.[a-z]+|[a-z]+\.[a-z0-9-]+(?:~[a-z0-9_.]+)?))?$/;
function launchToken(raw) {
  const t = (typeof raw === "string" ? raw.trim() : "").replace(/^dates(?=\.|$)/, "timeline"); /* V13e: the Dates alias */
  if (!t || t.length > 100 || !/^[A-Za-z0-9._~-]+$/.test(t)) return null;
  return SCENES.includes(t) || LAUNCH_LIB.test(t) || /^tonight\.[a-z0-9-]{1,40}$/.test(t) || /^buffs\.[a-z_-]{1,40}$/.test(t) || LAND_RE.test(t) ? t : null;
}
/* Memory (V6-SPEC 3.1): browser only, never sent. Depth, the picked person, last-seen stamps, where you left off, expert. */
const MEM_KEYS = ["board-depth", "board-me", "board-seen", "board-left", "board-expert", "board-room", "board-room-streak", "board-journey", "board-key", "board-glowed", "board-snooze", "board-mode", "board-mode-sound", "board-chat", "board-walked"]; /* companion N3: Not now on the next step; N4: Play mode and the sound it held; N6: the chat log on this device; N7: the first-open walk was seen */
const MEM = {
  get: (k) => { try { return localStorage.getItem(`board-${k}`); } catch (e) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(`board-${k}`); else localStorage.setItem(`board-${k}`, v); } catch (e) {} },
  slug: (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  me: () => MEM.get("me"),
  member: () => { const m = MEM.me(); return m && m !== "just-looking" && D.party ? D.party.members.find((x) => MEM.slug(x.name) === m) || null : null; },
  setMe: (slug) => { const ok = slug === "just-looking" || (D.party ? D.party.members.some((x) => MEM.slug(x.name) === slug) : /^[a-z0-9-]{1,40}$/.test(slug)); if (ok) MEM.set("me", slug); return ok; },
  seenMap: () => { try { const m = JSON.parse(MEM.get("seen") || "{}"); return m && typeof m === "object" && !Array.isArray(m) ? m : {}; } catch (e) { return {}; } }, /* a stored value that is not an object (a number, a list) is treated as empty, never thrown on */
  seen: (k) => { const m = MEM.seenMap(); m[k] = Date.now(); MEM.set("seen", JSON.stringify(m)); },
  forget: () => { for (const k of MEM_KEYS) { try { localStorage.removeItem(k); } catch (e) {} } try { Object.keys(localStorage).filter((k) => k.startsWith("board-before-")).forEach((k) => localStorage.removeItem(k)); } catch (e) {} },
};
/* V11: an event with a window (names) is "Next up" while it is open, and reads "Open now, until <day>" */
function tonightNext(T) { const now = Date.now() / 1000; const ts = (e) => (e.epoch !== null ? e.epoch : Date.parse(`${e.date}T23:59:59Z`) / 1000); const open = T.events.find((e) => e.until_epoch && e.epoch <= now && now < e.until_epoch); if (open) return { ...open, when: open.open_when || open.when, open: true }; return T.events.find((e) => ts(e) > now) || T.events[T.events.length - 1]; }
/* the meeting point on Next steps: chosen, or the Sign-ups card to choose it */
function meetP() {
  const m = D.party && D.party.open.find((o) => /meeting point/i.test(o.title));
  if (!m) return null;
  const url = D.party.signup_url;
  return h("p", { class: "tn-line" }, h("b", { text: "Meeting point: " }), unchosen(m) ? (url ? h("a", { class: "tn-link", href: url, target: "_blank", rel: "noopener noreferrer", "aria-label": "Meeting point not chosen yet: answer on the sign-up card in Discord" }, "not chosen yet") : "not chosen yet") : m.status);
}
function yourTime(T) {
  const l = T.events.find((e) => e.key === "launch"); if (!l || !l.epoch) return "";
  const f = (tz) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) }).format(new Date(l.epoch * 1000)).replace(":00", "");
  const mine = f(), et = f("America/New_York");
  return mine === et ? "" : ` (${mine} your time)`;
}
/* V13c: "Launch: Wed, Nov 4, 6 PM ET, in 7 days" in the viewer's zone, from the launch event's epoch */
function launchWhen() { const e = D.timeline && D.timeline.events.find((x) => x.key === "launch"); return e && e.epoch ? `Launch: ${fmtWhen(e.epoch, { rel: true })}` : ""; }
function renderTonight() {
  const T = D.tonight, P = D.party, me = MEM.me(), member = MEM.member();
  const box = $("#tn-cards"), meBox = $("#tn-me"), act = $("#tn-actions"); if (!T || !P || !box) return;
  const pick = (slug) => { MEM.setMe(slug); renderTonight(); markMe(); try { renderDiscordSignups(); renderWheel(); renderBuffsDeep(); } catch (e) {} };
  /* V13b (mobile 8): one name chip everywhere: the same crest pills as the Buffs picker, and once chosen, a plain line saying
     who and the one action, "Change person" */
  if (!me) meBox.replaceChildren(h("div", { class: "tn-pick", role: "group", "aria-label": T.labels.who }, h("p", { class: "tn-who", text: T.labels.who }), T.labels.why ? h("p", { class: "tn-why", text: T.labels.why }) : null, ...P.members.map((m) => h("button", { type: "button", class: "lib-tool tn-name", style: `--cc: ${classVar(m.class_key)}`, onclick: () => pick(MEM.slug(m.name)) }, crestMark(m), m.name)), h("button", { type: "button", class: "lib-tool tn-name", onclick: () => pick("just-looking") }, T.labels.looking)));
  else meBox.replaceChildren(h("div", { class: "tn-chip deep-who", role: "group", "aria-label": "Whose steps are shown" }, h("b", { class: "deep-me" }, member ? crestMark(member) : null, member ? `${T.labels.iam} ${member.name}: ${member.race} ${member.class}` : T.labels.looking), h("button", { type: "button", class: "lib-tool", id: "tn-change", onclick: () => { MEM.set("me", null); renderTonight(); markMe(); const x = $("#tn-me .tn-name"); if (x) x.focus({ preventScroll: true }); } }, "Change person")));
  const ev = tonightNext(T);
  const idx = member ? P.members.indexOf(member) : -1, person = T.people.find((x) => x.member === idx);
  const S = D.signups, entries = S && S.entries ? S.entries : [];
  const mine = member ? entries.find((e) => cleanName(e.name).toLowerCase() === member.name.toLowerCase()) : null;
  /* V11: every step says where to act. An open poll is on everyone's list until it closes; the sign-up step stays until they answer */
  const L = T.links || {}, nowS = Date.now() / 1000;
  const pollOpen = !!L.poll && (!T.poll_closes || nowS < T.poll_closes);
  const steps = [];
  if (!me) steps.push([T.steps.looking, null]);
  else if (member) {
    if (person && person.step) steps.push([person.step, person.step === T.steps.spec ? L.spec : L.choose]);
    if (pollOpen && T.steps.poll) steps.push([T.steps.poll, L.poll]);
    if (!mine) steps.push([T.steps.signup, L.signup]);
  }
  if (!steps.length) steps.push([pollOpen && T.steps.poll ? T.steps.poll : T.steps.none, pollOpen ? L.poll : null]);
  const ext = (href) => href && /^https?:/.test(href);
  /* V12: the vote step carries its deadline in the viewer's own time */
  const stepEl = ([t0, href]) => { const t = t0 === T.steps.poll && T.poll_closes ? `${t0.replace(/\.$/, "")}, by ${fmtWhen(T.poll_closes)}.` : t0; return stepLi(t, href); };
  const stepLi = (t, href) => h("li", { class: "tn-big" }, href ? h("a", { class: "tn-link", href, ...(ext(href) ? { target: "_blank", rel: "noopener noreferrer", "aria-label": `${t} Opens Discord.` } : {}) }, ext(href) ? emb("speech") : null, t) : t);
  const who = (k) => entries.filter((e) => e.rsvp === k && e !== mine).map((e) => cleanName(e.name));
  const line = (label, names) => h("p", { class: "tn-line" }, h("b", { text: `${label}: ` }), ...names.flatMap((n, i) => [i ? ", " : null, h("span", { class: "tn-n", text: n })]).filter(Boolean));
  const groups = RSVP_KEYS.map((k) => [T.labels[k] || RSVP_SAY[k], who(k)]).filter(([, n]) => n.length);
  const card = (title, ...kids) => h("section", { class: "tn-card", "aria-label": title }, h("h3", { text: title }), ...kids);
  box.replaceChildren(...[
    card(T.cards[1], h("ul", { class: "tn-steps" }, steps.map(stepEl))),
    card(T.cards[0], h("p", { class: "tn-big", text: ev.label }), h("p", { class: "tn-when", text: ev.when }), h("p", { text: ev.meaning }), ev.key !== "launch" && T.launch ? h("p", { class: "tn-launch", text: launchWhen() || T.launch + yourTime(T) }) : null, T.play ? h("p", { class: "tn-play", text: T.play }) : null),
    card(T.cards[2], meetP(), mine ? line(T.labels.you, [T.labels[mine.rsvp] || RSVP_SAY[mine.rsvp] || T.labels.maybe]) : null, ...groups.map(([l, n]) => line(l, n)), !mine && !groups.length ? h("p", { text: T.labels.nobody }) : null)].filter(Boolean));
  /* V9: with a name, one tap from Tonight to what the others give you at a level (outside the three cards, so their budget holds) */
  const gets = member && D.client && D.client.buffs ? h("div", { class: "tn-gets", role: "group", "aria-label": "What the others give you: open Buffs at a level" }, h("span", { class: "tn-gets-l", text: "What the others give you" }),
    h("div", { class: "deep-marks tn-buffs" }, D.client.buffs.marks.map((k) => h("button", { type: "button", class: "lib-tool", "aria-label": `Buffs at level ${k}`, onclick: () => { BD.level = k; try { localStorage.setItem("board-buff-level", String(k)); } catch (e) {} renderBuffsDeep(); goScene("buffs"); } }, `At ${k}`)))) : null;
  /* V16: the decision view is one tap away (a link, so the two action buttons stay two) */
  act.replaceChildren(...[gets, h("button", { type: "button", class: "lib-btn strong", onclick: () => requestClose() }, T.actions[0]), h("button", { type: "button", class: "lib-btn", onclick: () => LIBUI.focusSearch() }, T.actions[1]), h("a", { class: "lib-btn tn-decide", href: "#decide", text: TITLES.decide })].filter(Boolean));
  const left = (() => { try { return JSON.parse(MEM.get("left") || "null"); } catch (e) { return null; } })();
  try { renderBefore(); startHow(); } catch (e) { console.error("before", e); }
  $("#tn-left").replaceChildren(...(left ? ["Last time you read ", h("a", { href: `#${left.tok}`, text: left.title }), " in the library."] : []));
  KIT.emit("tonight");
}
/* V15: "Before launch" checklist (per person, ticks in this browser only) and "How things work" strip. Facts come from the
   generated tonight/party data and from library pages already shipped; a fact the library lacks reads "not published yet". */
function beforeTicks(slug) { try { const a = JSON.parse(MEM.get(`before-${slug}`) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch (e) { return []; } }
function beforeItems(T, P, member, mine) {
  const open = (rx) => P.open.find((o) => rx.test(o.title)), nowS = Date.now() / 1000, L = T.links || {};
  const ev = (k) => T.events.find((e) => e.key === k), names = ev("names_open"), launch = ev("launch");
  const dt = (epoch) => fmtWhen(epoch), out = [];
  if (member) out.push({ id: "build", text: `Your build on the board: ${member.race} ${member.class}, ${member.spec}.`, more: `As the group has it (${(member.spec_status && member.spec_status.status) || "listed"}).` });
  if (T.poll_closes) out.push({ id: "guild", text: `Guild name: the poll ${nowS < T.poll_closes ? "closes" : "closed"} ${dt(T.poll_closes)}.`, href: L.poll, more: "Names can also be added in chat.", stamp: T.poll_closes });
  if (member) {
    const po = open(/profession/i) || {}, pr = member.professions || [], und = pr.some((p) => p.status === "undecided"), gap = (po.text || "").match(/Gap: ([A-Za-z]+)/);
    out.push({ id: "prof", text: `Professions on the board: ${pr.map((p) => p.name).join(" and ") || "none yet"}${und ? " (one still undecided)" : ""}.`, href: po.links && po.links[0] ? po.links[0].url : L.choose, more: gap ? `The group has no ${gap[1]} yet.` : "" });
  }
  if (names && names.until_epoch) out.push({ id: "names", text: nowS < names.until_epoch ? "Names: open now for pack holders, until the end of Nov 3 (Pacific time)." : "Names: the pack-holder window has closed.", more: (open(/pack/i) || {}).detail || "", stamp: names.until_epoch });
  if (member) out.push({ id: "signup", text: mine ? `Sign-up card: you answered "${T.labels[mine.rsvp] || RSVP_SAY[mine.rsvp] || mine.rsvp}".` : "Sign-up card: no answer from you yet.", href: L.signup });
  const meet = open(/meeting point/i);
  if (meet) out.push({ id: "meet", text: unchosen(meet) ? "Meeting point: nothing chosen yet." : `Meeting point: ${meet.status}.`, href: unchosen(meet) ? P.signup_url : null, more: meet.detail || "" });
  if (launch && launch.epoch) { const night = open(/launch night/i); out.push({ id: "launch", text: `Launch: ${fmtWhen(launch.epoch, { rel: true })}.`, href: night && night.links && night.links[0] ? night.links[0].url : null, more: `${night ? night.detail + " " : ""}${T.play || ""}`.trim(), stamp: launch.epoch }); }
  return out;
}
function groupOpenLine(T, P) {
  const nowS = Date.now() / 1000, bits = [];
  for (const o of P.open) {
    if (o.status === "the event") continue;
    if (/guild/i.test(o.title)) bits.push(T.poll_closes ? `${o.title} (poll ${nowS < T.poll_closes ? "closes" : "closed"} ${fmtWhen(T.poll_closes)})` : o.title);
    else if (/profession/i.test(o.title)) { const g = (o.text || "").match(/Gap: ([A-Za-z]+)/); bits.push(`${o.title}${g ? ` (gap: ${g[1]})` : ""}`); }
    else bits.push(`${o.title}${o.status ? ` (${o.status})` : ""}`);
  }
  return bits.length ? `Still open for the group: ${bits.join("; ")}.` : "Nothing is open for the group right now.";
}
function renderBefore() {
  const T = D.tonight, P = D.party, box = $("#tn-before"); if (!T || !P || !box) return;
  const me = MEM.me(), member = MEM.member(), slug = member ? MEM.slug(member.name) : "just-looking";
  const S = D.signups, entries = S && S.entries ? S.entries : [], mine = member ? entries.find((e) => cleanName(e.name).toLowerCase() === member.name.toLowerCase()) : null;
  const items = me ? beforeItems(T, P, member, mine) : [], ticks = new Set(beforeTicks(slug));
  const ext = (u) => u && /^https?:/.test(u);
  const count = h("p", { class: "tnb-count", "aria-live": "polite" });
  const sum = h("span", { class: "tnb-sum-t" });
  const upd = () => { const n = items.filter((i) => ticks.has(i.id)).length; sum.textContent = `Your list: ${items.length} thing${items.length === 1 ? "" : "s"} the board knows about your side, ${n} ticked`; count.textContent = items.length ? `${n} of ${items.length} ticked on this device${member ? ` for ${member.name}` : ""}.` : ""; };
  const row = (i) => h("li", { class: "tnb-item", "data-on": ticks.has(i.id) ? "1" : "0" },
    h("label", { class: "tnb-tick" }, h("input", { type: "checkbox", checked: ticks.has(i.id), onchange: (ev) => { const li = ev.target.closest("li"); if (ev.target.checked) ticks.add(i.id); else ticks.delete(i.id); li.dataset.on = ev.target.checked ? "1" : "0"; MEM.set(`before-${slug}`, ticks.size ? JSON.stringify([...ticks]) : null); upd(); } }), h("span", { text: i.text })),
    i.href ? h("a", { class: "tn-link tnb-go", href: i.href, ...(ext(i.href) ? { target: "_blank", rel: "noopener noreferrer", "aria-label": `Open in Discord: ${i.text}` } : { "aria-label": `Open in the library: ${i.text}` }) }, ext(i.href) ? emb("speech") : null, "Open") : null,
    i.more || i.stamp ? h("p", { class: "tnb-more", "data-j": "c e" }, i.more || "", i.stamp ? [" ", h("code", { "data-j": "e", text: `<t:${i.stamp}:F>`, title: "Discord timestamp: pasted into chat, it shows each reader their own local time" })] : null) : null);
  box.replaceChildren(h("h3", { id: "tnb-h", text: "Before launch" }),
    h("p", { class: "tnb-group", text: groupOpenLine(T, P) }),
    /* integrator pass 3: the list folds under its own summary (open, it ran Next steps to 3.2 laptop screens once a name was picked) */
    me ? h("details", { class: "tnb-fold" }, h("summary", { class: "tnb-sum" }, sum), h("ul", { class: "tnb-list", "aria-label": member ? `Before launch, ${member.name}` : "Before launch" }, items.map(row)), count) : h("p", { class: "tnb-hint", text: "With a name picked above, a short list of what the board knows about your side shows here." }),
    me ? null : count);
  upd();
}
const HOW_Q = ["How do guilds work?", "Can I chat in game without a guild?", "How big is a dungeon group?", "How does loot rolling work?", "What does a pack do?", "Where does the group meet?"];
function renderHow() {
  const box = $("#tn-how"); if (!box) return;
  const page = (id) => LIBD.full[id] || null;
  const fact = (id, k) => { const p = page(id), f = p && p.facts && p.facts.find((x) => x.key === k); return f ? f.value : null; };
  const cite = (id, k) => { const p = page(id); return p ? { id, title: p.title, asOf: p.as_of, fact: k } : null; };
  const NP = "Not published yet.", A = [];
  const g1 = fact("history/beta-builds", "beta.known_issues_sep_17"), g2 = fact("systems/gold-and-riding", "gold.rules.economy_holds");
  A.push({ t: `${NP} The library has no Forever guild how-to yet (founding one, charters, what a guild gets).${g1 ? " What it does hold: guild charters could not be signed in the Sep 17 beta build." : ""}${g2 ? " The guild bank was among the features paused in the Oct 13 economy hold." : ""}`, c: [cite("history/beta-builds", "beta.known_issues_sep_17"), cite("systems/gold-and-riding", "gold.rules.economy_holds")].filter(Boolean), miss: true });
  const c1 = fact("systems/names", "names.surname_hidden"), c2 = fact("dungeons/overview", "voice.discord");
  A.push({ t: `${NP} No channel list for Forever (say, yell, general, party) is in the library.${c1 ? " Nearby: a hidden second name still shows in chat." : ""}${c2 ? " Discord voice can be switched on under Audio settings, set by the party leader for the whole party." : ""}`, c: [cite("systems/names", "names.surname_hidden"), cite("dungeons/overview", "voice.discord")].filter(Boolean), miss: true });
  const gs = fact("dungeons/overview", "new_dungeons.group_size"), cnt = fact("dungeons/overview", "new_dungeons.count"), gf = fact("dungeons/overview", "group_finder.type");
  A.push({ t: gs ? `Blizzard's ${cnt || "new"} new dungeons are for ${gs}. Whether the returning Classic dungeons keep a 10-player cap is contested between guide sites.${gf ? ` The Group Finder is a ${gf}.` : ""}` : `${NP} Group size is missing from the library data.`, c: [cite("dungeons/overview", "new_dungeons.group_size")].filter(Boolean), miss: !gs });
  const q = fact("dungeons/overview", "quest_drops.party");
  A.push({ t: `${NP} The library holds no loot-rolling rules for Forever.${q ? " Nearby: quest drops are spread more evenly in a party, and each player still needs their own drop." : ""}`, c: [cite("dungeons/overview", "quest_drops.party")].filter(Boolean), miss: true });
  const pk = (k) => fact("systems/packs-and-pricing", k), req = pk("pack.required"), hv = pk("pack.heroic.contents"), ep = pk("pack.epic.contents"), co = pk("pack.collection.contents"), pr = ["heroic", "epic", "collection"].map((k) => (pk(`pack.${k}.price`) || "").split(" (")[0]);
  const all = req && hv && ep && co;
  A.push({ t: all ? `A pack is optional: ${req.replace(/^no; /, "")}. Heroic adds ${hv.replace(/, 1 Invite-A-Friend code/, " and 1 friend code")}. Epic is Heroic plus ${ep.replace(/^Heroic plus /, "")}. Collection is Epic plus ${co.replace(/^Epic plus /, "")}. None lists early access.${pr.every(Boolean) ? ` Shop prices read on Oct 18: ${pr.join(" / ")}.` : ""}` : `${NP} Pack contents are missing from the library data.`, c: [cite("systems/packs-and-pricing", "pack.heroic.contents")].filter(Boolean), miss: !all });
  const mp = D.party && D.party.open.find((o) => /meeting point/i.test(o.title));
  A.push({ t: mp ? `${unchosen(mp) ? "Nothing chosen yet." : mp.status + "."} ${mp.detail || ""} Launch night itself is a voice call in Fellowship.` : `${NP} No meeting point on the board.`, c: [], group: true, miss: !mp });
  box.replaceChildren(h("h3", { id: "tnh-h", text: "How things work" }), h("p", { class: "tnh-sub", text: "Plain answers from the library. Where it has nothing, it says so." }),
    h("div", { class: "tnh-grid" }, A.map((a, i) => h("section", { class: "tnh-card", "data-miss": a.miss ? "1" : "0", "aria-labelledby": `tnh-q${i}` }, h("h4", { id: `tnh-q${i}`, text: HOW_Q[i] }), h("p", { class: "tnh-a", text: a.t }),
      h("p", { class: "tnh-c" }, ...(a.group ? ["From the board's group notes."] : a.c.length ? ["From ", ...a.c.flatMap((c, j) => [j ? ", " : null, h("a", { class: "tn-link", href: `#library.${c.id.replace("/", ".")}`, text: c.title }), h("span", { "data-j": "e", text: ` (${c.fact}, as of ${c.asOf})` })]).filter(Boolean)] : ["Library page not loaded."]))))));
  { const kids = [...box.children], d = h("details", { class: "tnh-det" }, h("summary", { class: "tnh-sum", text: "How things work: six plain answers (tap to open)" })); d.append(...kids); box.replaceChildren(d); }
}
let howWatch = false;
function startHow() {
  const panel = $("#panel-tonight"); if (!panel || !$("#tn-how")) return;
  const go = () => { if (panel.hidden || document.documentElement.dataset.journey === "guided") return; (window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 2500 }) : (f) => setTimeout(f, 800))(() => Promise.all(["dungeons", "systems", "history"].map(libCat)).then(() => renderHow()).catch(() => { const b = $("#tn-how"); if (b) b.replaceChildren(h("h3", { text: "How things work" }), h("p", { class: "tnh-sub", text: "The library facts did not load just now. A refresh may help." })); })); };
  if (!howWatch && typeof MutationObserver === "function") { howWatch = true; new MutationObserver(go).observe(panel, { attributes: true, attributeFilter: ["hidden"] }); }
  go();
}
/* The picked person's tile and medallion stand out. */
function markMe() {
  const m = MEM.member();
  document.querySelectorAll("#ts-five .med").forEach((x) => x.classList.toggle("me", !!m && x.dataset.k === m.class_key));
  const chip = $("#depth"); if (chip) chip.dataset.me = m ? m.name : "";
}
function markDepth() { const d = MEM.get("depth") || "wall"; document.querySelectorAll("#depth [data-depth]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.depth === d))); }
function startDepth() {
  const xb = $("#lib-expert"), fb = $("#lib-forget");
  const xpLabel = (on) => { xb.setAttribute("aria-pressed", String(on)); xb.textContent = on ? "Expert: on" : "Expert: off"; };
  if (xb) { xpLabel(libExpert()); xb.addEventListener("click", () => { const on = !libExpert(); MEM.set("expert", on ? "1" : null); xpLabel(on); libRender(false); }); }
  if (fb) fb.addEventListener("click", () => { MEM.forget(); KIT.emit("forget"); if (xb) xpLabel(false); renderTonight(); markMe(); markDepth(); document.querySelectorAll(".new-badge").forEach((x) => x.remove()); libRender(false); fb.textContent = "Forgotten"; setTimeout(() => { fb.textContent = "Forget me"; }, 2400); });
  const nav = $("#depth"); if (!nav) return;
  markDepth();
  nav.addEventListener("click", (e) => { const b = e.target.closest("[data-depth]"); if (!b) return; const d = b.dataset.depth; if (d === "wall") { MEM.set("depth", "wall"); requestClose(); markDepth(); } else goScene(d); });
}
/* V13a: work deferred past Tonight starts after the close has finished moving, not inside its frames */
function whenOffTonight(f) { if (SC.open !== "tonight" && SC.want !== "tonight") { f(); return; } let done = false; sceneHooks.push(() => setTimeout(() => { if (!done && SC.open !== "tonight") { done = true; f(); } }, motionMs("move") + 160)); }
/* V13a warm-up. */
const WARM = { queue: null, step: null, done: false, ms: 0, scenes: 0 };
/* V13c: the baked paper is the sheet's paper now; the buff emblems and pints are decoded ahead too */
const WARM_IMAGES = ["img/paper-baked.jpg", "img/parchment-tile.jpg", "img/board-wall.jpg", "img/map-parchment.jpg", "img/map/zeppelin.png", "img/map/town.png", ...["in", "maybe", "late", "out", "none"].map((k) => `img/pints/${k}@2x.png`), ...["scroll", "hourglass", "horn", "skull", "seal"].map((k) => `img/emblems/dates/${k}.webp`), "img/seats/table.webp", ...["allstats", "armor", "attackpower", "healing", "intellect", "mana", "resistance", "spirit", "stamina", "thorns"].map((k) => `img/buffs/${k}.png`)];
/* the scene layer is wanted for real: the warm-up steps aside at once, and comes back to the scene it lost later */
function warmStop() {
  WARM.calm = performance.now() + MOTION.move + 300; /* a scene moving in or out is left alone */
  const s = WARM.step; if (!s) return;
  if (WARM.queue) WARM.queue.push(s.key);
  warmRestore(s);
}
function warmRestore(s) {
  WARM.step = null; cancelAnimationFrame(s.raf); clearTimeout(s.timer);
  s.panel.classList.remove("warm", "warm-m"); s.panel.inert = false;
  if (s.fx) s.fx.remove();
  if (SC.open !== s.key) s.panel.hidden = true;
  if (s.layer) { const L = $("#scene"); L.classList.remove("warming"); L.inert = false; if (SC.open === null && !SC.want) L.hidden = true; }
}
function warmNext() {
  if (WARM.done || WARM.step) return;
  if (roomHas("play")) { WARM.held = true; return; } /* integrator pass 3: Play warms nothing (it was 33 of the wall's 35 frames in 10 s); Lounge picks it up again */
  if (document.hidden) { warmLater(); return; }
  if (!WARM.queue) {
    WARM.queue = SCENES.filter((k) => k !== "library").sort((a, b) => (a === "tonight") - (b === "tonight"));
    for (const u of WARM_IMAGES) { const im = new Image(); im.decoding = "async"; im.src = u; if (im.decode) im.decode().catch(() => {}); WARM.keep = (WARM.keep || []).concat(im); }
  }
  const L = $("#scene");
  /* never while a scene is moving in or out, and never the scene on screen */
  if (SC.want || L.classList.contains("closing") || performance.now() < (WARM.calm || 0)) { warmLater(); return; }
  let key = WARM.queue.shift();
  while (key && key === SC.open) key = WARM.queue.shift();
  if (!key) { WARM.done = true; return; }
  const panel = $(`#panel-${key}`); if (!panel) { warmLater(); return; }
  const t0 = performance.now();
  const step = { key, panel, layer: SC.open === null, raf: 0, timer: 0 };
  /* V13c: the warm-up draws a scene in the frame it will open in, so its first raster at that size is
     done while idle */
  if (step.layer) { L.inert = true; L.classList.add("warming"); L.hidden = false; }
  if (!WARM.fx) { WARM.fx = true; step.fx = h("div", { class: "warm-fx", "aria-hidden": "true" }); L.append(step.fx); }
  /* CLS (2026-10-30): the panel is laid out and fitted while visibility: hidden (.warm-m), then shown for the raster frames: a box that was not visible in the previous frame is not a layout shift, and the fit zoom / late rows used to count 0.05 to 0.1 per scene on the wall */
  panel.classList.add("warm", "warm-m"); panel.inert = true; panel.hidden = false;
  WARM.step = step;
  /* three frames: the commit, the raster, the draw; then the panel goes back */
  /* V13b: the Roads map is drawn again once at its real width while it warms, so its first opening never redraws it */
  let n = 0; const tick = () => { if (WARM.step !== step) return; if (n === 0 && key === "roads") { try { mapFit(); } catch (e) {} } if (n === 1 && step.layer && !FIT_SKIP.includes(key)) { try { fitScene(key); } catch (e) {} } if (n === 1) panel.classList.remove("warm-m"); if (++n < 3) { step.raf = requestAnimationFrame(tick); return; } WARM.ms += performance.now() - t0; WARM.scenes++; warmRestore(step); warmLater(); };
  step.raf = requestAnimationFrame(tick);
}
addEventListener("board-mode", () => { CT.sig = ""; try { if (D.timeline) tick(); } catch (e) {} if (!roomHas("play") && WARM.held) { WARM.held = false; warmLater(); } });
function warmLater() { if (WARM.done) return; (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(warmNext, { timeout: 1500 }); }
/* "New" since the last look: the sign-ups (their own change stamp) and the library (its newest change). */
function markNew() {
  const seen = MEM.seenMap();
  const badge = (k, stamp) => { const t = document.querySelector(`#board [data-scene="${k}"] .tile-title`); if (!t || !seen[k] || !stamp || Date.parse(stamp) <= seen[k] || t.parentNode.querySelector(".new-badge")) return; t.parentNode.insertBefore(h("span", { class: "new-badge", text: "New" }), t.nextSibling); };
  if (D.signups) badge("signups", D.signups.updated);
  whenOffTonight(() => libIndex().then((ix) => { if (ix && ix.changes[0]) badge("library", `${ix.changes[0].date}T23:59:59Z`); }).catch(() => {}));
}
async function boot(mode, sdk) {
  try { performance.mark("board-boot"); } catch (e) {}
  $("#gate").hidden = true;
  $("#board").hidden = false;
  $("#hero-art").classList.remove("gate-mode");
  const wall = $("#wall");
  wall.classList.add("settle");
  setTimeout(() => wall.classList.remove("settle"), MOTION.stagger * 8 + MOTION.move * 2);
  pinTiles();
  startAim();
  startEmblems();
  startParallax();
  startScenes();
  try { startGloss(); } catch (e) { console.error(e); }
  startSubtitles();
  startMiniClock();
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => startLight(), { timeout: 1200 });
  (window.requestIdleCallback || ((f) => setTimeout(f, 600)))(() => medalsIdle(), { timeout: 2500 });
  startSound();
  try { setBuffView(localStorage.getItem("board-buff-view") === "list" ? "list" : "wheel"); } catch (e) { setBuffView("wheel"); }
  try {
    const got = await Promise.all(DATA_P.need);
    DATA_NAMES.forEach((n, i) => { D[n] = got[i]; });
    [D.signups, D.tonight] = await Promise.all(DATA_P.opt);
    try { performance.mark("board-data"); } catch (e) {}
  } catch (e) {
    setClockLabel("The data files did not load", "");
    $("#footer").textContent = `Could not read the board's data: ${e.message}. The page needs its data folder published beside it.`;
    document.querySelectorAll(".tile-body").forEach((b) => b.replaceChildren(h("span", { class: "tile-line", text: "Not loaded." })));
    route();
    return;
  }
  if (mode === "discord" && sdk) { const tok = launchToken(sdk.customId); if (tok) { try { history.replaceState(null, "", `${location.pathname}${location.search}#${tok}`); } catch (e) {} } }
  /* No hash: open at the depth the person left at; a first visit opens Tonight (V6-SPEC 3.1). */
  /* V14: */
  let firstBeat = null;
  if (!location.hash || location.hash === "#") {
    const d = (KIT.openDepth ? KIT.openDepth() : null) || MEM.get("depth"); /* V15 (2026-10-30): launch night opens on the wall's hero (js/v15.js), the memory untouched */
    if (!d) {
      document.documentElement.classList.add("first-beat");
      const cancel = () => { if (firstBeat) { clearTimeout(firstBeat); firstBeat = null; } document.documentElement.classList.remove("first-beat"); removeEventListener("pointerdown", cancel, true); removeEventListener("keydown", cancel, true); removeEventListener("hashchange", cancel); };
      addEventListener("pointerdown", cancel, true); addEventListener("keydown", cancel, true); addEventListener("hashchange", cancel);
      const open = () => { if (!firstBeat) return; firstBeat = null; if (!location.hash || location.hash === "#") { document.documentElement.classList.remove("first-beat"); goScene("tonight"); } };
      /* the room's first frame freezes the main thread for about a second (long-frame trace, 2026-10-29), so on a room-capable screen the sheet waits for the */
      const small = innerWidth < 700 || matchMedia("(pointer: coarse)").matches || MEM.get("room") === "off" || !(() => { try { const g = document.createElement("canvas").getContext("webgl2"); if (g) { const x = g.getExtension("WEBGL_lose_context"); x && x.loseContext(); } return !!g; } catch (e) { return false; } })(), calm = reduceMQ && reduceMQ.matches;
      firstBeat = setTimeout(open, calm ? 900 : small ? 1500 : 7500);
      if (!calm && !small) { const onRoom = () => { if (!document.documentElement.classList.contains("room-on") || !firstBeat) return; removeEventListener("board-room", onRoom); clearTimeout(firstBeat); firstBeat = setTimeout(open, 1700); }; addEventListener("board-room", onRoom); }
    } else if (d === "tonight" || d === "library") setHash(d, false);
  }
  /* Tonight paints first (V6-SPEC 3.3: under 1.0 s on the 4x throttle): its cards and the scene open before the wall renders. */
  const early = sceneFromHash() === "tonight";
  for (const step of [renderTonight, markMe]) { try { step(); } catch (e) { console.error(step.name, e); } }
  if (early) { route(); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); }
  const steps = [markMe, renderHero, renderTiles, renderCards, renderMap, renderRaces, renderLegacy, renderWheel, renderBuffsDeep, renderLedger, renderLibrarian, renderFooter, renderDiscordSignups, buildSignupControls];
  for (const step of steps) { try { step(); } catch (e) { console.error(step.name, e); } }
  /* V12: an early scene (Tonight) painted before party.json's glossary was in hand: dot it now */
  if (SC.open && SC.open !== "library") { try { dotPanel($(`#panel-${SC.open}`)); } catch (e) {} }
  try { startArt(); } catch (e) { console.error(e); }
  try { startSheen(); } catch (e) { console.error(e); }
  /* The library's files wait until the person leaves Tonight: Tonight loads no library file. */
  whenOffTonight(() => (window.requestIdleCallback || ((f) => setTimeout(f, 600)))(libPrefetch, { timeout: 2500 }));
  KIT.emit("rendered");
  if (!early) route();
  markNew(); startDepth();
  KIT.emit("booted", mode);
  if (mode !== "discord" && !$("#presence-text").textContent) $("#presence-text").textContent = PRESENCE_WEB;
  /* the room starts after first paint, when the main thread is idle (V7-SPEC 3.3) */
  (window.requestIdleCallback || ((f) => setTimeout(f, 800)))(startRoomLadder, { timeout: 2500 });
  /* V13a: the scenes are drawn once, invisibly, while the page is idle (only where the browser has idle callbacks) */
  if (typeof window.requestIdleCallback === "function") warmLater();
  if (mode === "discord") startDiscordPresence(sdk);
  else startRuntime().catch((e) => { console.error(e); setStatus("Sign-ups are read-only on this view."); });
}
/* V13d: what js/v13d.js reads and calls (it runs after this file, before boot) */
Object.assign(KIT, { medalSet, medalLoad, libCore, libIndex, $, h, s, emb, D, MEM, SC, JR, sfx, crestMark, classVar, fmtWhen, relWhen, reduceMQ, MOTION, motionMs, sceneHooks, TITLES, SCENES, RSVP_KEYS, RSVP_SAY, cleanName, launchWhen, wholeClause, andList, glDef, dotBtn, glClose, glPlace, glShow, GL, ttPlace, ttShow, ttClose, TT, LIBUI, libRender, goScene, switchTab, requestClose, setHash, fitScene, startSwipe, aimAt, FIT, focusBuff, markNew, nextEvent, eventTs, fmtMs, fmtVal, fmtCost, nf, beforeTicks,
  render: { tonight: renderTonight, tiles: renderTiles, cards: renderCards, races: renderRaces, legacy: renderLegacy, timeline: renderTimeline, ledger: renderLedger, signups: renderDiscordSignups, buffs: renderBuffsDeep, wheel: renderWheel, librarian: renderLibrarian, map: renderMap } });
/* V14: an image that 404s is hidden (and its slot keeps its size) instead of showing a broken-image icon. */
document.addEventListener("error", (e) => { const t = e.target; if (t && t.tagName === "IMG") { t.classList.add("img-missing"); try { console.warn("image missing:", t.getAttribute("src")); } catch (x) {} } }, true);
/* V14: burn-in care. Persistent chrome drifts a few pixels every 45 s; after 120 s without input a black veil dims the page. */
(function grain() { try { const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d"), d = x.createImageData(128, 128); for (let i = 0; i < d.data.length; i += 4) { const v = (Math.random() * 255) | 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } x.putImageData(d, 0, 0); document.documentElement.style.setProperty("--noise", `url(${c.toDataURL("image/png")})`); } catch (e) {} })();
(function burnIn() {
  const root = document.documentElement; let n = 0, idle = 0, veil = null;
  setInterval(() => { if (document.hidden) return; n += 1; root.style.setProperty("--drift-x", `${Math.round(Math.cos(n * 1.7) * 3)}px`); root.style.setProperty("--drift-y", `${Math.round(Math.sin(n * 1.3) * 3)}px`); }, 45000);
  const wake = () => { idle = Date.now(); if (root.classList.contains("idle-dim")) root.classList.remove("idle-dim"); };
  ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach((ev) => addEventListener(ev, wake, { passive: true, capture: true }));
  idle = Date.now();
  setInterval(() => { if (document.hidden) return; if (!veil) { veil = document.createElement("div"); veil.setAttribute("class", "idle-veil"); veil.setAttribute("aria-hidden", "true"); document.body.appendChild(veil); } if (Date.now() - idle > 120000) root.classList.add("idle-dim"); }, 10000);
})();
/* V14: */
KIT.on("booted", () => {
  if (typeof document.querySelectorAll !== "function") return;
  const stampOf = (txt) => { const m = /js\/board\.js\?v=([0-9a-f]{10})/.exec(txt || ""); return m ? m[1] : ""; };
  const mine = stampOf([...document.querySelectorAll("script[src]")].map((x) => x.getAttribute("src") || "").join(" "));
  const foot = $("#footer"); if (foot && mine && !foot.querySelector(".build-stamp")) foot.appendChild(h("span", { class: "build-stamp", title: "Build stamp of this page", text: `build ${mine.slice(0, 7)}` }));
  if (!mine || location.protocol === "file:") return;
  let shown = false;
  const check = async () => {
    if (shown || document.hidden) return;
    try {
      const self = new URL(location.href); self.hash = ""; const r = await fetch(self.href, { cache: "no-store", credentials: "omit" }); if (!r.ok) return;
      const theirs = stampOf(await r.text());
      if (theirs && theirs !== mine) { shown = true; const pill = h("button", { class: "newer-pill", type: "button", role: "status", text: "A newer board is ready. Refresh" }); pill.addEventListener("click", () => location.reload()); document.body.appendChild(pill); }
    } catch (e) {}
  };
  setTimeout(check, 20000); setInterval(check, 300000); document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(check, 1500); });
});
window.__boardKit = KIT;
startWisps();
let started = false;
window.__board = Object.freeze({ fmt: { when: fmtWhen, rel: relWhen, rsvp: RSVP_SAY }, start: (mode, sdk) => { if (started) return; started = true; boot(mode, sdk); }, status: () => ({ light: { ...LS, aim: { tx: LB.tx, ty: LB.ty, x: Math.round(LB.x), y: Math.round(LB.y), tilt: LB.tilt, frames: LB.frames, running: LB.running } }, wisps: { ...WS }, scene: SC.open, warm: { scenes: WARM.scenes, ms: Math.round(WARM.ms), done: WARM.done }, map: { running: !!(MC.raf || MC.timer), t: Math.round(MC.t), untangled: MC.untangled || 0, moved: MC.moved || 0 }, longtasks: LT.slice(), library: LIBUI.status() }), sound: (on) => { if (on !== undefined) setSound(!!on); return AU.on; }, audio: audioStatus, room: () => ({ ...RS, room: RS.status ? RS.status() : null }) });
})();
