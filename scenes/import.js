/* Import from game: the panel under your own sheet that reads the Leeroy add-on's export string.
   Nothing is sent until you tap Send. Nothing is stored: the pasted text lives in this page only. The parser is js/addon-import.js. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { h } = K;
const HERE = (document.currentScript && document.currentScript.src) || null;
const NAME = { race: "Race", class: "Class", level: "Level", professions: "Professions" };
const FILE_MAX = 2 * 1024 * 1024;
const WHY = { "no key": "this board link has no key", key: "this board link is not yours", off: "the party sheet is switched off for now", offline: "no connection", busy: "busy, try again in a minute", refused: "the board did not accept that value", failed: "the board could not save it", "nowhere to send": "no connection to the board", "not on the board's lists": "that value is not on the board's lists" };
const S = { text: "", sending: false, results: null, mod: null, modP: null, ctx: null, say: "", fileErr: "", frozen: null, rev: 0 }
let ctl = null;
let outEl = null;

function lib() {
  if (S.modP || !HERE) return S.modP;
  S.modP = import(new URL("../js/addon-import.js?v=ee0fc5e72b", HERE).href).then((m) => { S.mod = m; return m; }).catch(() => { S.modP = null; return null; });
  return S.modP;
}
const show = (f, v) => {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return "nothing yet";
  const L = S.ctx.label;
  return f === "level" ? `Level ${v}` : f === "professions" ? K.andList(v.map((x) => L(f, x))) : L(f, v);
};
const age = (d) => (d < 0.04 ? "just now" : d < 1 ? "today" : `${Math.floor(d)} day${Math.floor(d) === 1 ? "" : "s"} ago`);

function read() {
  const A = S.mod, t = S.text;
  if (!A) return { kind: "wait" };
  if (!t.trim()) return { kind: "empty" };
  const r = A.parse(t);
  if (!r.ok) return { kind: "bad", why: r.why };
  const mapped = A.mapToBoard(r.data, S.ctx.lists());
  return { kind: "ok", r, mapped, rows: S.results && S.frozen ? S.frozen : A.plan(mapped, S.ctx.current()) };
}
function summary(x) {
  const { r, mapped, rows } = x, d = r.data, A = S.mod, kids = [];
  kids.push(h("p", { class: "imp-found", text: `Found a Leeroy export from ${age(r.ageDays)}: level ${d.level}, ${d.race}, ${d.class}${d.prof && d.prof.length ? `, ${d.prof.length} profession${d.prof.length === 1 ? "" : "s"}` : ""}.` }));
  const info = [];
  if (d.name) info.push(`character name ${d.name} (shown here only, never sent)`);
  if (d.zone) info.push(`zone ${d.zone}`);
  if (d.talents) info.push(`talent points ${d.talents.join("/")}`);
  if (info.length) kids.push(h("p", { class: "imp-info", text: `Also in the export, not written to your sheet: ${info.join("; ")}.` }));
  for (const w of r.warnings) kids.push(h("p", { class: "imp-warn", text: w }));
  const list = rows.map((o) => {
    const res = S.results && S.results[o.field];
    const st = res ? (res.ok ? "sent" : "failed") : o.change ? "change" : "same";
    const state = res ? (res.ok ? "Sent." : `Not sent: ${res.why}.`) : o.change ? "Will change." : "Already the same.";
    return h("li", { class: "imp-row", "data-field": o.field, "data-state": st },
      h("b", { class: "imp-f", text: NAME[o.field] }),
      h("span", { class: "imp-ba" }, h("span", { class: "imp-b", text: show(o.field, o.before) }), h("span", { class: "imp-arrow", "aria-hidden": "true", text: " to " }), h("span", { class: "imp-a", text: show(o.field, o.after) })),
      h("span", { class: "imp-s", text: state }));
  });
  kids.push(list.length ? h("ul", { class: "imp-rows", "aria-label": "Sheet lines this export would set" }, ...list) : h("p", { class: "imp-warn", text: "Nothing in this export matches the board's lists, so there is nothing to send." }));
  /* Professions are never cleared by an export. A self-reported export that finds none (prof= empty, left out, or nothing on the board list) must not wipe what a friend typed on the board: the add-on may not see professions the board knows. So an empty result is omitted from the changes and said plainly here. */
  if (!rows.some((o) => o.field === "professions")) kids.push(h("p", { class: "imp-info imp-kept", text: "Professions: none found in the export, your board value is kept." }));
  if (mapped.skipped.length) kids.push(h("ul", { class: "imp-skips", "aria-label": "Skipped values" }, ...mapped.skipped.map((s) => h("li", { class: "imp-skip", text: A.skippedLine(s) }))));
  const n = rows.filter((o) => o.change).length, can = S.ctx.canSend(), done = !!S.results;
  kids.push(h("p", { class: "imp-note", text: "Only lines marked Will change are sent, one at a time, after you tap Send. A line you left unticked in the add-on options is not in the export." }));
  kids.push(h("div", { class: "imp-act" },
    h("button", { type: "button", class: "lib-tool imp-send", id: "imp-send", "aria-disabled": n && can.ok && !S.sending && !done ? null : "true", onclick: () => send(rows) }, S.sending ? "Sending..." : done ? "Done" : n ? `Send ${n} change${n === 1 ? "" : "s"} to my sheet` : "Nothing to send"),
    !can.ok ? h("span", { class: "imp-why", text: can.why }) : null));
  return h("div", { class: "imp-sum" }, ...kids);
}
async function send(rows) {
  const can = S.ctx.canSend(); if (S.sending || S.results || !can.ok) return;
  const todo = rows.filter((o) => o.change); if (!todo.length) return;
  const rev = ++S.rev; S.sending = true; S.frozen = rows; update();
  const res = {}, B = window.BoardBrain;
  for (const o of todo) {
    let r; try { r = await B.setSheet(o.field, o.after); } catch (e) { r = { ok: false, why: "failed" }; }
    res[o.field] = r && r.ok ? { ok: true } : { ok: false, why: WHY[r && r.why] || "the board could not save it" };
  }
  const ok = Object.values(res).filter((x) => x.ok).length;
  S.sending = false;
  if (S.rev !== rev) { S.frozen = null; update(); return; }
  S.rev++; /* a read that began before Send and ends after it is stale too */ /* the input changed while sending: these results belong to the old export and are never shown against the new one */
  S.results = res;
  S.say = ok === todo.length ? `Sent ${ok} line${ok === 1 ? "" : "s"} to your sheet.` : `${ok} of ${todo.length} lines sent. The rest were not.`;
  update();
  if (S.ctx.done) S.ctx.done();
}
function update() {
  if (!outEl || !outEl.isConnected) return;
  const x = read();
  let body;
  if (S.fileErr) body = h("p", { class: "imp-bad", role: "alert", text: S.fileErr });
  else if (x.kind === "ok") body = summary(x);
  else if (x.kind === "bad") body = h("p", { class: "imp-bad", role: "alert", text: x.why });
  else if (x.kind === "wait") body = h("p", { class: "imp-info", text: "Loading the reader..." });
  else body = h("p", { class: "imp-info", text: "Nothing is read until you paste or drop an export. Nothing is sent until you tap Send." });
  if (ctl) { const lock = S.sending; ctl.ta.disabled = lock; ctl.pick.disabled = lock; ctl.choose.disabled = lock; ctl.drop.setAttribute("aria-disabled", String(lock)); }
  outEl.replaceChildren(body, h("p", { class: "imp-say", id: "imp-say", role: "status", "aria-live": "polite", text: S.say }));
}
function setText(t) { if (S.sending) return; S.rev++; S.text = String(t).slice(0, 400000); S.results = null; S.say = ""; S.fileErr = ""; S.frozen = null; update(); }
function fromFile(file, ta) {
  if (!file || S.sending) return;
  const tok = S.rev; /* a read is only used if nothing was typed, dropped or sent since it started */
  if (file.size > FILE_MAX) { S.fileErr = "That file is over 2 MB. The add-on's file is far smaller; pick the right one."; update(); return; }
  file.text().then((t) => { if (S.sending || S.rev !== tok) return; ta.value = t; setText(t); }).catch(() => { S.fileErr = "That file could not be read."; update(); });
}
function mount(host, ctx) {
  S.ctx = ctx;
  const ta = h("textarea", { id: "imp-text", class: "imp-text", rows: "4", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-label": "Export from the Leeroy add-on", placeholder: "LEEROY1|..." });
  ta.value = S.text;
  ta.addEventListener("input", () => setText(ta.value));
  const pick = h("input", { type: "file", class: "imp-file", id: "imp-file", accept: ".lua,.txt,text/plain", tabindex: "-1", "aria-hidden": "true" });
  pick.addEventListener("change", () => { fromFile(pick.files && pick.files[0], ta); pick.value = ""; });
  const choose = h("button", { type: "button", class: "ps-chb imp-choose", onclick: () => pick.click() }, "choose a file");
  const drop = h("div", { class: "imp-drop", id: "imp-drop" }, h("span", { text: "Drop the add-on's saved file here, or " }), choose, h("span", { text: "." }));
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("imp-over"); });
  for (const ev of ["dragleave", "dragend"]) drop.addEventListener(ev, () => drop.classList.remove("imp-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("imp-over"); if (S.sending) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) fromFile(f, ta); else { const t = e.dataTransfer && e.dataTransfer.getData("text/plain"); if (t) { ta.value = t; setText(t); } }
  });
  outEl = h("div", { class: "imp-out", id: "imp-out" });
  host.replaceChildren(h("section", { class: "imp", "aria-labelledby": "imp-h" },
    h("h4", { class: "imp-h", id: "imp-h", text: "Import from game" }),
    h("p", { class: "imp-lede", text: "In the game, the Leeroy add-on shows an export string. Paste it here, or drop the add-on's saved file. This page reads it on your device and shows what it found before anything is sent." }),
    h("label", { class: "imp-l", for: "imp-text", text: "Export string or file text" }), ta, drop, pick, outEl));
  ctl = { ta, pick, choose, drop };
  lib(); update(); if (S.modP) S.modP.then(update);
}
window.BoardImport = Object.freeze({ mount });
})();
