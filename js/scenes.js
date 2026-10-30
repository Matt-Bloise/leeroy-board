/* Lazy scenes (companion N1, 2026-10-30): the scripts and stylesheets one scene uses live in scenes/ and load on demand, so the page
   a friend downloads first stays under its budget. load(name) adds the stylesheet (at the old slot, after css/v15.css, so a later
   sheet such as fit.css still wins) and the script, then replays the page hooks the script missed. Runs after js/v13d.js, before boot. */
(() => {
"use strict";
const K = window.__boardKit; if (!K || typeof document === "undefined") return;
const HERE = (document.currentScript && document.currentScript.src) || null; /* this file's own URL; null under the fake DOM */
/* new URL("../scenes/x?v=...", HERE): board/stamp.mjs stamps these against this file's folder. A stamp of ten zeros means the file
   did not exist when the page was stamped (walk ships with node N7): that load resolves at once, with no request */
const SCENES = {
  sheet: () => [new URL("../scenes/sheet.css?v=451af8a4a2", HERE), new URL("../scenes/sheet.js?v=87bcd5843e", HERE)],
  chamber: () => [new URL("../scenes/chamber.css?v=9feee0b93b", HERE), new URL("../scenes/chamber.js?v=57749dcbb7", HERE)],
  decide: () => [new URL("../scenes/decide.css?v=99fcaa246c", HERE), new URL("../scenes/decide.js?v=250667e6fa", HERE)],
  probe: () => [new URL("../scenes/probe.css?v=c41750fabe", HERE), new URL("../scenes/probe.js?v=5d73e2299f", HERE)],
  walk: () => [new URL("../scenes/walk.css?v=66b809dee8", HERE), new URL("../scenes/walk.js?v=430616c521", HERE)],
  place: () => [new URL("../scenes/place.css?v=a890a4436f", HERE), new URL("../scenes/place.js?v=1b9e9b4574", HERE)],
  buffs: () => [new URL("../scenes/buffs.css?v=0c35e116cb", HERE), new URL("../scenes/buffs.js?v=2f4a786354", HERE)],
  wide: () => [null, new URL("../scenes/wide.js?v=ea2b5cab32", HERE)],
};
const NEEDS = { sheet: ["decide"] }; /* the sheet reads decide.json through decide.js (K.decideData) */
/* forget is listed for a later caller and never replayed: a module that loads after Clear my name has nothing of the old visit */
const REPLAY = ["booted", "rendered", "scene", "tonight", "signups", "launch", "forget", "map"];
/* the hover layer's stylesheet keeps its old slot (before css/ask.css) so the sheets after it still win as they did */
/* polish (2026-10-30): the buffs effects layer's stylesheet keeps its old slot too (just before css/fit.css); the wide roads map has
   no stylesheet of its own (css/wide.css stays in the page: its card pips serve every scene) */
const AT = { place: 'link[href*="css/ask.css"]', buffs: 'link[href*="css/fit.css"]' };
const P = Object.create(null), ok = [], bad = [], seen = {}, done = new WeakSet(), land = Object.create(null);
let after = null;
const ONCE = ["signups", "rendered", "booted", "launch", "map"]; /* the order boot emits them; replayed only once the page has, with its last arguments */
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
  let cssErr = null; /* a stylesheet that fails leaves the scene unstyled, not dead: the script's hooks are still replayed */
  return (P[name] = Promise.all([...needs, (urls[0] ? tag(urls[0], true, AT[name]) : Promise.resolve()).catch((e) => { cssErr = e; }), tag(urls[1], false)]).then(() => {
    ok.push(name);
    const fresh = (n) => (K.hooks[n] || []).slice(n0[n]), SC = K.SC, cap = land[name]; land[name] = null;
    for (const n of ONCE) if (seen[n]) for (const f of fresh(n)) call(n, f, seen[n]);
    if (typeof SC.open === "string") {
      /* a deep link (#decide.<slug>, #five.sheet-<slug>) is read from SC.land in the scene event and by K.lander right after: the
         replay sees it as the open did, and a lander the module added gets it once */
      const keep = SC.land, l = cap && cap.key === SC.open ? cap : null; if (l) SC.land = l;
      for (const f of fresh("scene")) call("scene", f, [SC.open]);
      if (l && SC.land === l) SC.land = keep;
      if (l && K.lander !== lander0 && K.lander) { try { K.lander(l.key, l.sub); } catch (e) { console.error("lander", e); } }
    }
    if (SC.open === "tonight") for (const f of fresh("tonight")) call("tonight", f, []);
    return cssErr ? fail(cssErr) : { ok: true };
  }, fail));
}
/* What to decide has no markup in index.html: decide.js added its tab and panel at load, and board.js reads them at boot (every
   scene switch, the tab rail, the More list). Built here before boot, the same as decide.js mount(), which then finds them and stops */
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
/* what opens a scene's code: its scene, Next steps with a name picked (the sheet's "Your sheet" link), #probe, a first visit (the walk) */
/* polish (2026-10-30, contract 10.4 pattern): Who buffs whom's effects layer (scenes/buffs.*, the scene name, so the harness runs it) and the wide roads map left the first download too */
const OF = { five: "sheet", librarian: "chamber", decide: "decide", buffs: "buffs", roads: "wide" };
K.on("scene", (k) => {
  const m = OF[k]; if (!m) return;
  const L = K.SC.land; if (!ok.includes(m)) land[m] = L && L.key === k ? { key: k, sub: L.sub, from: null } : null;
  /* polish: Three roads opened before its wide layout code arrived drew the compact layout first and then jumped (a 0.35 layout
     shift at 1366x768); the panel waits unseen for that code, one frame at most after it lands, and never longer than 3 s */
  const wait = m === "wide" && !ok.includes(m) && innerWidth >= 700 && innerHeight >= 501 ? document.getElementById("panel-roads") : null;
  if (wait) { wait.classList.add("wide-wait"); const go = () => wait.classList.remove("wide-wait"), t = setTimeout(go, 3000); load(m).then(() => requestAnimationFrame(() => { clearTimeout(t); go(); })); return; }
  load(m);
});
K.on("tonight", () => { const me = K.MEM && K.MEM.me(); if (me && me !== "just-looking") load("sheet"); });
const probeHash = () => { try { return decodeURIComponent(String(location.hash || "").slice(1)) === "probe"; } catch (e) { return false; } };
if (probeHash()) load("probe");
/* a deep link into Three roads or the Atlas fetches the wide map's code at once, so the roads layout is there for the first open */
try { if (/^(roads|atlas)(\.|$)/.test(decodeURIComponent(String(location.hash || "").slice(1)))) load("wide"); } catch (e) {}
addEventListener("hashchange", () => { if (probeHash()) load("probe"); });
K.on("booted", () => { let walked = null; try { walked = localStorage.getItem("board-walked"); } catch (e) {} if (!walked && !/[?&](render|brain)=/.test(location.search)) load("walk"); });
/* Warm the scenes a friend opens next once the first screen is idle, so a first tap never paints an empty panel that then grows
   (verifier round 1: 1 to 4 blank frames, then a jump of up to 1,203 px on What to decide). A pointer over, a touch on or a focus on
   a scene's control warms that one at once. Only in a real browser (this file's URL known; Safari has no idle callback, so a short
   timer stands in); never under ?render= or ?brain=. */
const WARM = ["chamber", "sheet", "decide", "wide"], PLACE = { five: "sheet", sheet: "sheet", librarian: "chamber", decide: "decide", buffs: "buffs", roads: "wide" };
/* polish (2026-10-30): Play mode is for while the game runs, so nothing is fetched in idle time there (the warm-up and the hover
   layer ran in the 10 s after a Play load: 0.135 s of main thread at 2560); a control's own pointer, touch or focus still warms its
   scene, and leaving Play starts the idle warm-up then */
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
/* contract 10.4: the hover layer (scenes/place.*: hover cards, tips, the glossary's placing) is a desktop feature, so it left the
   first download. It loads on the first hover with a fine pointer, the first key press (keyboard focus does what hover does), and in
   idle time on a fine-pointer device once the scenes above are warm. A touch-only phone never fetches it; board.js and v13d.js place
   their cards themselves until K.placeCard exists. */
const fine = () => { try { return matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) { return false; } };
const hoverIn = (e) => { if (P.place) return; const t = e && e.pointerType; if (t === "mouse" || t === "pen" || (!t && fine())) load("place"); };
if (typeof document.addEventListener === "function") {
  document.addEventListener("pointerover", hoverIn, { capture: true, passive: true });
  document.addEventListener("keydown", () => { if (!P.place) load("place"); }, { capture: true, passive: true });
}
K.on("booted", () => { if (HERE && fine() && !/[?&](render|brain)=/.test(String(location.search || ""))) afterPlay(() => setTimeout(() => afterPlay(() => { if (!P.place) load("place"); }), 4000)); });
window.__scenes = Object.freeze({ load, loaded: (n) => ok.includes(n), status: () => ({ loaded: ok.slice(), failed: bad.slice(), base: HERE }) });
})();
