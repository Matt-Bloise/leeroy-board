/* V16 (board/V16-DECIDE-SPEC.md): What to decide. Per friend, what the party records leave open (professions, the spec at 40,
   the first talents, what is locked), by Blizzard's dates only, and what each option changes, every line with its status and
   source, from data/decide.json (built from the records, the timeline, the client table and the wiki). Plus the party's
   composition: roles by level, who gives which buff to whom, what nobody at the table plays, has or gives. Runs after
   js/seals.js through the page's own hooks (window.__boardKit): it adds its tab and panel itself (so a merge never has to
   reconcile index.html), reads the picked person from the board's memory, and gives the seal a mechanic: pressing it turns the
   coin to the next friend's choices. Facts and options only; it never recommends. (2026-10-30) */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h, s, D, MEM, SC } = K;
const KEY = "decide", TITLE = "What to decide";
const DV = { data: null, p: null, who: null, order: [] };
const STATE = { open: "Still open", declared: "On the Party Board", chat: "Said in chat", none: "Nothing recorded", locked: "Locked in" };
const members = () => (D.party ? D.party.members : []);
const byKey = (k) => members().find((m) => m.class_key === k) || null;
const nameOf = (k) => { const m = byKey(k); return m ? m.name : k; };
/* "{class_key}" in a data line is a name slot: the page fills it from party.json, so the data file never carries a name */
const slot = (t) => String(t).replace(/\{([a-z]+)\}/g, (_, k) => nameOf(k));
const snd = (n) => { try { if (window.BoardSound) window.BoardSound.play(n); } catch (e) {} };
const hap = (n) => { try { if (window.BoardHaptics) window.BoardHaptics.fire(n); } catch (e) {} };
const dayOf = (iso) => { try { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`)); } catch (e) { return iso; } };
const labels = () => (DV.data && DV.data.labels) || { forever: "Forever", classic: "Classic baseline", unknown: "Unknown" };
const slugOf = (k) => { const m = byKey(k); return m ? MEM.slug(m.name) : null; };
/* a crest beside a name that is already text: no title, so the hover hook neither tips it nor makes it a second tab stop */
const crest = (m) => { const i = K.crestMark(m); i.removeAttribute("title"); return i; };
const byslug = (slug) => members().find((m) => MEM.slug(m.name) === slug) || null;

/* the tab and the panel, placed before Next steps (the last scene) at script load; board.js reads them at boot */
function mount() {
  const tabs = $("#tabs"), body = $("#sheet-body"), tonightTab = $("#tab-tonight"), tonightPanel = $("#panel-tonight");
  if (!tabs || !body || $("#tab-decide")) return;
  const ico = s("svg", { class: "emblem", viewBox: "0 0 24 24" }, s("path", { d: "M12 3.5v16M8 19.5h8M5 7.5h14" }), s("path", { d: "M5 7.5l-2.8 6.2a2.8 2.8 0 0 0 5.6 0zM19 7.5l-2.8 6.2a2.8 2.8 0 0 0 5.6 0z" }));
  const tab = h("button", { class: "tab", type: "button", role: "tab", id: "tab-decide", "data-tab": KEY, "aria-controls": "panel-decide", "aria-selected": "false", tabindex: "-1" }, h("span", { class: "tab-ico", "aria-hidden": "true" }, ico), TITLE);
  tabs.insertBefore(tab, tonightTab && tonightTab.parentNode === tabs ? tonightTab : $("#tab-ind"));
  const panel = h("div", { class: "panel dc", role: "tabpanel", id: "panel-decide", "aria-labelledby": "tab-decide", tabindex: "0", hidden: true },
    h("p", { class: "lede", id: "dc-lede", text: "What is still open for each of us, what the game says about each option, and the only dates Blizzard has given. Facts, not advice." }),
    h("div", { class: "deep-who dc-who", id: "dc-who", role: "group", "aria-label": "Whose choices" }),
    h("div", { class: "dc-dates", id: "dc-dates", role: "group", "aria-label": "Blizzard's dates" }),
    h("section", { class: "dc-main", id: "dc-main", "aria-label": "Choices" }),
    h("section", { class: "dc-party", id: "dc-party", "aria-label": "Party composition" }));
  body.insertBefore(panel, tonightPanel && tonightPanel.parentNode === body ? tonightPanel : null);
}
mount();

const get = () => (DV.data ? Promise.resolve(DV.data) : (DV.p ||= fetch("data/decide.json", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(`data/decide.json answered ${r.status}`); return r.json(); }).then((d) => { DV.data = d; DV.order = [...d.people.map((p) => p.class_key), "all"]; return d; }).catch((e) => { DV.p = null; throw e; })));
K.decideData = get; /* Phase 0 (2026-10-30): the party sheet (js/sheet.js) reads the same file through the same cache */
const defaultWho = () => { const m = MEM.member(); return m && DV.data && DV.data.people.some((p) => p.class_key === m.class_key) ? m.class_key : "all"; };
const who = () => DV.who || defaultWho();

/* one person's open items in a sentence, from the states alone */
function summary(p) {
  const open = p.decisions.filter((x) => x.state === "open"), chat = p.decisions.filter((x) => x.state === "chat"), spec = p.decisions.find((x) => x.key === "spec40");
  const bits = [open.length ? `Still open on the Party Board: ${K.andList(open.map((x) => x.title.toLowerCase()))}.` : "Nothing still open on the Party Board."];
  if (chat.length) bits.push(`${K.andList(chat.map((x) => x.title))}: said in chat, not on a card yet.`);
  if (spec) bits.push(spec.at40 ? "The board names a change at 40." : "No change at 40 on the board.");
  return bits.join(" ");
}
function eventWhen(d, key) {
  const e = d.dates[key]; if (!e) return "";
  if (key === "names_open") return `${K.fmtWhen(e.epoch)}, until the end of ${e.until}, ${e.until_zone} time.`;
  if (key === "raids") return `${K.fmtWhen(e.epoch, { time: false })}.`;
  return `${K.fmtWhen(e.epoch, { rel: true })}.`;
}
function dateLines(d) {
  const now = Date.now() / 1000, n = d.dates.names_open, l = d.dates.launch, r = d.dates.raids;
  const row = (label, when, note) => h("p", { class: "dc-date" }, h("b", { text: `${label}: ` }), h("span", { class: "dc-when", text: when }), note ? h("span", { class: "dc-now", text: ` ${note}` }) : null);
  return [
    n ? row("Names", `opened ${K.fmtWhen(n.epoch)}, until the end of ${n.until}, ${n.until_zone} time`, n.until_epoch && now < n.until_epoch ? (now >= n.epoch ? "(open now, pack holders)" : "") : "(closed)") : null,
    l ? row("Launch", K.fmtWhen(l.epoch, { rel: true }), "") : null,
    r ? row("Raids open", K.fmtWhen(r.epoch, { time: false }), "(no opening hour announced)") : null,
  ].filter(Boolean);
}
function srcEl(src) {
  if (!src) return null;
  if (src.kind === "wiki") {
    const tok = `library.${String(src.page).replace("/", ".")}${src.key ? `~${src.key}` : ""}`;
    return h("span", { class: "dc-src" }, h("a", { class: "dc-ref", href: `#${tok}` }, src.open ? "an open question in the library" : src.label), src.accessed ? `, read ${dayOf(src.accessed)}` : "", h("span", { class: "dc-id", "data-j": "e", text: ` (${src.page}${src.key ? `, ${src.key}` : ""}${src.tier === null || src.tier === undefined ? "" : `, tier ${src.tier}`})` }));
  }
  if (src.kind === "client") return h("span", { class: "dc-src" }, `client table ${String(src.build || "").split(".").pop()}`, h("span", { class: "dc-id", "data-j": "e", text: ` (${[src.spells ? `spell ${src.spells.join(", ")}` : src.spell ? `spell ${src.spell}` : "", src.talent ? `talent ${src.talent}` : "", src.items ? `item ${src.items.join(", ")}` : ""].filter(Boolean).join(", ")})` }));
  if (src.kind === "board") return h("span", { class: "dc-src", text: "the Party Board" });
  if (src.kind === "timeline") return h("span", { class: "dc-src", text: "Blizzard's calendar" });
  return h("span", { class: "dc-src", text: "the library" });
}
function lineEl(l) {
  return h("li", { class: "dc-line", "data-status": l.status }, h("span", { class: `st st-${l.status}`, text: labels()[l.status] || l.status }), " ", h("b", { class: "dc-l", text: `${l.label}: ` }), h("span", { class: "dc-t", text: slot(l.text) }), srcEl(l.src));
}
const OPT_H = { professions: "Each profession, what it makes", spec40: "Each tree, what the game says", talents: "Row one of each tree, from the client table" };
function card(d, x) {
  return h("details", { class: "dc-card", "data-key": x.key, "data-state": x.state },
    h("summary", { class: "dc-sumy" }, h("span", { class: "dc-title", text: x.title }), h("span", { class: "dc-state", "data-state": x.state, text: STATE[x.state] || x.state }), h("span", { class: "dc-stext", text: slot(x.state_text) })),
    h("div", { class: "dc-body" },
      h("p", { class: "dc-by" }, h("b", { text: "By when: " }), x.by.text, x.by.event ? ` ${eventWhen(d, x.by.event)}` : ""),
      x.lines.length ? h("ul", { class: "dc-lines" }, x.lines.map(lineEl)) : null,
      x.options.length ? h("div", { class: "dc-opts" }, h("h4", { class: "dc-h4", text: OPT_H[x.key] || "Options" }), ...x.options.map((o) => h("details", { class: "dc-opt", "data-name": o.name, ...(o.board ? { "data-board": "1" } : {}) },
        h("summary", {}, h("b", { text: o.name }), o.board ? h("span", { class: "dc-state", "data-state": "declared", text: "named on the Party Board" }) : null, h("span", { class: "dc-n", text: `${o.lines.length} ${o.lines.length === 1 ? "line" : "lines"}` })),
        h("ul", { class: "dc-lines" }, o.lines.map(lineEl))))) : null,
      x.group.length ? h("div", { class: "dc-group" }, h("h4", { class: "dc-h4", text: "What the group has" }), h("ul", { class: "dc-lines" }, x.group.map(lineEl))) : null));
}
function personView(d, key) {
  const m = byKey(key), p = d.people.find((x) => x.class_key === key);
  if (!m || !p) return h("p", { class: "dc-sum", text: "No record for that person on the board." });
  return h("div", { class: "dc-person", "data-who": key },
    h("h3", { class: "dc-name" }, crest(m), `${m.name}: ${m.race} ${m.class}`),
    h("p", { class: "dc-sum", text: summary(p) }),
    h("div", { class: "dc-cards" }, p.decisions.map((x) => card(d, x))));
}
function allView(d) {
  return h("div", { class: "dc-person", "data-who": "all" }, h("h3", { class: "dc-name", text: "All five" }), h("ul", { class: "dc-all" }, d.people.map((p) => {
    const m = byKey(p.class_key); if (!m) return null;
    return h("li", { class: "dc-row", style: `--cc: ${K.classVar(m.class_key)}` },
      h("button", { type: "button", class: "dc-open", "aria-label": `${m.name}: open their choices`, onclick: () => pick(m.class_key) }, crest(m), h("b", { text: m.name })),
      h("span", { class: "dc-rowt", text: `${m.race} ${m.class}. ${summary(p)}` }));
  })));
}
const tick = () => s("svg", { class: "dc-tick", viewBox: "0 0 24 24", role: "img", "aria-label": "yes" }, s("path", { d: "M5 12.5l4.5 4.5L19 7" }));
function partyView(d) {
  const P = d.party, ms = members(), names = (ks) => (ks.length ? K.andList(ks.map(nameOf)) : "nobody");
  const roles = h("div", { class: "dc-sect" }, h("h4", { class: "dc-h4", text: "Roles by level" }),
    h("table", { class: "dc-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Levels" }), h("th", { scope: "col", text: "Tank" }), h("th", { scope: "col", text: "Healers" }), h("th", { scope: "col", text: "Damage" }))),
      h("tbody", {}, P.brackets.map((b) => h("tr", {}, h("th", { scope: "row", text: `${b.from} to ${b.to}` }), h("td", { text: `${b.tank.length}: ${names(b.tank)}` }), h("td", { text: `${b.healer.length}: ${names(b.healer)}` }), h("td", { text: `${b.damage.length}: ${names(b.damage)}` }))))),
    h("p", { class: "dc-note", text: `${P.brackets.map((b) => b.note).filter((x, i, a) => a.indexOf(x) === i).join(". ")}.` }),
    h("ul", { class: "dc-lines" }, P.role_lines.map(lineEl)));
  const givers = [...new Set(P.buffs.map((b) => b.giver))];
  const grid = h("div", { class: "dc-grid" }, h("table", { class: "dc-table dc-bufft" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Buff" }), ...ms.map((m) => h("th", { scope: "col" }, h("img", { class: "crest-mark", src: `img/crests/${m.class_key}.png`, alt: "", width: 56, height: 56, decoding: "async" }), h("span", { class: "dc-colname", text: m.name }))))),
    h("tbody", {}, givers.flatMap((g) => [h("tr", { class: "dc-giver" }, h("th", { scope: "row", colspan: String(ms.length + 1), text: `${nameOf(g)} gives` })), ...P.buffs.filter((b) => b.giver === g).map((b) => h("tr", {}, h("th", { scope: "row", text: b.name }), ...ms.map((m) => h("td", {}, b.to.includes(m.class_key) ? tick() : h("span", { class: "sr-only", text: "no" })))))]))));
  const list = h("ul", { class: "dc-blist" }, givers.map((g) => h("li", {}, h("b", { text: `${nameOf(g)} gives: ` }), P.buffs.filter((b) => b.giver === g).map((b) => `${b.name} (${b.to.length === ms.length ? "everyone" : names(b.to)})`).join("; "), ".")));
  const buffs = h("div", { class: "dc-sect" }, h("h4", { class: "dc-h4", text: `Who gives which buff to whom (${P.buffs.length})` }), h("p", { class: "dc-note", text: "From Who buffs whom: a buff lands on everyone, on the tank, on the healers or on the two melee fighters. Every number by level is on that scene." }), grid, list);
  const nb = (title, items) => h("div", { class: "dc-nb" }, h("b", { text: title }), h("ul", { class: "dc-lines" }, items));
  const nobody = h("div", { class: "dc-sect dc-nobody" }, h("h4", { class: "dc-h4", text: "Nobody at this table for" }),
    nb(`Classes: ${K.andList(P.nobody.classes.map((c) => c.name))}`, P.nobody.classes.flatMap((c) => c.lines.map((l) => lineEl({ ...l, label: `${c.name}: ${l.label}` })))),
    nb(`Professions nobody has recorded: ${P.nobody.professions.length ? K.andList(P.nobody.professions.map((c) => c.name)) : "none of the nine"}`, P.nobody.professions.flatMap((c) => c.lines.map((l) => lineEl({ ...l, label: `${c.name}: ${l.label}` })))),
    nb("Secondary skills nobody has recorded", P.nobody.secondaries.map(lineEl)),
    nb(`Buffs nobody gives: a Shaman's (${P.nobody.buffs.length})`, P.nobody.buffs.map((b) => h("li", { class: "dc-line" }, h("b", { class: "dc-l", text: `${b.name}: ` }), h("span", { class: "dc-t", text: b.lands_text })))));
  const facts = h("div", { class: "dc-sect" }, h("h4", { class: "dc-h4", text: "Group sizes and tuning" }), h("ul", { class: "dc-lines" }, P.lines.map(lineEl)));
  const b0 = P.brackets[0], b1 = P.brackets[1];
  const sumText = `${b0.tank.length} tank, ${b0.healer.length} ${b0.healer.length === 1 ? "healer" : "healers"} to ${b0.to}${b1 ? `, then ${b1.healer.length}` : ""}; ${P.buffs.length} buffs between the five; nobody for ${P.nobody.classes.length} classes.`;
  return h("details", { class: "dc-card dc-partyc", id: "dc-party-card" }, h("summary", { class: "dc-sumy" }, h("span", { class: "dc-title", text: "Party composition" }), h("span", { class: "dc-stext", text: sumText })), h("div", { class: "dc-body" }, roles, buffs, nobody, facts));
}
function render() {
  const panel = $("#panel-decide"), d = DV.data; if (!panel || !d || !D.party) return;
  const w = who();
  $("#dc-who").replaceChildren(h("b", { class: "dc-q", text: "Whose choices?" }),
    ...members().map((m) => h("button", { type: "button", class: "lib-tool dc-pill", "data-who": m.class_key, "aria-pressed": String(w === m.class_key), style: `--cc: ${K.classVar(m.class_key)}`, onclick: () => pick(m.class_key) }, crest(m), m.name)),
    h("button", { type: "button", class: "lib-tool dc-pill", "data-who": "all", "aria-pressed": String(w === "all"), onclick: () => pick("all") }, "All five"));
  $("#dc-dates").replaceChildren(...dateLines(d));
  const main = $("#dc-main"); main.replaceChildren(w === "all" ? allView(d) : personView(d, w));
  $("#dc-party").replaceChildren(partyView(d));
  if (K.JR() === "everything") panel.querySelectorAll("details").forEach((x) => { x.open = true; });
  K.emit("decide", w);
}
function pick(w, quiet) {
  const was = who(); DV.who = w;
  const main = $("#dc-main"); if (main) { main.classList.remove("dc-in"); void main.getBoundingClientRect(); main.classList.add("dc-in"); }
  render();
  if (SC.open === KEY) { const slug = w === "all" ? null : slugOf(w); try { K.setHash(slug ? `${KEY}.${slug}` : KEY, false); } catch (e) {} }
  if (!quiet) { if (was !== w) { snd("page"); hap("tick"); } const b = $(`#dc-who [data-who="${w}"]`); if (b) { try { b.focus({ preventScroll: true }); } catch (e) {} } }
}
function fail(e) {
  const main = $("#dc-main"); if (main && !DV.data) main.replaceChildren(h("p", { class: "dc-sum", text: `The decision data did not load (${e && e.message ? e.message : "no file"}). A refresh may help.` }));
}
/* what the panel shows now; a render happens only when that differs from what it should show, so open cards stay open across
   a tab switch and the idle prefetch never snaps a fold shut under the reader */
const shown = () => { const p = $("#dc-main .dc-person"); return p ? p.dataset.who : null; };
/* opening the scene: the landing hash (#decide.<slug>) picks the person, then the data renders */
K.on("scene", (k) => {
  if (k !== KEY) return;
  const L = SC.land; let want = null;
  if (L && L.key === KEY && L.sub) { const m = byslug(L.sub); want = m ? m.class_key : L.sub === "all" ? "all" : null; }
  get().then(() => { if (want) { DV.who = want; render(); } else if (shown() !== who()) render(); }, fail);
});
/* the board's picked person (Next steps, Buffs) is this scene's default until a pill says otherwise */
K.on("tonight", () => { if (DV.data && SC.open === KEY && shown() !== who()) render(); });
/* the data is small and local: it is read on the first idle moment after boot, so the first open draws at once */
K.on("booted", () => { (window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(() => { get().then(() => { if (SC.open === KEY && shown() !== who()) render(); }, () => {}); }, { timeout: 4000 }); });
K.on("forget", () => { DV.who = null; });

/* ---------- the seal: press it to turn to the next friend's choices; arrow keys go either way ---------- */
function stepWho(by) {
  const d = DV.data; if (!d) { get().then(() => stepWho(by), fail); return; }
  const cur = who(), i = DV.order.indexOf(cur), next = DV.order[(i + by + DV.order.length) % DV.order.length];
  pick(next, true);
  const B = window.BoardSeals, el = $("#seal"), m = next === "all" ? null : byKey(next), p = next === "all" ? null : d.people.find((x) => x.class_key === next);
  const openAll = d.people.reduce((n, x) => n + x.decisions.filter((y) => y.state === "open").length, 0);
  const openN = p ? p.decisions.filter((x) => x.state === "open").length : openAll;
  const line = next === "all" ? `All five: ${openAll === 1 ? "one thing" : `${openAll} things`} still open on the Party Board between you.` : `${m.name}: ${summary(p)}`;
  const btn = $("#seal .seal-btn"); if (btn) btn.setAttribute("aria-label", `${TITLE} seal, showing ${next === "all" ? "all five" : m.name}. Press for the next friend; arrow keys go either way.`);
  if (!B || !el) return;
  snd("latch");
  B.spin({ land: "back", mid: () => {
    const b = el.querySelector(".seal-b"), i2 = el.querySelector(".seal-i"), chip = el.querySelector(".seal-chip"), num = el.querySelector(".seal-n");
    if (b) b.textContent = next === "all" ? "All five" : m.name;
    if (i2) i2.textContent = `${openN} open on the board`;
    if (chip) chip.hidden = true; if (num) num.textContent = "";
  } }).then(() => B.say(line));
}
if (window.BoardSeals && window.BoardSeals.MECH) window.BoardSeals.MECH[KEY] = { hint: "to turn to the next friend's choices; arrow keys go either way", spin: false, press: () => stepWho(1) };
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const B = window.BoardSeals, t = e.target; if (!B || B.status().key !== KEY || !t || !t.closest || !t.closest("#seal .seal-btn")) return;
  e.preventDefault(); stepWho(e.key === "ArrowRight" ? 1 : -1);
});
window.__decide = Object.freeze({ who, pick, step: stepWho, summary, status: () => ({ who: who(), loaded: !!DV.data, order: DV.order.slice() }) });
})();
