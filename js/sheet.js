/* Party sheet Phase 0 (notes/VISION-PARTY-SHEET.md 5.1 and 5.2; 2026-10-30): Your sheet and the party table, two views inside The
   five. Why there and not a thirteenth scene: the tab rail holds twelve tabs from 1280 px only by dropping their icons, and The five
   already owns the crests and the frame every scene shares; a sheet opens from a friend's crest and the table is The five folded.
   A sheet fills itself from what the board already holds (the Party Board through party.json, the options in decide.json, the
   sign-ups, the launch-night state and checklist), shows each line's source as a small seal (board, Discord, game, Leeroy) and a
   "the party sees this" switch. Writes go one field per call through BoardBrain.setSheet, with a value only from the lists built
   here from the board's own data (sheetVocab); without the Worker's route, a key or a match between the key and the sheet, the
   line is kept on this device and says so. Everything reads as facts and options; an empty line invites, it never asks twice.
   Runs after js/decide.js through the page's own hooks; fake-DOM safe. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h, D, MEM, SC } = K;
const BB = () => window.BoardBrain || null;
const FIELDS = ["race", "class", "spec_path", "spec_at_40", "professions", "level", "launch_state", "plan_zone", "goals"];
const LABEL = { race: "Race", class: "Class", spec_path: "Spec path", spec_at_40: "Spec at 40", professions: "Professions", level: "Level", launch_state: "Launch night", plan_zone: "Plan zone", goals: "Goals" };
const LAUNCH = { queue: "In the queue", in: "In the game", done: "Done for tonight" };
const SRC = { board: "the Party Board", discord: "Discord", game: "the game", leeroy: "Leeroy" };
const GOALS_MAX = 140;
const PS = { view: "cards", who: null, data: null, voc: null, edit: null, say: "", sigs: {}, dirty: false };
/* the Worker's slug (cloudflare/worker/src/brain.js slugOf): lower case, accents and apostrophes dropped, runs of the rest a dash */
const slugOf = (n) => String(n == null ? "" : n).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
const words = (sl) => String(sl || "").split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const members = () => (D.party ? D.party.members : []);
const pslug = (m) => MEM.slug(m.name);
const bySlug = (sl) => members().find((m) => pslug(m) === sl) || null;
const sameName = (a, b) => K.cleanName(a).toLowerCase() === K.cleanName(b).toLowerCase();
const crest = (m) => { const i = K.crestMark(m); i.removeAttribute("title"); return i; };
const snd = (n) => { try { if (window.BoardSound) window.BoardSound.play(n); } catch (e) {} };
const dayOf = (iso) => { try { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso)); } catch (e) { return ""; } };

/* ---------- the lists every listed value must come from: the board's own data ---------- */
function vocab(d) {
  const L = { race: {}, class: {}, spec: {}, professions: {}, plan_zone: {} }, specs = {};
  const add = (t, n) => { const k = slugOf(n); if (k) L[t][k] = n; return k; };
  for (const r of Object.keys((D.client && D.client.racials) || {})) add("race", r);
  for (const m of members()) { add("race", m.race); add("class", m.class); if (m.start_zone) add("plan_zone", m.start_zone); }
  if (d) {
    for (const c of d.party.nobody.classes) add("class", c.name);
    for (const p of d.people) for (const x of p.decisions) {
      if (x.key === "spec40") specs[p.class_key] = x.options.map((o) => add("spec", o.name));
      if (x.key === "professions") for (const o of x.options) add("professions", o.name);
    }
    for (const o of d.party.nobody.professions) add("professions", o.name);
  }
  const S = D.signups, meet = (S && S.options && S.options.meet) || [], other = (S && S.tallies && S.tallies.meet && S.tallies.meet.other && S.tallies.meet.other.places) || [];
  for (const pl of [...meet, ...other]) add("plan_zone", pl);
  const keys = (t) => Object.keys(L[t]).sort();
  return { labels: L, specs, lists: { race: keys("race"), class: keys("class"), spec_path: keys("spec"), spec_at_40: keys("spec"), professions: keys("professions"), plan_zone: keys("plan_zone"), levelMax: (D.client && D.client.level) || 60 } };
}
const labelOf = (f, v) => { const L = PS.voc ? PS.voc.labels : {}, t = f === "spec_path" || f === "spec_at_40" ? L.spec : L[f]; return (t && t[v]) || words(v); };
function textOf(f, v) {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length) || v === "") return "";
  if (f === "professions") return K.andList(v.map((x) => labelOf(f, x)));
  if (f === "level") return `Level ${v}`;
  if (f === "launch_state") return LAUNCH[v] || v;
  if (f === "goals") return String(v);
  return labelOf(f, v);
}

/* ---------- what the board already holds about a person (source per line) ---------- */
function prefill(m) {
  const d = PS.data, p = d && d.people.find((x) => x.class_key === m.class_key), out = {};
  out.race = { value: slugOf(m.race), src: "board", locked: true };
  out.class = { value: slugOf(m.class), src: "board", locked: true };
  const sp = p && p.decisions.find((x) => x.key === "spec40");
  /* the board's own spec words name the path first ("Frost, Fire at 40"; "Retribution to 40, then Ret/Holy") */
  const at = (n) => { const i = String(m.spec).toLowerCase().indexOf(n.toLowerCase().slice(0, 3)); return i < 0 ? 99 : i; };
  const named = sp ? sp.options.filter((o) => o.board).map((o) => o.name).sort((a, b) => at(a) - at(b)) : [];
  if (named[0]) out.spec_path = { value: slugOf(named[0]), src: "board" };
  if (named[1]) out.spec_at_40 = { value: slugOf(named[1]), src: "board" };
  else if (named[0] && sp && sp.state === "declared") out.spec_at_40 = { value: slugOf(named[0]), src: "board", note: "no change at 40 on the Party Board" };
  const prof = (m.professions || []).filter((x) => !x.status), open = (m.professions || []).find((x) => x.status === "undecided");
  if (prof.length) out.professions = { value: prof.map((x) => slugOf(x.name)).slice(0, 2), src: prof.some((x) => x.source === "chat") ? "discord" : "board", note: open ? `${open.name}: still open` : null };
  else if (open) out.professions = { value: [], src: "board", note: `${open.name}: still open` };
  const e = D.signups && Array.isArray(D.signups.entries) ? D.signups.entries.find((x) => sameName(x.name, m.name)) : null;
  if (e && e.meet) out.plan_zone = { value: slugOf(e.meet), src: "discord", at: e.updated || null };
  const B = BB(), mine = B && B.mineLaunch ? B.mineLaunch() : null, me = B && B.status ? B.status().me : null;
  const ls = mine && me && sameName(me.name, m.name) ? mine.state : MEM.get(`launch-${pslug(m)}`);
  if (LAUNCH[ls]) out.launch_state = { value: ls, src: "board", at: mine && mine.at };
  return out;
}
/* the device's own record of a person's edits: { field: { value, visible, at } } */
const devKey = (m) => `sheet-${pslug(m)}`;
const dev = (m) => { try { const o = JSON.parse(MEM.get(devKey(m)) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };
const devSet = (m, f, rec) => { const o = dev(m); o[f] = rec; MEM.set(devKey(m), JSON.stringify(o)); };
const isMe = (m) => { const me = MEM.member(); return !!me && me.class_key === m.class_key; };
/* the key's person is the sheet's person: only then does a write leave the page */
const keyIsThem = (m) => { const B = BB(), st = B && B.status ? B.status() : null; return !!(st && st.me && sameName(st.me.name, m.name)); };
const partyRowOf = (m) => { const B = BB(), rows = B && B.party ? B.party() : []; return rows.find((r) => sameName(r.name, m.name)) || null; };
/* one line per field: the newest of the brain's event, this device's edit, the party row and the board's own record */
function fieldsFor(m) {
  const pre = prefill(m), mine = isMe(m), d = mine ? dev(m) : {}, B = BB();
  const brain = mine && keyIsThem(m) && B && B.sheet ? (B.sheet() || { fields: {} }).fields : {}, row = mine ? null : partyRowOf(m);
  const out = {};
  for (const f of FIELDS) {
    const p = pre[f] || null, dv = d[f] || null, bv = brain[f] || null, rv = row && row.fields[f] ? row.fields[f] : null;
    let x = p ? { value: p.value, src: p.src, at: p.at || null, note: p.note || null, visible: true, from: "board" } : { value: null, src: null, at: null, visible: true, from: "empty" };
    if (rv) x = { value: rv.value, src: rv.source, at: rv.at, visible: true, from: "party" };
    if (dv && (!bv || !bv.at || (dv.at && Date.parse(dv.at) > Date.parse(bv.at)))) x = { ...x, value: dv.value === undefined ? x.value : dv.value, visible: dv.visible !== false, at: dv.at, src: dv.value === undefined ? x.src : "board", note: dv.value === undefined ? x.note : null, from: "device" };
    else if (bv) x = { value: bv.value, src: bv.source, at: bv.at, visible: bv.visible, note: null, from: "brain" };
    x.locked = !!(p && p.locked); x.text = textOf(f, x.value);
    out[f] = x;
  }
  return out;
}

/* ---------- the source seal and the parity bar ---------- */
/* the owner's painted wax marks (img/marks/source-<board|discord|game|leeroy>.webp; board/img/chamber/CREDITS.md). Nothing is drawn here
   (2026-10-30): the mark is decorative (the line's source is said in words next to it), loads only when a sheet is on screen, and
   a mark that does not load is simply dropped */
function seal(src, from) {
  const k = Object.prototype.hasOwnProperty.call(SRC, src) ? src : "board", where = SRC[k], dev0 = from === "device";
  const say = dev0 ? `Changed on this board, kept on this device` : `From ${where}`;
  const img = h("img", { class: "ps-mark", src: `img/marks/source-${k}.webp`, alt: "", width: 28, height: 28, loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => { img.remove(); });
  return h("span", { class: "ps-src", "data-src": k, title: say }, img, h("span", { class: "sr-only", text: say }));
}
function parity(m, F) {
  const filled = FIELDS.filter((f) => F[f].text), seen = filled.filter((f) => F[f].visible), newest = FIELDS.map((f) => F[f].at).filter(Boolean).sort().pop();
  const share = seen.length / FIELDS.length, fresh = newest ? (Date.now() - Date.parse(newest)) / 864e5 : null;
  return h("div", { class: "ps-par", "data-fresh": fresh === null ? "board" : fresh < 3 ? "new" : "older" },
    h("span", { class: "ps-bar", "aria-hidden": "true" }, h("i", { style: `--p: ${share.toFixed(3)}` })),
    h("span", { class: "ps-par-t", text: `The party sees ${seen.length} of ${FIELDS.length} lines. ${newest ? `Newest line ${dayOf(newest)}.` : "Every line so far comes from the board's records."}` }));
}

/* ---------- the editor of one line (own sheet only) ---------- */
function editor(m, f, x) {
  const v = PS.voc, slug = pslug(m), id = `ps-in-${f}`;
  const opt = (val, label, cur) => h("option", { value: val, ...(cur ? { selected: "" } : {}) }, label);
  const sel = (key, list, cur, label) => { const e = h("select", { id: key, class: "ps-sel", "aria-label": label }, opt("", "Not chosen", !cur), ...list.map((x2) => opt(x2, labelOf(f, x2), x2 === cur))); e.value = cur || ""; return e; };
  let ctl, read;
  if (f === "spec_path" || f === "spec_at_40") { const list = (v.specs[m.class_key] || []).filter(Boolean); ctl = sel(id, list, x.value, LABEL[f]); read = () => ctl.value || null; }
  else if (f === "professions") {
    const cur = Array.isArray(x.value) ? x.value : [], a = sel(id, v.lists.professions, cur[0], "First profession"), b = sel(`${id}-b`, v.lists.professions, cur[1], "Second profession");
    ctl = h("span", { class: "ps-two" }, a, b); read = () => [...new Set([a.value, b.value].filter(Boolean))];
  } else if (f === "level") { ctl = h("input", { id, class: "ps-num", type: "number", min: "1", max: String(v.lists.levelMax), inputmode: "numeric", "aria-label": "Level" }); ctl.value = x.value ? String(x.value) : ""; read = () => { const n = Number(ctl.value); return ctl.value === "" ? null : n; }; }
  else if (f === "launch_state") { ctl = h("select", { id, class: "ps-sel", "aria-label": LABEL[f] }, opt("", "Not set", !x.value), ...Object.entries(LAUNCH).map(([k, l]) => opt(k, l, k === x.value))); ctl.value = x.value || ""; read = () => ctl.value || null; }
  else if (f === "plan_zone") { ctl = sel(id, v.lists.plan_zone, x.value, LABEL[f]); read = () => ctl.value || null; }
  else { ctl = h("input", { id, class: "ps-txt", type: "text", maxlength: String(GOALS_MAX), autocomplete: "off", "aria-label": "Goals, in your own words" }); ctl.value = x.value || ""; read = () => { const t = ctl.value.replace(/\s+/g, " ").trim(); return t ? t : null; }; }
  const save = h("button", { type: "button", class: "lib-tool ps-save", onclick: () => { write(m, f, read(), undefined); } }, "Save");
  const cancel = h("button", { type: "button", class: "lib-tool ps-cancel", onclick: () => { PS.edit = null; render(); const b = $(`#ps-sheet [data-field="${f}"] .ps-edit`); if (b) b.focus({ preventScroll: true }); } }, "Cancel");
  /* the field keeps focus until the button's own click lands: on a phone a focused field hides the bottom bar, and a blur on the press
     brought it back and moved the button out from under the finger (2026-10-30) */
  for (const b of [save, cancel]) b.addEventListener("pointerdown", (e) => { if (e && e.preventDefault) e.preventDefault(); });
  const keyed = (e) => { if (e && e.key === "Enter" && f !== "goals") { if (e.preventDefault) e.preventDefault(); save.click(); } if (e && e.key === "Escape") { if (e.stopPropagation) e.stopPropagation(); cancel.click(); } };
  ctl.addEventListener("keydown", keyed);
  return h("div", { class: "ps-ed", "data-field": f }, ctl, h("span", { class: "ps-ed-row" }, save, cancel), f === "goals" ? h("span", { class: "ps-hint", text: `Up to ${GOALS_MAX} characters. Links and tags are left out.` }) : null);
}
/* where an empty line points: the options in What to decide, the Sign-ups card, or launch night */
function invite(m, f) {
  const sl = pslug(m), a = (href, t) => h("a", { class: "tn-link", href }, t);
  if (f === "spec_at_40" || f === "spec_path") return ["Not chosen yet. ", a(`#decide.${sl}`, "The three paths, in What to decide")];
  if (f === "professions") return ["None on the board yet. ", a(`#decide.${sl}`, "Every profession, in What to decide")];
  if (f === "plan_zone") return ["No place yet. ", a("#roads", "Where the roads meet, on Three roads")];
  if (f === "level") return ["Fills in once the game is live. ", a("#timeline", "Launch, on Dates")];
  if (f === "launch_state") return ["Not set. The three states are on the wall on launch night."];
  if (f === "goals") return ["Empty. A line of your own, if you like."];
  return ["Not on the board yet."];
}
function lineEl(m, f, x, mine) {
  const empty = !x.text, edit = mine && PS.edit === f;
  const val = empty ? h("span", { class: "ps-v ps-empty" }, ...(mine || f === "level" ? invite(m, f) : ["Nothing on the sheet yet."])) : h("span", { class: "ps-v" }, x.text, x.note ? h("small", { class: "ps-note", text: ` (${x.note})` }) : null);
  const sw = mine ? h("button", { type: "button", class: "ps-see", role: "switch", "aria-checked": String(x.visible !== false), "aria-label": `${LABEL[f]}: the party sees this`, onclick: () => toggle(m, f) }, h("span", { class: "ps-knob", "aria-hidden": "true" }), h("span", { class: "ps-see-t", text: x.visible !== false ? "The party sees this" : "Off the party table" })) : null;
  const ch = mine && !x.locked ? h("button", { type: "button", class: "lib-tool ps-edit", "aria-expanded": String(edit), "aria-controls": `ps-ed-${f}`, onclick: () => { PS.edit = PS.edit === f ? null : f; render(); const c = $(`#ps-in-${f}`); if (c) c.focus({ preventScroll: true }); } }, empty ? "Add" : "Change") : null;
  return h("li", { class: "ps-line", "data-field": f, "data-from": x.from, ...(empty ? { "data-empty": "1" } : {}), ...(x.visible === false ? { "data-hidden": "1" } : {}) },
    h("span", { class: "ps-k" }, LABEL[f], x.src && !empty ? seal(x.src, x.from) : null, x.locked ? h("span", { class: "ps-lock", text: "locked in" }) : null),
    val, mine ? h("span", { class: "ps-ctl" }, sw, ch) : null,
    edit ? h("div", { id: `ps-ed-${f}`, class: "ps-ed-box" }, editor(m, f, x)) : null);
}

/* ---------- writes: one field per call, the device first ---------- */
const SAY = {
  saved: (l) => `${l}: saved. The party sees it on the table.`,
  hidden: (l) => `${l}: saved, kept off the party table.`,
  "no key": (l) => `${l}: saved on this device. With My board link from the Sign-ups card it reaches the party too.`,
  key: (l) => `${l}: saved on this device. This board link belongs to someone else, so nothing was sent.`,
  off: (l) => `${l}: saved on this device. The party sees it once the owner switches the sheet on.`,
  refused: (l) => `${l}: saved on this device. The brain did not take that value.`,
  offline: (l) => `${l}: not sent, saved on this device.`,
  busy: (l) => `${l}: not sent just now, saved on this device.`,
  failed: (l) => `${l}: not sent, saved on this device.`,
  "nowhere to send": (l) => `${l}: saved on this device.`,
  bad: (l) => `${l}: that value is not on the board's lists, so it was not kept.`,
};
function say(t) { PS.say = t; const n = $("#ps-say"); if (n && n.textContent !== t) n.textContent = t; }
async function write(m, f, value, visible) {
  if (!isMe(m)) return { ok: false };
  const B = BB(), x = fieldsFor(m)[f], at = new Date().toISOString(), vis = visible === undefined ? x.visible !== false : visible;
  if (f === "level" && value !== null && !(Number.isInteger(value) && value >= 1 && value <= PS.voc.lists.levelMax)) { say(SAY.bad(LABEL[f])); return { ok: false }; }
  const rec = { ...(value === undefined ? {} : { value }), visible: vis, at };
  devSet(m, f, rec);
  if (f === "launch_state" && value !== undefined) MEM.set(`launch-${pslug(m)}`, value);
  PS.edit = null; snd("stamp");
  let r = { ok: false, local: true, why: "nowhere to send" };
  if (B && B.setSheet) {
    if (!keyIsThem(m) && B.status && B.status().key) r = { ok: false, local: true, why: B.status().me ? "key" : "offline" };
    else r = await B.setSheet(f, value, visible === undefined ? undefined : vis);
    if (r.state === "refused") { const o = dev(m); delete o[f]; MEM.set(devKey(m), JSON.stringify(o)); say(SAY.bad(LABEL[f])); render(); return r; }
    /* launch night still reaches Discord through the launch intent while the sheet route is off */
    if (!r.ok && r.why === "off" && f === "launch_state" && value && B.setLaunch) B.setLaunch(value);
  }
  say((r.ok ? (vis ? SAY.saved : SAY.hidden) : SAY[r.why] || SAY.failed)(LABEL[f]));
  render(); K.emit("sheet", pslug(m), f);
  return r;
}
function toggle(m, f) { const x = fieldsFor(m)[f]; return write(m, f, x.text ? x.value : undefined, !(x.visible !== false)); }

/* ---------- the views ---------- */
function sheetView(m) {
  const mine = isMe(m), F = fieldsFor(m), B = BB(), st = B && B.status ? B.status() : null;
  const how = mine ? (st && st.key ? (keyIsThem(m) ? (st.sheetOff ? "Changes stay on this device until the owner switches the sheet on." : "Changes go to the party through Leeroy's brain.") : st.me ? "This board link belongs to someone else: changes stay on this device." : "Changes stay on this device for now.") : "Changes stay on this device. With My board link from the Sign-ups card they reach the party.")
    : `What the party sees of ${m.name}'s sheet. Only ${m.name} changes it, from their own board.`;
  return h("article", { class: "ps-card", "data-who": pslug(m), style: `--cc: ${K.classVar(m.class_key)}`, "aria-labelledby": "ps-name" },
    h("header", { class: "ps-head" },
      h("span", { class: "ps-crest" }, h("img", { src: `img/crests/${m.class_key}.png`, alt: "", width: 72, height: 72, loading: "lazy", decoding: "async" })),
      h("span", { class: "ps-id" }, h("h3", { class: "ps-name", id: "ps-name", text: `${m.name}'s sheet` }), h("span", { class: "ps-what", text: `${m.race} ${m.class}${m.role ? `, ${m.role_detail || m.role}` : ""}` }), parity(m, F)),
      h("button", { type: "button", class: "lib-tool ps-back", onclick: () => show("cards", null, true) }, "Back to The five")),
    h("p", { class: "ps-how", text: how }),
    h("ul", { class: "ps-lines", "aria-label": `${m.name}'s sheet, line by line` }, FIELDS.map((f) => lineEl(m, f, F[f], mine))),
    h("p", { class: "ps-say", id: "ps-say", role: "status", "aria-live": "polite", text: PS.say }));
}
const nameList = (ms) => K.andList(ms.map((m) => m.name));
function tableView() {
  const ms = members(), d = PS.data, all = ms.map((m) => ({ m, F: fieldsFor(m), p: d ? d.people.find((x) => x.class_key === m.class_key) : null }));
  const take = {};
  for (const { m, F } of all) for (const pr of Array.isArray(F.professions.value) ? F.professions.value : []) (take[pr] ||= []).push(m);
  const two = Object.entries(take).filter(([, l]) => l.length > 1).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const NUM = ["", "one", "two", "three", "four", "five"];
  const deciding = ({ m, F, p }) => {
    const out = [], pr = p && p.decisions.find((x) => x.key === "professions"), und = (m.professions || []).find((x) => x.status === "undecided");
    if (pr && pr.state === "open") out.push(und ? `a profession (${und.name})` : "a profession");
    else if (!Array.isArray(F.professions.value) || F.professions.value.length < 2) out.push("a second profession");
    if (!F.spec_at_40.text) out.push("the spec at 40");
    return out;
  };
  const cell = (l, ...kids) => h("td", { "data-l": l }, ...kids);
  const rows = all.map((x) => {
    const { m, F } = x, profs = Array.isArray(F.professions.value) ? F.professions.value : [], open = deciding(x);
    return h("tr", { "data-who": m.class_key, style: `--cc: ${K.classVar(m.class_key)}` },
      h("th", { scope: "row" }, h("button", { type: "button", class: "ps-who", "aria-label": `${m.name}: open their sheet`, onclick: () => openSheet(pslug(m), true) }, crest(m), h("b", { text: m.name }))),
      cell("Role", m.role_detail ? `${m.role} (${m.role_detail})` : m.role || "not on the board"),
      cell("Race and class", `${F.race.text || m.race} ${F.class.text || m.class}`),
      cell("Spec plan", F.spec_path.text ? `${F.spec_path.text}${F.spec_at_40.text && F.spec_at_40.value !== F.spec_path.value ? `, then ${F.spec_at_40.text} at 40` : ", no change at 40 on record"}` : "not on the board"),
      cell("Professions", profs.length ? h("span", {}, ...profs.flatMap((pr, i) => [i ? " and " : "", labelOf("professions", pr), take[pr] && take[pr].length > 1 ? h("span", { class: "ps-two-t", text: ` (${NUM[take[pr].length] || take[pr].length} takers)` }) : ""])) : "none on the board", F.professions.note ? h("small", { class: "ps-note", text: ` ${F.professions.note}` }) : null),
      cell("Still deciding", open.length ? K.andList(open) : "nothing open on the record"));
  });
  const ev = K.nextEvent ? K.nextEvent(Date.now() / 1000) : null;
  const notes = [
    two.length ? h("li", {}, h("b", { text: "Two takers: " }), two.map(([pr, l]) => `${labelOf("professions", pr)} (${nameList(l)})`).join("; "), ".") : h("li", { text: "No profession has two takers yet." }),
    (() => { const still = all.filter((x) => deciding(x).length); return h("li", {}, h("b", { text: "Still deciding: " }), still.length ? still.map((x) => `${x.m.name}, ${K.andList(deciding(x))}`).join("; ") + "." : "nothing open on the record."); })(),
    d && d.party.nobody.professions.length ? h("li", {}, h("b", { text: "Nobody has: " }), `${K.andList(d.party.nobody.professions.map((x) => x.name))}.`) : null,
    ev ? h("li", {}, h("b", { text: "Next shared date: " }), `${ev.label}, ${K.fmtWhen(ev.epoch, { rel: true })}. `, h("a", { class: "tn-link", href: "#timeline", text: "Dates" })) : null,
  ].filter(Boolean);
  return h("div", { class: "ps-tablebox" },
    h("p", { class: "ps-how ps-how-mark" }, h("img", { class: "ps-mark ps-mark-party", src: "img/marks/source-party.webp", alt: "", width: 40, height: 40, loading: "lazy", decoding: "async" }), "The five sheets folded into one view: the Party Board's records, with what each person changed on their own sheet and left visible."),
    h("div", { class: "ps-scroll" }, h("table", { class: "ps-table" }, h("caption", { class: "sr-only", text: "The party table: role, race and class, spec plan, professions and what is still open, one row per person" }),
      h("thead", {}, h("tr", {}, ["Who", "Role", "Race and class", "Spec plan", "Professions", "Still deciding"].map((t) => h("th", { scope: "col", text: t })))),
      h("tbody", {}, rows))),
    h("ul", { class: "ps-notes" }, notes));
}

/* ---------- mounting inside The five ---------- */
function mount() {
  const panel = $("#panel-five"); if (!panel || $("#ps-views")) return;
  const btn = (v, t) => h("button", { type: "button", class: "lib-tool ps-view", "data-view": v, "aria-pressed": String(v === "cards"), onclick: () => show(v, null, true) }, t);
  const bar = h("div", { class: "ps-views", id: "ps-views", role: "group", "aria-label": "How to see the five" }, btn("cards", "The cards"), btn("party", "The party table"));
  panel.insertBefore(bar, panel.firstChild);
  panel.append(h("section", { class: "ps", id: "ps-sheet", "aria-label": "A sheet", hidden: true }), h("section", { class: "ps-party", id: "ps-party", "aria-label": "The party table", hidden: true }));
}
mount();
function crests() {
  for (const card of document.querySelectorAll("#cards .card")) {
    if (card.querySelector(".ps-crestbtn")) continue;
    const m = members().find((x) => x.class_key === card.dataset.k), front = card.querySelector(".front"); if (!m || !front) continue;
    /* the crest lands once its art is probed (board.js placeCrest); a card without one keeps its plain face */
    const img = front.querySelector("img.crest"); if (!img || !img.parentNode) continue;
    const b = h("button", { type: "button", class: "ps-crestbtn", "aria-label": `Open ${m.name}'s sheet`, onclick: () => openSheet(pslug(m), true) });
    img.parentNode.insertBefore(b, img); b.append(img, h("span", { class: "ps-crest-t", "aria-hidden": "true", text: "Sheet" }));
  }
}
function mineLink() {
  const chip = $("#tn-me .tn-chip"), m = MEM.member(); if (!chip) return;
  const old = chip.querySelector(".ps-mine"); if (old) old.remove();
  if (m) chip.insertBefore(h("a", { class: "lib-tool ps-mine", href: `#five.sheet-${pslug(m)}`, text: "Your sheet" }), $("#tn-change"));
}
async function ready() {
  if (!PS.data && K.decideData) { try { PS.data = await K.decideData(); } catch (e) { PS.data = null; } }
  PS.voc = vocab(PS.data);
  const B = BB(); if (B && B.sheetVocab) B.sheetVocab(PS.voc.lists);
  return PS.voc;
}
function render() {
  const panel = $("#panel-five"); if (!panel || !D.party) return;
  PS.dirty = false;
  /* the control that had focus is found again after the redraw (the switch or Change of the same line) */
  const a = document.activeElement, line = a && a.closest ? a.closest("#ps-sheet .ps-line") : null, again = line ? `#ps-sheet .ps-line[data-field="${line.dataset.field}"] ${a.classList.contains("ps-see") ? ".ps-see" : a.classList.contains("ps-edit") ? ".ps-edit" : ""}`.trim() : null;
  panel.dataset.view = PS.view;
  for (const b of panel.querySelectorAll(".ps-view")) b.setAttribute("aria-pressed", String(b.dataset.view === PS.view));
  const sh = $("#ps-sheet"), pt = $("#ps-party"), m = PS.who ? bySlug(PS.who) : null;
  sh.hidden = PS.view !== "sheet" || !m; pt.hidden = PS.view !== "party";
  if (!sh.hidden && PS.voc) sh.replaceChildren(sheetView(m));
  if (!pt.hidden && PS.voc) pt.replaceChildren(tableView());
  /* the frame's fit follows the view on screen (the cards' zoom is not the sheet's) */
  if (SC.open === "five" && K.fitScene) { try { K.fitScene("five"); } catch (e) {} }
  if (again && !PS.edit) { const f = $(again); if (f && f !== document.activeElement) { try { f.focus({ preventScroll: true }); } catch (e) {} } }
}
function show(v, who, user) {
  PS.view = v; if (v === "sheet") PS.who = who; else PS.edit = null;
  if (v !== "sheet") PS.say = "";
  ready().then(() => {
    render();
    if (SC.open === "five") { try { K.setHash(v === "sheet" ? `five.sheet-${who}` : v === "party" ? "five.party" : "five", false); } catch (e) {} }
    if (user) { snd("page"); const f = v === "sheet" ? $("#ps-name") : v === "party" ? $("#ps-party .ps-how") : $(`#ps-views [data-view="cards"]`); if (f) { if (v !== "cards") f.setAttribute("tabindex", "-1"); try { f.focus({ preventScroll: true }); } catch (e) {} } }
    K.emit("sheetview", v, who || null);
  });
}
function openSheet(sl, user) { if (!bySlug(sl)) return false; if (SC.open !== "five" && K.goScene) { K.goScene("five"); } show("sheet", sl, user); return true; }
/* #five.sheet-<slug> opens a sheet, #five.party the table; any other #five.<slug> still lands on that card (js/v13d.js) */
const lander0 = K.lander;
K.lander = (k, sub) => {
  if (k === "five" && sub === "party") { show("party"); return $("#ps-party"); }
  const mm = k === "five" && /^sheet-([a-z0-9-]{1,40})$/.exec(sub || "");
  if (mm && bySlug(mm[1])) { show("sheet", mm[1]); return $("#ps-sheet"); }
  if (k === "five" && PS.view !== "cards") show("cards");
  return lander0 ? lander0(k, sub) : null;
};
/* the crests arrive after their probes: looked for at render, a moment later, and on every open of The five */
K.on("rendered", () => { crests(); mineLink(); ready().then(render); for (const t of [300, 1500, 4000]) setTimeout(crests, t); });
K.on("tonight", mineLink);
K.on("scene", (k) => { if (k === "five") { crests(); if (PS.view !== "cards") ready().then(render); } });
K.on("closed", (k) => { if (k === "five" && PS.view !== "cards") { PS.view = "cards"; PS.edit = null; PS.say = ""; render(); } });
K.on("signups", () => { if (PS.view !== "cards") render(); });
K.on("forget", () => { try { Object.keys(localStorage).filter((x) => x.startsWith("board-sheet-")).forEach((x) => localStorage.removeItem(x)); } catch (e) {} for (const m of members()) MEM.set(devKey(m), null); PS.edit = null; PS.say = ""; render(); });
const B0 = BB();
/* the brain's pushes redraw only when what they carry changed, and never under an open editor (it waits for Save or Cancel) */
const later = (why, sig) => { if (sig !== undefined) { if (PS.sigs[why] === sig) return; PS.sigs[why] = sig; } if (PS.view === "cards") return; if (PS.edit) { PS.dirty = true; return; } render(); };
if (B0 && B0.on) { B0.on("sheet", (x) => later("sheet", JSON.stringify(x))); B0.on("party", (x) => later("party", JSON.stringify(x))); B0.on("me", (x) => later("me", JSON.stringify(x))); }
window.__sheet = Object.freeze({ show, openSheet, fieldsFor: (sl) => { const m = bySlug(sl); return m ? fieldsFor(m) : null; }, vocab: () => PS.voc, slugOf, status: () => ({ view: PS.view, who: PS.who, edit: PS.edit, say: PS.say }) });
})();
