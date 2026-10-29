/* Seals (notes/VISION-SEALS.md): each scene's emblem is a physical coin, large and lit, that can be pressed and spun. It rides on
   the page's own events (window.__boardKit.on("scene" | "closed")), reads the scene medallion img/medal/<key>.webp at its native
   640 px, and adds no code to js/board.js. Scene mechanics register in MECH below. Sound and haptics go through the sensory
   events when present and are skipped when not. Reduced motion swaps every move for a short brightening. */
(() => {
  const K = window.__boardKit; if (!K) return;
  const $ = (q, r) => (r || document).querySelector(q);
  const h = (t, a, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a || {})) { if (v == null || v === false) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); } for (const c of kids.flat()) if (c != null && c !== false) e.append(c); return e; };
  const mq = (q) => { try { return matchMedia(q); } catch (e) { return { matches: false, addEventListener() {} }; } };
  const reduceMQ = mq("(prefers-reduced-motion: reduce)"), coarse = mq("(hover: none)");
  const snd = (n) => { try { if (window.BoardSound) window.BoardSound.play(n); } catch (e) {} };
  const hap = (n) => { try { if (window.BoardHaptics) window.BoardHaptics.fire(n); } catch (e) {} };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const BACK = { tonight: "Your next step, the next date and who is coming.", timeline: "Every date that matters, from the Blizzard calendar.", five: "Who plays what, straight from the group's own words.", roads: "Where each character starts and how the roads meet.", racials: "What each race brings, from the game client.", legacy: "The bonuses Forever carries over.", buffs: "Every buff by level, who gives it, who gets it.", ledger: "Every decision, in order, with the date.", signups: "Who is in for which night.", librarian: "Leeroy: ask in chat or ask here.", library: "Every fact the group has researched, searchable.", decide: "What is still open for each of us, by Blizzard's dates, and what each option changes." /* V16: the mechanic lives in js/decide.js */ };
  /* MECH[key] = { hint, press(api) }: hint finishes "Press the seal to ..."; press runs after the spin starts, api = { seal, key, say, spin } */
  const MECH = {};
  const S = { ang: 0, el: null, btn: null, disc: null, key: null, light: { x: 0.3, y: 0.2 }, raf: 0, spun: 0 };

  /* the coin itself: seven brass edges between a medallion front and a lettered back (shared with coin() below, V15) */
  const makeDisc = () => h("span", { class: "seal-disc" },
    ...Array.from({ length: 7 }, (_, i) => h("span", { class: "seal-edge", style: `--i:${i}` })),
    h("span", { class: "seal-face seal-front" }, h("img", { class: "seal-img", alt: "", width: 640, height: 640, decoding: "async" }), h("span", { class: "seal-spec" }), h("span", { class: "seal-sweep" })),
    h("span", { class: "seal-face seal-back" }, h("span", { class: "seal-back-in" }, h("b", { class: "seal-b" }), h("i", { class: "seal-i" }))));
  function build() {
    const disc = makeDisc();
    const btn = h("button", { class: "seal-btn", type: "button" }, h("span", { class: "seal-cast" }), disc);
    const el = h("div", { class: "seal", id: "seal", hidden: true }, btn, h("span", { class: "seal-say", role: "status" }));
    S.el = el; S.btn = btn; S.disc = disc;
    btn.addEventListener("pointerdown", (e) => { if (e.button > 0) return; el.classList.add("down"); snd("latch"); hap("tap"); });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, () => el.classList.remove("down"));
    btn.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") el.classList.add("down"); });
    btn.addEventListener("keyup", () => el.classList.remove("down"));
    btn.addEventListener("blur", () => el.classList.remove("down"));
    btn.addEventListener("click", press);
    btn.addEventListener("pointermove", tilt); btn.addEventListener("pointerleave", () => { el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); });
    const head = $("#scene .sheet-head"); (head || $("#scene")).appendChild(el);
    return el;
  }
  function tilt(e) {
    if (reduceMQ.matches || e.pointerType === "touch" || !S.el) return;
    const r = S.btn.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width - 0.5, ny = (e.clientY - r.top) / r.height - 0.5;
    S.el.style.setProperty("--rx", `${(-ny * 16).toFixed(1)}deg`); S.el.style.setProperty("--ry", `${(nx * 16).toFixed(1)}deg`);
  }
  /* one light for the page: the pointer (or a slow drift on touch) moves where the seal is lit from */
  function lightTo(x, y) {
    S.light.x = x; S.light.y = y;
    if (S.raf || !S.el) return;
    S.raf = requestAnimationFrame(() => {
      S.raf = 0; if (!S.el || S.el.hidden) return;
      const r = S.btn.getBoundingClientRect(), nx = clamp((S.light.x - r.left) / r.width, -1, 2), ny = clamp((S.light.y - r.top) / r.height, -1, 2);
      const st = S.el.style; st.setProperty("--lx", `${(nx * 100).toFixed(0)}%`); st.setProperty("--ly", `${(ny * 100).toFixed(0)}%`);
      st.setProperty("--sx", `${((0.5 - nx) * 26).toFixed(1)}px`); st.setProperty("--sy", `${(18 + (0.5 - ny) * 14).toFixed(1)}px`);
    });
  }
  addEventListener("pointermove", (e) => { if (S.el && !S.el.hidden && e.pointerType !== "touch") lightTo(e.clientX, e.clientY); }, { passive: true });

  /* land: "back" or "front" ends the spin on that face and keeps it; mid: runs once the face is edge-on (swap the back's words there) */
  function spin(o) {
    o = o || {}; if (!S.disc) return Promise.resolve();
    S.spun++; const from = S.ang || 0, same = o.land ? (o.land === "back") === (from === 180) : true, dir = S.spun % 2 ? 1 : -1, to = from + dir * (same ? 720 : 540), keep = o.land ? (o.land === "back" ? 180 : 0) : from;
    if (o.mid) setTimeout(o.mid, reduceMQ.matches ? 0 : 380);
    const fin = () => { S.ang = keep; S.disc.style.transform = `rotateY(${keep}deg)`; if (S.el) S.el.classList.remove("spinning"); };
    if (reduceMQ.matches || !S.disc.animate) { fin(); const a = S.el.animate && S.el.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.5)" }, { filter: "brightness(1)" }], { duration: 260 }); return a ? a.finished.catch(() => {}) : Promise.resolve(); }
    const mid = from + (to - from) * 0.55;
    const a = S.disc.animate([{ transform: `rotateY(${from}deg) translateZ(0)` }, { transform: `rotateY(${mid}deg) translateZ(18px)`, offset: 0.55 }, { transform: `rotateY(${to}deg) translateZ(0)` }], { duration: 900, easing: "cubic-bezier(.2,.75,.25,1)" });
    S.el.classList.add("spinning"); S.disc.style.transform = `rotateY(${keep}deg)`; S.ang = keep;
    return a.finished.then(fin, fin);
  }
  function say(text) {
    const n = $(".seal-say", S.el); if (!n) return;
    clearTimeout(S.sayT); n.textContent = text; n.classList.add("on"); S.sayT = setTimeout(() => { n.classList.remove("on"); }, 5200);
  }
  function press() {
    const key = S.key, m = MECH[key]; snd("stamp"); hap("tap");
    const run = m && m.spin === false ? Promise.resolve() : spin();
    if (m && m.press) { try { m.press({ seal: S.el, key, say, spin, run }); } catch (e) { console.error("seal", key, e); } }
    else say(BACK[key] || "");
  }

  function show(key) {
    if (!BACK[key]) return;
    const el = S.el || build(); S.key = key; el.dataset.k = key;
    const title = K.TITLES ? K.TITLES[key] : key, m = MECH[key];
    const img = $(".seal-img", el), src = `img/medal/${key}.webp`; if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    $(".seal-b", el).textContent = title; $(".seal-i", el).textContent = BACK[key];
    S.btn.setAttribute("aria-label", `${title} seal. Press it ${m && m.hint ? m.hint : "to give it a spin and read what it holds"}.`);
    S.ang = 0; S.disc.style.transform = ""; el.removeAttribute("data-kind");
    el.hidden = false; document.documentElement.classList.add("has-seal");
    $(".seal-say", el).classList.remove("on");
    lightTo(innerWidth * 0.5, innerHeight * 0.1);
  }
  function hide() { if (S.el) S.el.hidden = true; document.documentElement.classList.remove("has-seal"); }
  K.on("scene", show); K.on("closed", hide);
  if (K.SC && K.SC.open) show(K.SC.open);

  /* ---------- Next steps: three wax seals, pressed into the page, choose the journey ---------- */
  const JR = { guided: ["Guided", "roads", "Two hours a week: walk me through it"], curious: ["Curious", "library", "I'll click around"], everything: ["Everything", "legacy", "Show me every number"] };
  const jnow = () => (window.__v13d ? window.__v13d.journey() : document.documentElement.dataset.journey || "curious");
  function waxRow() {
    const panel = $("#tn-me"); if (!panel || !window.__v13d) return;
    let row = $("#tn-seals", panel);
    if (!row) {
      row = h("div", { class: "tn-seals", id: "tn-seals", role: "group", "aria-label": "How do you want to explore?" }, h("p", { class: "tn-seals-q", text: "How do you want to explore? Press a seal into the page." }),
        h("div", { class: "wx-row" }, ...Object.entries(JR).map(([j, [name, ico, line]]) => h("button", { class: "wx", type: "button", "data-journey": j, "aria-pressed": "false", onclick: () => stamp(j) },
          h("span", { class: "wx-wax" }, h("span", { class: "wx-ring" }), h("img", { class: "wx-ico", src: `img/icons/${ico}.png`, alt: "", width: 192, height: 192, decoding: "async" }), h("span", { class: "wx-lit" })),
          h("b", { class: "wx-name", text: name }), h("span", { class: "wx-line", text: line })))));
      panel.append(row);
    }
    const j = jnow(); row.querySelectorAll(".wx").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.journey === j)));
  }
  function stamp(j) {
    const b = $(`#tn-seals .wx[data-journey="${j}"]`); if (!b) return;
    if (j !== jnow() || !window.__v13d.status().picked) { snd("stamp"); hap("success"); window.__v13d.setJourney(j, "force"); }
    else snd("latch");
    waxRow();
    if (!reduceMQ.matches && b.animate) { const w = $(".wx-wax", b); w.animate([{ transform: "scale(1)" }, { transform: "scale(0.82)", offset: 0.28 }, { transform: "scale(1.05)", offset: 0.62 }, { transform: "scale(1)" }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" }); $(".wx-ring", b).animate([{ opacity: 0.9, transform: "scale(0.8)" }, { opacity: 0, transform: "scale(1.5)" }], { duration: 620, easing: "ease-out" }); }
    const s = $("#seal"); if (s && window.BoardSeals) say(`Exploring: ${JR[j][0]}. Change it any time at the top or here.`);
  }
  K.on("tonight", waxRow);
  MECH.tonight = { hint: "to choose how you explore", press: ({ say: sy }) => { sy(`Exploring: ${JR[jnow()][0]}. Press a wax seal below to change it.`); const b = $("#tn-seals .wx[aria-pressed=\"true\"]") || $("#tn-seals .wx"); if (b) b.focus({ preventScroll: false }); } };
  waxRow();

  /* ---------- The five: class coins that turn the card over, and a formation to arrange ---------- */
  const LANES = [["tank", "Tank"], ["healer", "Healer"], ["damage", "Damage"]];
  const F = { lane: {}, built: false };
  const members = () => (K.D && K.D.party ? K.D.party.members : []);
  const cardOf = (m) => $(`#cards .card[data-slug="${K.MEM.slug(m.name)}"]`);
  function fiveSum() {
    const ms = members(), n = Object.fromEntries(LANES.map(([r]) => [r, 0])), diff = [];
    ms.forEach((m) => { const r = F.lane[m.name]; n[r]++; if (r !== m.role) diff.push(`${m.name} on ${r}, the cards say ${m.role}`); });
    const out = $("#five-sum"); if (!out) return;
    out.textContent = `Your arrangement: ${LANES.map(([r, l]) => `${n[r]} ${r}`).join(", ")}. ` + (diff.length ? `Different from the cards: ${diff.join("; ")}.` : "Same as the cards.");
    $("#five-reset").hidden = !diff.length;
  }
  function placeCoin(btn, role, silent) {
    const m = members().find((x) => x.name === btn.dataset.name); if (!m) return;
    F.lane[m.name] = role; $(`#five-form .fl[data-role="${role}"] .fl-tray`).append(btn); fiveSum();
    if (!silent) { snd("stamp"); hap("tick"); }
  }
  function buildFive() {
    const panel = $("#panel-five"), lede = panel && $(".lede", panel); const ms = members(); if (!lede || !ms.length) return;
    if ($("#five-form")) return;
    const form = h("div", { class: "five-form", id: "five-form", title: "Press a coin to turn its card over. Drag it between lanes to try another formation." },
      h("div", { class: "fl-row", role: "group", "aria-label": "Party formation" }, ...LANES.map(([r, l]) => h("div", { class: "fl", "data-role": r }, h("span", { class: "fl-name", text: l }), h("div", { class: "fl-tray" })))),
      h("p", { class: "fv-sum", id: "five-sum", role: "status" }), h("button", { class: "lib-tool", id: "five-reset", type: "button", hidden: true, text: "Back to the cards' roles", onclick: () => { ms.forEach((m) => placeCoin($(`#five-form .fc[data-name="${m.name}"]`), m.role, true)); snd("latch"); } }),
      h("p", { class: "sr-only", text: "Press a coin to turn its card over. Drag a coin between lanes to try a different formation; arrow keys move the focused coin." }));
    lede.parentNode.insertBefore(form, lede.nextSibling);
    ms.forEach((m) => {
      const b = h("button", { class: "fc", type: "button", "data-name": m.name, "data-k": m.class_key, "aria-pressed": "false", style: `--cc: ${K.classVar(m.class_key)}`, "aria-label": `${m.name}, ${m.class}. Turn the card over. Arrow keys move between lanes.` },
        h("span", { class: "fc-in" }, h("span", { class: "fc-face fc-f" }, h("img", { src: `img/crests/${m.class_key}.png`, alt: "", width: 320, height: 320, decoding: "async" }), h("span", { class: "fc-nm", text: m.name })), h("span", { class: "fc-face fc-b" }, h("b", { text: m.class }), h("i", { text: "spells" }))));
      coinInput(b, m); F.lane[m.name] = m.role; $(`.fl[data-role="${m.role}"] .fl-tray`, form).append(b);
    });
    fiveSum();
    const cards = $("#cards"); if (cards && window.MutationObserver) new MutationObserver(syncFive).observe(cards, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
  }
  function syncFive() { $$(".fc").forEach((b) => { const m = members().find((x) => x.name === b.dataset.name), c = m && cardOf(m), on = !!(c && c.classList.contains("flipped")); b.classList.toggle("turned", on); b.setAttribute("aria-pressed", String(on)); }); }
  const $$ = (q) => [...document.querySelectorAll(q)];
  function turnCard(m) { const c = cardOf(m); if (!c) return; const f = c.classList.contains("flipped") ? $(".back .flip", c) : $(".front .flip", c); if (f) f.click(); syncFive(); }
  function coinInput(b, m) {
    let d = null;
    b.addEventListener("pointerdown", (e) => { if (e.button > 0) return; d = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId }; });
    b.addEventListener("pointermove", (e) => {
      if (!d || e.pointerId !== d.id) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 8) { d.moved = true; try { b.setPointerCapture(e.pointerId); } catch (x) {} b.classList.add("drag"); snd("pin"); }
      if (d.moved) { b.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`; const l = laneAt(e.clientX, e.clientY, b); $$(".fl").forEach((x) => x.classList.toggle("over", x === l)); }
    });
    const end = (e) => {
      if (!d || e.pointerId !== d.id) return; const was = d; d = null; $$(".fl").forEach((x) => x.classList.remove("over"));
      if (!was.moved) return; b.classList.remove("drag"); b.style.transform = ""; b.dataset.dragged = "1"; setTimeout(() => delete b.dataset.dragged, 60);
      const l = e.type === "pointerup" ? laneAt(e.clientX, e.clientY, b) : null; if (l && l.dataset.role !== F.lane[m.name]) placeCoin(b, l.dataset.role); else if (l) snd("tick");
    };
    b.addEventListener("pointerup", end); b.addEventListener("pointercancel", end);
    b.addEventListener("click", () => { if (b.dataset.dragged) return; snd("flip"); hap("tap"); turnCard(m); });
    b.addEventListener("keydown", (e) => {
      const i = LANES.findIndex(([r]) => r === F.lane[m.name]), j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : i;
      if (j !== i && j >= 0 && j < LANES.length) { e.preventDefault(); placeCoin(b, LANES[j][0]); b.focus(); }
    });
  }
  function laneAt(x, y, self) { self.style.pointerEvents = "none"; const el = document.elementFromPoint(x, y); self.style.pointerEvents = ""; return el && el.closest ? el.closest("#five-form .fl") : null; }
  K.on("scene", (k) => { if (k === "five") { buildFive(); syncFive(); } });
  MECH.five = { hint: "to turn all five cards over, or back", press: ({ say: sy }) => {
    const ms = members(), cs = ms.map(cardOf).filter(Boolean), all = cs.every((c) => c.classList.contains("flipped"));
    ms.forEach((m, i) => setTimeout(() => { const c = cardOf(m); if (c && c.classList.contains("flipped") === all) turnCard(m); }, reduceMQ.matches ? 0 : i * 110));
    sy(all ? "All five cards are back on their fronts." : "All five cards are turned to their spells.");
  } };

  /* ---------- Race skills: the coin's back shows one racial at a time; chips narrow the sequence to active, passive or a change date ---------- */
  const R = { i: -1, f: "all" }, KS = {};
  document.addEventListener("keydown", (e) => { const t = e.target, f = KS[S.key]; if (!f || !S.btn || t !== S.btn || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return; e.preventDefault(); f(e.key === "ArrowRight" ? 1 : -1); });
  const racialList = () => { const r = K.D && K.D.client ? K.D.client.racials : null; return r ? Object.entries(r).flatMap(([race, l]) => l.map((x) => [race, x])) : []; };
  const clause = (x) => (x.wiki ? x.wiki.replace(/^(active|passive),\s*/, "").split(/[;(]/)[0].trim() : "Not on the wiki page yet");
  const chDate = (x) => (x.changed_oct26 ? x.changed_on || "Oct 26" : null);
  const passF = ([, x]) => R.f === "all" || R.f === x.kind || R.f === `ch:${chDate(x)}`;
  const rowOf = (race, x) => $(`#races .race[data-race="${K.MEM.slug(race)}"] .rrow[data-key="${K.MEM.slug(x.name)}"]`);
  function faceRacial(l) {
    const [race, x] = l[R.i], el = $("#seal"), back = $(".seal-back-in", el), n = l.filter(passF), at = n.findIndex(([r, y]) => r === race && y === x);
    $(".seal-b", el).textContent = x.name; $(".seal-i", el).textContent = `${race} · ${x.kind || "racial"}`;
    let chip = $(".seal-chip", back), num = $(".seal-n", back);
    if (!chip) { chip = h("span", { class: "seal-chip" }); num = h("small", { class: "seal-n" }); back.append(chip, num); }
    chip.textContent = chDate(x) ? `changed ${chDate(x)}` : ""; chip.hidden = !chDate(x); num.textContent = at >= 0 ? `${at + 1} of ${n.length}` : "";
    el.dataset.kind = x.kind || "";
    S.btn.setAttribute("aria-label", `Race skills seal, showing ${x.name}, ${race}, ${x.kind || "racial"}${chDate(x) ? `, changed ${chDate(x)}` : ""}. Press for the next racial; arrow keys go either way.`);
    document.querySelectorAll("#races .rr-now").forEach((r) => r.classList.remove("rr-now"));
    const row = rowOf(race, x); if (row) { const d = row.closest("details"); if (d) d.open = true; row.classList.add("rr-now"); if (row.scrollIntoView && !reduceMQ.matches) row.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    return `${race}, ${x.name} (${x.kind || "racial"}${chDate(x) ? `, changed ${chDate(x)}` : ""}): ${clause(x)}.`;
  }
  function raceTo(i) {
    const l = racialList(); if (!l[i]) return; R.i = i; let msg = "";
    S.el.removeAttribute("data-kind"); snd(l[i][1].kind === "active" ? "stamp" : "latch");
    spin({ land: "back", mid: () => { msg = faceRacial(l); } }).then(() => say(msg || faceRacial(l)));
  }
  function raceStep(by) {
    const l = racialList(), cyc = l.map((e, i) => [e, i]).filter(([e]) => passF(e)); if (!cyc.length) { say("Nothing matches that chip."); return; }
    let pos = cyc.findIndex((c) => c[1] === R.i); if (pos < 0) pos = by > 0 ? -1 : 0;
    raceTo(cyc[(pos + by + cyc.length) % cyc.length][1]);
  }
  function raceChips() {
    const l = racialList(), host = $("#races"); if (!l.length || !host || !host.parentNode) return;
    const old = $("#race-chips"); if (old && old.parentNode) old.parentNode.removeChild(old);
    const dates = [...new Set(l.map(([, x]) => chDate(x)).filter(Boolean))].sort(), cnt = (f) => { const o = R.f; R.f = f; const n = l.filter(passF).length; R.f = o; return n; };
    const chips = [["all", "All"], ["active", "Active"], ["passive", "Passive"], ...dates.map((d) => [`ch:${d}`, `Changed ${d}`])];
    const bar = h("div", { class: "rc-bar", id: "race-chips", role: "group", "aria-label": "Narrow the racials the coin spins through" }, ...chips.map(([f, label]) => h("button", { class: "lib-tool rc-chip", type: "button", "data-f": f, "aria-pressed": String(R.f === f),
      onclick: () => { R.f = R.f === f ? "all" : f; syncChips(); applyRaceFilter(); snd("chip"); hap("tick"); const n = racialList().filter(passF).length; say(`${n} racial${n === 1 ? "" : "s"} in the spin${R.f === "all" ? "" : `: ${label}`}.`); } }, `${label} `, h("b", { text: String(cnt(f)) }))));
    host.parentNode.insertBefore(bar, host);
  }
  const syncChips = () => document.querySelectorAll("#race-chips .rc-chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.f === R.f)));
  function applyRaceFilter() { racialList().forEach(([race, x]) => { const row = rowOf(race, x); if (row) row.classList.toggle("rr-off", !passF([race, x])); }); }
  MECH.racials = { hint: "to spin the coin to the next racial", spin: false, press: () => raceStep(1) };
  document.addEventListener("click", (e) => { const t = e.target, row = t && t.closest && t.closest("#races .rrow"); if (!row || !S.el || S.el.hidden || S.key !== "racials") return; const k = racialList().findIndex(([race, x]) => K.MEM.slug(x.name) === row.dataset.key && row.closest(`.race[data-race="${K.MEM.slug(race)}"]`)); if (k >= 0 && k !== R.i) raceTo(k); });
  KS.racials = raceStep;
  K.on("scene", (k) => { if (k === "racials") { R.i = -1; raceChips(); applyRaceFilter(); } });
  if (K.SC && K.SC.open === "racials") { raceChips(); applyRaceFilter(); }

  /* ---------- Bonuses: the what-if dial is the coin's rim. Tapping a challenge pours its points into the ring; the seal steps through the reward track ---------- */
  const tween = (from, to, ms, step) => new Promise((done) => {
    if (reduceMQ.matches || from === to) { step(to); done(); return; }
    const t0 = performance.now(), ease = (x) => 1 - Math.pow(1 - x, 3);
    const tick = (n) => { const x = Math.min(1, (n - t0) / ms); step(from + (to - from) * ease(x)); if (x < 1) requestAnimationFrame(tick); else done(); };
    requestAnimationFrame(tick);
  });
  const LG = { picks: [], step: -1, run: 0, ctx: null };
  const lgNow = () => (K.dial ? K.dial.now : 0);
  function lgRead(v) {
    const L = K.D.client.legacy, out = $("#wi-read"); if (!out) return;
    const got = L.thresholds.filter((t) => t.n <= v), next = L.thresholds.find((t) => t.n > v), names = LG.picks.map((k) => L.categories.find((c) => c.key === k).key);
    const head = v === lgNow() && !names.length ? `Where the group is now: ${v} of ${L.total} points.` : `${v} of ${L.total} points${names.length ? ` if all the ${names.join(" and ")} challenges get done` : ""}.`;
    out.textContent = `${head} ${got.length ? `That reaches ${got.map((t) => t.reward).join(", ")}.` : "No reward on the track yet."} ${next ? `${next.n - v} more for ${next.reward}.` : "That is the whole track."}${v > L.solo_cap ? ` One character can earn ${L.solo_cap} alone, so this one needs more than one.` : ""}`;
  }
  /* one eased move of the dial to v; a newer move cancels the one in flight, so quick taps never fight */
  function lgTo(v, ms) {
    const d = K.dial; if (!d) return Promise.resolve(); const id = ++LG.run, from = d.get();
    return tween(from, v, ms || 700, (x) => { if (id === LG.run) d.set(x, false, true); }).then(() => { if (id === LG.run) d.set(v, false); });
  }
  function lgMark(svg, legend) {
    const set = new Set(LG.picks);
    svg.querySelectorAll(".ring-seg").forEach((x) => x.classList.toggle("dim", set.size > 0 && !set.has(x.dataset.cat)));
    legend.querySelectorAll("li[data-cat]").forEach((li) => { const on = set.has(li.dataset.cat), b = $(".cat-line", li); li.classList.toggle("lit", on); if (b) b.setAttribute("aria-pressed", String(on)); });
  }
  K.on("legacy", ({ svg, L, legend }) => {
    if (!K.dial) return;
    const wrap = svg.parentNode, read = h("p", { class: "wi-read", id: "wi-read", "aria-live": "polite" });
    wrap.append(read); LG.picks = []; LG.step = -1; LG.ctx = { svg, legend }; K.dialHook = lgRead; lgRead(K.dial.get());
    const toggle = (k) => {
      if (K.dial.get() !== Math.min(L.total, lgNow() + LG.picks.reduce((n, c) => n + L.categories.find((x) => x.key === c).n, 0))) LG.picks = [];
      const i = LG.picks.indexOf(k); if (i < 0) LG.picks.push(k); else LG.picks.splice(i, 1);
      lgMark(svg, legend); snd(i < 0 ? "coin" : "latch"); hap("tap");
      const goal = Math.min(L.total, lgNow() + LG.picks.reduce((n, c) => n + L.categories.find((x) => x.key === c).n, 0));
      lgTo(goal, 700).then(() => { if (L.thresholds.some((t) => t.n > K.dial.now && t.n <= goal) && i < 0) snd("stamp"); });
    };
    legend.querySelectorAll("li[data-cat]").forEach((li) => { const b = $(".cat-line", li); if (b) b.addEventListener("click", () => toggle(li.dataset.cat)); });
    svg.querySelectorAll(".ring-seg").forEach((sg) => sg.addEventListener("click", () => toggle(sg.dataset.cat)));
  });
  MECH.legacy = { hint: "to step to the next reward on the track", press: ({ say: sy }) => {
    const L = K.D && K.D.client ? K.D.client.legacy : null, wrap = $("#legacy-ring"); if (!L || !wrap || !K.dial) return;
    wrap.classList.remove("filling"); void wrap.getBoundingClientRect(); wrap.classList.add("filling");
    const stops = [...L.thresholds.map((t) => t.n), lgNow()], i = (LG.step + 1) % stops.length, n = stops[i], t = L.thresholds[i]; LG.step = i; LG.picks = [];
    if (LG.ctx) lgMark(LG.ctx.svg, LG.ctx.legend);
    lgTo(n, 900).then(() => { if (t) snd("stamp"); });
    sy(t ? `${n} points: ${t.reward}, ${t.kind === "toy" ? "a fun item with no stats" : t.kind === "pet" ? "a pet that follows you" : t.kind === "tabard" ? "a cloth crest worn over armor" : "a mount to ride"}.${t.alt ? ` One guide says ${t.alt} for the first.` : ""}` : `Back to where the group is now: ${n} of ${L.total}.`);
  } };

  /* ---------- Sign-ups: raising a mug answers through the page's own RSVP buttons (v13d suControls); the counts sit on a shelf of wax seals ---------- */
  /* a live answer lifts the mug and tips its neighbour toward it for the clink; the sound and the buzz come from the sensory layer's own click handler */
  document.addEventListener("click", (e) => {
    const t = e.target, b = t && t.closest && t.closest(".su-st"); if (!b || b.getAttribute("aria-disabled") === "true" || reduceMQ.matches) return;
    const row = b.parentNode, bs = row ? [...row.children].filter((x) => x.classList && x.classList.contains("su-st")) : [], i = bs.indexOf(b), nb = bs[i + 1] || bs[i - 1];
    b.classList.remove("lift"); void b.offsetWidth; b.classList.add("lift"); b.style.setProperty("--tip", i < bs.length - 1 ? "1" : "-1");
    if (nb) { nb.style.setProperty("--tip", i < bs.length - 1 ? "-1" : "1"); setTimeout(() => { nb.classList.remove("clinked"); void nb.offsetWidth; nb.classList.add("clinked"); setTimeout(() => nb.classList.remove("clinked"), 520); }, 190); }
    setTimeout(() => b.classList.remove("lift"), 620);
  }, true);
  const SH = { prev: {} };
  const shelfCounts = () => {
    const S = K.D && K.D.signups, rs = S && S.tallies && S.tallies.rsvp; if (!rs) return null;
    const c = K.RSVP_KEYS.map((k) => [k, K.RSVP_SAY[k], rs[k] ? rs[k].count : 0, rs[k] ? rs[k].names.map(K.cleanName) : []]), said = c.reduce((n, x) => n + x[2], 0), ms = K.D.party.members;
    return [...c, ["none", "No answer", Math.max(0, ms.length - said), null]];
  };
  function shelf() {
    const body = $("#dsu-body"), items = shelfCounts(); if (!body || !items) return;
    const B = window.BoardBrain, mine = B && B.mine ? B.mine() : null, old = $("#su-shelf"); if (old && old.parentNode) old.parentNode.removeChild(old); if (!body.parentNode) return;
    const who = h("p", { class: "sh-who", id: "sh-who", role: "status", "aria-live": "polite" });
    const list = (x) => (x[3] ? `${x[1]}: ${x[3].length ? x[3].join(", ") : "nobody yet"}.` : `${x[2]} of ${K.D.party.members.length} have not answered yet.`);
    const seals = items.map((x, i) => h("button", { class: `sh-seal${x[0] === "none" ? " none" : ""}${mine && mine.rsvp === x[0] ? " mine" : ""}${SH.prev[x[0]] != null && SH.prev[x[0]] !== x[2] ? " bump" : ""}`, type: "button", "data-k": x[0], "aria-pressed": "false", style: `--i:${i}`, "aria-label": `${x[1]}: ${x[2]}${mine && mine.rsvp === x[0] ? ", your answer" : ""}. Press to see who.`,
      onclick: (e) => { const me = e.currentTarget; shelfSeals().forEach((s) => s.setAttribute("aria-pressed", String(s === me && s.getAttribute("aria-pressed") !== "true"))); who.textContent = me.getAttribute("aria-pressed") === "true" ? list(x) : ""; snd("stamp"); hap("tap"); } },
      h("span", { class: "sh-wax" }, x[0] === "none" ? null : h("img", { class: "sh-pint", src: `img/pints/${x[0]}.png`, alt: "", width: 36, height: 36, decoding: "async" }), h("span", { class: "sh-lit" })),
      h("b", { class: "sh-n", text: String(x[2]) }), h("span", { class: "sh-l", text: x[1] })));
    items.forEach((x) => { SH.prev[x[0]] = x[2]; });
    const el = h("div", { class: "su-shelf", id: "su-shelf", role: "group", "aria-label": `Launch night so far: ${items.map((x) => `${x[1]} ${x[2]}`).join(", ")}` }, h("div", { class: "sh-row" }, seals), h("span", { class: "sh-plank", "aria-hidden": "true" }), who);
    body.parentNode.insertBefore(el, body);
    setTimeout(() => el.querySelectorAll(".bump").forEach((x) => x.classList.remove("bump")), 900);
  }
  const shelfSeals = () => [...document.querySelectorAll("#su-shelf .sh-seal")];
  K.on("signups", shelf);
  MECH.signups = { hint: "to stamp the shelf of counts again, then raise a mug below", press: ({ say: sy }) => {
    const items = shelfCounts(); if (!items) return;
    shelfSeals().forEach((x) => { x.classList.remove("bump"); void x.offsetWidth; x.classList.add("bump"); setTimeout(() => x.classList.remove("bump"), 900); });
    sy(`Launch night: ${items.filter((x) => x[0] !== "none").map((x) => `${x[1]} ${x[2]}`).join(", ")}${items[items.length - 1][2] ? `, ${items[items.length - 1][2]} yet to answer` : ""}.`);
    const b = $("#dsu-act .su-st[aria-pressed=\"true\"]") || $("#dsu-act .su-st"); if (b) b.focus({ preventScroll: true });
  } };

  /* ---------- the scenes that replay their own motion, and the ones whose coin shows facts on its back ---------- */
  const replayOn = (sel, cls) => { const el = $(sel); if (!el) return; el.classList.remove(cls); void el.getBoundingClientRect(); el.classList.add(cls); };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  MECH.roads = { hint: "to draw the roads again", press: ({ say: sy }) => { replayOn("#map", "drawing"); sy("The roads draw again from where each character starts."); } };
  MECH.buffs = { hint: "to light the wheel again", press: ({ say: sy }) => { replayOn("#wheel", "lighting"); sy("The wheel lights each link between the five."); } };
  MECH.ledger = { hint: "to stamp the ledger again", press: ({ say: sy }) => {
    replayOn("#ledger-slip", "stamping");
    const p = K.D && K.D.party; if (!p) return;
    const settled = p.settled.length + (p.settled_extra || []).length + (p.play ? 1 : 0), open = p.open.filter((o) => !p.polls.some((q) => q.title === o.title)).length;
    sy(`${plural(settled, "thing")} settled, ${open} still open${p.polls.length ? `, ${plural(p.polls.length, "poll")} taking votes` : ""}.`);
  } };
  /* Dates: the coin's back counts down to each upcoming date in turn */
  const DT = { i: -1 };
  const upcoming = () => { const t = K.D && K.D.timeline, now = Date.now() / 1000; return t ? t.events.filter((e) => K.eventTs(e) > now).sort((a, b) => K.eventTs(a) - K.eventTs(b)) : []; };
  MECH.timeline = { hint: "to spin the coin to the next date", spin: false, press: () => {
    const l = upcoming(); if (!l.length) { say("No dates ahead on the calendar right now."); return; }
    DT.i = (DT.i + 1) % l.length; const e = l[DT.i], ep = K.eventTs(e), el = $("#seal");
    spin({ land: "back", mid: () => { $(".seal-b", el).textContent = e.label.split(":")[0]; $(".seal-i", el).textContent = K.relWhen(ep); } }).then(() => say(`${e.label}: ${K.fmtWhen(ep, { rel: true })}.${e.detail ? ` ${e.detail[0].toUpperCase()}${e.detail.slice(1)}.` : ""}`));
  } };
  K.on("scene", (k) => { if (k === "timeline") DT.i = -1; });
  /* Library: a surprise search, one of the page's own example queries; Leeroy: where to ask */
  MECH.library = { hint: "to try one of the example searches", press: ({ say: sy }) => {
    const ex = [...document.querySelectorAll("#lib-examples button")]; if (!ex.length) { const q = $("#lib-q"); if (q) q.focus(); return; }
    const b = ex[Math.floor(Math.random() * ex.length)]; sy(`Trying: ${b.textContent.trim()}`); b.click();
  } };
  /* Leeroy: the seal reads his last answers one at a time and moves a marker along the chart; arrow keys go either way */
  const LR = { i: -1 };
  const lrVals = () => (K.D && K.D.stats && K.D.stats.last7 ? K.D.stats.last7 : []);
  function lrStep(by) {
    const l = lrVals(), svg = $("#lib-box .spark svg"); if (!l.length || !svg) return;
    LR.i = ((LR.i < 0 ? (by > 0 ? -1 : 0) : LR.i) + by + l.length) % l.length; const x = l[LR.i], el = $("#seal"), W = 260, H = 70, pad = 10, vs = l.map((v) => v.seconds), max = Math.max(...vs, 1);
    const cx = pad + (LR.i * (W - 2 * pad)) / Math.max(1, l.length - 1), cy = H - pad - (x.seconds / max) * (H - 2 * pad - 10);
    let mk = $(".spark-cur", svg); if (!mk) { mk = document.createElementNS("http://www.w3.org/2000/svg", "circle"); mk.setAttribute("class", "spark-cur"); mk.setAttribute("r", "6.5"); svg.append(mk); }
    mk.style.transform = `translate(${cx}px, ${cy}px)`; svg.querySelectorAll(".spark-text").forEach((tx, k) => tx.classList.toggle("on", k === LR.i));
    const when = K.fmtWhen(Date.parse(x.closed_utc) / 1000), msg = `Answer ${LR.i + 1} of ${l.length}: ${x.seconds} s, ${x.kind === "/ask" ? "an /ask question" : "a mention"}, ${when}.`;
    S.btn.setAttribute("aria-label", `Leeroy seal, showing ${msg} Press for the next answer; arrow keys go either way.`);
    snd("latch"); spin({ land: "back", mid: () => { $(".seal-b", el).textContent = `${x.seconds} s`; $(".seal-i", el).textContent = `answer ${LR.i + 1} of ${l.length} · ${x.kind === "/ask" ? "/ask" : "mention"}`; } }).then(() => say(msg));
  }
  KS.librarian = lrStep;
  K.on("scene", (k) => { if (k === "librarian") LR.i = -1; });
  MECH.librarian = { hint: "to read his last answers one by one, then ask him in #wow-forever", spin: false, press: () => lrStep(1) };
  /* ---------- V15 (2026-10-30): a free-standing coin of the same make for the wall's Launch night hero (board/V15-LAUNCH-SPEC.md 3.1) ----------
     o = { key (medallion, default timeline), title, back (the two lines on the back), label (aria), press({ turn, face, say }) }.
     Not the scene seal: its own element and angle, no light tracking, no has-seal class; the page positions it (.seal-free).
     A press without a mechanic turns it over; reduced motion brightens instead of spinning. say() goes to o.say when given. */
  function coin(o) {
    o = o || {};
    const key = o.key || "timeline", d = makeDisc(), el = h("div", { class: "seal seal-free", "data-k": key });
    const btn = h("button", { class: "seal-btn", type: "button", "aria-label": o.label || `${o.title || "Dates"} seal. Press it to turn it over.` }, h("span", { class: "seal-cast" }), d);
    el.append(btn);
    $(".seal-img", el).setAttribute("src", `img/medal/${key}.webp`);
    const C = { ang: 0, n: 0 };
    const face = (title, line) => { $(".seal-b", el).textContent = title || ""; $(".seal-i", el).textContent = line || ""; };
    face(o.title, o.back);
    const say = (t) => { if (typeof o.say === "function") { try { o.say(t); } catch (e) {} } };
    /* land: "back" or "front" keeps that face; nothing flips to the other one; mid runs once the coin is edge-on */
    const turn = (land, mid) => {
      C.n++; const from = C.ang, keep = land === "back" ? 180 : land === "front" ? 0 : from === 180 ? 0 : 180, dir = C.n % 2 ? 1 : -1, to = from + dir * (keep === from ? 720 : 540);
      if (mid) setTimeout(mid, reduceMQ.matches ? 0 : 380);
      const fin = () => { C.ang = keep; d.style.transform = `rotateY(${keep}deg)`; el.classList.remove("spinning"); };
      if (reduceMQ.matches || !d.animate) { fin(); const a = el.animate && el.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.5)" }, { filter: "brightness(1)" }], { duration: 260 }); return a ? a.finished.catch(() => {}) : Promise.resolve(); }
      const m = from + (to - from) * 0.55;
      const a = d.animate([{ transform: `rotateY(${from}deg) translateZ(0)` }, { transform: `rotateY(${m}deg) translateZ(18px)`, offset: 0.55 }, { transform: `rotateY(${to}deg) translateZ(0)` }], { duration: 900, easing: "cubic-bezier(.2,.75,.25,1)" });
      el.classList.add("spinning"); d.style.transform = `rotateY(${keep}deg)`; C.ang = keep;
      return a.finished.then(fin, fin);
    };
    btn.addEventListener("pointerdown", (e) => { if (e.button > 0) return; el.classList.add("down"); snd("latch"); hap("tap"); });
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) btn.addEventListener(ev, () => el.classList.remove("down"));
    btn.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") el.classList.add("down"); });
    btn.addEventListener("keyup", () => el.classList.remove("down"));
    btn.addEventListener("click", () => { snd("stamp"); hap("tap"); if (typeof o.press === "function") { try { o.press({ el, btn, turn, face, say }); } catch (e) { console.error("coin", key, e); } } else turn(); });
    return { el, btn, turn, face, say, side: () => (C.ang === 180 ? "back" : "front") };
  }
  window.BoardSeals = Object.freeze({ MECH, press, spin, say, snd, hap, h, $, mq, reduceMQ, clamp, coin, status: () => ({ key: S.key, hidden: S.el ? S.el.hidden : true, spun: S.spun }) });
})();
