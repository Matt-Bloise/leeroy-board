/* Vector fidelity kit (2026-10-31). One module, loaded lazily by js/board.js (import("../img/vector/vector.js")) the moment a ring, a wheel or a
   map pin has been drawn; each export dresses the plain svg the page already built and never replaces it, so every id, class, data- attribute,
   label and event the page and the harness rely on stays where it was. If this file fails to load the plain drawing stands as before.
   Light comes from the top left everywhere (the room's key light). Colours are the board's own tokens (var(--brass), --oak-*, --c-<class>,
   --wax) mixed with color-mix(), so a palette change reaches every graphic. Nothing here animates: a still image is the reduced-motion and Play
   state by construction. Widths and radii are in the host svg's own units and were chosen for a device pixel of 1/3 css px (hairlines 0.4 to 0.5).
   Numbers are listed in notes/vector-fidelity/NOTES.md. */
const NS = "http://www.w3.org/2000/svg", PHI = 1.6180339887, TAU = Math.PI * 2;
const f = (n) => +n.toFixed(2);
const mk = (tag, a, ...kids) => { const n = document.createElementNS(NS, tag); for (const k in a || {}) n.setAttribute(k, a[k]); for (const c of kids) if (c) n.append(c); return n; };
const cm = (a, p, b) => `color-mix(in srgb, ${a} ${p}%, ${b})`;
const B = { hi: "var(--brass-hi)", mid: "var(--brass)", lo: "var(--brass-dim)", dk: "var(--oak-0)", cream: "var(--cream)", blk: "var(--black)" };
const stop = (o, c, op) => mk("stop", { offset: o, style: `stop-color:${c}` + (op == null ? "" : `;stop-opacity:${op}`) });
const lin = (id, a, stops, o) => mk("linearGradient", { id, ...(o || {}), x1: a[0], y1: a[1], x2: a[2], y2: a[3] }, ...stops.map((s) => stop(...s)));
const rad = (id, a, stops) => mk("radialGradient", { id, ...a }, ...stops.map((s) => stop(...s)));
const CLASSES = ["druid", "priest", "paladin", "mage", "warlock"];
/* The paintings (assets/board/ai/tavern, baked by tools/art/vfbake.py into img/vector/*.webp). paint(name, fn) runs fn only once the file has loaded, so a
   missing or broken image leaves the procedural drawing below it untouched: every painted surface keeps its stand-in nodes and hides them (display none)
   only inside fn. */
const ART = {};
const art = (n) => ART[n] || (ART[n] = new Promise((ok) => { try { const i = new Image(); i.onload = () => ok(true); i.onerror = () => ok(false); i.src = `img/vector/${n}.webp`; } catch (e) { ok(false); } }));
const paint = (n, fn) => art(n).then((ok) => { if (ok) try { fn(`img/vector/${n}.webp`); } catch (e) { /* the stand-in stays */ } });
const hide = (list) => list.forEach((n) => n && n.setAttribute("display", "none"));

/* the shared kit: bounding-box gradients, the soft shadows and the class gems, in one hidden svg; the stylesheet that lifts the host svgs' old CSS disc */
export function kit() {
  if (typeof document === "undefined" || document.getElementById("vf-defs")) return;
  const st = document.createElement("style"); st.id = "vf-style";
  st.textContent = ".ring-wrap svg.vf,.wheel svg.vf{background:none;box-shadow:none;border-radius:0;overflow:visible}.vf *{pointer-events:none}.vf .ring-seg,.vf .ring-tick,.vf .dial,.vf .dial *,.vf .wheel-node,.vf .wheel-node *,.vf .wheel-edge,.vf .wheel-tip{pointer-events:auto}.vf .vf-ring-num{paint-order:stroke;stroke:var(--oak-0);stroke-width:1.1px;stroke-linejoin:round}";
  document.head.append(st);
  const d = mk("defs");
  d.append(
    mk("filter", { id: "vf-soft", x: "-30%", y: "-30%", width: "160%", height: "160%" }, mk("feGaussianBlur", { stdDeviation: 2.4 })),
    mk("filter", { id: "vf-soft-s", x: "-40%", y: "-40%", width: "180%", height: "180%" }, mk("feGaussianBlur", { stdDeviation: 1.1 })),
    mk("filter", { id: "vf-soft-l", x: "-20%", y: "-20%", width: "140%", height: "140%" }, mk("feGaussianBlur", { stdDeviation: 7 })),
    mk("filter", { id: "vf-drop", x: "-40%", y: "-40%", width: "180%", height: "180%" }, mk("feDropShadow", { dx: 0, dy: 1.3, stdDeviation: 1.1, "flood-color": "#000", "flood-opacity": 0.6 })),
    /* brass: light at the top left, a darker body, a bright return edge at the bottom right (a turned metal edge catches the opposite light) */
    lin("vf-brass", [0, 0, 1, 1], [[0, B.hi], [0.28, B.mid], [0.62, B.lo], [0.86, cm(B.lo, 70, B.dk)], [1, cm(B.mid, 55, B.lo)]]),
    lin("vf-brass-r", [1, 1, 0, 0], [[0, B.hi], [0.3, B.mid], [0.7, B.lo], [1, cm(B.lo, 60, B.dk)]]),
    lin("vf-edge-hi", [0, 0, 1, 1], [[0, B.cream, 0.85], [0.5, B.cream, 0], [1, B.cream, 0]]),
    lin("vf-edge-lo", [0, 0, 1, 1], [[0, B.blk, 0], [0.5, B.blk, 0], [1, B.blk, 0.6]]),
    rad("vf-rivet", { cx: 0.5, cy: 0.5, r: 0.5, fx: 0.34, fy: 0.3 }, [[0, B.cream], [0.3, B.hi], [0.7, B.lo], [1, B.dk]]),
    rad("vf-wax-gem", { cx: 0.5, cy: 0.5, r: 0.5, fx: 0.34, fy: 0.3 }, [[0, cm("var(--wax-hi)", 60, B.cream)], [0.35, "var(--wax-hi)"], [0.75, "var(--wax)"], [1, "var(--wax-lo)"]]),
    rad("vf-metal-gem", { cx: 0.5, cy: 0.5, r: 0.5, fx: 0.36, fy: 0.3 }, [[0, B.cream], [0.25, B.hi], [0.62, B.mid], [1, B.lo]]));
  for (const k of CLASSES) {
    const c = `var(--c-${k})`;
    d.append(
      lin(`vf-en-${k}`, [0, 0, 1, 1], [[0, cm(c, 62, B.cream)], [0.4, c], [1, cm(c, 52, B.dk)]]),
      rad(`vf-gem-${k}`, { cx: 0.5, cy: 0.5, r: 0.5, fx: 0.34, fy: 0.3 }, [[0, B.cream], [0.28, cm(c, 80, B.cream)], [0.6, c], [1, cm(c, 45, B.dk)]]));
  }
  const h = mk("svg", { id: "vf-defs", width: 0, height: 0, "aria-hidden": "true", focusable: "false", style: "position:absolute;width:0;height:0;overflow:hidden" }, d);
  document.body.append(h);
}

/* a conic brass band as wedges: the colour of each wedge follows the light (cos) plus a second, narrower glint, so the metal shows a sheen
   along the form instead of one diagonal fade. Wedges overlap by 0.35 degrees so no seam shows at 3x */
function band(r0, r1, n, o) {
  const g = mk("g"), a0 = (o && o.light) || -2.356; /* the key light sits at the top left: -135 degrees */
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n * TAU - Math.PI / 2, u = 0.5 + 0.5 * Math.cos(t - a0), v = 0.5 + 0.5 * Math.cos(2 * (t - a0 - 1.9)), k = Math.min(1, Math.max(0, 0.7 * u + 0.3 * v * v));
    const col = k < 0.34 ? cm(B.lo, 45 + Math.round(k * 160), B.dk) : k < 0.68 ? cm(B.mid, Math.round((k - 0.34) * 294), B.lo) : cm(B.hi, Math.round((k - 0.68) * 312), B.mid);
    const s0 = i / n * TAU - Math.PI / 2 - 0.0061, s1 = (i + 1) / n * TAU - Math.PI / 2 + 0.0061, p = (r, a) => `${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`;
    g.append(mk("path", { d: `M${p(r0, s0)}L${p(r1, s0)}A${r1} ${r1} 0 0 1 ${p(r1, s1)}L${p(r0, s1)}A${r0} ${r0} 0 0 0 ${p(r0, s0)}Z`, style: `fill:${col}` }));
  }
  return g;
}
const dashK = (c, k) => { c.setAttribute("stroke-dasharray", c.getAttribute("stroke-dasharray").split(" ").map((x) => f(+x * k)).join(" ")); c.setAttribute("stroke-dashoffset", f(+c.getAttribute("stroke-dashoffset") * k)); };

/* THE BONUSES RING. Face radius F = 120 of the viewBox's 130; the segment track sits at F / phi = 74.2 (r = 74 is passed by the page), 14.2 wide
   (F / 2 phi^3); the what-if dial rides the brass lip at r + 13 = 87 (the painted wood ends at 0.727 F = 87.2). */
export function ring(svg) {
  kit(); if (svg.classList.contains("vf")) return; svg.classList.add("vf");
  const segs = [...svg.querySelectorAll(".ring-seg")], g = svg.querySelector("g[mask]"); if (!segs.length || !g) return;
  const r = +segs[0].getAttribute("r"), W = 14.2, F = 120, S = 2 * F / 0.9694;
  const L = (id, a, stops) => lin(id, a, stops, { gradientUnits: "userSpaceOnUse" });
  const defs = mk("defs", {},
    L("vf-ring-gloss", [-r, -r, r, r], [[0, B.cream, 0.5], [0.42, B.cream, 0], [0.58, B.blk, 0], [1, B.blk, 0.5]]),
    L("vf-ring-hi", [-r, -r, r, r], [[0, B.cream, 0.85], [0.5, B.cream, 0.05], [1, B.cream, 0]]),
    L("vf-ring-spec", [-r, -r, r * 0.2, r * 0.2], [[0, B.cream, 0.7], [0.55, B.cream, 0], [1, B.cream, 0]]),
    L("vf-ring-arc", [-90, -90, 90, 90], [[0, "var(--wax-hi)"], [0.5, "var(--wax)"], [1, "var(--wax-lo)"]]),
    rad("vf-ring-scrim", { cx: 0, cy: 0, r: 72, gradientUnits: "userSpaceOnUse" }, [[0, B.blk, 0.42], [0.8, B.blk, 0.3], [1, B.blk, 0]]),
    lin("vf-plaque", [0, 0, 0, 1], [[0, "var(--oak-3)"], [1, "var(--oak-0)"]]));
  const under = [
    defs,
    mk("circle", { r: F - 1, cy: 4, style: `fill:${B.blk};opacity:.6`, filter: "url(#vf-soft)" }),
    mk("image", { href: "img/dial-face.webp", x: f(-S / 2), y: f(-S / 2), width: f(S), height: f(S), "aria-hidden": "true" }),
    mk("circle", { r: f(r + 0.5), fill: "none", stroke: B.blk, "stroke-width": f(W + 3.2), opacity: 0.5 }), /* the carved track the gems sit in */
    mk("circle", { r: f(r - W / 2 - 1.4), fill: "none", stroke: "url(#vf-edge-hi)", "stroke-width": 0.5, opacity: 0.5 }),
    mk("circle", { r: 72, fill: "url(#vf-ring-scrim)" })];
  under.forEach((n) => svg.insertBefore(n, g));
  /* gems: a shadow, then the page's own segments (resized), then gloss, rim light, a specular streak and the dark lower edge, all on the same dashes */
  const sh = mk("g", { filter: "url(#vf-soft-s)", transform: "translate(0.6 1.8)", opacity: 0.6 });
  const top = mk("g", { "aria-hidden": "true" });
  const clone = (c, rr, w, stroke, op) => { const n = c.cloneNode(false); for (const k of ["class", "role", "aria-label", "data-cat", "data-tip"]) n.removeAttribute(k); n.setAttribute("stroke", stroke); n.setAttribute("stroke-width", w); if (op != null) n.setAttribute("opacity", op); n.setAttribute("pointer-events", "none"); if (rr !== r) dashK(n, rr / r); n.setAttribute("r", f(rr)); return n; };
  for (const c of segs) {
    c.setAttribute("stroke-width", W); c.setAttribute("role", "img"); /* the hover layer labels it: a label needs a role (axe aria-prohibited-attr) */
    sh.append(clone(c, r, W, B.blk));
    top.append(clone(c, r, W, "url(#vf-ring-gloss)"), clone(c, r + W / 2 - 0.45, 0.9, "url(#vf-ring-hi)"), clone(c, r - W / 2 + 0.5, 1, B.blk, 0.5), clone(c, r - 2.6, 1.7, "url(#vf-ring-spec)"));
  }
  g.insertBefore(sh, g.firstChild);
  /* the painted gem texture (gem-tex.webp, six cabochon centres 160 px in a 3 x 2 sheet): one cell stretched over the ring's box as each arc's stroke, laid
     over the page's flat segment colour (kept beneath, so the legend colours stay true), under the gloss */
  const tex = mk("g", { "aria-hidden": "true" }); g.append(tex, top);
  paint("gem-tex", (u) => {
    const bx = 2 * (r + W), pd = mk("defs");
    segs.forEach((c, i) => {
      const cell = i % 6, id = "vf-gt-" + i;
      pd.append(mk("pattern", { id, patternUnits: "userSpaceOnUse", x: f(-bx / 2), y: f(-bx / 2), width: f(bx), height: f(bx) }, mk("image", { href: u, x: f(-(cell % 3) * bx), y: f(-Math.floor(cell / 3) * bx), width: f(3 * bx), height: f(2 * bx), preserveAspectRatio: "none" })));
      tex.append(clone(c, r, W, `url(#${id})`, 0.78));
    });
    svg.insertBefore(pd, g);
  });
  /* milestones: an engraved pin under each tick and an inlaid plaque behind each number */
  for (const t of svg.querySelectorAll(".ring-tick")) {
    const dk = t.cloneNode(false); dk.removeAttribute("class"); dk.setAttribute("stroke", B.blk); dk.setAttribute("stroke-width", 3.4); dk.setAttribute("opacity", 0.55); dk.setAttribute("transform", "translate(0.5 0.9)"); dk.setAttribute("stroke-linecap", "round");
    svg.insertBefore(dk, t);
  }
  for (const t of svg.querySelectorAll(".ring-tlabel")) {
    const x = +t.getAttribute("x"), y = +t.getAttribute("y") - 4, w = 25, h = 17;
    const stand = [
      mk("rect", { x: f(x - w / 2 - 1), y: f(y - h / 2 - 1), width: w + 2, height: h + 2, rx: 6, fill: "url(#vf-brass-r)" }),
      mk("rect", { x: f(x - w / 2), y: f(y - h / 2), width: w, height: h, rx: 5, fill: "url(#vf-plaque)" }),
      mk("rect", { x: f(x - w / 2 + 0.4), y: f(y - h / 2 + 0.4), width: w - 0.8, height: h - 0.8, rx: 4.6, fill: "none", stroke: "url(#vf-edge-hi)", "stroke-width": 0.5 })];
    const pim = mk("image", { x: f(x - w / 2 - 1), y: f(y - h / 2 - 1), width: w + 2, height: h + 2, preserveAspectRatio: "none" });
    const pl = mk("g", { "aria-hidden": "true" },
      mk("rect", { x: f(x - w / 2), y: f(y - h / 2 + 1.4), width: w, height: h, rx: 5, style: `fill:${B.blk}`, opacity: 0.55, filter: "url(#vf-soft-s)" }), ...stand, pim);
    svg.insertBefore(pl, t);
    paint("plaque-oak", (u) => { pim.setAttribute("href", u); hide(stand); }); /* plaque-oak.webp: the painted oak plaque, 27 x 19 */
  }
  const num = svg.querySelector(".ring-num"); if (num) num.classList.add("vf-ring-num");
  /* the what-if dial (js/v13d.js): a wax gem knob in a brass bezel, and the arc as a wax-red inlay */
  const arc = svg.querySelector(".dial-arc"); if (arc) { arc.style.stroke = "url(#vf-ring-arc)"; arc.style.strokeWidth = "4.2px"; arc.setAttribute("filter", "url(#vf-drop)"); }
  const kn = svg.querySelector(".dial-knob");
  if (kn) {
    const [a, b] = kn.querySelectorAll("circle");
    if (a) { a.style.fill = "url(#vf-metal-gem)"; a.style.stroke = "var(--oak-0)"; a.style.strokeWidth = "1.2px"; }
    if (b) { b.style.fill = "url(#vf-wax-gem)"; b.style.stroke = "var(--oak-0)"; b.style.strokeWidth = "0.5px"; b.setAttribute("r", 4.6); }
    kn.insertBefore(mk("circle", { r: 8.1, fill: "none", stroke: "url(#vf-edge-hi)", "stroke-width": 0.7 }), kn.firstChild.nextSibling);
    kn.setAttribute("filter", "url(#vf-drop)");
    /* knob-wax.webp (the painted wax gem in a brass collar) was tried and not adopted: at 18 units its dark collar sinks into the brass lip and the dial
       loses its handle, so the stand-in gem above stays (notes/vector-fidelity/NOTES.md) */
  }
}

/* THE BUFF WHEEL. Field radius 178 (the node ring, 112, times phi is 181), a brass bezel 178 to 190 with 60 engraved notches, five of them
   long and on the five nodes, a wood field with a lit centre, a carved track at the node ring, wire grooves under every thread, a gem on
   each arrowhead and a brass bezel round each class crest. The svg's viewBox and every id stay; the old CSS disc is lifted by .vf. */
export function wheel(svg) {
  kit(); if (svg.classList.contains("vf")) return; svg.classList.add("vf");
  const first = svg.firstChild, R = 112, FLD = 178, OUT = 190, put = (n) => svg.insertBefore(n, first), st = [], putS = (n) => { st.push(n); put(n); };
  const defs = mk("defs", {},
    rad("vf-w-field", { cx: 0, cy: 0, r: FLD, gradientUnits: "userSpaceOnUse", fx: -50, fy: -62 }, [[0, cm("var(--oak-3)", 86, B.hi)], [0.55, "var(--oak-2)"], [1, "var(--oak-1)"]]),
    rad("vf-w-vig", { cx: 0, cy: 0, r: FLD, gradientUnits: "userSpaceOnUse" }, [[0.78, B.blk, 0], [1, B.blk, 0.62]]),
    lin("vf-w-lip", [-FLD, -FLD, FLD, FLD], [[0, B.cream, 0.7], [0.45, B.cream, 0], [0.55, B.blk, 0], [1, B.blk, 0.7]], { gradientUnits: "userSpaceOnUse" }));
  put(defs);
  put(mk("circle", { r: OUT - 1, cy: 6, style: `fill:${B.blk};opacity:.62`, filter: "url(#vf-soft-l)" }));
  putS(band(FLD - 0.4, OUT, 90));
  const notches = mk("g", { stroke: B.blk, "stroke-linecap": "butt" }), lights = mk("g", { stroke: B.cream, opacity: 0.32 });
  for (let i = 0; i < 60; i++) {
    const a = -Math.PI / 2 + i / 60 * TAU, c = Math.cos(a), s = Math.sin(a), major = i % 12 === 0, r0 = FLD + 2.2, r1 = FLD + (major ? 8.6 : 5.6);
    const l = (dx, dy) => ({ x1: f(c * r0 + dx), y1: f(s * r0 + dy), x2: f(c * r1 + dx), y2: f(s * r1 + dy), "stroke-width": major ? 1.5 : 0.9 });
    notches.append(mk("line", { ...l(0, 0), opacity: 0.62 })); lights.append(mk("line", l(0.45, 0.7)));
  }
  putS(lights); putS(notches);
  putS(mk("circle", { r: OUT - 0.35, fill: "none", stroke: "url(#vf-edge-hi)", "stroke-width": 0.7 }));
  putS(mk("circle", { r: FLD + 0.2, fill: "none", stroke: B.blk, "stroke-width": 1.2, opacity: 0.8 }));
  putS(mk("circle", { r: FLD, fill: "url(#vf-w-field)" }));
  putS(mk("circle", { r: FLD, fill: "url(#vf-w-vig)" }));
  putS(mk("circle", { r: FLD - 1.6, fill: "none", stroke: "url(#vf-w-lip)", "stroke-width": 1.8 }));
  /* the painted face (wheel-face.webp, 1024 px): the wood meets its brass band at 0.844 of the radius, so the wood is drawn to 172 units and the band
     runs 172 to 204 (the labels under the two lower crests sit at 150 to 184) */
  const WOOD = 172, PO = WOOD / 0.844, face = mk("image", { x: f(-PO), y: f(-PO), width: f(2 * PO), height: f(2 * PO), "aria-hidden": "true" }); put(face);
  paint("wheel-face", (u) => { face.setAttribute("href", u); hide(st); });
  put(mk("circle", { r: R, fill: "none", stroke: B.blk, "stroke-width": 1.6, opacity: 0.5 }));
  put(mk("circle", { r: R + 1.6, fill: "none", stroke: B.cream, "stroke-width": 0.5, opacity: 0.18 }));
  put(mk("circle", { r: f(R / PHI), fill: "none", stroke: B.blk, "stroke-width": 1, opacity: 0.4 }));
  put(mk("circle", { r: f(R / PHI + 1.1), fill: "none", stroke: B.cream, "stroke-width": 0.5, opacity: 0.14 }));
  /* grain: a stretched turbulence, kept faint, in the field's own browns */
  defs.append(mk("filter", { id: "vf-w-grain", x: -FLD, y: -FLD, width: 2 * FLD, height: 2 * FLD, filterUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" },
    mk("feTurbulence", { type: "fractalNoise", baseFrequency: "0.011 0.34", numOctaves: 3, seed: 7 }),
    mk("feColorMatrix", { values: "0 0 0 0 0.16  0 0 0 0 0.09  0 0 0 0 0.04  0 0 0 1.5 -0.55", result: "g" }),
    mk("feComposite", { in: "g", in2: "SourceAlpha", operator: "in" })));
  const grain = mk("circle", { r: FLD - 1, fill: "#000", filter: "url(#vf-w-grain)", opacity: 0.4, "aria-hidden": "true" }); put(grain); st.push(grain);
  /* the web ghosted into the wood: a pentagram groove between the five nodes and a brass rivet at each gap of the node ring */
  const nodes = [...svg.querySelectorAll(".wheel-node")].map((n) => [+n.getAttribute("data-x") || 0, +n.getAttribute("data-y") || 0]);
  if (nodes.length === 5) {
    const star = [0, 2, 4, 1, 3, 0].map((i) => nodes[i].map(f).join(",")).join(" ");
    put(mk("polyline", { points: star, fill: "none", stroke: B.blk, "stroke-width": 1.5, opacity: 0.34, "stroke-linejoin": "round", "aria-hidden": "true" }));
    put(mk("polyline", { points: star, fill: "none", stroke: B.cream, "stroke-width": 0.5, opacity: 0.12, transform: "translate(0.5 0.8)", "stroke-linejoin": "round", "aria-hidden": "true" }));
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i + 0.5) * TAU / 5, x = f(Math.cos(a) * R), y = f(Math.sin(a) * R);
      put(mk("circle", { cx: x, cy: f(y + 1.1), r: 3.4, style: `fill:${B.blk};opacity:.5`, filter: "url(#vf-soft-s)" }));
      put(mk("circle", { cx: x, cy: y, r: 2.7, fill: "url(#vf-rivet)", stroke: B.dk, "stroke-width": 0.4 }));
    }
  }
  const gr = mk("g", { "aria-hidden": "true", fill: "none", "stroke-linecap": "round", stroke: B.blk, opacity: 0.4 });
  for (const e of svg.querySelectorAll(".wheel-edge")) gr.append(mk("path", { d: e.getAttribute("d"), "stroke-width": 4.6 }));
  put(gr);
  put(mk("circle", { r: 7.4, cy: 1.4, style: `fill:${B.blk};opacity:.55`, filter: "url(#vf-soft-s)" }));
  put(mk("circle", { r: 6, fill: "url(#vf-brass)", stroke: B.dk, "stroke-width": 0.6 }));
  put(mk("circle", { r: 2.2, fill: "url(#vf-rivet)" }));
  for (const t of svg.querySelectorAll(".wheel-tip")) { const k = t.getAttribute("data-from"); if (CLASSES.includes(k)) { t.style.fill = `url(#vf-gem-${k})`; t.style.stroke = "var(--oak-0)"; t.style.strokeWidth = "0.6px"; t.setAttribute("r", 3.6); } }
  for (const n of svg.querySelectorAll(".wheel-node")) {
    const x = +n.getAttribute("data-x") || 0, y = +n.getAttribute("data-y") || 0, c = n.firstChild;
    /* the page's CSS styles every circle inside a node (fill, class-colour stroke), so each bezel circle carries its own style */
    const ci = (cy, r, style, a) => mk("circle", { cx: x, cy, r, style: `stroke-width:0;${style}`, ...(a || {}) });
    const stand = [ci(y, 31.4, `fill:url(#vf-brass);stroke:${B.dk};stroke-width:.7px`), ci(y, 30.2, "fill:none;stroke:url(#vf-edge-hi);stroke-width:.6px"), ci(y, 28.6, `fill:none;stroke:${B.dk};stroke-width:.8px;opacity:.7`)];
    const k = n.getAttribute("data-k"), bz = mk("image", { x: f(x - 33.88), y: f(y - 33.88), width: 67.76, height: 67.76 });
    /* the painted bezel (medallion-bezel.webp): outer radius 33.5, hole 25 under the crest; a class-colour line inside its lip is the per-class tint */
    const tint = ci(y, 25.5, `fill:none;stroke:var(--c-${k});stroke-width:1.1px;opacity:.85`);
    const b = mk("g", { "aria-hidden": "true" },
      ci(f(y + 2.2), 31, `fill:${B.blk};stroke:none;opacity:.6`, { filter: "url(#vf-soft-s)" }),
      ...stand,
      ci(y, 27.6, `fill:${B.blk};stroke:none;opacity:.55`), bz, tint);
    tint.setAttribute("display", "none");
    paint("medallion-bezel", (u) => { bz.setAttribute("href", u); hide(stand); tint.removeAttribute("display"); });
    n.insertBefore(b, c);
  }
}

/* THE ROADS PINS (Three roads and the wall tile's small map). Same outline, same 30 x 41 box and the same tip, so no label, plate or hit area
   moves: a brass teardrop, a class-colour enamel field, a brass lip round the crest, and a rivet near the tip. The crest is cut to 22 px so the
   brass and the enamel show round it. */
export function pins(root) {
  kit(); if (!root) return;
  for (const n of root.querySelectorAll(".map-zep-g,.map-town")) n.setAttribute("role", "img");
  const D = "M0 0c-7-8-15-16-15-26a15 15 0 1 1 30 0c0 10-8 18-15 26z", sc = (k) => `translate(0 -26) scale(${k}) translate(0 26)`;
  for (const g of root.querySelectorAll(".map-pin,.mm-pin")) {
    if (g.getAttribute("data-vf")) continue;
    const body = g.querySelector(".pin-body"), im = g.querySelector("image"); if (!body || !im) continue;
    const k = ((im.getAttribute("href") || "").match(/crests\/(\w+)\.png/) || [])[1]; if (!CLASSES.includes(k)) continue;
    g.setAttribute("data-vf", "1");
    body.style.fill = "transparent"; body.style.stroke = "none";
    im.setAttribute("x", -11); im.setAttribute("y", -37); im.setAttribute("width", 22); im.setAttribute("height", 22);
    const L = mk("g", { "aria-hidden": "true" },
      mk("path", { d: D, transform: "translate(1.1 1.7)", style: `fill:${B.blk};opacity:.55`, filter: "url(#vf-soft-s)" }),
      mk("path", { d: D, fill: "url(#vf-brass)", stroke: B.dk, "stroke-width": 0.8, "stroke-linejoin": "round" }),
      mk("path", { d: D, transform: sc(0.965), fill: "none", stroke: "url(#vf-edge-hi)", "stroke-width": 0.6 }),
      mk("path", { d: D, transform: sc(0.88), fill: `url(#vf-en-${k})`, stroke: B.dk, "stroke-width": 0.6, "stroke-opacity": 0.8 }),
      mk("path", { d: D, transform: sc(0.82), fill: "none", stroke: "url(#vf-edge-hi)", "stroke-width": 0.7 }),
      mk("path", { d: D, transform: sc(0.82), fill: "none", stroke: "url(#vf-edge-lo)", "stroke-width": 0.7 }),
      mk("path", { d: "M-10.6-33.5a13 13 0 0 1 9.6-6.6c-3.4 2.6-6.2 6.4-7.6 11.6z", fill: "url(#vf-edge-hi)", opacity: 0.8 }),
      mk("circle", { cx: 0, cy: -26, r: 12.1, style: `fill:${B.blk};opacity:.6` }),
      mk("circle", { cx: 0, cy: -26, r: 12.4, fill: "none", stroke: "url(#vf-brass-r)", "stroke-width": 1.2 }),
      mk("circle", { cx: 0, cy: -5.4, r: 1.5, fill: "url(#vf-rivet)", stroke: B.dk, "stroke-width": 0.35 }));
    g.insertBefore(L, body);
    /* the painted pin (pin-<class>.webp, 200 px tall, the class enamel baked in): 46 units tall from the tip (the stand-in's 41), the enamel hole's
       centre at 0.695 of that and its radius 0.185, so the crest (17) sits in the enamel with a hair of it showing round the edge */
    const W = PIN_W[k] * 46, pi = mk("image", { x: f(-W * 0.495), y: -46, width: f(W), height: 46, "aria-hidden": "true" });
    g.insertBefore(pi, body);
    paint("pin-" + k, (u) => { pi.setAttribute("href", u); hide([L]); im.setAttribute("x", -8.5); im.setAttribute("y", -40.5); im.setAttribute("width", 17); im.setAttribute("height", 17); });
  }
}
const PIN_W = { mage: 0.615, priest: 0.63, paladin: 0.615, warlock: 0.615, druid: 0.61 };

/* THE WALL TILES' SMALL RING AND WHEEL (shown in Curious and Everything). Same language at 100 units: the ring on the dial face (F = 48, track at
   F / phi = 29.7, 5.8 wide, the number on the wood), the wheel in a brass bezel with a bezel round each crest. */
export function mini(svg) {
  kit(); if (svg.classList.contains("vf")) return; svg.classList.add("vf");
  const segs = [...svg.querySelectorAll("circle[stroke^='var(--seg']")], first = svg.firstChild;
  if (segs.length) {
    const r = +segs[0].getAttribute("r"), r2 = 29.7, F = 48, S = 2 * F / 0.9694;
    svg.insertBefore(mk("defs", {}, lin("vf-mini-gloss", [-r2, -r2, r2, r2], [[0, B.cream, 0.5], [0.42, B.cream, 0], [0.58, B.blk, 0], [1, B.blk, 0.5]], { gradientUnits: "userSpaceOnUse" })), first);
    svg.insertBefore(mk("circle", { r: F - 0.5, cy: 1.6, style: `fill:${B.blk};opacity:.55`, filter: "url(#vf-soft-s)" }), first);
    svg.insertBefore(mk("image", { href: "img/dial-face.webp", x: f(-S / 2), y: f(-S / 2), width: f(S), height: f(S), "aria-hidden": "true" }), first);
    svg.insertBefore(mk("circle", { r: 29.7, fill: "none", stroke: B.blk, "stroke-width": 8, opacity: 0.5 }), first);
    const tops = [];
    for (const c of segs) {
      const k = r2 / r; dashK(c, k); c.setAttribute("r", r2); c.setAttribute("stroke-width", 5.8);
      const n = c.cloneNode(false); n.setAttribute("stroke", "url(#vf-mini-gloss)"); n.setAttribute("stroke-width", 5.8); tops.push(n);
    }
    const num = svg.querySelector(".viz-ring-num"); if (num) { num.style.paintOrder = "stroke"; num.style.stroke = "var(--oak-0)"; num.style.strokeWidth = "1px"; num.style.fontSize = "26px"; }
    const nx = num || null; for (const n of tops) svg.insertBefore(n, nx);
    return;
  }
  const FLD = 52, OUT = 55.4;
  const st = [], ins = (n, ref) => { svg.insertBefore(n, ref); return n; };
  ins(mk("circle", { r: OUT - 0.5, cy: 2, style: `fill:${B.blk};opacity:.55`, filter: "url(#vf-soft-s)" }), first);
  st.push(ins(band(FLD - 0.2, OUT, 60), first));
  st.push(ins(mk("circle", { r: FLD, style: `fill:${cm("var(--oak-2)", 70, B.dk)}` }), first));
  st.push(ins(mk("circle", { r: FLD, fill: "none", stroke: B.blk, "stroke-width": 1.2, opacity: 0.6 }), first));
  /* the painted face at the tile's own outer radius (its wood runs to 0.844 of that) */
  const face = ins(mk("image", { x: -OUT, y: -OUT, width: 2 * OUT, height: 2 * OUT, "aria-hidden": "true" }), first);
  paint("wheel-face", (u) => { face.setAttribute("href", u); hide(st); });
  for (const im of [...svg.querySelectorAll("image:not([aria-hidden])")]) {
    const x = +im.getAttribute("x") + 10, y = +im.getAttribute("y") + 10, stand = mk("circle", { cx: x, cy: y, r: 12.4, fill: "url(#vf-brass)", stroke: B.dk, "stroke-width": 0.4 });
    ins(mk("circle", { cx: x, cy: f(y + 1), r: 12.6, style: `fill:${B.blk};opacity:.55`, filter: "url(#vf-soft-s)" }), im);
    ins(stand, im);
    ins(mk("circle", { cx: x, cy: y, r: 10.6, style: `fill:${B.blk}` }), im);
    const bz = ins(mk("image", { x: f(x - 13.55), y: f(y - 13.55), width: 27.1, height: 27.1, "aria-hidden": "true" }), im);
    paint("medallion-bezel", (u) => { bz.setAttribute("href", u); hide([stand]); });
  }
}

/* THE ANSWER-TIME SPARKLINE (Leeroy scene). The page's line, area, diamonds and wax drop keep their classes and their draw-on animation; they get
   a brass line with a soft glow and a dark groove under it, a fading brass area, metal gem diamonds and a glossy wax drop. */
export function spark(svg) {
  kit(); if (svg.classList.contains("vf")) return; svg.classList.add("vf");
  svg.insertBefore(mk("defs", {}, lin("vf-spark-area", [0, 0, 0, 1], [[0, B.mid, 0.55], [1, B.mid, 0]]), lin("vf-spark-line", [0, 0, 1, 0], [[0, B.lo], [0.6, B.mid], [1, B.hi]])), svg.firstChild);
  const area = svg.querySelector(".spark-area"), line = svg.querySelector(".spark-line");
  if (area) { area.style.fill = "url(#vf-spark-area)"; area.style.opacity = "1"; }
  if (line) {
    line.style.stroke = "url(#vf-spark-line)"; line.style.strokeWidth = "2.2px"; line.setAttribute("stroke-linejoin", "round"); line.setAttribute("stroke-linecap", "round");
    for (const [w, st, op, fl] of [[6, B.mid, 0.28, "url(#vf-soft-s)"], [3.8, B.blk, 0.5, null]]) {
      const g = line.cloneNode(false); g.removeAttribute("class"); g.removeAttribute("pathLength"); g.setAttribute("fill", "none"); g.setAttribute("stroke", st); g.setAttribute("stroke-width", w); g.setAttribute("opacity", op); g.setAttribute("stroke-linejoin", "round"); g.setAttribute("stroke-linecap", "round"); g.setAttribute("aria-hidden", "true");
      if (fl) g.setAttribute("filter", fl); svg.insertBefore(g, line);
    }
  }
  for (const d of svg.querySelectorAll(".spark-dot")) { d.style.fill = "url(#vf-metal-gem)"; d.style.stroke = "var(--oak-0)"; d.style.strokeWidth = "0.6px"; }
  const dr = svg.querySelector(".spark-drop"); if (dr) { dr.setAttribute("role", "img"); dr.style.fill = "url(#vf-wax-gem)"; dr.style.strokeWidth = "0.7px"; dr.setAttribute("filter", "url(#vf-drop)"); }
}
