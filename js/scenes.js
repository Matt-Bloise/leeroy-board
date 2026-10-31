(() => {
"use strict";
const K = window.__boardKit; if (!K || typeof document === "undefined") return;
const HERE = (document.currentScript && document.currentScript.src) || null;
const SCENES = {
  sheet: () => [new URL("../scenes/sheet.css?v=7a8d1c52e5", HERE), new URL("../scenes/sheet.js?v=5b5a1785d3", HERE)],
  chamber: () => [new URL("../scenes/chamber.css?v=5951072482", HERE), new URL("../scenes/chamber.js?v=134acfc3b1", HERE)],
  decide: () => [new URL("../scenes/decide.css?v=8d874e23ef", HERE), new URL("../scenes/decide.js?v=907d901b50", HERE)],
  probe: () => [new URL("../scenes/probe.css?v=c41750fabe", HERE), new URL("../scenes/probe.js?v=5d73e2299f", HERE)],
  walk: () => [new URL("../scenes/walk.css?v=66b809dee8", HERE), new URL("../scenes/walk.js?v=95d283c0e2", HERE)],
  place: () => [new URL("../scenes/place.css?v=a890a4436f", HERE), new URL("../scenes/place.js?v=1280b387e0", HERE)],
  buffs: () => [new URL("../scenes/buffs.css?v=0c35e116cb", HERE), new URL("../scenes/buffs.js?v=256503156b", HERE)],
  hades: () => [new URL("../scenes/hades.css?v=8eb34e6d88", HERE), new URL("../scenes/hades.js?v=f432c92235", HERE)],
  wide: () => [null, new URL("../scenes/wide.js?v=ea2b5cab32", HERE)],
  refresh: () => [new URL("../scenes/refresh.css?v=f843425d4d", HERE), new URL("../scenes/refresh.js?v=a053a35f34", HERE)],
  guided: () => [new URL("../scenes/guided-atlas.css?v=6cd88a7eed", HERE), new URL("../scenes/guided-atlas.js?v=51a8daed4d", HERE)],
  foley: () => [null, new URL("../scenes/foley.js?v=54054813b9", HERE)],
  foleyfx: () => [null, new URL("../scenes/foley-fx.js?v=ef6c4c1e09", HERE)],
};
const NEEDS = { sheet: ["decide"] };
NEEDS.hades = ["chamber"];
const REPLAY = ["booted", "rendered", "scene", "tonight", "signups", "launch", "forget", "map"];
const AT = { place: 'link[href*="css/ask.css"]', buffs: 'link[href*="css/fit.css"]' };
const P = Object.create(null), ok = [], bad = [], seen = {}, done = new WeakSet(), land = Object.create(null);
let after = null;
const ONCE = ["signups", "rendered", "booted", "launch", "map"];
for (const n of ONCE) K.on(n, (...a) => { seen[n] = a; });
const call = (n, f, a) => { if (done.has(f)) return; done.add(f); try { f(...a); } catch (e) { console.error(n, e); } };
function tag(u, css, before) {
  return new Promise((res, rej) => {
    const el = document.createElement(css ? "link" : "script");
    el.addEventListener("load", () => res()); el.addEventListener("error", () => rej(new Error(`${u.pathname} did not load`)));
    const head = document.head || document.documentElement;
    if (css) {
      el.setAttribute("rel", "stylesheet"); el.setAttribute("href", u.href);
      let b4 = null; if (before) { try { b4 = document.querySelector(before); } catch (e) {} }
      if (b4 && b4.parentNode) { b4.parentNode.insertBefore(el, b4); return; }
      let at = after; if (!at) { try { at = document.querySelector('link[href*="css/v15.css"]'); } catch (e) {} }
      if (at && at.parentNode) at.parentNode.insertBefore(el, at.nextSibling); else head.appendChild(el);
      after = el;
    } else { el.async = false; el.setAttribute("src", u.href); head.appendChild(el); }
  });
}
function load(name) {
  if (P[name]) return P[name];
  if (!Object.prototype.hasOwnProperty.call(SCENES, name)) { console.warn(`scenes: no scene named ${name}`); return (P[name] = Promise.resolve({ ok: false, why: "unknown" })); }
  let urls = null; try { urls = HERE && typeof URL === "function" ? SCENES[name]() : null; } catch (e) {}
  if (!urls) return (P[name] = Promise.resolve({ ok: false, why: "no base" }));
  if (urls.some((u) => u && /[?&]v=0{10}$/.test(u.search))) return (P[name] = Promise.resolve({ ok: false, why: "not shipped" }));
  const needs = (NEEDS[name] || []).map(load);
  const n0 = {}; for (const n of REPLAY) n0[n] = K.hooks[n] ? K.hooks[n].length : 0;
  const lander0 = K.lander, fail = (e) => { bad.push(name); console.warn(`scenes: ${name} did not load (${e && e.message})`); return { ok: false, why: "load" }; };
  let cssErr = null;
  return (P[name] = Promise.all([...needs, (urls[0] ? tag(urls[0], true, AT[name]) : Promise.resolve()).catch((e) => { cssErr = e; }), tag(urls[1], false)]).then(() => {
    ok.push(name);
    const fresh = (n) => (K.hooks[n] || []).slice(n0[n]), SC = K.SC, cap = land[name]; land[name] = null;
    for (const n of ONCE) if (seen[n]) for (const f of fresh(n)) call(n, f, seen[n]);
    if (typeof SC.open === "string") {
      const keep = SC.land, l = cap && cap.key === SC.open ? cap : null; if (l) SC.land = l;
      for (const f of fresh("scene")) call("scene", f, [SC.open]);
      if (l && SC.land === l) SC.land = keep;
      if (l && K.lander !== lander0 && K.lander) { try { K.lander(l.key, l.sub); } catch (e) { console.error("lander", e); } }
    }
    if (SC.open === "tonight") for (const f of fresh("tonight")) call("tonight", f, []);
    return cssErr ? fail(cssErr) : { ok: true };
  }, fail));
}
(function decideShell() {
  const { $, h, s } = K, tabs = $("#tabs"), body = $("#sheet-body"); if (!tabs || !body || !h || !s || $("#tab-decide")) return;
  const tt = $("#tab-tonight"), tp = $("#panel-tonight");
  const ico = s("svg", { class: "emblem", viewBox: "0 0 24 24" }, s("path", { d: "M12 3.5v16M8 19.5h8M5 7.5h14" }), s("path", { d: "M5 7.5l-2.8 6.2a2.8 2.8 0 0 0 5.6 0zM19 7.5l-2.8 6.2a2.8 2.8 0 0 0 5.6 0z" }));
  tabs.insertBefore(h("button", { class: "tab", type: "button", role: "tab", id: "tab-decide", "data-tab": "decide", "aria-controls": "panel-decide", "aria-selected": "false", tabindex: "-1" }, h("span", { class: "tab-ico", "aria-hidden": "true" }, ico), "What to decide"), tt && tt.parentNode === tabs ? tt : $("#tab-ind"));
  body.insertBefore(h("div", { class: "panel dc", role: "tabpanel", id: "panel-decide", "aria-labelledby": "tab-decide", tabindex: "0", hidden: true },
    h("p", { class: "lede", id: "dc-lede", text: "What is still open for each of us, what the game says about each option, and the only dates Blizzard has given. Facts, not advice." }),
    h("div", { class: "deep-who dc-who", id: "dc-who", role: "group", "aria-label": "Whose choices" }),
    h("div", { class: "dc-dates", id: "dc-dates", role: "group", "aria-label": "Blizzard's dates" }),
    h("section", { class: "dc-main", id: "dc-main", "aria-label": "Choices" }),
    h("section", { class: "dc-party", id: "dc-party", "aria-label": "Party composition" })), tp && tp.parentNode === body ? tp : null);
})();
const OF = { five: "sheet", librarian: "chamber", decide: "decide", buffs: "buffs", roads: "wide", library: "refresh" };
K.on("scene", (k) => {
  const m = OF[k]; if (!m) return;
  const L = K.SC.land; if (!ok.includes(m)) land[m] = L && L.key === k ? { key: k, sub: L.sub, from: null } : null;
  const wait = m === "wide" && !ok.includes(m) && innerWidth >= 700 && innerHeight >= 501 ? document.getElementById("panel-roads") : null;
  if (wait) { wait.classList.add("wide-wait"); const go = () => wait.classList.remove("wide-wait"), t = setTimeout(go, 3000); load(m).then(() => requestAnimationFrame(() => { clearTimeout(t); go(); })); return; }
  load(m);
});
K.on("tonight", () => { const me = K.MEM && K.MEM.me(); if (me && me !== "just-looking") load("sheet"); });
const probeHash = () => { try { return decodeURIComponent(String(location.hash || "").slice(1)) === "probe"; } catch (e) { return false; } };
if (probeHash()) load("probe");
try { const g = localStorage.getItem("board-journey"); if ((!g || g === "guided")) load("guided"); } catch (e) {}
document.addEventListener("click", (e) => { const t = e.target; if (t && t.closest && t.closest('[data-journey="guided"]')) load("guided"); }, true);
try { if (/^(roads|atlas)(\.|$)/.test(decodeURIComponent(String(location.hash || "").slice(1)))) load("wide"); } catch (e) {}
addEventListener("hashchange", () => { if (probeHash()) load("probe"); });
K.on("booted", () => { let walked = null; try { walked = localStorage.getItem("board-walked"); } catch (e) {} if (!walked && !/[?&](render|brain)=/.test(location.search)) load("walk"); });
const WARM = ["chamber", "sheet", "decide", "wide"], PLACE = { five: "sheet", sheet: "sheet", librarian: "chamber", decide: "decide", buffs: "buffs", roads: "wide", library: "refresh" };
const playing = () => { try { return document.documentElement.classList.contains("play"); } catch (e) { return false; } };
const afterPlay = (f) => { if (!playing()) { f(); return; } const go = () => { if (playing()) return; removeEventListener("board-mode", go); f(); }; addEventListener("board-mode", go); };
const warm = (m) => { if (m && !P[m]) load(m); };
K.on("booted", () => {
  if (!HERE || /[?&](render|brain)=/.test(String(location.search || ""))) return;
  const idle = typeof requestIdleCallback === "function" ? (f) => requestIdleCallback(f, { timeout: 3000 }) : (f) => setTimeout(f, 250);
  const next = () => { if (playing()) { afterPlay(next); return; } const m = WARM.find((x) => !P[x] && (x !== "wide" || innerWidth >= 700)); if (m) load(m).then(() => idle(next)); };
  afterPlay(() => setTimeout(() => idle(next), 1200));
});
const intent = (e) => { const t = e && e.target; if (!t || typeof t.closest !== "function") return; const c = t.closest("[data-tab], [data-place]"); if (c) warm(PLACE[c.getAttribute("data-tab") || c.getAttribute("data-place")]); };
if (typeof document.addEventListener === "function") for (const ev of ["pointerover", "focusin", "touchstart"]) document.addEventListener(ev, intent, { capture: true, passive: true });
const fine = () => { try { return matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) { return false; } };
const hoverIn = (e) => { if (P.place) return; const t = e && e.pointerType; if (t === "mouse" || t === "pen" || (!t && fine())) load("place"); };
if (typeof document.addEventListener === "function") {
  document.addEventListener("pointerover", hoverIn, { capture: true, passive: true });
  document.addEventListener("keydown", () => { if (!P.place) load("place"); }, { capture: true, passive: true });
}
K.on("booted", () => { if (HERE && fine() && !/[?&](render|brain)=/.test(String(location.search || ""))) afterPlay(() => setTimeout(() => afterPlay(() => { if (!P.place) load("place"); }), 4000)); });
if (window.BoardSound && BoardSound.onState) BoardSound.onState((on) => { if (on) load("foley"); });
window.__scenes = Object.freeze({ load, loaded: (n) => ok.includes(n), status: () => ({ loaded: ok.slice(), failed: bad.slice(), base: HERE }) });
})();
