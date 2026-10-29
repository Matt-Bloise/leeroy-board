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
  const BACK = { tonight: "Your next step, the next date and who is coming.", timeline: "Every date that matters, from the Blizzard calendar.", five: "Who plays what, straight from the group's own words.", roads: "Where each character starts and how the roads meet.", racials: "What each race brings, from the game client.", legacy: "The bonuses Forever carries over.", buffs: "Every buff by level, who gives it, who gets it.", ledger: "Every decision, in order, with the date.", signups: "Who is in for which night.", librarian: "Leeroy: ask in chat or ask here.", library: "Every fact the group has researched, searchable." };
  /* MECH[key] = { hint, press(api) }: hint finishes "Press the seal to ..."; press runs after the spin starts, api = { seal, key, say, spin } */
  const MECH = {};
  const S = { ang: 0, el: null, btn: null, disc: null, key: null, light: { x: 0.3, y: 0.2 }, raf: 0, spun: 0 };

  function build() {
    const disc = h("span", { class: "seal-disc" },
      ...Array.from({ length: 7 }, (_, i) => h("span", { class: "seal-edge", style: `--i:${i}` })),
      h("span", { class: "seal-face seal-front" }, h("img", { class: "seal-img", alt: "", width: 640, height: 640, decoding: "async" }), h("span", { class: "seal-spec" }), h("span", { class: "seal-sweep" })),
      h("span", { class: "seal-face seal-back" }, h("span", { class: "seal-back-in" }, h("b", { class: "seal-b" }), h("i", { class: "seal-i" }))));
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

  /* ---------- Race skills: the coin's back shows one racial at a time; each press spins to the next ---------- */
  const R = { i: -1 };
  const racialList = () => { const r = K.D && K.D.client ? K.D.client.racials : null; return r ? Object.entries(r).flatMap(([race, l]) => l.map((x) => [race, x])) : []; };
  const clause = (x) => (x.wiki ? x.wiki.replace(/^(active|passive),\s*/, "").split(/[;(]/)[0].trim() : "Not on the wiki page yet");
  function faceRacial(l) {
    const [race, x] = l[R.i]; const el = $("#seal");
    $(".seal-b", el).textContent = x.name; $(".seal-i", el).textContent = `${race} · ${x.kind || "racial"}${x.changed_oct26 ? ` · changed ${x.changed_on || "Oct 26"}` : ""}`;
    el.dataset.kind = x.kind || "";
    return `${race}, ${x.name} (${x.kind || "racial"}): ${clause(x)}.`;
  }
  function raceStep(by) {
    const l = racialList(); if (!l.length) return; R.i = ((R.i < 0 ? (by < 0 ? 0 : -1) : R.i) + by + l.length) % l.length;
    let msg = ""; spin({ land: "back", mid: () => { msg = faceRacial(l); } }).then(() => say(msg || faceRacial(l)));
  }
  MECH.racials = { hint: "to spin the coin to the next racial", spin: false, press: () => raceStep(1) };
  document.addEventListener("click", (e) => { const row = e.target && e.target.closest && e.target.closest("#races .rrow"); if (!row || !S.el || S.el.hidden || S.key !== "racials") return; const l = racialList(), k = l.findIndex(([, x]) => K.MEM.slug(x.name) === row.dataset.key); if (k >= 0 && k !== R.i) { R.i = k - 1; raceStep(1); } });
  K.on("scene", (k) => { if (k === "racials") R.i = -1; });

  /* ---------- Bonuses: the coin fills the ring, the number counts up to what the group has earned ---------- */
  MECH.legacy = { hint: "to fill the ring again", press: ({ say: sy }) => {
    const L = K.D && K.D.client ? K.D.client.legacy : null, wrap = $("#legacy-ring"); if (!L || !wrap) return;
    wrap.classList.remove("filling"); void wrap.getBoundingClientRect(); wrap.classList.add("filling");
    const num = $(".ring-num", wrap), to = L.earned_now, t0 = performance.now(), ease = (x) => 1 - Math.pow(1 - x, 3);
    if (num) { if (reduceMQ.matches) num.textContent = String(to); else { const tick = (n) => { const x = Math.min(1, (n - t0) / 900); num.textContent = String(Math.round(to * ease(x))); if (x < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); } }
    const next = L.thresholds.find((x) => x.n > to);
    sy(`${to} of ${L.total} points earned so far.${next ? ` Next reward on the track: ${next.reward} at ${next.n}.` : ""}`);
  } };

  /* ---------- Sign-ups: raising a mug answers through the page's own RSVP buttons ---------- */
  document.addEventListener("pointerdown", (e) => { const b = e.target.closest && e.target.closest(".su-st"); if (!b) return; b.classList.remove("lift"); void b.offsetWidth; b.classList.add("lift"); snd("clink"); hap("rsvp"); setTimeout(() => b.classList.remove("lift"), 600); }, true);
  MECH.signups = { hint: "to read the night's count, then raise a mug below", press: ({ say: sy }) => {
    const S = K.D && K.D.signups, rs = S && S.tallies && S.tallies.rsvp ? S.tallies.rsvp : {}, n = (k) => (rs[k] ? rs[k].count : 0);
    sy(`Launch night: ${K.RSVP_KEYS.map((k) => `${K.RSVP_SAY[k]} ${n(k)}`).join(", ")}.`);
    const b = $("#dsu-act .su-st[aria-pressed=\"true\"]") || $("#dsu-act .su-st"); if (b) b.focus({ preventScroll: false });
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
  MECH.librarian = { hint: "to see how to ask Leeroy", press: ({ say: sy }) => sy("In #wow-forever type /ask and your question, or tag Leeroy Jenkins. He answers from the same library.") };
  window.BoardSeals = Object.freeze({ MECH, press, spin, say, snd, hap, h, $, mq, reduceMQ, clamp, status: () => ({ key: S.key, hidden: S.el ? S.el.hidden : true, spun: S.spun }) });
})();
