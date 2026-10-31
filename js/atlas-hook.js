/* The Atlas hook (board/ATLAS-NOTES.md) */
(() => {
  "use strict";
  const ATLAS_DEFAULT = false; /* true: the Atlas first (the owner's call) */
  const K = window.__boardKit; if (!K || typeof document === "undefined") return;
  const $ = (q, r) => (r || document).querySelector(q), h = K.h, TOK = /^atlas(?:\.|$)/;
  const H = { on: false, pending: null };
  const hashTok = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch (e) { return ""; } };
  /* board.js stops the sketch's clock under the Atlas */
  const fire = () => { try { dispatchEvent(new Event("board-atlas")); } catch (e) {} };
  const idle = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 600));

  const kit = () => Object.fromEntries("h $ reduceMQ motionMs MOTION classVar andList sfx setHash goScene JR".split(" ").map((k) => [k, k === "$" ? $ : k === "reduceMQ" ? { get matches() { return !!(K.reduceMQ && K.reduceMQ.matches) || document.documentElement.classList.contains("play"); } } : K[k]]));
  const load = async () => {
    const m = await import("../atlas/atlas.js?v=b096d4ddbd");
    return m.createAtlas({ host: H.host, base: "", kit: kit(), data: { party: K.D.party, signups: K.D.signups }, sound: window.BoardSound || null, haptics: window.BoardHaptics || null, shapesNote: true, on: onEv });
  };
  const onEv = (type, d) => {
    K.emit("atlas", type, d);
    if (type === "close") closeAtlas(true);
    else if (H.user && (type === "view" || type === "card" || type === "plan")) { /* fix E4: only a gesture moves the hash */ clearTimeout(H.t); H.t = setTimeout(() => { if (H.on && H.A) K.setHash(H.A.token(), false); }, 400); }
  };
  const fail = () => { H.host.replaceChildren(h("p", { class: "atlas-fail", role: "status", text: "The Atlas did not load." })); H.failT = setTimeout(() => closeAtlas(true), 1500); };

  async function openAtlas(token, o) {
    const map = $("#map"); if (!map) return;
    H.pending = token; H.on = true;
    H.user = false;
    if (!H.host || !H.host.isConnected) { if (H.A) { try { H.A.destroy(); } catch (e) { } } H.host = h("div", { id: "atlas", class: "atlas" }); for (const t of ["pointerdown", "wheel", "keydown"]) H.host.addEventListener(t, () => { H.user = true; }, { capture: true, passive: true }); map.append(H.host); H.A = null; H.loading = null; }
    map.classList.add("atlas-on"); fire(); K.sfx("open"); if (map.scrollIntoView) map.scrollIntoView({ block: "nearest" });
    if (o && o.push) { K.setHash(token, true); H.pushed = 1; }
    try {
      if (!H.A) { H.loading = H.loading || load(); H.A = await H.loading; }
      if (!H.on) return;
      H.A.resume();
      if (!H.A.openToken(token, { animate: true })) H.A.openToken("atlas", { animate: true });
      H.pending = null;
    } catch (e) { H.loading = null; H.A = null; fail(); }
  }
  function closeAtlas(fixHash) {
    clearTimeout(H.failT);
    if (!H.on) return;
    H.on = false; H.pending = null;
    const map = $("#map"); if (map) map.classList.remove("atlas-on"); fire();
    if (H.A) H.A.pause();
    if (fixHash && TOK.test(hashTok())) { if (H.pushed) history.back(); else K.setHash("roads", false); }
    H.pushed = 0;
  }
  const fromHash = () => {
    const t = hashTok();
    if (TOK.test(t)) { H.pending = t; if (K.SC && K.SC.open === "roads" && !H.on) openAtlas(t); else if (H.on && H.A) { H.user = false; H.A.openToken(t, { animate: true }); H.pending = null; } }
    else if (H.on) closeAtlas(false);
  };

  /* the control (next round D2: under the sketch on a phone) and the wheel past the sketch */
  const control = () => {
    const panel = $("#panel-roads"); if (!panel) return;
    const b = $(".atlas-open", panel) || h("button", { type: "button", class: "atlas-open", text: "Open the Atlas", title: "The roads on a map drawn from the game's own coordinates", onclick: () => openAtlas("atlas", { push: true }) });
    const at = $(innerWidth < 700 || document.documentElement.classList.contains("phone-shell") ? "#map" : "#map-caption", panel), c = [...panel.children], ref = at && c[c.indexOf(at) + 1] || null;
    if (at ? ref !== b : !b.parentNode) panel.insertBefore(b, ref);
  };
  const zoneSlug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const wheel = (e) => {
    const map = $("#map"), sv = map && $("svg", map); if (H.on || !sv || !(e.deltaY < 0)) return;
    const v = (sv.getAttribute("viewBox") || "0 0 600 400").split(/\s+/).map(Number), a = (map.clientWidth || 3) / (map.clientHeight || 2), wf = Math.max(600, 400 * a);
    if (!(wf / v[2] >= 3.45)) return;
    e.preventDefault(); e.stopPropagation();
    let best = null, bd = 1e9; const cx = v[0] + v[2] / 2, cy = v[1] + v[3] / 2;
    for (const [n, z] of Object.entries(H.zones || {})) { const d = Math.hypot(z.x - cx, z.y - cy); if (d < bd) { bd = d; best = n; } }
    openAtlas(best ? `atlas.z.${zoneSlug(best)}` : "atlas", { push: true });
  };

  const mark = (id) => h("a", { class: "atlas-mark", href: `#atlas.${id}`, "aria-label": `${H.marks.names[id] || id} on the Atlas` }, h("img", { src: "img/map/waymark.webp", alt: "", width: 20, height: 20, decoding: "async" }));
  const addMarks = (el, ids) => { if (!el || el.getAttribute("data-atlas")) return; el.setAttribute("data-atlas", "1"); for (const id of ids.slice(0, 3)) el.append(mark(id)); };
  const pass = () => {
    const M = H.marks; if (!M) return;
    const tok = (K.LIBUI && K.LIBUI.token ? K.LIBUI.token() : "").replace(/^library\./, "").split("."), page = tok.length > 1 ? `${tok[0]}/${tok[1]}` : "";
    const lib = $("#lib-main");
    if (lib && page && M.pages[page]) addMarks($("#lib-page-title", lib) || $("h1, h2, h3", lib), M.pages[page]);
    if (lib) for (const lf of lib.querySelectorAll(".lf")) { const ids = M.facts[`${page}~${lf.getAttribute("data-key")}`]; if (ids) addMarks($("dd", lf) || lf, ids); }
    if (!H.re) { const al = Object.keys(M.aliases).sort((a, b) => b.length - a.length).map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); H.re = al.length ? new RegExp(`(?:^|[^a-z0-9-])(${al.join("|")})(?![a-z0-9-])`, "gi") : null; }
    if (!H.re) return;
    for (const el of document.querySelectorAll("#ask-out p, #ask-out li, .panel li, .panel p")) {
      if (el.getAttribute("data-atlas") || el.closest("a") || el.querySelector("li, p") || el.closest("#panel-library, #panel-roads, #atlas")) continue;
      const txt = (el.textContent || "").replace(/https?:\/\/\S+/g, " "), ids = [];
      for (const m of txt.matchAll(H.re)) { const id = M.aliases[m[1].toLowerCase()]; if (id && !ids.includes(id)) ids.push(id); }
      if (!ids.length) continue;
      /* in line after the place's name (at a list row's end they made empty rows) */
      const t = textAt(el);
      if (!t || el.getAttribute("data-atlas")) { addMarks(el, ids); continue; }
      el.setAttribute("data-atlas", "1");
      const par = t.parentNode, kids = Array.prototype.slice.call(par.childNodes), ref = kids[kids.indexOf(t) + 1] || null;
      for (const id of ids.slice(0, 3)) { if (par === el) par.insertBefore(mark(id), ref); else par.appendChild(mark(id)); } /* else at the end of its own line */
    }
  };
  /* the first text node naming a place, outside links and source tags */
  const textAt = (el) => {
    for (const c of Array.prototype.slice.call(el.childNodes || [])) {
      if (c.nodeType === 3) { H.re.lastIndex = 0; const txt = String(c.textContent || "").replace(/https?:\/\/\S+/g, " "); if (H.re.test(txt)) { H.re.lastIndex = 0; return c; } }
      else if (c.nodeType === 1 && c.localName !== "a" && !(c.classList && c.classList.contains("label"))) { const f = textAt(c); if (f) return f; }
    }
    return null;
  };
  const later = () => { clearTimeout(H.pt); H.pt = setTimeout(pass, 160); };
  const loadMarks = async () => {
    if (H.marks || H.mLoading) return; H.mLoading = true;
    try { const r = await fetch("data/atlas/marks.json", { cache: "no-store" }); if (r.ok) H.marks = await r.json(); } catch (e) { }
    if (!H.marks) return;
    pass();
    if (typeof MutationObserver === "function" && !H.mo) { H.mo = true; for (const q of ["#lib-main", "#ask-out"]) { const t = $(q); if (t) new MutationObserver(later).observe(t, { childList: true, subtree: true }); } }
  };

  K.on("map", (M) => { H.zones = M && M.zones; control(); const map = $("#map"); if (map) map.addEventListener("wheel", wheel, { capture: true, passive: false });
    if (map && !H.zm && typeof MutationObserver === "function") { H.zm = 1; new MutationObserver(() => { const c = $(".zone-card", map), n = c && $("h3", c); if (!n || c.getAttribute("data-atlas")) return; c.setAttribute("data-atlas", "1"); c.append(h("a", { class: "atlas-zone", href: `#atlas.z.${zoneSlug(n.textContent)}`, text: "Open on the Atlas" })); }).observe(map, { childList: true }); } if (H.on && H.host && !H.host.isConnected && map) map.append(H.host); });
  K.on("scene", (k) => {
    if (k === "roads") { control(); const t = hashTok(); if (TOK.test(t)) openAtlas(t); else if (H.on && H.A) H.A.resume(); else if (ATLAS_DEFAULT && !H.on) openAtlas("atlas"); }
    if (k === "library" || k === "roads") idle(loadMarks);
    later();
  });
  K.on("closed", (k) => { if (k === "roads" && H.A) H.A.pause(); });
  K.on("hdr", () => { if (H.A) H.A.refreshColors(); });
  addEventListener("hashchange", fromHash); addEventListener("popstate", fromHash); addEventListener("resize", () => setTimeout(control, 0));
  control();
  if (TOK.test(hashTok())) H.pending = hashTok();
  window.__atlas = { get api() { return H.A; }, status: () => Object.assign(H.A && H.A.status ? H.A.status() : {}, { on: H.on, pending: H.pending, loaded: !!H.A, marks: !!H.marks }), hook: H };
})();
