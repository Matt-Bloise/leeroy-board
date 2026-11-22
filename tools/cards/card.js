// Builds one picture card from its model (infrastructure/worker/card-models.js, tools/cards/sources.mjs) inside card.html.
// window.renderCard(model) replaces the stage, waits for every font and image, lays out the map labels, and resolves with the card's size.
// Text only ever goes in through textContent. No clock, no locale, no network: render.mjs serves this page from a private origin.
(() => {
  "use strict";
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const sv = (tag, attrs, text) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const kicker = (main, rest) => {
    const k = el("div", "kicker");
    k.append(el("span", "", main));
    if (rest) { k.append(el("span", "dot")); k.append(el("span", "rest", rest)); }
    return k;
  };
  const rule = () => el("div", "rule");
  const foot = (left) => {
    const f = el("div", "foot");
    const l = el("span", "");
    l.append(el("b", "", "the living board"), document.createTextNode(left ? ` \u00b7 ${left}` : ""));
    f.append(l, el("span", "", "leeroy.party"));
    return f;
  };

  // A brass medallion with an enamel colour and one letter (the board's crest medallion, drawn here so no image is decoded).
  function medal(colour, letter) {
    const s = sv("svg", { class: "medal", viewBox: "0 0 64 64", width: 52, height: 52 });
    const defs = sv("defs");
    const g = sv("linearGradient", { id: "mb", x1: 0, y1: 0, x2: 0, y2: 1 });
    g.append(sv("stop", { offset: 0, "stop-color": "#e3c27a" }), sv("stop", { offset: 1, "stop-color": "#8a6c35" }));
    defs.append(g);
    s.append(defs);
    s.append(sv("circle", { cx: 32, cy: 32, r: 28.5, fill: "url(#mb)", stroke: "#1d140d", "stroke-width": 1 }));
    s.append(sv("circle", { cx: 32, cy: 32, r: 24.5, fill: "#1d140d" }));
    s.append(sv("circle", { cx: 32, cy: 32, r: 23, fill: colour }));
    for (const deg of [0, 90, 180, 270]) s.append(sv("path", { transform: `rotate(${deg} 32 32)`, d: "M32 .8l3.4 4.6L32 10l-3.4-4.6z", fill: "#e3c27a", stroke: "#1d140d", "stroke-width": 0.8 }));
    s.append(sv("text", { x: 32, y: 42, "text-anchor": "middle", "font-family": "Grenze Gotisch", "font-weight": 700, "font-size": 30, fill: "#f6ecd2", stroke: "#1d140d", "stroke-width": 2.4, "paint-order": "stroke", "stroke-linejoin": "round" }, letter));
    return s;
  }

  function pageCard(m) {
    const card = el("div", "card page");
    const inner = el("div", "inner");
    inner.append(kicker("library", m.category), el("h1", "title", m.title), rule());
    if (m.blurb) inner.append(el("p", "blurb clamp3", m.blurb));
    if (m.facts.length) {
      const dl = el("dl", "facts");
      for (const f of m.facts) dl.append(el("dt", "", f.label), el("dd", "clamp2", f.value));
      inner.append(dl);
    } else if (!m.blurb) inner.append(el("p", "none", "Open the page on the board for every verified fact."));
    card.append(inner, medal(m.medal.colour, m.medal.letter), foot(m.footNote));
    return card;
  }

  function tooltipCard(m) {
    const card = el("div", "card tooltip");
    const inner = el("div", "inner");
    const top = el("div", "top");
    const name = el("span", "name", m.name);
    name.style.setProperty("--qc", m.colour);
    top.append(name);
    if (m.rank) top.append(el("span", "rank", m.rank));
    inner.append(top);
    for (const r of m.rows) {
      const row = el("div", "row");
      row.append(el("span", "", r[0]), el("span", "", r[1]));
      inner.append(row);
    }
    for (const l of m.lines) inner.append(el("div", `line ${l.tone}`, l.text));
    if (m.desc) inner.append(el("div", "desc", m.desc));
    const src = el("div", "src");
    src.append(el("span", "", m.source), el("span", "", "leeroy.party"));
    inner.append(src);
    card.append(inner);
    return card;
  }

  function signupCard(m) {
    const card = el("div", "card signup");
    const inner = el("div", "inner");
    inner.append(kicker("sign-ups", "tonight"), el("h1", "title", "Who is in tonight?"), rule());
    const group = (label, items) => {
      const g = el("div", "group");
      const c = el("div", "chips");
      for (const it of items) {
        const chip = el("span", "chip");
        if (it.c) { const i = el("i", ""); i.style.setProperty("--c", it.c); chip.append(i); }
        chip.append(document.createTextNode(it.t));
        c.append(chip);
      }
      g.append(el("div", "k", label), c);
      return g;
    };
    inner.append(group("answer", m.answers.map((t, i) => ({ t, c: m.colours[i] }))));
    if (m.meet.length) inner.append(group("meet at", m.meet.map((t) => ({ t }))));
    if (m.when.length) inner.append(group("arrive", m.when.map((t) => ({ t }))));
    card.append(inner, medal("#275520", "S"), foot("tap a button below"));
    return card;
  }

  // The map scene is computed in Node (sources.mjs: projected rings, label anchors, the pin). Here it only becomes SVG, and the labels
  // that would overlap one already placed are dropped, in the scene's priority order, using the real text widths.
  function mapCard(m) {
    const card = el("div", "card map wide");
    const inner = el("div", "inner");
    inner.append(kicker("atlas", m.kicker), el("h1", "title", m.title));
    card.append(inner, el("div", "sub", m.sub));
    const s = m.scene;
    const svg = sv("svg", { class: "chart", viewBox: `0 0 ${s.w} ${s.h}`, width: s.w, height: s.h });
    for (let x = s.grid; x < s.w; x += s.grid) svg.append(sv("path", { class: "grid", d: `M${x} 0V${s.h}` }));
    for (let y = s.grid; y < s.h; y += s.grid) svg.append(sv("path", { class: "grid", d: `M0 ${y}H${s.w}` }));
    for (const d of s.land) svg.append(sv("path", { class: "land", d }));
    for (const z of s.zones) svg.append(sv("path", { class: z.on ? "zone on" : "zone", d: z.d }));
    const labels = sv("g");
    svg.append(labels);
    const dots = sv("g");
    svg.append(dots);
    if (s.pin) {
      const p = s.pin;
      svg.append(sv("path", { class: "pin", d: `M${p.x} ${p.y}l-9 -16a10 10 0 1 1 18 0z` }));
      svg.append(sv("circle", { cx: p.x, cy: p.y - 21, r: 3.5, fill: "#fbf4e4" }));
    }
    card.append(svg, foot(m.footNote));
    card._labels = { svg, labels, dots, scene: s };
    return card;
  }

  function placeLabels(card) {
    const { svg, labels, dots, scene } = card._labels;
    const boxes = [];
    const hit = (b) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    const inside = (b) => b.x >= 2 && b.y >= 2 && b.x + b.w <= scene.w - 2 && b.y + b.h <= scene.h - 2;
    if (scene.pin) {
      const p = scene.pin;
      boxes.push({ x: p.x - 11, y: p.y - 33, w: 22, h: 34 });
      const t = sv("text", { class: "pinlabel", x: 0, y: 0 }, scene.pin.label);
      svg.append(t);
      const w = Math.ceil(t.getComputedTextLength());
      const box = { w: w + 20, h: 28 };
      const right = { x: p.x + 16, y: p.y - 36 };
      const left = { x: p.x - 16 - box.w, y: p.y - 36 };
      const at = inside({ ...right, ...box }) || !inside({ ...left, ...box }) ? right : left;
      const plate = sv("rect", { class: "plate", x: at.x, y: at.y, width: box.w, height: box.h, rx: 4 });
      t.setAttribute("x", at.x + 10);
      t.setAttribute("y", at.y + 19);
      svg.insertBefore(plate, t);
      boxes.push({ x: at.x, y: at.y, ...box });
    }
    // A town is a dot and a name together: when the name cannot be placed, the dot is left out too.
    for (const l of scene.labels) {
      const t = sv("text", { class: l.cls, x: l.x, y: l.y, "text-anchor": l.anchor || "middle" }, l.text);
      labels.append(t);
      const bb = t.getBBox();
      const b = { x: bb.x - 3, y: bb.y - 2, w: bb.width + 6, h: bb.height + 4 };
      const dot = l.dot ? { x: l.dot.x - 6, y: l.dot.y - 6, w: 12, h: 12 } : null;
      if (hit(b) || !inside(b) || (dot && (hit(dot) || !inside(dot)))) { t.remove(); continue; }
      boxes.push(b);
      if (dot) { boxes.push(dot); dots.append(sv("circle", { class: "hub", cx: l.dot.x, cy: l.dot.y, r: 4 })); }
    }
  }

  const BUILD = { page: pageCard, tooltip: tooltipCard, signup: signupCard, map: mapCard };

  // Every face in card.css is loaded before the first card, so a missing or broken font file rejects here instead of quietly
  // painting a fallback. A face that is still "unloaded" later would mean a font rule this file does not know: that fails too.
  const fontsReady = Promise.all([...document.fonts].map((f) => f.load())).then(() => document.fonts.ready);

  window.renderCard = async (model) => {
    await fontsReady;
    const stage = document.getElementById("stage");
    stage.replaceChildren();
    const build = BUILD[model && model.kind];
    if (!build) throw new Error(`unknown card kind ${model && model.kind}`);
    const card = build(model);
    card.id = "card";
    stage.append(card);
    card.getBoundingClientRect(); // style and layout now, so any font the card needs is requested before fonts.ready is read
    await document.fonts.ready;
    const faces = [...document.fonts];
    const bad = faces.filter((f) => f.status !== "loaded").map((f) => `${f.family} ${f.weight} ${f.style}: ${f.status}`);
    if (bad.length) throw new Error(`font not loaded: ${bad.join("; ")}`);
    await Promise.all([...document.images].map((img) => img.decode()));
    if (card._labels) placeLabels(card);
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = card.getBoundingClientRect();
    return { width: r.width, height: r.height, text: card.textContent, faces: faces.map((f) => `${f.family}|${f.weight}|${f.style}|${f.status}`).sort() };
  };
})();
