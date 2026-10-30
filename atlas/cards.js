// The place card, the zone card, the plan panel and the keyboard's places list (contract 3.3, 4.2). DOM only, built with the
// board's own h(). Library voice throughout: it says what is known and how sure the board is, and never tells anyone what
// to do. Names come from party.json at run time (the publish step maps them to display names).
export const KIND = { zone: "zone", subzone: "area", city: "city", hub: "town", flight: "flight point", zeppelin: "zeppelin tower", dungeon: "dungeon", raid: "raid", start: "starting place", meet: "meeting point" };
const LEVEL_SAY = { confirmed: "confirmed", likely: "likely", speculative: "speculative" };
const title = (s) => s.replace(/-/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
// "the Undercity", "the Crossroads", "Orgrimmar": the way a sentence names a place
export const spoken = (name) => (/^the /i.test(name) ? `the ${name.slice(4)}` : name === "Undercity" ? "the Undercity" : name);
export const pageHref = (page) => `#library.${page.replace("/", ".")}`;
export const pageName = (page) => { const p = page.split("/"); return `${title(p[1] || p[0])} (${title(p[0])})`; };

export function createCards(o) {
  const { host, h } = o, C = { open: null, planOpen: false, byId: new Map(o.places.places.map((p) => [p.id, p])), zoneById: new Map(o.world.zones.map((z) => [z.id, z])) };
  const jr = () => (typeof o.journey === "function" ? o.journey() : "curious") || "curious";
  const card = h("aside", { id: "atlas-card", class: "atlas-card", role: "region", "aria-label": "Place card", hidden: true });
  const plan = h("aside", { id: "atlas-plan", class: "atlas-plan", role: "region", "aria-label": "Day-one plan", hidden: true });
  const list = h("ul", { id: "atlas-places", class: "atlas-places", "aria-label": "Places in view" });
  host.append(card, plan, list);
  const zoneName = (id) => (C.zoneById.get(id) ? C.zoneById.get(id).name : "");
  const chip = (text, cls, attrs) => h("span", { class: `atlas-chip ${cls || ""}`, ...(attrs || {}), text });
  const copyChip = (text, status) => {
    const b = h("button", { type: "button", class: "atlas-chip atlas-copy", "aria-label": `Copy ${text}`, text });
    b.addEventListener("click", () => o.copy(text));
    return h("span", { class: "atlas-way" }, b, status ? chip(LEVEL_SAY[status] || status, `st-${status}`) : null);
  };
  const closeBtn = (f) => { const b = h("button", { type: "button", class: "atlas-x", "aria-label": "Close", text: "Close" }); b.addEventListener("click", f); return b; };
  const sec = (label, body) => (body ? h("div", { class: "atlas-sec" }, h("h3", { text: label }), body) : null);

  // library pages and asked questions that name an id
  const pagesFor = (id, extra) => {
    const out = new Set(extra || []);
    for (const [pg, ids] of Object.entries((o.links && o.links.pages) || {})) if (ids.includes(id)) out.add(pg);
    return [...out];
  };
  const questionsFor = (id) => (((o.links && o.links.questions) || []).filter((q) => q.places.includes(id))).slice(0, 5);
  const libBlock = (id, extra) => {
    const pgs = pagesFor(id, extra); if (!pgs.length) return null;
    return sec("In the library", h("ul", { class: "atlas-links" }, pgs.map((pg) => h("li", {}, h("a", { href: pageHref(pg), text: pageName(pg) })))));
  };
  const askBlock = (id) => {
    const qs = questionsFor(id); if (!qs.length) return null;
    return sec("Friends asked", h("ul", { class: "atlas-asked" }, qs.map((q) => h("li", {}, h("q", { text: q.text }), h("span", { class: "atlas-when", text: ` asked on ${q.day}` })))));
  };
  const levelLine = (lv) => {
    if (!lv) return null;
    const src = lv.src ? h("a", { class: "atlas-chip", href: pageHref(lv.src.page), text: "leveling/zones" }) : null;
    return h("p", { class: "atlas-levels" }, `Levels ${lv.min} to ${lv.max} `, chip(LEVEL_SAY[lv.status] || lv.status, `st-${lv.status}`), src);
  };

  C.showPlace = (p) => {
    C.open = { kind: "place", id: p.id };
    const full = jr() !== "guided", ev = jr() === "everything", z = C.zoneById.get(p.zone);
    const kids = [h("div", { class: "atlas-head" }, h("h2", { text: p.name }), closeBtn(() => o.act.close()))];
    kids.push(h("p", { class: "atlas-sub", text: `${KIND[p.kind] || p.kind}${z ? ` in ${z.name}` : ""}` }));
    if (full) {
      if (p.zone_pct) kids.push(h("p", { class: "atlas-line" }, copyChip(`/way ${p.zone_pct[0].toFixed(1)} ${p.zone_pct[1].toFixed(1)}`, p.src && p.src.status), h("span", { class: "atlas-note", text: p.src && p.src.status === "likely" ? " launch night will check it in the game" : "" })));
      if (p.levels) kids.push(levelLine(p.levels));
      if (p.players) kids.push(h("p", { class: "atlas-line", text: `${p.players} players` }));
      kids.push(libBlock(p.id, p.library), askBlock(p.id));
      if (ev) kids.push(h("p", { class: "atlas-line atlas-fine", text: `World yards ${p.world ? p.world.map((n) => Math.round(n)).join(", ") : "unknown"}; A-units ${p.a.join(", ")}` }));
      const plan2 = h("button", { type: "button", class: "atlas-btn", text: "Plan a meetup here" });
      plan2.addEventListener("click", () => o.act.plan(p.id));
      kids.push(h("div", { class: "atlas-actions" }, plan2));
      if (p.src) kids.push(h("p", { class: "atlas-src" }, chip(`client table ${p.src.table} ${p.src.id}`, "atlas-source"), ev ? chip(LEVEL_SAY[p.src.status] || p.src.status, `st-${p.src.status}`) : null));
    }
    card.replaceChildren(...kids.filter(Boolean));
    card.setAttribute("aria-label", `${p.name} card`); card.hidden = false; card.setAttribute("data-card", p.id);
    return card;
  };
  C.showZone = (z) => {
    C.open = { kind: "zone", id: z.id };
    const full = jr() !== "guided";
    const kids = [h("div", { class: "atlas-head" }, h("h2", { text: z.name }), closeBtn(() => o.act.close()))];
    kids.push(h("p", { class: "atlas-sub", text: `zone${z.faction && z.faction !== "contested" ? `, ${z.faction} side` : ""}` }));
    if (full) {
      kids.push(levelLine(z.levels) || h("p", { class: "atlas-line", text: "No level range recorded in the library yet." }));
      const inZone = o.places.places.filter((p) => p.zone === z.id && p.kind !== "subzone" && p.kind !== "zone");
      if (inZone.length) kids.push(sec("What is there", h("ul", { class: "atlas-there" }, inZone.map((p) => { const b = h("button", { type: "button", class: "atlas-link", text: `${p.name} (${KIND[p.kind] || p.kind})` }); b.addEventListener("click", () => o.act.openPlace(p.id)); return h("li", {}, b); }))));
      kids.push(libBlock(z.id), askBlock(z.id));
      const here = (o.party.members || []).filter((m) => m.start_zone === z.name);
      if (here.length) kids.push(sec("Starts here", h("p", { class: "atlas-line", text: here.map((m) => m.name).join(", ").replace(/, ([^,]*)$/, " and $1") })));
    }
    card.replaceChildren(...kids.filter(Boolean));
    card.setAttribute("aria-label", `${z.name} card`); card.hidden = false; card.setAttribute("data-card", z.id);
    return card;
  };
  C.hideCard = () => { const was = C.open; C.open = null; card.hidden = true; card.removeAttribute("data-card"); card.replaceChildren(); return was; };

  // ---------- the plan panel ----------
  const placeOf = (id) => C.byId.get(id);
  const stepsText = (w, graph) => {
    const out = [];
    w.route.forEach((id, i) => {
      if (!i) return;
      const p = placeOf(id), e = graph.edges.get(w.edges[i - 1]);
      if (e && (e.mode === "zeppelin" || e.mode === "boat")) { if (!out.includes("the zeppelin") && e.mode === "zeppelin") out.push("the zeppelin"); return; }
      if (p && p.kind === "zeppelin") return;
      out.push(p ? spoken(p.name) : id);
    });
    if (!out.length) return "";
    return out.length === 1 ? `then ${out[0]}` : `${out.slice(0, -1).join(", ")}, then ${out[out.length - 1]}`;
  };
  const reasons = (w, graph) => {
    const r = [];
    if (w.edges.some((id) => ((graph.edges.get(id).src || {}).kind) === "straight")) r.push("straight courses");
    if (w.edges.some((id) => ((graph.edges.get(id) || {}).mode) === "zeppelin")) r.push("the zeppelin's wait not counted");
    if (w.edges.some((id) => ((graph.edges.get(id).src || {}).kind) === "taxi")) r.push("flight path geometry");
    return r.join(", ");
  };
  C.planLine = (w, graph, name) => {
    const start = placeOf(w.from), z = start ? C.zoneById.get(start.zone) : null, mins = Math.round(w.minutes);
    const where = z ? z.name : start ? start.name : w.from;
    const rs = reasons(w, graph);
    return `${name} wakes in ${where}: ${stepsText(w, graph)}. About ${mins} minute${mins === 1 ? "" : "s"} on foot (${w.status}${rs ? `: ${rs}` : ""}).`;
  };
  C.showPlan = (pl, graph, meta) => {
    C.planOpen = true; const ev = jr() === "everything";
    const members = new Map((o.party.members || []).map((m) => [m.class_key, m]));
    const mp = placeOf(pl.meet), mst = meta.status;
    const meetSay = mst === "agreed" ? "agreed" : mst === "leading" ? "leading on the sign-up sheet" : "not agreed yet; shown so the lines have somewhere to end";
    const rows = pl.who.map((w) => {
      const m = members.get(w.class_key), nm = m ? m.name : "A friend";
      const b = h("button", { type: "button", class: "atlas-who", "data-who": w.class_key, text: C.planLine(w, graph, nm) });
      b.addEventListener("click", () => o.act.planWho(pl.meet, w.class_key));
      return h("li", {}, b, ev ? h("span", { class: "atlas-fine", text: ` ${w.yards} yards` }) : null);
    });
    const send = h("button", { type: "button", class: "atlas-btn", text: "Send the plan card" });
    send.addEventListener("click", () => o.act.send(pl.meet));
    // on a phone the panel opens folded to its title bar, so the map stays free for taps and pinches
    const folded = typeof o.foldFirst === "function" ? !!o.foldFirst() : false;
    const fold = h("button", { type: "button", class: "atlas-fold", "aria-expanded": folded ? "false" : "true", "aria-controls": "atlas-plan", text: folded ? "Show lines" : "Hide lines" });
    fold.addEventListener("click", () => C.foldPlan(!plan.classList.contains("folded")));
    plan.classList.toggle("folded", folded);
    plan.replaceChildren(
      h("div", { class: "atlas-head" }, h("h2", { text: "Day-one plan" }), h("span", { class: "atlas-head-b" }, fold, closeBtn(() => o.act.closePlan()))),
      h("p", { class: "atlas-sub", text: `Meeting point: ${mp ? mp.name : pl.meet} (${meetSay})` }),
      h("ul", { class: "atlas-lines" }, rows),
      h("p", { class: "atlas-fine", text: "Walking minutes come from yards at 7 a second (Classic run speed, likely). Roads are not in the client tables, so courses are straight lines, labelled." }),
      h("div", { class: "atlas-actions" }, send));
    plan.hidden = false; return plan;
  };
  C.foldPlan = (on) => {
    plan.classList.toggle("folded", !!on);
    const b = plan.querySelector(".atlas-fold"); if (b) { b.setAttribute("aria-expanded", on ? "false" : "true"); b.textContent = on ? "Show lines" : "Hide lines"; }
    if (o.act.folded) o.act.folded(!!on);
    return !!on;
  };
  C.hidePlan = () => { const was = C.planOpen; C.planOpen = false; plan.hidden = true; plan.replaceChildren(); return was; };

  // ---------- the keyboard's list: one real button per place in view ----------
  let sig = "";
  C.places = (items, onFocus) => {
    const s = items.map((p) => p.id).join(",");
    if (s === sig) return false;
    sig = s;
    list.replaceChildren(...items.slice(0, 80).map((p) => {
      const b = h("button", { type: "button", "data-place": p.id, "aria-label": `${p.name}, ${KIND[p.kind] || p.kind}`, text: p.name });
      b.addEventListener("focus", () => onFocus(p)); b.addEventListener("click", () => o.act.openPlace(p.id));
      return h("li", {}, b);
    }));
    return true;
  };
  C.list = list; C.card = card; C.plan = plan;
  C.destroy = () => { for (const e of [card, plan, list]) { if (e.parentNode) e.parentNode.removeChild(e); } };
  return C;
}
