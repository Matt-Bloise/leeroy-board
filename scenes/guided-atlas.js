(() => {
"use strict";
const K = window.__boardKit, D = document;
if (!K || !D.head || !K.MEM || /[?&](render|brain)=/.test(String(location.search || ""))) return;
const { $, h, MEM } = K, root = D.documentElement, VIEW = "board-view", JN = ["guided", "curious", "everything"];
const G = { more: innerWidth >= 1000 && innerHeight >= 640, layer: null, A: null, loading: null, data: null, dataP: null, failed: false, booted: false, shown: false, plan: null, stops: [], hi: -1, moved: false, tour: null };
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
const journey = () => (JN.includes(root.dataset.journey) ? root.dataset.journey : "guided");
const view = () => (ls.get(VIEW) === "team" ? "team" : "atlas");
const eligible = () => journey() === "guided" && !!MEM.member();
const open = () => K.SC.open;
const wants = () => !G.failed && eligible() && view() === "atlas";
const calm = () => root.classList.contains("play") || root.classList.contains("calm") || !!(K.reduceMQ && K.reduceMQ.matches);
const kit = () => ({ ...Object.fromEntries("h $ motionMs MOTION classVar andList sfx setHash goScene".split(" ").map((k) => [k, K[k]])), JR: () => "curious", reduceMQ: { get matches() { return calm(); } } });
const sched = (f) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : setTimeout(f, 16));
const focus = (el) => { try { if (el) el.focus({ preventScroll: true }); } catch (e) {} };

function facts() {
  return (G.dataP ||= fetch("data/guided-atlas.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { G.data = d; return d; }));
}
const mine = () => { const m = MEM.member(), d = G.data; return m && d && d.classes ? d.classes[m.class_key] || null : null; };
function meetLine() {
  const o = K.D && K.D.party && (K.D.party.open || []).find((x) => /meeting point/i.test(x.title || ""));
  const d = G.data && G.data.meet;
  if (!o) return { head: `Where the party meets: ${d ? d.name : "not chosen yet"}.`, sub: "" };
  const none = /nothing|not chosen|open/i.test(o.status || "");
  return { head: none ? "Where the party meets: nothing chosen yet." : `Where the party meets: ${o.status}.`, sub: o.detail || "" };
}
function steps() {
  const c = mine(), d = G.data; if (!c) return [];
  const m = MEM.member(), out = [];
  const cap = d.starter_cap ? ` Trainers inside a starting area teach up to level ${d.starter_cap.level}.` : "";
  out.push({ icon: "start-star", id: c.start.id, head: `Start: ${c.start.name}, in ${c.start.zone_name}.`, sub: `Your ${m.race} ${m.class} begins here.` });
  out.push({ icon: "start-star", id: c.start.id, head: c.trainer.name ? `Your class trainer: ${c.trainer.name}.` : "Your class trainer is in your start area.", sub: `A trainer teaches your class new abilities.${cap}` });
  if (c.town) out.push({ icon: "town", id: c.town.id, head: `Your first town: ${c.town.name}.`, sub: c.town.trainer ? `After level ${d.starter_cap ? d.starter_cap.level : 6}, your next trainer is ${c.town.trainer}.` : "The next town on your way." });
  const ml = meetLine(); out.push({ icon: "meeting-banner", id: d.meet ? d.meet.id : null, head: ml.head, sub: ml.sub });
  if (d.dungeon) out.push({ icon: "dungeon-gate", id: d.dungeon.id, head: `Your first dungeon: ${d.dungeon.name}.`, sub: `${d.dungeon_def || ""} It opens to groups at about level ${d.dungeon.level}${d.dungeon.where ? `, at ${d.dungeon.where}` : ""}.`.trim() });
  return out;
}
function legend() {
  const d = G.data, rows = [["start-star", "Start", "Where your character begins."], ["town", "Town", "A town on your way. Your next class trainer stands in one."]];
  rows.push(["dungeon-gate", "Dungeon", (d && d.dungeon_def) || "A shorter adventure for a group of five players."], ["meeting-banner", "Meeting point", "Where the party meets."]);
  if (G.plan && G.plan.crossings && G.plan.crossings.length) rows.push(["zeppelin-tower", "Zeppelin", "An airship that carries you between two cities."]);
  return rows;
}

function build() {
  if (G.layer) return G.layer;
  const team = h("button", { type: "button", class: "ga-team", id: "ga-team", onclick: () => setView("team") }, "See the whole party");
  G.title = h("h2", { class: "ga-h", id: "ga-h", tabindex: "-1" });
  G.card = h("section", { class: "ga-card", id: "ga-card", "aria-labelledby": "ga-t" });
  G.more_ = h("div", { class: "ga-more", id: "ga-more" });
  G.key = h("ul", { class: "ga-key", id: "ga-key", "aria-label": "What the pictures on the map mean" });
  G.map = h("div", { class: "ga-map", id: "ga-map" });
  const rail = h("aside", { class: "ga-rail", id: "ga-rail", "aria-label": "Your guide" }, G.card, G.key, G.more_);
  G.layer = h("div", { class: "ga", id: "ga", hidden: true, role: "region", "aria-labelledby": "ga-h" }, h("header", { class: "ga-bar" }, G.title, team), h("div", { class: "ga-body" }, rail, G.map));
  D.body.appendChild(G.layer);
  return G.layer;
}
function head() {
  const m = MEM.member(); if (!m || !G.title) return;
  G.title.replaceChildren(`${m.name}, ${m.race} ${m.class}`, h("small", { text: "Your map. Your route to launch night." }));
}
function mirror() {
  if (!G.card || !G.shown) return;
  Z.hiSync();
  const src = $("#nx-card"), box = G.card, B = h;
  const rest = [];
  const status = window.__next && window.__next.status ? window.__next.status() : null;
  const why = src && $(".nx-why", src), t = src && $("#nx-t", src);
  const acts = src ? [...src.querySelectorAll(".nx-act button")] : [], say = src && $("#nx-say", src), ext = src && $("#nx-ext", src);
  const kids = [B("p", { class: "ga-k", text: "Next" }), B("h3", { class: "ga-t", id: "ga-t", text: t ? t.textContent : "You are set for now." }),
    B("p", { class: "ga-why", text: why ? why.textContent : t ? "" : "Your route is on the map. The whole party is one tap away." })];
  if (acts.length) kids.push(B("div", { class: "ga-act", role: "group", "aria-label": "Your next step" }, ...acts.map((a, i) => B("button", { type: "button", class: i ? "ga-btn" : "ga-btn strong", "aria-pressed": a.getAttribute("aria-pressed") || null, onclick: () => { a.click(); } }, a.textContent))));
  if (say && say.textContent) kids.push(B("p", { class: "ga-say", role: "status", text: say.textContent }));
  if (ext) kids.push(B("a", { class: "ga-link", href: ext.getAttribute("href"), target: "_blank", rel: "noopener" }, ext.textContent));
  kids.push(B("button", { type: "button", class: "ga-link ga-showmore", id: "ga-showmore", "aria-expanded": String(G.more), "aria-controls": "ga-more", onclick: toggle }, G.more ? "Show less" : "Show me more"));
  box.replaceChildren(...kids);
  rest.push(...extra(src));
  G.more_.hidden = !G.more; G.more_.replaceChildren(...(G.more ? rest : []));
}
function extra(src) {
  const out = [], min = src && [...src.querySelectorAll(".nx-min")].map((x) => x.textContent).filter(Boolean).join(" ");
  if (min) out.push(h("p", { class: "ga-meta", text: min }));
  const week = src && $(".nx-week", src); if (week) out.push(h("p", { class: "ga-meta", text: [...week.querySelectorAll("li")].map((li) => li.textContent).join(" ") }));
  const st = steps();
  if (st.length) out.push(h("h3", { class: "ga-sub", text: "Your route" }), h("ol", { class: "ga-steps" }, ...st.map((s) => h("li", {}, h("button", { type: "button", class: "ga-step", onclick: () => fly(s.id) },
    h("img", { src: `img/atlas/C-${s.icon}.webp`, alt: "", width: 28, height: 28, decoding: "async" }), h("span", { class: "ga-step-t" }, h("b", { text: s.head }), s.sub ? h("small", { text: s.sub }) : null))))));
  out.push(h("h3", { class: "ga-sub", text: "What the map shows" }), h("dl", { class: "ga-legend" }, ...legend().flatMap(([ic, n, say]) => [h("dt", {}, h("img", { src: `img/atlas/C-${ic}.webp`, alt: "", width: 24, height: 24 }), n), h("dd", { text: say })]),
    h("dt", { text: "The line" }), h("dd", { text: "Your route. The walking times are estimates, not measured." })));
  const src2 = G.data && G.data.classes && mine(); if (src2 && src2.trainer.src) out.push(h("p", { class: "ga-meta", text: `Trainer names come from a community guide (${src2.trainer.src.host}), not from Blizzard.` }));
  return out;
}
function keyRow() {
  if (!G.key) return;
  G.key.replaceChildren(...legend().map(([ic, n]) => h("li", {}, h("img", { src: `img/atlas/C-${ic}.webp`, alt: "", width: 22, height: 22 }), n)));
}
function toggle() { G.more = !G.more; try { if (window.__next) window.__next.expand(G.more); } catch (e) {} mirror(); }
function fly(id) { if (id && G.A) { try { G.A.open(id, { animate: !calm() }); } catch (e) {} } }

async function ensure() {
  if (G.A || G.loading) return G.loading;
  G.host = G.host && G.host.isConnected ? G.host : h("div", { id: "ga-atlas", class: "atlas ga-atlas" });
  if (!G.host.parentNode) G.map.appendChild(G.host);
  G.loading = (async () => {
    try {
      const [m] = await Promise.all([import("../atlas/atlas.js?v=f90088706f"), facts()]);
      G.A = await m.createAtlas({ host: G.host, base: "", kit: kit(), data: { party: K.D.party, signups: K.D.signups }, member: () => MEM.member(), sound: window.BoardSound || null, haptics: window.BoardHaptics || null, shapesNote: true, on: (t) => { if (t === "view") Z.place(); } });
      if (G.busy || !G.shown) { G.A.pause(); } else { G.A.resume(); }
      G.A.openToken("atlas", { animate: false });
      const m2 = MEM.member(); G.plan = m2 ? G.A.plan({ who: m2.class_key }) : null;
      keyRow(); mirror(); Z.init();
    } catch (e) { G.A = null; G.loading = null; G.failed = true; sync(); }
  })();
  return G.loading;
}
function destroyAtlas() { Z.stop(); G.stops = []; Z.pins = null; if (G.A) { try { G.A.destroy(); } catch (e) {} } G.A = null; G.loading = null; if (G.host) G.host.remove(); G.host = null; }

const TOURKEY = "board-ga-toured", PIN = 15;
const clampN = (n, a, b) => Math.max(a, Math.min(b, n));
const Z = {
  pins: null, cv: null, bar: null, tour: null, framed: null, layer: null,
  build() {
    const A = G.A, c = mine(), d = G.data; if (!A || !c || !d || !G.plan || !G.plan.who.length) return [];
    const w = G.plan.who[0], g = A.debug.graph, out = [], seen = new Set();
    const add = (id, kind, name, say) => { const p = id && A.place(id); if (!p || seen.has(id)) return; seen.add(id); out.push({ id, kind, name, say, a: p.a.slice(), n: out.length + 1 }); };
    const city = (id) => { const p = A.place(id); return p ? String(p.name).replace(/^(Zeppelin|Boat)[^,]*,\s*/i, "") : ""; };
    add(c.start.id, "start", c.start.name, c.trainer.name ? `You start here. Trainer: ${c.trainer.name}` : "You start here");
    if (c.town) add(c.town.id, "town", c.town.name, `First town. Trainer: in ${c.town.name}`);
    const ix = w.edges.findIndex((e) => g.edges.get(e) && /zeppelin|boat/.test(g.edges.get(e).mode));
    if (ix >= 0) add(w.route[ix], "cross", `${city(w.route[ix])} zeppelin`, `Ride it to ${city(w.route[ix + 1]) || "the next city"}`);
    if (d.meet) add(d.meet.id, "meet", d.meet.name, d.meet.chosen ? "Where the party meets" : "Where the party may meet");
    if (d.dungeon) add(d.dungeon.id, "dungeon", d.dungeon.name, `First dungeon, level ${d.dungeon.level}`);
    return out;
  },
  lines() {
    const g = G.A.debug.graph, w = G.plan.who[0], out = [];
    w.edges.forEach((id, i) => { const e = g.edges.get(id); if (!e || !e.a_path) return; out.push({ pts: w.route[i] === e.from ? e.a_path : e.a_path.slice().reverse(), dash: false }); });
    const m = G.stops.find((s) => s.kind === "meet"), q = G.stops.find((s) => s.kind === "dungeon");
    if (m && q) out.push({ pts: [m.a, q.a], dash: true });
    return out;
  },
  box() { const s = G.stops; if (!s.length) return null; let r = [1e9, 1e9, -1e9, -1e9]; for (const p of s) r = [Math.min(r[0], p.a[0]), Math.min(r[1], p.a[1]), Math.max(r[2], p.a[0]), Math.max(r[3], p.a[1])]; if (r[2] - r[0] < 500) { r[0] -= 500; r[2] += 500; } if (r[3] - r[1] < 500) { r[1] -= 400; r[3] += 400; } return r; },
  insets() {
    const o = G.host && G.host.getBoundingClientRect(), I = { l: 0, t: 0, r: 0, b: 0 }; if (!o || !o.width) return I;
    const W = o.width, H = o.height, box = (sel) => { const e = G.host.querySelector(sel); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { l: r.left - o.left, t: r.top - o.top, r: r.right - o.left, b: r.bottom - o.top } : null; };
    const c = box(".atlas-ctl"); if (c && c.l > W * 0.5 && c.b - c.t > c.r - c.l) I.r = Math.max(I.r, W - c.l + 8);
    const p = box(".atlas-plan"); if (p && p.r - p.l > W * 0.6 && p.t > H * 0.4) I.b = Math.max(I.b, H - p.t + 8);
    const b = box(".ga-mapbar"); if (b && b.r - b.l > W * 0.5) I.t = Math.max(I.t, b.b + 8);
    I.l += 24; I.r += 24; I.t += 24; I.b += 24;
    if (W < 700) { I.l += 14; I.r += 14; }
    return I;
  },
  target() { const r = Z.box(); return r ? G.A.view.fitIn(r, Z.insets(), 0.12, 2.2, 0) : null; },
  frame(animate) { const t = Z.target(); if (!t) return; Z.framed = t; G.A.goto({ au: t.cx, av: t.cy, zoom: t.z }, { animate: !!animate && !calm() }); },
  world() { Z.stop(); G.moved = true; G.A.goto({ au: 15000, av: 10000, zoom: -3 }, { animate: !calm() }); },
  init() {
    if (!G.A || !G.plan) return;
    G.stops = Z.build(); if (!G.stops.length) return;
    G.A.debug.state.noLabel = new Set(G.stops.map((x) => x.id));
    const host = G.host;
    const mk = (s) => h("button", { type: "button", class: "ga-pin", "data-stop": String(s.n), "aria-label": `Stop ${s.n}: ${s.name}. ${s.say}.`, onclick: () => { Z.stop(); G.moved = true; fly(s.id); } }, h("b", { text: String(s.n) }));
    const lab = (s) => h("span", { class: "ga-lab", "data-stop": String(s.n), "aria-hidden": "true" }, h("span", { class: "ga-lab-n", text: s.name }), h("span", { class: "ga-lab-s", text: s.say }));
    Z.pins = G.stops.map((s) => ({ s, pin: mk(s), lab: lab(s) }));
    Z.cv = h("canvas", { class: "ga-route", "aria-hidden": "true" });
    Z.bar = h("div", { class: "ga-mapbar" }, h("button", { type: "button", class: "ga-mb", id: "ga-myroute", onclick: () => { Z.stop(); G.moved = false; Z.frame(true); } }, "My route"), h("button", { type: "button", class: "ga-mb", id: "ga-world", onclick: () => Z.world() }, "Show the whole world"));
    Z.layer = h("div", { class: "ga-pins" }, Z.cv, Z.bar, ...Z.pins.map((p) => p.lab), ...Z.pins.map((p) => p.pin));
    host.appendChild(Z.layer);
    Z.measure();
    try { if (D.fonts && D.fonts.ready) D.fonts.ready.then(() => { if (Z.pins) { Z.measure(); Z.place(); } }); } catch (e) {}
    if (typeof ResizeObserver === "function") { Z.ro = new ResizeObserver(() => { if (G.A && !G.moved && !Z.tour) Z.frame(false); Z.place(); }); Z.ro.observe(host); }
    for (const ev of ["pointerdown", "wheel", "keydown"]) host.addEventListener(ev, (e) => { if (e.target && e.target.closest && e.target.closest(".ga-mapbar")) return; G.moved = true; Z.stop(); }, { capture: true, passive: true });
    Z.hiSync(true);
    Z.frame(false);
    let never = true; try { never = !localStorage.getItem(TOURKEY); } catch (e) { never = true; }
    if (never && !calm() && G.stops.length > 1 && G.shown) Z.startTour(); else Z.place();
  },
  measure() {
    if (!Z.pins) return;
    Z.bw = Z.pins[0].pin.offsetWidth || 30;
    for (const p of Z.pins) { p.lab.classList.remove("short"); const a = [p.lab.offsetWidth, p.lab.offsetHeight]; p.lab.classList.add("short"); const b = [p.lab.offsetWidth, p.lab.offsetHeight]; p.lab.classList.remove("short"); p.sz = { full: a, short: b }; }
  },
  hiSync(force) {
    let id = null; try { id = window.__next && window.__next.status().stepId; } catch (e) { id = null; }
    const kind = /meet/.test(id || "") ? "meet" : /dungeon/.test(id || "") ? "dungeon" : /^(make-character|pick-name|train-10)/.test(id || "") ? "start" : null;
    const i = kind ? G.stops.findIndex((s) => s.kind === kind) : -1;
    if (i !== G.hi || force) { G.hi = i; Z.place(); }
  },
  place() {
    if (!Z.pins || !G.A || !G.shown) return;
    const V = G.A.view, W = V.w, H = V.h; if (!W || !H) return;
    const dpr = V.dpr || 1; if (Z.cv.width !== Math.round(W * dpr) || Z.cv.height !== Math.round(H * dpr)) { Z.cv.width = Math.round(W * dpr); Z.cv.height = Math.round(H * dpr); }
    if (Z.hiKey !== G.hi || !Z.pins[0].sz || !Z.pins[0].sz.full[0]) { Z.hiKey = G.hi; Z.pins.forEach((p, i) => { const hi = i === G.hi, c = G.hi >= 0 && !hi; p.lab.classList.toggle("hi", hi); p.lab.classList.toggle("calm", c); p.pin.classList.toggle("hi", hi); p.pin.classList.toggle("calm", c); }); Z.measure(); }
    const P = Z.pins.map((p) => { const [x, y] = V.toScreen(p.s.a[0], p.s.a[1]); return { p, tx: x, ty: y, x, y, on: x > -40 && y > -40 && x < W + 40 && y < H + 40 }; });
    const vis = P.filter((q) => q.on), rad = (q) => PIN + (q.p.s.n - 1 === G.hi ? 9 : 0);
    for (let it = 0; it < 60; it++) { let moved = false; for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) { const a = vis[i], b = vis[j], D = rad(a) + rad(b) + 4; let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); if (d >= D) continue; if (d < 0.5) { dx = 0; dy = 1; d = 1; } const k = (D - d) / 2 / d; a.x -= dx * k; a.y -= dy * k; b.x += dx * k; b.y += dy * k; moved = true; } if (!moved) break; }
    for (const q of vis) { q.x = clampN(q.x, PIN + 4, W - PIN - 4); q.y = clampN(q.y, PIN + 4, H - PIN - 4); }
    const rects = [];
    const rel = (el) => { if (!el || !G.host) return null; const r = el.getBoundingClientRect(), o = G.host.getBoundingClientRect(); if (!r.width || !r.height) return null; return [r.left - o.left, r.top - o.top, r.right - o.left, r.bottom - o.top]; };
    for (const sel of [".atlas-ctl", ".atlas-plan", ".atlas-card", ".atlas-scale", ".atlas-cartouche", ".ga-mapbar"]) { const r = rel(G.host.querySelector(sel)); if (r) rects.push(r); }
    const pinRects = vis.map((q) => { const r = PIN + (q.p.s.n - 1 === G.hi ? 9 : 2); return [q.x - r, q.y - r, q.x + r, q.y + r]; });
    const hit = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const order = vis.slice().sort((a, b) => (b.p.s.n - 1 === G.hi ? 1 : 0) - (a.p.s.n - 1 === G.hi ? 1 : 0) || a.p.s.n - b.p.s.n);
    const placed = [], gap = 7, R = PIN + gap;
    for (const q of order) {
      let best = null; const R = PIN + gap + (q.p.s.n - 1 === G.hi ? 8 : 0);
      for (const tier of ["full", "short"]) {
        const [w, hh] = q.p.sz[tier];
        const cand = [];
        for (const r of [R, R + 26, R + 52, R + 84, R + 120, R + 160]) for (const a of [0, 180, 270, 90, 315, 45, 225, 135, 337.5, 22.5, 157.5, 202.5, 292.5, 247.5, 67.5, 112.5]) { const rad = (a * Math.PI) / 180, c = Math.cos(rad), sn = Math.sin(rad), ax = q.x + c * r, ay = q.y + sn * r; cand.push([c > 0.3 ? ax : c < -0.3 ? ax - w : ax - w / 2, sn > 0.3 ? ay : sn < -0.3 ? ay - hh : ay - hh / 2]); }
        for (const [x, y] of cand) {
          const b = [x, y, x + w, y + hh]; let cost = 0;
          if (b[0] < 4) cost += (4 - b[0]) * hh * 4; if (b[1] < 4) cost += (4 - b[1]) * w * 4; if (b[2] > W - 4) cost += (b[2] - W + 4) * hh * 4; if (b[3] > H - 4) cost += (b[3] - H + 4) * w * 4;
          for (const r of rects) cost += hit(b, r);
          for (const r of pinRects) cost += hit(b, r);
          for (const r of placed) cost += hit(b, r) * 2;
          if (tier === "short") cost += 20;
          if (!best || cost < best.cost) best = { cost, x, y, b, tier };
          if (cost === 0) break;
        }
        if (best && best.cost === 0) break;
      }
      placed.push(best.b); q.lab = best;
    }
    G.labels = placed.length;
    for (const q of P) {
      const s = q.p.s, hi = s.n - 1 === G.hi, calmed = G.hi >= 0 && !hi;
      const bw = Z.bw || 30; q.p.pin.style.transform = `translate(${(q.x - bw / 2).toFixed(1)}px, ${(q.y - bw / 2).toFixed(1)}px)`;
      q.p.pin.hidden = !q.on; q.p.lab.hidden = !q.on;
      q.p.pin.classList.toggle("hi", hi); q.p.lab.classList.toggle("hi", hi); q.p.pin.classList.toggle("calm", calmed); q.p.lab.classList.toggle("calm", calmed);
      if (q.lab) { q.p.lab.classList.toggle("short", q.lab.tier === "short"); q.p.lab.style.transform = `translate(${q.lab.x.toFixed(1)}px, ${q.lab.y.toFixed(1)}px)`; }
    }
    Z.last = P.map((q) => ({ n: q.p.s.n, x: q.x, y: q.y, tx: q.tx, ty: q.ty, on: q.on, box: q.lab ? q.lab.b : null, cost: q.lab ? q.lab.cost : 0 }));
    Z.paint(V, P);
  },
  paint(V, P) {
    const cx = Z.cv.getContext && Z.cv.getContext("2d"); if (!cx) return;
    const k = V.dpr || 1; cx.setTransform(k, 0, 0, k, 0, 0); cx.clearRect(0, 0, V.w, V.h);
    const css = getComputedStyle(root), col = (n, f) => (css.getPropertyValue(n) || "").trim() || f;
    const fill = col("--brass-hi", "#e6c36a"), edge = col("--oak-0", "#1d130c");
    const arrow = (x, y, ang) => { cx.save(); cx.translate(x, y); cx.rotate(ang); cx.beginPath(); cx.moveTo(8, 0); cx.lineTo(-6, -6.5); cx.lineTo(-3, 0); cx.lineTo(-6, 6.5); cx.closePath(); cx.lineJoin = "round"; cx.lineWidth = 3; cx.strokeStyle = edge; cx.stroke(); cx.fillStyle = fill; cx.fill(); cx.restore(); };
    for (const L of Z.lines()) {
      const pts = L.pts.map((p) => V.toScreen(p[0], p[1]));
      if (L.dash) { cx.save(); cx.setLineDash([6, 6]); cx.lineWidth = 4; cx.strokeStyle = edge; cx.beginPath(); pts.forEach((p, i) => (i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1]))); cx.stroke(); cx.lineWidth = 2; cx.strokeStyle = fill; cx.stroke(); cx.restore(); }
      let next = 44;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d < 1) continue;
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        while (next < d) { const x = a[0] + Math.cos(ang) * next, y = a[1] + Math.sin(ang) * next; if (x > 0 && y > 0 && x < V.w && y < V.h && !P.some((q) => q.on && Math.hypot(q.x - x, q.y - y) < PIN + 10)) arrow(x, y, ang); next += 120; }
        next -= d;
      }
    }
    for (const q of P) if (q.on && q.lab) {
      const b = q.lab.b, nx = clampN(q.x, b[0], b[2]), ny = clampN(q.y, b[1], b[3]);
      if (Math.hypot(nx - q.x, ny - q.y) > PIN + 10) { const a = Math.atan2(ny - q.y, nx - q.x); cx.save(); cx.lineCap = "round"; cx.beginPath(); cx.moveTo(q.x + Math.cos(a) * PIN, q.y + Math.sin(a) * PIN); cx.lineTo(nx, ny); cx.lineWidth = 3.5; cx.strokeStyle = edge; cx.stroke(); cx.lineWidth = 1.5; cx.strokeStyle = fill; cx.stroke(); cx.restore(); }
    }
    for (const q of P) if (q.on && Math.hypot(q.x - q.tx, q.y - q.ty) > 8) { cx.save(); cx.lineWidth = 3; cx.strokeStyle = edge; cx.beginPath(); cx.moveTo(q.tx, q.ty); cx.lineTo(q.x, q.y); cx.stroke(); cx.lineWidth = 1.5; cx.strokeStyle = fill; cx.stroke(); cx.beginPath(); cx.arc(q.tx, q.ty, 3, 0, 6.3); cx.fillStyle = fill; cx.fill(); cx.restore(); }
  },
  startTour() {
    const A = G.A, st = G.stops, end = Z.target(); if (!A || st.length < 2 || !end) return;
    try { localStorage.setItem(TOURKEY, "1"); } catch (e) {}
    const legs = st.map((s) => ({ cx: s.a[0], cy: s.a[1], z: 2 })); legs.push({ cx: end.cx, cy: end.cy, z: end.z });
    const dwell = 420, move = clampN((7000 - dwell * st.length) / (legs.length - 1), 700, 1300), ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const T = { id: 0, t0: 0, dead: false }; Z.tour = T; G.moved = false;
    const go = (to) => A.goto({ au: to.cx, av: to.cy, zoom: to.z }, { animate: false });
    go(legs[0]); Z.place();
    const slot = move + dwell, total = dwell + (legs.length - 1) * slot;
    const step = (now) => {
      if (T.dead || Z.tour !== T || !G.shown || G.A !== A) return;
      if (!T.t0) T.t0 = now;
      const e = now - T.t0;
      if (e >= total) { go(legs[legs.length - 1]); Z.tour = null; Z.framed = end; Z.place(); return; }
      const u = Math.max(0, e - dwell), i = Math.min(legs.length - 2, Math.floor(u / slot)), t = u - i * slot, a = legs[i], b = legs[i + 1];
      if (t <= 0 || e < dwell) go(a);
      else if (t < move) { const f = ease(t / move), dz = Math.hypot(b.cx - a.cx, b.cy - a.cy), arc = clampN(Math.log2(1 + dz / 5000), 0, 1.4) * Math.sin(Math.PI * f); go({ cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f, z: a.z + (b.z - a.z) * f - arc }); }
      else go(b);
      T.id = requestAnimationFrame(step);
    };
    T.id = requestAnimationFrame(step);
  },
  stop() { const T = Z.tour; if (T) { T.dead = true; try { cancelAnimationFrame(T.id); } catch (e) {} Z.tour = null; } },
};

function setView(v) {
  ls.set(VIEW, v);
  if (v === "team") { destroyAtlas(); }
  G.failed = false; sync();
  if (v === "team") focus($("#main")); else focus(G.title);
}
function pill() {
  const need = eligible() && view() === "team" && !G.failed && open() === null && !!K.D.party;
  let p = $("#ga-back");
  if (!need) { if (p) p.hidden = true; return; }
  if (!p) { p = h("button", { type: "button", class: "ga-back", id: "ga-back", onclick: () => setView("atlas") }, "Back to my map"); D.body.appendChild(p); }
  p.hidden = false;
}
function seal() {
  const b = $("#board"); if (!b || !("inert" in b)) return;
  if (open() === null) b.inert = true;
  if (G.mo || typeof MutationObserver !== "function") return;
  G.mo = new MutationObserver(() => { if (G.shown && open() === null && !b.inert) b.inert = true; });
  G.mo.observe(b, { attributes: true, attributeFilter: ["inert"] });
}
function sync() {
  clearTimeout(G.t);
  if (G.booted) root.classList.remove("ga-pre");
  root.classList.toggle("ga-one", journey() === "guided" && !MEM.me());
  const on = wants(), o = open(), busy = o !== null && o !== "tonight", first = on && !G.shown;
  if (on) {
    if (first) { G.used = false; build(); G.shown = true; G.layer.hidden = false; root.classList.add("ga-on"); ensure(); }
    head(); keyRow(); mirror();
    G.layer.inert = busy;
    if (o === "tonight") K.requestClose({ glided: true });
    if (!busy && !G.A && !G.loading) ensure();
    if (G.A) { if (busy) { Z.stop(); if (o === "roads") destroyAtlas(); else G.A.pause(); } else G.A.resume(); }
    seal();
    if (!busy && (first || G.busy)) {
      const lost = () => G.shown && !G.busy && !G.used && (!D.activeElement || D.activeElement === D.body || !G.layer.contains(D.activeElement));
      sched(() => { if (lost()) focus(G.title); }); setTimeout(() => { if (lost()) focus(G.title); }, 900);
    }
  } else if (G.shown) {
    G.shown = false; if (G.layer) G.layer.hidden = true; root.classList.remove("ga-on");
    Z.stop(); if (G.A) G.A.pause();
    const b = $("#board"); if (b && open() === null && b.inert) b.inert = false;
  }
  G.busy = busy;
  pill();
}
const later = () => { clearTimeout(G.t); G.t = setTimeout(sync, 0); };

K.on("booted", () => { G.booted = true; facts().then(() => { later(); }); sync(); setTimeout(() => root.classList.remove("ga-pre"), 3000); });
for (const ev of ["scene", "closed", "tonight", "signups", "forget"]) K.on(ev, (...a) => { if (ev === "forget") { try { localStorage.removeItem(VIEW); } catch (e) {} destroyAtlas(); } later(); });
if (typeof MutationObserver === "function") {
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ["data-journey"] });
  const watch = () => { const p = $("#panel-tonight"); if (!p || G.pw) return !!G.pw; G.pw = new MutationObserver(() => { if (G.shown && !G.rq) { G.rq = 1; sched(() => { G.rq = 0; mirror(); }); } }); G.pw.observe(p, { childList: true, subtree: true, characterData: true }); return true; };
  if (!watch()) K.on("rendered", watch);
}
for (const ev of ["pointerdown", "keydown"]) D.addEventListener(ev, () => { G.used = true; }, { capture: true, passive: true });
addEventListener("storage", (e) => { if (e.key === VIEW || e.key === "board-me") later(); });
{ const me = ls.get("board-me"), j = ls.get("board-journey"), g = !j || j === "guided";
  if (g && me && me !== "just-looking" && ls.get(VIEW) !== "team") root.classList.add("ga-pre");
  if (g && !me) root.classList.add("ga-one"); }
window.__guidedAtlas = Object.freeze({ stops: () => ({ stops: G.stops.map((x) => ({ n: x.n, kind: x.kind, id: x.id, name: x.name, a: x.a })), last: Z.last || [], hi: G.hi, touring: !!Z.tour, framed: Z.framed, labels: G.labels || 0, moved: G.moved }), world: () => Z.world(), route: () => { G.moved = false; Z.frame(false); }, status: () => ({ on: G.shown, view: view(), eligible: eligible(), loaded: !!G.A, failed: G.failed, more: G.more, plan: G.plan ? G.plan.meet : null, data: !!G.data }), api: () => G.A, setView, steps, mirror });
})();
