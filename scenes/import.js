/* Import from game: the panel under your own sheet that reads the Leeroy add-on's export string.
   Nothing is sent until you tap Send. Nothing is stored: the pasted text lives in this page only. The parser is js/addon-import.js.

   STRUCTURE. Every operation (a paste, a file read, a send, a retry) is ONE run object {id, kind, phase} made by begin() and stored as S.cur; beginning a run
   supersedes the previous one. All shared state (text, results, frozen, left, say, fileErr) is written only through put(run, patch), which does nothing unless
   S.cur === run (own(run)). An async completion that is no longer current returns without touching anything: no flag, no lock, no render. reset() replaces S.cur
   with a new idle run, so a run that was in flight can never write into the new context. The lock (inputs disabled) is derived: sending() is S.cur.phase === "sending".

   PHASES (run.phase)  what it means           entered by                        inputs   Send button
   idle                nothing pasted          start, reset(), an emptied paste  open     none
   reading             a file read pending     drop or choose a file             open     none
   ready               text present            a paste, or a finished read       open     Send N / Nothing to send
   sending             writes in flight        Send or Retry                     LOCKED   Sending...
   done                results shown           the last write came back          open     Retry N failed / Done
   failed              a read was refused      a file too big or unreadable      open     none
   A new paste, read, send or reset moves S.cur to a new run; a superseded run is never resumed. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { h } = K;
const HERE = (document.currentScript && document.currentScript.src) || null;
const NAME = { race: "Race", class: "Class", level: "Level", professions: "Professions" };
/* ONE size limit for the file, the text box and the reader: an export is at most 2048 characters, so 400000 is already generous (a whole SavedVariables file). Over it is refused out loud, never cut. */
const TEXT_MAX = 400000, TOO_BIG = "That file is larger than the add-on ever writes; paste only the export string.";
const WHY = { "no key": "this board link has no key", key: "this board link is not yours", off: "the party sheet is switched off for now", offline: "no connection", busy: "busy, try again in a minute", refused: "the board did not accept that value", failed: "the board could not save it", "nowhere to send": "no connection to the board", "not on the board's lists": "that value is not on the board's lists" };
const S = { text: "", results: null, mod: null, modP: null, ctx: null, say: "", fileErr: "", frozen: null, left: null, id: null, loadFail: false, tries: 0, n: 0, cur: null };
const begin = (kind, phase) => (S.cur = { id: ++S.n, kind, phase });
const own = (run) => S.cur === run;
const sending = () => !!S.cur && S.cur.phase === "sending";
/* the only way shared state is written: a superseded run changes nothing and learns so from the return value */
function put(run, patch) { if (!own(run)) return false; Object.assign(S, patch); return true; }
begin("idle", "idle");
let ctl = null, outEl = null;

function lib() {
  if (S.modP || !HERE) return S.modP;
  /* a failed import is remembered by the browser for that exact URL, so a retry asks for a new one */
  const u = new URL("../js/addon-import.js?v=ee0fc5e72b", HERE); if (S.tries) u.searchParams.set("r", String(S.tries));
  S.modP = import(u.href).then((m) => { S.mod = m; return m; }).catch(() => { S.modP = null; S.loadFail = true; S.tries++; return null; });
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
  if (!A) return { kind: S.loadFail ? "fail" : "wait" };
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
  const n = rows.filter((o) => o.change).length, can = S.ctx.canSend(), done = !!S.results, busy = sending();
  const failed = S.results ? Object.keys(S.results).filter((f) => !S.results[f].ok) : [];
  kids.push(h("p", { class: "imp-note", text: "Only lines marked Will change are sent, one at a time, after you tap Send. A line you left unticked in the add-on options is not in the export." }));
  kids.push(h("div", { class: "imp-act" },
    h("button", { type: "button", class: "lib-tool imp-send", id: "imp-send", "aria-disabled": can.ok && !busy && (failed.length || (n && !done)) ? null : "true", onclick: () => (failed.length ? retry() : send(rows)) }, busy ? "Sending..." : failed.length ? `Retry ${failed.length} failed line${failed.length === 1 ? "" : "s"}` : done ? "Done" : n ? `Send ${n} change${n === 1 ? "" : "s"} to my sheet` : "Nothing to send"),
    !can.ok ? h("span", { class: "imp-why", text: can.why }) : null));
  return h("div", { class: "imp-sum" }, ...kids);
}
function send(rows) {
  const can = S.ctx.canSend(); if (sending() || S.results || !can.ok) return;
  const todo = rows.filter((o) => o.change); if (!todo.length) return;
  return execute("send", todo, rows, {});
}
/* Retry: plan again against what the sheet shows NOW, and send only the lines that failed (and still differ). Lines already sent keep their result. */
function retry() {
  const A = S.mod, can = S.ctx.canSend(); if (sending() || !S.results || !can.ok || !A) return;
  const failed = Object.keys(S.results).filter((f) => !S.results[f].ok); if (!failed.length) return;
  const r = A.parse(S.text); if (!r.ok) return;
  const fresh = A.plan(A.mapToBoard(r.data, S.ctx.lists()), S.ctx.current());
  const keep = {}; for (const f of Object.keys(S.results)) if (S.results[f].ok) keep[f] = S.results[f];
  const frozen = (S.frozen || []).map((o) => (failed.includes(o.field) ? fresh.find((x) => x.field === o.field) || o : o));
  const todo = fresh.filter((o) => failed.includes(o.field) && o.change);
  if (!todo.length) { const run = begin("retry", "done"); put(run, { results: keep, frozen, say: "Nothing left to retry: those lines already match your sheet." }); update(); return; }
  return execute("retry", todo, frozen, keep);
}
/* One send or retry. Everything after an await first asks own(run): a run that was superseded (a character switch, a reset) writes nothing, unlocks nothing and renders nothing. */
async function execute(kind, todo, frozen, keep) {
  const run = begin(kind, "sending"), who = S.ctx.identity ? S.ctx.identity() : null, res = {}, B = window.BoardBrain;
  put(run, { left: todo.map((o) => o.field), frozen, results: Object.keys(keep).length ? keep : null, say: "" }); update();
  try {
    for (const o of todo) {
      if (!own(run)) return;
      if (who !== null && !sameWho(who, S.ctx.identity())) { for (const q of todo) if (!(q.field in res)) res[q.field] = { ok: false, why: "you switched characters" }; break; }
      put(run, { left: todo.filter((q) => q !== o && !(q.field in res)).map((q) => q.field) });
      let r; try { r = await B.setSheet(o.field, o.after); } catch (e) { r = { ok: false, why: "failed" }; }
      if (!own(run)) return;
      res[o.field] = r && r.ok ? { ok: true } : { ok: false, why: WHY[r && r.why] || "the board could not save it" };
    }
  } catch (e) { if (put(run, { left: null, say: "Sending stopped because of an error. Check the lines below." })) { run.phase = "done"; put(run, { results: { ...keep, ...res } }); update(); } return; }
  if (!own(run)) return;
  const ok = Object.values(res).filter((x) => x.ok).length;
  run.phase = "done";
  put(run, { left: null, results: { ...keep, ...res }, say: ok === todo.length ? `Sent ${ok} line${ok === 1 ? "" : "s"} to your sheet.` : `${ok} of ${todo.length} lines sent. The rest were not.` });
  update();
  if (S.ctx.done) S.ctx.done();
}
/* the same context: same view and sheet, and the same character, where an empty character id (the list has not loaded yet) matches any */
function sameWho(a, b) {
  const [pa, ca] = String(a).split("|"), [pb, cb] = String(b).split("|");
  return pa === pb && (!ca || !cb || ca === cb);
}
/* Wipes everything that belongs to one context by replacing the current run with a new idle one: anything still in flight is superseded and can never write again.
   If a send was cut off by the switch, the lines it had not sent yet are named in the notice. */
function reset() {
  const cut = sending() && S.left && S.left.length ? S.left.map((f) => NAME[f]).join(", ") : "";
  const run = begin("idle", "idle");
  Object.assign(S, { text: "", results: null, frozen: null, fileErr: "", left: null, id: null, say: cut ? `Not sent: you switched characters. Stopped before ${cut}.` : "" });
  if (run && outEl && outEl.isConnected) update();
}
function update() {
  if (!outEl || !outEl.isConnected) return;
  const x = read();
  let body;
  if (S.fileErr) body = h("p", { class: "imp-bad", role: "alert", text: S.fileErr });
  else if (x.kind === "ok") body = summary(x);
  else if (x.kind === "bad") body = h("p", { class: "imp-bad", role: "alert", text: x.why });
  else if (x.kind === "fail") body = h("div", { class: "imp-sum" }, h("p", { class: "imp-bad", role: "alert", text: "The reader could not load. Reload the page and try again." }), h("div", { class: "imp-act" }, h("button", { type: "button", class: "lib-tool imp-retry-load", id: "imp-retry-load", onclick: () => { S.loadFail = false; update(); const p = lib(); if (p) p.then(update); } }, "Try loading it again"), h("button", { type: "button", class: "lib-tool imp-reload", onclick: () => { try { location.reload(); } catch (e) {} } }, "Reload the page")));
  else if (x.kind === "wait") body = h("p", { class: "imp-info", text: "Loading the reader..." });
  else body = h("p", { class: "imp-info", text: "Nothing is read until you paste or drop an export. Nothing is sent until you tap Send." });
  if (ctl) { const lock = sending(); ctl.ta.disabled = lock; ctl.pick.disabled = lock; ctl.choose.disabled = lock; ctl.drop.setAttribute("aria-disabled", String(lock)); }
  outEl.replaceChildren(body, h("p", { class: "imp-say", id: "imp-say", role: "status", "aria-live": "polite", text: S.say }));
}
/* a paste or a dropped text: a new run, synchronous */
function setText(t) {
  if (sending()) return;
  t = String(t); const big = t.length > TEXT_MAX, run = begin("paste", big ? "failed" : t.trim() ? "ready" : "idle");
  put(run, { results: null, say: "", frozen: null, text: big ? "" : t, fileErr: big ? TOO_BIG : "" }); update();
}
function fromFile(file, ta) {
  if (!file || sending()) return;
  const run = begin("read", "reading"); put(run, { fileErr: "", results: null, frozen: null, say: "" }); /* a new read supersedes every earlier read, paste and result */
  if (file.size > TEXT_MAX) { run.phase = "failed"; if (put(run, { text: "", fileErr: TOO_BIG })) { ta.value = ""; update(); } return; }
  Promise.resolve().then(() => file.text()).then((t) => {
    if (!own(run)) return;
    if (t.length > TEXT_MAX) { run.phase = "failed"; if (put(run, { text: "", fileErr: TOO_BIG })) { ta.value = ""; update(); } return; }
    run.phase = t.trim() ? "ready" : "idle";
    if (put(run, { text: t, fileErr: "" })) { ta.value = t; update(); }
  }, () => { if (!own(run)) return; run.phase = "failed"; if (put(run, { fileErr: "That file could not be read." })) update(); });
}
function mount(host, ctx) {
  const id = ctx.identity ? ctx.identity() : null;
  if (S.id !== null && id !== null && !sameWho(S.id, id)) reset();
  S.id = id; S.ctx = ctx;
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
    e.preventDefault(); drop.classList.remove("imp-over"); if (sending()) return;
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
window.BoardImport = Object.freeze({ mount, reset });
})();
