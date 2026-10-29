/* V13d (board/V13D-SPEC.md): the three journeys, the interaction top 10 of board/qa/2026-10-28-interaction.md, and the board
   side of the shared brain's screens. Runs after js/board.js, before boot, through the page's own hooks (window.__boardKit). */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h, s, emb, D, MEM, SC, sfx } = K;
const root = document.documentElement;
const JOURNEYS = ["guided", "curious", "everything"];
const J_LINE = { guided: "Two hours a week: walk me through it", curious: "I'll click around", everything: "Show me every number" };
const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const put = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
const reduced = () => K.reduceMQ.matches;
const rm = (el) => { if (el && el.parentNode) el.parentNode.removeChild(el); };
const kid = (el, cls) => [...el.children].find((c) => c.classList.contains(cls)) || null;
const FIRST = !get("board-seen") && !get("board-glowed");
const V = { picked: JOURNEYS.includes(get("board-journey")), path: {}, zoom: null, map: null, dial: null, glow: false };
/* V13e retest-3: the page names its own icon (a brass tankard drawn inline), so no browser asks the host for /favicon.ico */
if (!document.querySelector('link[rel="icon"]')) { const ic = document.createElement("link"); ic.rel = "icon"; ic.type = "image/svg+xml"; ic.href = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#2a1a10"/><path d="M8 9h13v16a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z" fill="#c9952e"/><path d="M21 12h3a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-3" fill="none" stroke="#c9952e" stroke-width="2.4"/><path d="M7 9a3 3 0 0 1 3-3h1a3 3 0 0 1 5 0h1a3 3 0 0 1 3 3z" fill="#f3e6c8"/></svg>'); (document.head || document.documentElement).appendChild(ic); }

// ---------------- 1. Journeys ----------------
const journey = () => (JOURNEYS.includes(root.dataset.journey) ? root.dataset.journey : "curious");
root.dataset.journey = JOURNEYS.includes(get("board-journey")) ? get("board-journey") : "curious";
function markJourney() {
  const j = journey();
  document.querySelectorAll(".journey [data-journey], #more-menu [data-journey]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.journey === j)));
}
/* one switch, effects at once, nothing lost: the open scene and its scroll stay; every renderer draws the new depth */
function setJourney(j, how) {
  if (!JOURNEYS.includes(j)) return false;
  const was = journey(); V.picked = true; put("board-journey", j);
  if (was === j && how !== "force") { markJourney(); return false; }
  root.dataset.journey = j;
  const body = $("#sheet-body"), top = body ? body.scrollTop : 0;
  for (const k of Object.keys(K.FIT)) delete K.FIT[k];
  for (const f of ["races", "cards", "legacy", "ledger", "timeline", "buffs", "signups", "tonight"]) { try { K.render[f](); } catch (e) { console.error(f, e); } }
  if (SC.open === "library") { try { K.libRender(false); } catch (e) {} }
  applyDepth(); paths(); markJourney();
  if (SC.open) { try { K.fitScene(); } catch (e) {} if (body) body.scrollTop = top; }
  if (how !== "mirror" && how !== "quiet") { sfx("latch"); if (window.BoardBrain) window.BoardBrain.setJourney(j); }
  return true;
}
/* Everything expands: every fold in the scenes opens (the library keeps its own) */
function applyDepth() {
  if (journey() !== "everything") return;
  document.querySelectorAll("#sheet-body details").forEach((d) => { if (!d.closest("#panel-library")) d.open = true; });
}
/* the launch date at each depth: the same epoch through the board's one formatter */
function preview(j) {
  const e = D.timeline && D.timeline.events.find((x) => x.key === "launch"); if (!e || !e.epoch) return "";
  if (j === "guided") return `Launch: ${K.relWhen(e.epoch)}, ${K.fmtWhen(e.epoch)}.`; /* V13e retest-2: with the time */
  if (j === "curious") return `Launch: ${K.fmtWhen(e.epoch)}.`;
  return `Launch: ${K.fmtWhen(e.epoch, { rel: true })}. Source: Blizzard.`;
}
function pickerEl() {
  const cards = JOURNEYS.map((j) => h("button", { type: "button", class: `jr-card jr-${j}`, "data-journey": j, "aria-pressed": String(j === journey()), onclick: () => { V.confirm = j; setJourney(j, "force"); done(j); } },
    h("b", { class: "jr-name", text: j.charAt(0).toUpperCase() + j.slice(1) }), h("span", { class: "jr-line", text: J_LINE[j] }), h("span", { class: "jr-fact", text: preview(j) }),
    j === "curious" ? h("span", { class: "jr-start", text: "Not sure? Start here." }) : null));
  const box = h("div", { class: "jr-pick", role: "group", "aria-labelledby": "jr-q" }, h("div", { class: "jr-top" }, h("p", { class: "tn-who", id: "jr-q", text: "How do you want to explore?" }), h("p", { class: "jr-note" }, "Change it any time at the top. ", h("button", { type: "button", class: "lib-tool jr-skip", onclick: () => { V.confirm = "curious"; setJourney("curious", "quiet"); done("curious"); } }, "Skip"))), h("div", { class: "jr-cards" }, cards));
  function done(j) { const live = $("#tn-me .jr-pick") || box; live.replaceChildren(h("p", { class: "jr-done", role: "status", text: `Exploring: ${j.charAt(0).toUpperCase() + j.slice(1)}. Change it any time at the top.` })); }
  return box;
}
K.on("tonight", () => {
  const meBox = $("#tn-me"); if (!meBox) return;
  paths("tonight");
  if (!V.picked || V.confirm) { const p = pickerEl(); meBox.append(p); if (V.confirm) p.replaceChildren(h("p", { class: "jr-done", role: "status", text: `Exploring: ${V.confirm.charAt(0).toUpperCase() + V.confirm.slice(1)}. Change it any time at the top.` })); }
});
function startJourneySwitch() {
  const nav = $("#journey");
  const phone = window.matchMedia("(max-width: 699px)");
  if (!nav) return;
  /* V13e perf: two plates, never moved. The wall keeps #journey in its header; the scene head has its own copy
     (#journey-scene), so opening or closing a scene changes no layout outside the sheet (moving one plate in and out of the
     scene head cost a reflow of both heads on every open and close, worst on phones). */
  const sceneNav = h("nav", { class: "journey journey-scene", "aria-label": nav.getAttribute("aria-label") || "How do you want to explore?" }, JOURNEYS.map((j) => h("button", { type: "button", "data-journey": j, "aria-pressed": String(j === journey()) }, j.charAt(0).toUpperCase() + j.slice(1)))); sceneNav.setAttribute("id", "journey-scene");
  const top = $(".sheet-top"), peek = $("#scene-peek"); if (top) top.insertBefore(sceneNav, peek && peek.parentNode === top ? peek : null);
  const plates = [nav, sceneNav];
  /* on a phone the head has room for one plate: it shows the journey, a tap opens the three */
  const onClick = (pl) => (e) => { const b = e.target.closest("[data-journey]"); if (!b) return; if (phone.matches && !pl.classList.contains("open") && b.getAttribute("aria-pressed") === "true") { pl.classList.add("open"); b.setAttribute("aria-expanded", "true"); return; } pl.classList.remove("open"); pl.querySelectorAll("[aria-expanded]").forEach((x) => x.removeAttribute("aria-expanded")); setJourney(b.dataset.journey); };
  for (const pl of plates) pl.addEventListener("click", onClick(pl));
  document.addEventListener("pointerdown", (e) => { for (const pl of plates) if (pl.classList.contains("open") && !pl.contains(e.target)) pl.classList.remove("open"); }, true);
  markJourney();
  K.sceneHooks.push((open) => { if (!open) { V.confirm = null; for (const pl of plates) pl.classList.remove("open"); } });
}

// ---------------- Guided: a day-one path on every scene, one step at a time ----------------
function nextDeadline() {
  const now = Date.now() / 1000, out = [];
  for (const e of (D.timeline && D.timeline.events) || []) {
    if (e.until_epoch && e.epoch <= now && now < e.until_epoch) out.push({ t: e.until_epoch, text: `${e.label.split(":")[0]} closes at the end of ${e.until}, ${e.until_zone || "Pacific"} time` });
    else if (e.epoch && e.epoch > now) out.push({ t: e.epoch, text: `${e.label.split(":")[0]}: ${K.fmtWhen(e.epoch, { rel: true })}` });
  }
  for (const q of (D.party && D.party.polls) || []) if (q.closes_epoch && q.closes_epoch > now) out.push({ t: q.closes_epoch, text: `The ${q.title.toLowerCase()} poll closes ${K.fmtWhen(q.closes_epoch, { rel: true })}` });
  return out.sort((a, b) => a.t - b.t)[0] || null;
}
const land = (tok, label) => h("button", { type: "button", class: "lib-tool jr-go", onclick: () => { const k = tok.split(".")[0]; SC.land = { key: k, sub: tok.slice(k.length + 1), from: null }; if (SC.open === k) { K.setHash(tok, false); landOn(k, SC.land.sub); SC.land = null; } else K.goScene(k); } }, label);
function steps(key) {
  const P = D.party, C = D.client, T = D.timeline, me = MEM.member(), now = Date.now() / 1000;
  if (!P || !C || !T) return [];
  const launch = T.events.find((e) => e.key === "launch");
  const sayOf = (k) => K.RSVP_SAY[k] || k;
  const mineSU = () => { const S = D.signups; return me && S && S.entries ? S.entries.find((e) => K.cleanName(e.name).toLowerCase() === me.name.toLowerCase()) : null; };
  switch (key) {
    case "tonight": {
      const ev = T.events.find((e) => (e.until_epoch && e.epoch <= now && now < e.until_epoch) || (e.epoch && e.epoch > now));
      const person = me && D.tonight ? D.tonight.people.find((x) => x.member === P.members.indexOf(me)) : null, su = mineSU();
      return [
        /* V13e retest-2: launch day and time are in step 1, never three taps away */
        [`${launch ? `Launch: ${K.fmtWhen(launch.epoch, { rel: true })}. ` : ""}${me ? `You are ${me.name}, ${me.race} ${me.class}.` : "First, pick your name above, or Just looking."}`],
        ev ? [`${ev.label.split(":")[0]}: ${ev.until_epoch && ev.epoch <= now ? `open now, until the end of ${ev.until}, ${ev.until_zone || "Pacific"} time` : K.fmtWhen(ev.epoch, { rel: true })}.`] : null,
        person && person.step ? [`Your one step: ${person.step}`] : [su ? `Your launch-night answer: ${sayOf(su.rsvp)}.` : "Your one step: answer the Sign-ups card in Discord."],
        ["A pack is the pre-order that lets you make characters early."],
      ].filter(Boolean);
    }
    case "timeline": return T.events.filter((e) => (e.until_epoch ? e.until_epoch : e.epoch) > now).slice(0, 3).map((e) => [`${e.label.split(":")[0]}: ${e.epoch ? K.fmtWhen(e.epoch, { rel: true, time: e.format !== "D" }) : e.date}. ${e.detail ? `${e.detail.charAt(0).toUpperCase()}${e.detail.slice(1)}.` : ""}`, land(`timeline.${e.key}`, "Show it on the rail")]);
    case "five": return P.members.map((m) => [`${m.name}: ${m.race} ${m.class}, ${m.role}${m.spec_status && m.spec_status.status === "open" ? ", still choosing a play style" : ""}.`, land(`five.${MEM.slug(m.name)}`, `Meet ${m.name}`)]);
    case "roads": {
      const zones = [...new Set(P.members.map((m) => m.start_zone))].filter(Boolean).sort((a, b) => (me && b === me.start_zone) - (me && a === me.start_zone));
      return zones.map((z) => { const ms = P.members.filter((m) => m.start_zone === z); const how = ({ "Tirisfal Glades": "the Undercity zeppelin", Mulgore: "the road past the Crossroads", Durotar: "the Durotar road" })[z] || "the road"; return [`${z}: ${K.andList(ms.map((m) => m.name))} wake${ms.length === 1 ? "s" : ""} here, then take ${how} to Orgrimmar.`, land(`roads.${MEM.slug(z)}`, `Zoom to ${z}`)]; });
    }
    case "racials": {
      const list = Object.entries(C.racials).sort(([a], [b]) => (me && b === me.race) - (me && a === me.race));
      return list.map(([race, rs]) => { const a = rs.find((r) => r.kind === "active") || rs[0]; const line = String(a.wiki || "").replace(/^(active|passive),\s*/, "").split(/;\s*/)[0].replace(/\s*\([^)]*\)/g, ""); return [`${race}: ${a.name}, ${line}.`, land(`racials.${MEM.slug(race)}`, `${race} skills`)]; });
    }
    case "legacy": { const L = C.legacy; return [[`Your whole account earns legacy points from challenges: ${L.total} in all, one point each.`], [`Earned so far: ${L.earned_now}, because ${L.earned_note}.`], ...L.thresholds.map((t) => [`At ${t.n} points: ${t.reward}.`])]; }
    case "buffs": {
      if (!me || !C.buffs) return [["Pick who you are below to see what you give and what you get."]];
      const give = C.buffs.list.filter((b) => !b.sixth && b.class === me.class_key).map((b) => b.name);
      const getN = C.buffs.list.filter((b) => !b.sixth && b.class !== me.class_key && P.members.some((m) => m.class_key === b.class)).length;
      return [[`You give the others: ${give.length ? K.andList(give) : "no group buffs"}.`], [`The others bring ${getN} buffs between them; the list below shows which reach you.`], ["Slide the level to see the numbers at any level."]];
    }
    case "ledger": {
      const open = P.open.filter((o) => !P.polls.some((q) => q.title === o.title));
      return [...P.polls.map((q) => [`Poll: ${q.title}${q.closes_epoch ? `, closes ${K.fmtWhen(q.closes_epoch, { rel: true })}` : ""}.`]), ...open.map((o, i) => [`Still open: ${o.title}.`, land(`ledger.open-${i}`, "Show it")])];
    }
    case "signups": { const su = mineSU(); return [["A pack is the pre-order that lets you make characters early."], ["Answer on the Sign-ups card in Discord: I'm in, Tentative, Running late or Out."], su ? [`Your answer now: ${sayOf(su.rsvp)}.`] : null].filter(Boolean); }
    case "librarian": return [["In any Discord channel here, type /ask and your question."], ["Leeroy answers from the same library this board searches."]];
    case "library": return [["Type a question in the search box, for example onyxia open."], ["Underlined words open a game tooltip; dotted words a plain definition."]];
    default: return [];
  }
}
/* drawn only on the Guided journey (the cards are hidden on the others), and only the scene whose data moved */
function paths(only) {
  if (!D.party || !D.timeline || journey() !== "guided") return;
  for (const key of only ? [only] : K.SCENES) {
    const panel = $(`#panel-${key}`); if (!panel) continue;
    let box = kid(panel, "jr-path");
    if (!box) { box = h("section", { class: "jr-path", "data-j": "g", "aria-label": "Your path" }); const after = key === "tonight" ? $("#tn-cards") : null; panel.insertBefore(box, after || panel.firstChild); }
    const list = steps(key), dl = nextDeadline(), launchEv = D.timeline && D.timeline.events.find((e) => e.key === "launch" && e.epoch > Date.now() / 1000);
    const i = Math.max(0, Math.min(list.length - 1, V.path[key] || 0)); V.path[key] = i;
    const step = list[i];
    const go = (d) => { V.path[key] = i + d; sfx("page"); paths(key); const b = panel.querySelector(`.jr-path .jr-${d > 0 ? "next" : "back"}`); if (b && !b.disabled) b.focus({ preventScroll: true }); else { const o = panel.querySelector(".jr-path .jr-step"); if (o) o.focus({ preventScroll: true }); } };
    box.replaceChildren(...[
      h("h3", { class: "jr-h", text: "Your path" }),
      /* V13e retest-2 and 12: launch is the date most friends need, so it sits beside the next date on every Guided path */
      dl || launchEv ? h("p", { class: "jr-dates" },
        dl ? h("span", { class: "jr-dl" }, emb("hourglass", "jr-dl-emb"), h("b", { text: "Next date: " }), dl.text, ".") : null,
        launchEv && (!dl || dl.t !== launchEv.epoch) ? h("span", { class: "jr-dl jr-launch" }, emb("moon", "jr-dl-emb"), h("b", { text: "Launch: " }), K.fmtWhen(launchEv.epoch, { rel: true }), ".") : null) : null,
      /* the cost is never a step away: on Next steps and Sign-ups the play line stays in view */
      ["tonight", "signups"].includes(key) && D.tonight && D.tonight.play ? h("p", { class: "jr-dl jr-cost" }, emb("ticket", "jr-dl-emb"), h("b", { text: "Cost: " }), D.tonight.play) : null,
      step ? h("div", { class: "jr-step", tabindex: "-1" }, h("span", { class: "jr-n", text: `Step ${i + 1} of ${list.length}` }), h("p", { class: "jr-say", text: step[0] }), step[1] || null) : null,
      list.length > 1 ? h("div", { class: "jr-nav" }, h("button", { type: "button", class: "lib-tool jr-back", disabled: i === 0 ? "" : null, onclick: () => go(-1) }, "Back"), h("span", { class: "jr-dots", "aria-hidden": "true" }, list.map((_, k) => h("i", { class: k === i ? "on" : null }))), h("button", { type: "button", class: "lib-tool jr-next", disabled: i === list.length - 1 ? "" : null, onclick: () => go(1) }, "Next")) : null].filter(Boolean));
  }
}

// ---------------- 2. Landing on the thing (interaction 1) ----------------
let landT = 0;
function lit(panel, el) {
  if (!panel || !el) return el;
  panel.querySelectorAll(".landed").forEach((x) => x.classList.remove("landed"));
  panel.classList.add("landing"); el.classList.add("landed");
  try { el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" }); } catch (e) {}
  clearTimeout(landT); landT = setTimeout(() => { el.classList.remove("landed"); panel.classList.remove("landing"); }, 6000);
  return el;
}
function landOn(key, sub) {
  const panel = $(`#panel-${key}`); if (!panel) return null;
  const q = (sel) => panel.querySelector(sel);
  if (key === "five") { const c = q(`.card[data-slug="${sub}"]`); return lit(panel, c); }
  if (key === "roads") { zoomTo(sub); return lit(panel, q(".zone-card") || q("#map")); }
  if (key === "racials") {
    if (sub === "changed") { const r = q(".rrow[data-changed]"); if (r) { const d = r.closest("details"); if (d) d.open = true; r.classList.add("open"); const b = r.querySelector(".rhead"); if (b) b.setAttribute("aria-expanded", "true"); } return lit(panel, r); }
    const d = q(`details.race[data-race="${sub}"]`); if (d) d.open = true; return lit(panel, d);
  }
  if (key === "legacy") return lit(panel, q(".ring-box"));
  if (key === "signups") return lit(panel, q(`[data-land-to="${sub}"]`) || q("#dsu-body .tally"));
  if (key === "ledger") return lit(panel, q(`[data-land-to="${sub}"]`));
  if (key === "timeline") { const st = sub === "next" ? q(".stop.open") || q(".stop.next") : q(`.stop[data-ev="${sub}"]`); if (st) lightDay(st.dataset.ev, true); return lit(panel, st); }
  if (key === "buffs") { const g = q(`details.bclass[data-class="${sub}"]`); if (g) g.open = true; return lit(panel, g); }
  return null;
}
K.lander = landOn;
K.on("tap", () => sfx("pin"));
/* where View Transitions are missing: a copy of the mark flies from the wall to its place */
K.on("fly", (from, to) => {
  if (reduced() || !from || !to || typeof to.animate !== "function") return;
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect(); if (!a.width || !b.width) return;
  const img = from.querySelector && from.querySelector("img"), ghost = h("div", { class: "fly-ghost", "aria-hidden": "true" }, img ? img.cloneNode(true) : null);
  ghost.style.left = `${a.left}px`; ghost.style.top = `${a.top}px`; ghost.style.width = `${a.width}px`; ghost.style.height = `${a.height}px`;
  document.body.append(ghost);
  const dx = b.left + Math.min(b.width, 120) / 2 - (a.left + a.width / 2), dy = b.top + Math.min(b.height, 120) / 2 - (a.top + a.height / 2);
  const an = ghost.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(1.6)`, opacity: 0 }], { duration: K.MOTION.hero, easing: K.MOTION.oak, fill: "forwards" });
  const end = () => rm(ghost); if (an && an.finished) an.finished.then(end, end); else setTimeout(end, K.MOTION.hero + 50);
});
K.on("closed", () => { document.querySelectorAll(".panel.landing").forEach((p) => p.classList.remove("landing")); document.querySelectorAll(".landed").forEach((x) => x.classList.remove("landed")); });

// ---------------- 3. Roads: two zoom levels (interaction 4) ----------------
const FULL = [0, 0, 600, 400];
function zoneBox(z) { const w = innerWidth >= 700 && innerHeight >= 501 ? 340 : 250, hh = w / 1.5, y = Math.max(0, Math.min(400 - hh, z.y - hh / 2 + 10)); let x = Math.max(0, Math.min(600 - w, z.x - w / 2 + 20));
  /* V13e retest-5: a box edge never cuts the Crossroads label (centred at 380, y 250): it moves to show the whole name */
  if (y < 256 && y + hh > 236) { if (x > 326 && x < 424) x = 326; else if (x + w > 336 && x + w < 434) x = Math.min(600 - w, 434 - w); }
  return [x, y, w, hh]; }
function animateBox(svg, to) {
  const from = (svg.getAttribute("viewBox") || "0 0 600 400").split(/\s+/).map(Number);
  if (V.boxRaf) cancelAnimationFrame(V.boxRaf);
  const set = (b) => svg.setAttribute("viewBox", b.map((v) => v.toFixed(1)).join(" "));
  if (reduced()) { set(to); return; }
  const t0 = performance.now(), dur = 400, ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = ease(k); set(from.map((v, i) => v + (to[i] - v) * e)); if (k < 1) V.boxRaf = requestAnimationFrame(step); else V.boxRaf = 0; };
  V.boxRaf = requestAnimationFrame(step);
}
function zoneCard(zone) {
  const M = V.map, ms = (M.byZone[zone] || []), r = M.roads.find((x) => x.zone === zone);
  const whole = h("button", { type: "button", class: "lib-tool zone-whole", onclick: () => zoomOut(true) }, "Whole map");
  return h("div", { class: "zone-card", role: "region", "aria-label": `${zone}, zoomed in` },
    h("h3", { text: zone }),
    h("ol", { class: "zone-steps" },
      h("li", {}, ms.length ? `${K.andList(ms.map((m) => `${m.name} (${m.race} ${m.class})`))} wake${ms.length === 1 ? "s" : ""} here.` : "Nobody at this table starts here."),
      r ? h("li", { text: `${r.how.charAt(0).toUpperCase()}${r.how.slice(1)} to Orgrimmar.` }) : null,
      h("li", { text: zone === "Mulgore" ? "The road passes the Crossroads, then the Valley of Strength in Orgrimmar." : "Into Orgrimmar through the Valley of Strength." })),
    whole);
}
function zoomTo(zSlug) {
  const M = V.map; if (!M) return false;
  const zone = Object.keys(M.zones).find((z) => MEM.slug(z) === zSlug); if (!zone) return false;
  V.zoom = zone; M.pick((M.roads.find((r) => r.zone === zone) || {}).key || null);
  const box = $("#map"), svg = M.svg; svg.classList.add("zoomed"); box.classList.add("zoomed");
  animateBox(svg, zoneBox(M.zones[zone]));
  rm(box.querySelector(".zone-card"));
  box.append(zoneCard(zone));
  sfx("paper");
  return true;
}
function zoomOut(focus) {
  const M = V.map; if (!M || !V.zoom) return false;
  const was = V.zoom; V.zoom = null; M.pick(null);
  const box = $("#map"); M.svg.classList.remove("zoomed"); box.classList.remove("zoomed");
  animateBox(M.svg, FULL);
  rm(box.querySelector(".zone-card"));
  if (focus) { const g = M.svg.querySelector(`[data-zone="${MEM.slug(was)}"]`); if (g && g.focus) g.focus({ preventScroll: true }); }
  sfx("paper");
  return true;
}
K.on("map", (M) => {
  V.map = M;
  M.svg.setAttribute("role", "group"); /* V13e axe: the zones inside are buttons, so the map is a labelled group, not a picture */
  const zoneOf = (g) => M.roads.find((r) => r.key === g.dataset.road).zone;
  for (const g of M.groups) {
    const zone = zoneOf(g);
    g.setAttribute("tabindex", "0"); g.setAttribute("role", "button"); g.setAttribute("data-zone", MEM.slug(zone)); g.setAttribute("aria-label", `Zoom to ${zone}`);
    /* V13e retest-4: the zone's own land and name take the tap too (a transparent hit area under the pins) */
    const zz = M.zones[zone]; if (zz && !g.querySelector(".zone-hit")) { const lx = zz.label ? zz.label[0] : zz.x, ly = zz.label ? zz.label[1] : zz.y; const x0 = Math.min(zz.x, lx) - 70, y0 = Math.min(zz.y, ly) - 60, x1 = Math.max(zz.x, lx) + 70, y1 = Math.max(zz.y, ly) + 22; g.insertBefore(K.s("rect", { class: "zone-hit", x: Math.max(0, x0), y: Math.max(0, y0), width: Math.min(600, x1) - Math.max(0, x0), height: Math.min(400, y1) - Math.max(0, y0) }), g.firstChild); }
    g.addEventListener("click", (e) => { e.stopPropagation(); if (V.zoom === zone) zoomOut(); else zoomTo(MEM.slug(zone)); });
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (V.zoom === zone) zoomOut(); else zoomTo(MEM.slug(zone)); } });
  }
  M.svg.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".road-g")) return;
    if (V.zoom) { zoomOut(); return; }
    /* V13e retest-4: a tap anywhere on a zone's land, name or name plates zooms to it (the nearest zone within reach) */
    const r = M.svg.getBoundingClientRect(), vb = (M.svg.getAttribute("viewBox") || "0 0 600 400").split(/\s+/).map(Number);
    const x = vb[0] + (e.clientX - r.left) / r.width * vb[2], y = vb[1] + (e.clientY - r.top) / r.height * vb[3];
    const near = Object.entries(M.zones).map(([z, p]) => [z, Math.min(Math.hypot(p.x - x, p.y - y), p.label ? Math.hypot(p.label[0] - x, p.label[1] - y) : 1e9)]).sort((a, b) => a[1] - b[1])[0];
    if (near && near[1] < 95) zoomTo(MEM.slug(near[0]));
  });
  /* a pinch on the map zooms the map, never the page: out zooms to the zone nearest the fingers, in returns to the whole map */
  const pts = new Map(); let d0 = 0;
  /* V13e: the pinch is read on the whole map box, so a pinch in also works over the zone card (on a phone it covers the map) */
  const PZ = M.svg.closest("#map") || M.svg;
  PZ.addEventListener("pointerdown", (e) => { if (e.pointerType !== "touch") return; pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size === 2) { const [a, b] = [...pts.values()]; d0 = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  PZ.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || (PZ.dataset.pan && innerWidth >= 700 && innerHeight >= 501)) return; /* js/wide.js pinches the wide map itself */ pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size !== 2 || !d0) return;
    const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d / d0 > 1.18 && !V.zoom) { const r = M.svg.getBoundingClientRect(), mx = ((a[0] + b[0]) / 2 - r.left) / r.width * 600, my = ((a[1] + b[1]) / 2 - r.top) / r.height * 400; const z = Object.entries(M.zones).sort(([, p], [, q]) => Math.hypot(p.x - mx, p.y - my) - Math.hypot(q.x - mx, q.y - my))[0]; if (z) zoomTo(MEM.slug(z[0])); d0 = 0; }
    else if (d / d0 < 0.85 && V.zoom) { zoomOut(); d0 = 0; }
  });
  for (const t of ["pointerup", "pointercancel"]) PZ.addEventListener(t, (e) => { pts.delete(e.pointerId); if (pts.size < 2) d0 = 0; });
  if (V.zoom) { const z = V.zoom; V.zoom = null; zoomTo(MEM.slug(z)); }
});
K.on("closed", (k) => { if (k === "roads" && V.zoom) { V.zoom = null; if (V.map) { V.map.svg.setAttribute("viewBox", FULL.join(" ")); V.map.svg.classList.remove("zoomed"); V.map.pick(null); } const box = $("#map"); if (box) { box.classList.remove("zoomed"); rm(box.querySelector(".zone-card")); } } });

// ---------------- 4. Dates: the calendar and the rail light each other (interaction 6), and .ics links (prior art 6) ----------------
function lightDay(ev, on) {
  document.querySelectorAll("#cal-col .cal-day.lit, #rail .stop.lit").forEach((x) => x.classList.remove("lit"));
  if (!on || !ev) return;
  document.querySelectorAll(`#cal-col .cal-day[data-ev="${ev}"], #rail .stop[data-ev="${ev}"]`).forEach((x) => x.classList.add("lit"));
}
function todayLine() {
  const T = D.timeline, now = Date.now() / 1000; if (!T) return "";
  const open = T.events.find((e) => e.until_epoch && e.epoch <= now && now < e.until_epoch), l = T.events.find((e) => e.key === "launch");
  const days = l && l.epoch ? Math.max(0, Math.ceil((l.epoch - now) / 86400)) : null;
  return `Today: ${open ? `${open.label.split(":")[0]}, until the end of ${open.until}` : "nothing on the board"}${days !== null && l.epoch > now ? `, ${days} ${days === 1 ? "day" : "days"} to launch` : ""}.`;
}
function icsFor(e) {
  const z = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = e.format === "D" ? e.epoch + 86400 : e.epoch + 4 * 3600;
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dungeons and Drinking//Living Board//EN", "BEGIN:VEVENT", `UID:${e.key}-${e.epoch}@leeroy-board`, `DTSTAMP:${z(Math.floor(Date.now() / 1000))}`, `DTSTART:${z(e.epoch)}`, `DTEND:${z(end)}`, `SUMMARY:WoW Forever: ${e.label.split(":")[0]}`, `DESCRIPTION:${(e.detail || "").replace(/[,;]/g, " ")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
K.on("timeline", () => {
  const cal = $("#cal-col"), rail = $("#rail"); if (!cal || !rail) return;
  if (!cal.dataset.linked) {
    cal.dataset.linked = "1";
    const day = (e) => e.target.closest && e.target.closest(".cal-day[data-ev]");
    cal.addEventListener("pointerover", (e) => { const d = day(e); if (d && d.dataset.ev !== "today") lightDay(d.dataset.ev, true); });
    cal.addEventListener("pointerout", (e) => { const d = day(e); if (d) lightDay(null, false); });
    cal.addEventListener("focusin", (e) => { const d = day(e); if (d && d.dataset.ev !== "today") lightDay(d.dataset.ev, true); });
    cal.addEventListener("click", (e) => {
      const d = day(e); if (!d) return;
      const card = cal.querySelector(".cal-card"); if (card) { card.textContent = d.dataset.ev === "today" ? todayLine() : d.getAttribute("aria-label") || ""; }
      if (d.dataset.ev === "today") { sfx("card"); return; }
      lightDay(d.dataset.ev, true); sfx("pin");
      const st = rail.querySelector(`.stop[data-ev="${d.dataset.ev}"]`); if (st) { try { st.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }); } catch (er) {} }
    });
    const stop = (e) => e.target.closest && e.target.closest(".stop[data-ev]");
    rail.addEventListener("pointerover", (e) => { const st = stop(e); if (st) lightDay(st.dataset.ev, true); });
    rail.addEventListener("pointerout", (e) => { const st = stop(e); if (st) lightDay(null, false); });
  }
  const c = cal.querySelector(".cal"); if (c && !c.querySelector(".cal-card")) c.append(h("p", { class: "cal-card", "aria-live": "polite", text: todayLine() }));
  /* the launch and the raids carry an "Add to my calendar" file, built here from the same epochs */
  for (const st of rail.querySelectorAll(".stop[data-ev]")) {
    const e = D.timeline.events.find((x) => x.key === st.dataset.ev);
    if (!e || !e.epoch || !["launch", "raids"].includes(e.key) || st.querySelector(".ics")) continue;
    const a = h("button", { type: "button", class: "lib-tool ics", "data-j": "c e", onclick: () => { try { const u = URL.createObjectURL(new Blob([icsFor(e)], { type: "text/calendar" })); const x = h("a", { href: u, download: `wow-forever-${e.key}.ics` }); document.body.append(x); x.click(); rm(x); setTimeout(() => URL.revokeObjectURL(u), 4000); sfx("copy"); } catch (er) {} } }, emb("cal"), "Add to my calendar");
    const body = st.querySelector(".stop-body"); if (body) body.append(a);
  }
});

// ---------------- 5. Bonuses: the ring is a what-if dial (interaction 7) ----------------
K.on("legacy", ({ svg, r, C, L, rewards, legend }) => {
  const total = L.total, now = L.earned_now;
  const D0 = V.dial && V.dial.total === total ? V.dial.v : now;
  const arc = s("circle", { class: "dial-arc", r: r + 13, cx: 0, cy: 0, fill: "none", transform: "rotate(-90)", "stroke-dasharray": `0 ${2 * Math.PI * (r + 13)}` });
  const knob = s("g", { class: "dial-knob" }, s("circle", { r: 9 }), s("circle", { class: "dial-knob-in", r: 3.5 }));
  const youA = (now / total) * 2 * Math.PI - Math.PI / 2;
  const you = s("g", { class: "dial-you", "aria-hidden": "true" }, s("line", { x1: Math.cos(youA) * (r + 4), y1: Math.sin(youA) * (r + 4), x2: Math.cos(youA) * (r + 22), y2: Math.sin(youA) * (r + 22) }));
  const hit = s("circle", { class: "dial-hit", r: r + 13, cx: 0, cy: 0, fill: "none" });
  const dial = s("g", { class: "dial", role: "slider", tabindex: "0", "aria-label": "What if: points earned", "aria-valuemin": "0", "aria-valuemax": String(total) }, hit, arc, knob, you);
  svg.append(dial);
  const out = h("output", { class: "dial-out", "aria-live": "polite" });
  const btn = (d, label, say) => h("button", { type: "button", class: "lib-tool dial-btn", "aria-label": say, onclick: () => set(V.dial.v + d, true) }, label);
  const ctl = h("div", { class: "dial-ctl", role: "group", "aria-label": "What if" }, h("span", { class: "dial-k", text: "What if" }), btn(-5, "−", "Five points fewer"), out, btn(5, "+", "Five points more"), h("span", { class: "dial-now", text: `You now: ${now}` }));
  svg.parentNode.append(ctl);
  const C2 = 2 * Math.PI * (r + 13);
  const reach = (v) => L.thresholds.filter((t) => t.n <= v);
  function set(v, sound) {
    v = Math.max(0, Math.min(total, Math.round(v)));
    const before = V.dial ? V.dial.v : -1; V.dial = { v, total };
    arc.setAttribute("stroke-dasharray", `${((v / total) * C2).toFixed(1)} ${C2.toFixed(1)}`);
    const a = (v / total) * 2 * Math.PI - Math.PI / 2; knob.setAttribute("transform", `translate(${(Math.cos(a) * (r + 13)).toFixed(1)} ${(Math.sin(a) * (r + 13)).toFixed(1)})`);
    const got = reach(v), top = got[got.length - 1];
    dial.setAttribute("aria-valuenow", String(v)); dial.setAttribute("aria-valuetext", `${v} points${top ? `: unlocks ${top.reward}` : ": no reward yet"}`);
    out.textContent = `${v} points`;
    rewards.querySelectorAll("li[data-n]").forEach((li) => { const on = Number(li.dataset.n) <= v; if (on && !li.classList.contains("lit") && before >= 0 && Number(li.dataset.n) > before) { li.classList.remove("pop"); void li.offsetWidth; li.classList.add("pop"); if (sound) sfx("stamp"); } li.classList.toggle("lit", on); });
    if (sound && before >= 0 && v !== before && !got.some((t) => t.n > before && t.n <= v)) sfx("detent", { gain: 0.6 });
  }
  set(D0, false);
  const fromPoint = (e) => { const b = svg.getBoundingClientRect(); const x = e.clientX - (b.left + b.width / 2), y = e.clientY - (b.top + b.height / 2); let a = Math.atan2(y, x) + Math.PI / 2; if (a < 0) a += 2 * Math.PI; return (a / (2 * Math.PI)) * total; };
  let drag = false;
  dial.addEventListener("pointerdown", (e) => { drag = true; try { dial.setPointerCapture(e.pointerId); } catch (er) {} set(fromPoint(e), true); e.preventDefault(); });
  dial.addEventListener("pointermove", (e) => { if (drag) set(fromPoint(e), true); });
  for (const t of ["pointerup", "pointercancel"]) dial.addEventListener(t, () => { drag = false; });
  dial.addEventListener("keydown", (e) => { const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); set(V.dial.v + d, true); } else if (e.key === "Home") { e.preventDefault(); set(0, true); } else if (e.key === "End") { e.preventDefault(); set(total, true); } });
  /* a category lights its share of the ring, and a share of the ring its category */
  const cat = (k) => { svg.querySelectorAll(".ring-seg").forEach((x) => x.classList.toggle("dim", !!k && x.dataset.cat !== k)); legend.querySelectorAll("li[data-cat]").forEach((x) => x.classList.toggle("lit", x.dataset.cat === k)); };
  /* V13e axe: a list item cannot be a button, so each category's line is wrapped in a real button (Enter and Space for free) */
  legend.querySelectorAll("li[data-cat]").forEach((li) => { const b = h("button", { type: "button", class: "cat-line", "aria-pressed": "false" }, ...li.childNodes); li.replaceChildren(b); b.addEventListener("click", () => { const on = !li.classList.contains("lit"); cat(on ? li.dataset.cat : null); legend.querySelectorAll(".cat-line").forEach((x) => x.setAttribute("aria-pressed", String(x.parentNode.classList.contains("lit")))); if (on) sfx("chip"); }); });
  svg.setAttribute("role", "group"); /* V13e axe: it holds the dial (a slider), so it is a group, not a picture */
  svg.querySelectorAll(".ring-seg").forEach((seg) => seg.addEventListener("click", () => cat(seg.dataset.cat)));
});

// ---------------- 6. The five: spell names open a game-style card (interaction 8) ----------------
const GLR = { re: null };
function glossRe() {
  const G = (D.party && D.party.glossary) || []; if (!G.length) return null;
  if (!GLR.re) { const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); GLR.re = new RegExp(`(?<![A-Za-z0-9'])(${G.flatMap((g) => g.forms).sort((a, b) => b.length - a.length).map(esc).join("|")})(?![A-Za-z0-9'])`, "gi"); }
  return GLR.re;
}
/* text with the board's glossary words dotted as a second-level card (never the card's own term) */
function dotted(text, self) {
  const re = glossRe(); if (!re) return [text];
  const out = []; let last = 0; const seen = new Set([].concat(self).filter(Boolean)); /* V13e retest-7: self may list the parent too */
  re.lastIndex = 0;
  for (const m of String(text).matchAll(re)) { const g = K.glDef(m[1]); if (!g || seen.has(g.term)) continue; seen.add(g.term); out.push(text.slice(last, m.index), h("button", { type: "button", class: "gl2", "data-term": g.term, "aria-expanded": "false" }, m[1])); last = m.index + m[1].length; }
  out.push(text.slice(last));
  return out.filter((x) => x !== "");
}
function spellCard(sp) {
  const row = (a, b) => (a || b ? h("div", { class: "ttc-row" }, h("span", { text: a || "" }), h("span", { text: b || "" })) : null);
  const vals = sp.values.map((v) => K.fmtVal(v, sp.duration_ms));
  return h("div", { class: "ttc-in", style: "--qc: var(--q-spell)" },
    h("div", { class: "ttc-top" }, h("b", { class: "ttc-name", id: "ttc-name", text: sp.name }), sp.rank ? h("span", { class: "ttc-rank", text: sp.rank }) : null),
    row(K.fmtCost(sp.cost), sp.cast_ms ? `${K.fmtMs(sp.cast_ms)} cast` : "Instant"),
    row(sp.duration_ms && !sp.values.some((v) => v.mode === "total") ? `Lasts ${K.fmtMs(sp.duration_ms)}` : "", sp.cooldown ? `${K.fmtMs(sp.cooldown.ms)} cooldown` : ""),
    ...vals.map((t) => h("div", { class: "ttc-line y" }, ...dotted(t))),
    sp.learned ? h("div", { class: "ttc-line w", text: `Learned at level ${sp.learned}` }) : null,
    h("div", { class: "ttc-src", text: `Game client ${D.client.build}` }));
}
function spellShow(btn, pinned) {
  const card = $("#ttc"); if (!card) return;
  const sp = ((D.client.classes[btn.dataset.cls]) || [])[Number(btn.dataset.sp)]; if (!sp) return;
  const TT = K.TT;
  if (TT.open && TT.trigger === btn) { if (pinned) TT.pinned = true; return; }
  if (TT.trigger && TT.trigger !== btn) TT.trigger.setAttribute("aria-expanded", "false");
  clearTimeout(TT.hideT);
  TT.open = true; TT.i = `sp${btn.dataset.cls}${btn.dataset.sp}`; TT.trigger = btn; TT.pinned = !!pinned;
  card.classList.remove("gloss");
  card.replaceChildren(spellCard(sp), h("button", { class: "ttc-x", type: "button", "aria-label": "Close the card", text: "Close" }));
  card.hidden = false; btn.setAttribute("aria-expanded", "true");
  K.ttPlace(card, btn);
  /* beside the five's card, never over the name that opened it (the board's placing puts it under the word) */
  if (!card.classList.contains("sheetmode")) {
    const sr = $(".sheet").getBoundingClientRect(), cr = (btn.closest(".card") || btn).getBoundingClientRect(), br = btn.getBoundingClientRect(), w = card.offsetWidth, ht = card.offsetHeight;
    let x = cr.right - sr.left + 10; if (x + w > sr.width - 10) x = cr.left - sr.left - w - 10; if (x < 10) x = Math.max(10, Math.min(sr.width - w - 10, br.left - sr.left));
    /* V13e retest-9: never over the neighbouring card's name band (the top 110 px of the row of cards) */
    const nameBand = cr.top - sr.top + 110;
    const y = Math.max(10, nameBand, Math.min(sr.height - ht - 10, br.top - sr.top - 12));
    card.style.left = `${Math.round(x)}px`; card.style.top = `${Math.round(y)}px`;
  }
  card.classList.remove("flipin"); void card.offsetWidth; card.classList.add("flipin");
  if (pinned) sfx("card");
}
function startSpells() {
  const panel = $("#panel-five"), card = $("#ttc"); if (!panel || !card) return;
  const hover = window.matchMedia("(hover: hover) and (pointer: fine)");
  const trig = (e) => e.target.closest && e.target.closest(".sp-tt");
  panel.addEventListener("click", (e) => { const t = trig(e); if (!t) return; e.preventDefault(); e.stopPropagation(); if (K.TT.open && K.TT.trigger === t && K.TT.pinned) K.ttClose(); else spellShow(t, true); });
  panel.addEventListener("mouseover", (e) => { const t = trig(e); if (t && hover.matches) spellShow(t, false); });
  panel.addEventListener("mouseout", (e) => { const t = trig(e); if (t && !K.TT.pinned) K.TT.hideT = setTimeout(() => { if (!K.TT.pinned) K.ttClose(); }, 160); });
  panel.addEventListener("focusin", (e) => { const t = trig(e); if (t) spellShow(t, false); });
  /* V13e retest-9: a turned card can be taller than the frame; once it has turned, its own button is brought into view */
  panel.addEventListener("click", (e) => { const f = e.target.closest && e.target.closest(".flip"); if (!f) return; const card = f.closest(".card"); setTimeout(() => { if (!card || !card.classList.contains("flipped")) return; const back = card.querySelector(".back .flip"); if (back) { try { back.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }); } catch (er) {} } }, (K.MOTION && K.MOTION.hero) || 500); });
}

// ---------------- 7. Nested definitions, two deep (interaction 9) ----------------
let pop2 = null;
function pop2El() { if (!pop2) { pop2 = h("div", { class: "gl-pop gl-pop2", id: "glpop2", role: "tooltip", hidden: "" }); document.body.append(pop2); } return pop2; }
function pop2Close() { if (!pop2 || pop2.hidden) return false; pop2.hidden = true; if (V.pop2From) V.pop2From.setAttribute("aria-expanded", "false"); V.pop2From = null; return true; }
function pop2Show(btn) {
  const g = K.glDef(btn.dataset.term); if (!g) return;
  const el = pop2El(), first = btn.closest("#glpop, #ttc, .gl-pop2");
  const parentCard = first && first.id === "glpop2" ? V.pop2Parent : first;
  if (V.pop2From && V.pop2From !== btn) V.pop2From.setAttribute("aria-expanded", "false");
  V.pop2From = btn; V.pop2Parent = parentCard; btn.setAttribute("aria-expanded", "true");
  const back = parentCard ? (parentCard.querySelector(".ttc-name, b") || {}).textContent || "" : "";
  el.replaceChildren(h("button", { type: "button", class: "gl-back", "aria-label": `Back to ${back}`, onclick: () => pop2Close() }, "‹ ", back), h("b", { text: g.term.charAt(0).toUpperCase() + g.term.slice(1) }), h("span", {}, ...dotted(g.def, [g.term, (K.glDef(back.trim()) || {}).term])));
  el.hidden = false;
  /* beside the first card: right of it when there is room, else under it */
  const r = (parentCard || btn).getBoundingClientRect(), w = Math.min(320, innerWidth - 24), m = 12;
  el.style.width = `${w}px`;
  let x = r.right + 10, y = r.top; if (x + w > innerWidth - m) { x = Math.max(m, Math.min(r.left, innerWidth - w - m)); y = r.bottom + 8; }
  const ht = el.offsetHeight || 120; if (y + ht > innerHeight - m) y = Math.max(m, innerHeight - ht - m);
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
  el.classList.remove("in"); void el.offsetWidth; el.classList.add("in");
  sfx("card");
}
/* the board's own card gets its words dotted once it shows (the board fills it in its click handler, before this one) */
function dotGlpop() {
  const pop = $("#glpop"); if (!pop || pop.hidden) return;
  const sp = pop.querySelector("span"); const term = (pop.querySelector("b") || {}).textContent || "";
  if (sp && !sp.querySelector(".gl2")) { const t = sp.textContent; sp.replaceChildren(...dotted(t, term.toLowerCase())); const g = K.glDef(term); if (g) sp.replaceChildren(...dotted(t, g.term)); }
}
function startNested() {
  document.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (pop2 && !pop2.hidden && !(t.closest && t.closest("#glpop2, #glpop, #ttc"))) pop2Close();
    if (pop2 && !pop2.hidden && t.closest && t.closest("#glpop2")) { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener("click", (e) => {
    const t = e.target;
    const b = t.closest && t.closest(".gl2[data-term]");
    if (b) { e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); e.stopPropagation(); if (V.pop2From === b && pop2 && !pop2.hidden) pop2Close(); else pop2Show(b); return; }
    if (t.closest && t.closest("#glpop2")) { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); return; }
    if (t.closest && t.closest(".gl[data-term]")) { pop2Close(); setTimeout(dotGlpop, 0); }
    else if (pop2 && !pop2.hidden && !(t.closest && t.closest("#glpop, #ttc"))) pop2Close();
  }, true);
  const pop = $("#glpop");
  if (pop && typeof MutationObserver === "function") new MutationObserver(() => { if (pop.hidden) pop2Close(); else dotGlpop(); }).observe(pop, { attributes: true, attributeFilter: ["hidden"], childList: true });
  const ttc = $("#ttc");
  if (ttc && typeof MutationObserver === "function") new MutationObserver(() => { if (ttc.hidden) pop2Close(); }).observe(ttc, { attributes: true, attributeFilter: ["hidden"] });
}

// ---------------- 8. New since you last looked (interaction 5) ----------------
const ROWS = {
  racials: [".rrow", (el) => el.dataset.key, (el) => el.textContent],
  ledger: ["#ledger-slip li, #ledger-slip .poll", (el, i) => (el.querySelector("strong") || {}).textContent || `i${i}`, (el) => el.textContent],
  signups: ["#dsu-body .trow", (el, i) => `${i}`, (el) => (el.querySelector(".trow-who") || el).textContent],
  five: ["#cards .card", (el) => el.dataset.slug, (el) => (el.querySelector(".front") || el).textContent],
  timeline: ["#rail .stop", (el) => el.dataset.ev, (el) => `${(el.querySelector("h3") || {}).textContent}|${([...el.querySelectorAll(".stop-body p")].find((p) => !p.classList.contains("state")) || {}).textContent || ""}`],
  legacy: [".rewards li", (el) => el.dataset.n, (el) => el.textContent],
};
const hash = (t) => { let x = 5381; const str = String(t).replace(/\s+/g, " ").trim(); for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
const sigs = () => { try { return JSON.parse(get("board-sigs") || "{}"); } catch (e) { return {}; } };
function sigOf(key) { const R = ROWS[key], panel = $(`#panel-${key}`); if (!R || !panel) return null; const out = {}; [...panel.querySelectorAll(R[0])].forEach((el, i) => { const k = R[1](el, i); if (k) out[k] = hash(R[2](el)); }); return out; }
const NEW = {};
function findNew() {
  const S = sigs();
  for (const key of Object.keys(ROWS)) {
    const old = S[key], cur = sigOf(key); if (!old || !cur) { NEW[key] = []; continue; }
    NEW[key] = Object.keys(cur).filter((k) => old[k] !== cur[k]);
  }
}
function sealRows(key) {
  const R = ROWS[key], panel = $(`#panel-${key}`); if (!R || !panel || !(NEW[key] || []).length) return;
  [...panel.querySelectorAll(R[0])].forEach((el, i) => { const k = R[1](el, i); if (NEW[key].includes(k) && !kid(el, "v-seal")) { el.classList.add("v-new"); el.prepend(h("span", { class: "v-seal", title: "New since you last looked", "aria-label": "New since you last looked" }, emb("seal"))); } });
}
function tileSeals() {
  for (const key of Object.keys(NEW)) {
    if (!NEW[key].length) continue;
    const t = document.querySelector(`#board [data-scene="${key}"] .tile-title`);
    if (t && !t.parentNode.querySelector(".new-badge")) t.parentNode.insertBefore(h("span", { class: "new-badge", text: "New" }), t.nextSibling);
  }
}
function looked(key) {
  if (!ROWS[key]) return;
  setTimeout(() => {
    if (SC.open !== key) return;
    const panel = $(`#panel-${key}`);
    panel.querySelectorAll(".v-seal").forEach((x) => { x.classList.add("v-seen"); setTimeout(() => rm(x), K.MOTION.hero); });
    panel.querySelectorAll(".v-new").forEach((x) => x.classList.remove("v-new"));
    NEW[key] = [];
    const S = sigs(); S[key] = sigOf(key); put("board-sigs", JSON.stringify(S));
    rm(document.querySelector(`#board [data-scene="${key}"] .new-badge`));
  }, 2000);
}
for (const [ev, key] of [["ledger", "ledger"], ["signups", "signups"], ["timeline", "timeline"]]) K.on(ev, () => sealRows(key));

// ---------------- 9. One first-visit glow on the five crests (interaction 10) ----------------
function glow() {
  if (V.glow || !FIRST || get("board-glowed")) return;
  const tile = document.querySelector("#board .t-five"); if (!tile) return;
  V.glow = true; /* V13e retest-13: remembered when the glow ends while the page is seen, not when it starts */
  const plate = h("span", { class: "glow-plate", "aria-hidden": "true", text: "Tap a face to meet them." });
  const body = tile.querySelector(".tile-body"); if (body) body.append(plate);
  tile.classList.add("glow-five");
  let on = true;
  const stop = (e) => { if (!on) return; on = false; tile.classList.remove("glow-five"); rm(plate); if (e !== "timer" || document.visibilityState === "visible") put("board-glowed", "1"); };
  setTimeout(() => stop("timer"), 8000);
  document.addEventListener("pointerdown", stop, true); document.addEventListener("keydown", stop, true);
  /* V13e perf: a scene opening ends it too (under a scene nobody sees the wall, and the pulse cost frames in the open) */
  K.sceneHooks.push((open) => { if (open) stop(); });
}

// ---------------- 10. Sign-ups from the board (the shared brain, stage 3) ----------------
const BR = { me: null, pend: {}, status: null };
const PEND_SAY = { sending: "Sending", waiting: "Waiting for Discord", stored: "Saved. Discord catches up when Leeroy is back.", saved: "Saved", newer: "Discord has a newer answer", failed: "Not sent" };
function suControls() {
  const act = $("#dsu-act"); if (!act) return;
  rm(act.querySelector(".su-states"));
  const B = window.BoardBrain, st = B ? B.status() : { base: null, key: false };
  const live = !!(st.base && st.key && BR.me);
  const mine = B && B.mine ? B.mine() : null, p = BR.pend.rsvp;
  const btns = K.RSVP_KEYS.map((k) => h("button", { type: "button", class: `su-st${p && p.value === k ? ` ${p.state}` : ""}`, "data-rsvp": k, "aria-pressed": String(!!((p && p.value === k && p.state !== "failed" && p.state !== "newer") || (!p && mine && mine.rsvp === k))), "aria-disabled": live ? null : "true", onclick: (e) => { if (!live) { /* V13e retest-11: a tap without a key says why, in the status line */ const pl = e.currentTarget.closest(".su-states"), pn = pl && pl.querySelector(".su-pend"), as = pl && pl.querySelector(".su-as"); if (pn && as) { pn.textContent = ""; requestAnimationFrame(() => { pn.textContent = as.textContent; }); as.classList.remove("nudge"); void as.offsetWidth; as.classList.add("nudge"); } sfx("chip"); return; } if (B) B.setRsvp(k); sfx("latch"); } }, h("img", { class: "su-pint", src: `img/pints/${k}.png`, alt: "", width: 36, height: 36, decoding: "async" }), K.RSVP_SAY[k]));
  const say = !st.base ? "Answers from this view go through Discord: the Sign-ups card." : !st.key ? "To answer here, tap My board link on the Sign-ups card in Discord. It opens this board as you." : st.keyBad ? "This board link is no longer valid. Tap My board link on the Sign-ups card again." : !BR.me ? "Checking who this board link belongs to." : `Answering as ${BR.me.name}.`;
  act.append(h("div", { class: `su-states${live ? "" : " off"}`, role: "group", "aria-label": "Your answer for launch night, from the board" }, h("p", { class: "su-as", text: say }), h("div", { class: "su-row" }, btns), h("p", { class: "su-pend", role: "status", "aria-live": "polite", text: p ? `${K.RSVP_SAY[p.value]}: ${PEND_SAY[p.state] || ""}${p.state === "newer" && p.other ? ` (${K.RSVP_SAY[p.other] || p.other})` : ""}.` : "" })));
}
K.on("signups", () => { suControls(); });
function mirrorIn(sig) {
  if (!sig || !Array.isArray(sig.entries)) return;
  D.signups = { ...(D.signups || {}), updated: sig.updated || (D.signups && D.signups.updated) || null, entries: sig.entries, ...(sig.tallies ? { tallies: { ...(D.signups && D.signups.tallies), ...sig.tallies } } : {}) };
  for (const f of ["tiles", "signups", "tonight"]) { try { K.render[f](); } catch (e) { console.error(f, e); } }
  paths("signups");
}
function startBrain() {
  const B = window.BoardBrain; if (!B) return;
  B.start({
    state: (sig) => mirrorIn(sig),
    me: (me) => {
      BR.me = me;
      /* the I-am picker is preset to the key's person when nobody is picked (writes always go out as the key's owner) */
      if (me && !MEM.me() && D.party) { const m = D.party.members.find((x) => K.cleanName(x.name).toLowerCase() === K.cleanName(me.name).toLowerCase()); if (m && MEM.setMe(MEM.slug(m.name))) { try { K.render.tonight(); } catch (e) {} } }
      suControls();
    },
    pending: (p) => { BR.pend = p || {}; suControls(); },
    status: (st) => { BR.status = st; },
    journey: (j) => { if (j !== journey()) setJourney(j, "mirror"); },
  });
}
K.on("forget", () => { if (window.BoardBrain) window.BoardBrain.forget(); put("board-sigs", null); setJourney("curious", "quiet"); V.picked = false; });

// ---------------- the tab rail's arrows on tablets (retest-16) ----------------
function startRailArrows() {
  const tabs = $("#tabs"); if (!tabs || $(".tabs-arrow")) return;
  const mk = (d) => h("button", { type: "button", class: `tabs-arrow ${d < 0 ? "prev" : "next"}`, "aria-label": d < 0 ? "Earlier scenes" : "Later scenes", tabindex: "-1", onclick: () => { try { tabs.scrollBy({ left: d * tabs.clientWidth * 0.7, behavior: reduced() ? "auto" : "smooth" }); } catch (e) { tabs.scrollLeft += d * tabs.clientWidth * 0.7; } } }, d < 0 ? "‹" : "›");
  const prev = mk(-1), next = mk(1), wrap = h("div", { class: "tabs-wrap" });
  tabs.parentNode.insertBefore(wrap, tabs); wrap.append(prev, tabs, next);
  const upd = () => { const over = tabs.scrollWidth > tabs.clientWidth + 4; prev.hidden = !over || tabs.scrollLeft < 4; next.hidden = !over || tabs.scrollLeft > tabs.scrollWidth - tabs.clientWidth - 4; };
  tabs.addEventListener("scroll", upd, { passive: true }); addEventListener("resize", upd, { passive: true });
  K.on("scene", () => { if (innerWidth >= 700) setTimeout(upd, K.motionMs("move") + 120); }); /* after the opening has moved, never inside its frames */
  upd();
}

// ---------------- keys: Esc steps back out of a zoom, a card, a second card before it closes a scene ----------------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (pop2Close()) { e.preventDefault(); sfx("esc"); return; }
  if (SC.open === "roads" && V.zoom) { e.preventDefault(); zoomOut(true); return; }
  if (SC.open === "five" && K.TT.open) { e.preventDefault(); K.ttClose("focus"); sfx("esc"); }
});

// ---------------- wiring ----------------
startNested(); /* before the board's own glossary handlers, so a second card never closes the first */
K.on("rendered", () => { applyDepth(); paths(); findNew(); for (const k of Object.keys(ROWS)) sealRows(k); });
K.on("booted", () => {
  startJourneySwitch(); startSpells(); startRailArrows(); tileSeals();
  startBrain();
  /* the Guided path follows the person and the data */
  for (const ev of ["ledger", "timeline", "signups"]) K.on(ev, () => paths(ev));
});
K.on("scene", (key) => { applyDepth(); looked(key); sealRows(key); });
/* V13e perf: the glow waits until the wall has settled after the close (its first frames used to land in the close) */
K.on("closed", (k) => { if (k === "tonight") setTimeout(glow, K.motionMs("move") + 900); });
K.on("legacy", () => sealRows("legacy"));
for (const f of ["races", "cards"]) { const orig = K.render[f]; K.render[f] = () => { orig(); applyDepth(); sealRows(f === "races" ? "racials" : "five"); }; }
window.__v13d = Object.freeze({ journey, setJourney, landOn, zoomTo, zoomOut, steps, nextDeadline, preview, status: () => ({ journey: journey(), picked: V.picked, zoom: V.zoom, dial: V.dial ? V.dial.v : null, glow: V.glow, isNew: JSON.parse(JSON.stringify(NEW)), brain: window.BoardBrain ? window.BoardBrain.status() : null }) });
})();
