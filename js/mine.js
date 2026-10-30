/* M3 (2026-10-30, MOBILE-CONTRACT 9.1): the board side of Discord parity. Full note: board/MOBILE-NOTES.md, file notes. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h } = K;
const BB = () => window.BoardBrain || null;
const html = document.documentElement;
const hap = (n) => { try { if (window.BoardHaptics) window.BoardHaptics.fire(n); } catch (e) {} };
const snd = (n) => { try { if (window.BoardSound) window.BoardSound.play(n); } catch (e) {} };
const WHEN = [["6pm", "6 PM ET, at launch"], ["8pm", "Around 8 PM ET"], ["later", "Later than that"]];
const PACK = [["yes", "Yes"], ["no", "No"]];
const MEET = [["vos", "Valley of Strength"], ["xroads", "The Crossroads"], ["other", "Somewhere else"]];
const NOT_YET = "Not switched on yet; your answer stays on this device.";
const NO_KEY = "To answer here, tap My board link on the Sign-ups card in Discord. It opens this board as you.";
const NO_FIX_KEY = "Reporting needs your own board link (My board link on the Sign-ups card).";
const M = { when: null, pack: null, meet: null, place: "", say: "", fixKey: null };
const phone = () => html.classList.contains("phone-shell");
const live = () => { const b = BB(), st = b ? b.status() : null; return !!(st && st.base && st.key); };
const clean = (t) => { const b = BB(); return b && b.cleanPlace ? b.cleanPlace(t) : String(t == null ? "" : t).replace(/<[^>]*>/g, " ").replace(/[<>*_~`|#\[\]@]/g, "").replace(/\s+/g, " ").trim(); };
const cut = (t, n) => Array.from(String(t)).slice(0, n).join("");

/* the board's own record of this person, where the mirror has it (Discord answers show as pressed) */
function seeded() {
  const b = BB(), e = b && b.mine ? b.mine() : null, loc = b && b.mineLocal ? b.mineLocal() : {};
  const pick = (list, v) => (list.some((x) => x[0] === v) ? v : null);
  const meetKey = (v) => (!v ? null : v === "Valley of Strength" ? "vos" : v === "The Crossroads" ? "xroads" : "other");
  if (loc.when) M.when = loc.when.value; else if (!M.when && e) M.when = pick(WHEN, e.when);
  if (loc.pack) M.pack = loc.pack.value; else if (!M.pack && e) M.pack = pick(PACK, e.pack);
  if (loc.meet) { M.meet = loc.meet.value; if (loc.meet.place) M.place = loc.meet.place; }
  else if (!M.meet && e && e.meet) { M.meet = meetKey(e.meet); if (M.meet === "other") M.place = cut(clean(e.meet), 40); }
}
function say(text) {
  M.say = text;
  for (const n of [$("#mine-status"), $("#mine-sheet-status")]) { if (n) n.textContent = text; }
}
async function write(slot, k, send) {
  if (!live()) { say(NO_KEY); hap("refusal"); snd("chip"); return; }
  const prev = M[slot]; M[slot] = k; paint();
  const r = await send();
  if (!(r && (r.ok || r.why === "not-yet"))) { M[slot] = prev; paint(); }
  if (r && r.ok) { say("Saved. Discord catches up when Leeroy is back."); hap("confirm"); snd("latch"); }
  else if (r && r.why === "not-yet") { say(NOT_YET); hap("select"); }
  else if (r && r.why === "busy") { say("Too many answers at once. Try again in a moment."); hap("refusal"); }
  else if (r && r.why === "key") { say("This board link is no longer valid. Tap My board link on the Sign-ups card again."); hap("refusal"); }
  else { say("Not sent. Nothing changed on the Sign-ups card."); hap("refusal"); }
}
const onWhen = (k) => write("when", k, () => BB().setWhen(k));
const onPack = (k) => write("pack", k, () => BB().setPack(k));
const onMeet = (k) => {
  if (k === "other" && !M.place) { if (!live()) { say(NO_KEY); hap("refusal"); return; } const i = $("#bsheet .mine-place") || $("#mine-place-row .mine-place"); say("Type a place, up to 40 characters, then Set this place."); if (i && i.focus) i.focus(); return; }
  return write("meet", k, () => BB().setMeet(k, k === "other" ? M.place : undefined));
};
const opt = (attrs, label, pressed, fn) => h("button", { type: "button", class: "lib-btn mine-opt", ...attrs, "aria-pressed": String(!!pressed), "aria-disabled": live() ? null : "true", onclick: () => fn() }, label);
function placeRow(inSheet) {
  const input = h("input", { type: "text", class: "mine-place", maxlength: "40", autocomplete: "off", "aria-label": "Somewhere else: a place, 40 characters", placeholder: "A place, 40 characters" });
  input.value = M.place;
  input.addEventListener("input", () => { M.place = cut(clean(input.value), 40); });
  const go = h("button", { type: "button", class: "lib-btn mine-opt", "aria-disabled": live() ? null : "true", onclick: () => { M.place = cut(clean(input.value), 40); if (!M.place) { say("Type a place first, up to 40 characters."); hap("refusal"); return; } onMeet("other"); } }, "Set this place");
  return h("div", { class: "mine-place-row", ...(inSheet ? {} : { id: "mine-place-row" }) }, input, go);
}
/* the groups; ids on the inline copy only, the sheet copy uses classes so no id repeats */
function groups(inSheet) {
  const g = (id, label, kids) => h("div", { class: "mine-grp", role: "group", "aria-label": label, ...(inSheet ? {} : { id }) }, h("p", { class: "mine-k", text: label }), kids);
  return [
    g("mine-when", "When you get on", h("div", { class: "mine-opts" }, WHEN.map(([k, t]) => opt({ "data-when": k }, t, M.when === k, () => onWhen(k))))),
    g("mine-pack", "A pack", h("div", { class: "mine-opts" }, PACK.map(([k, t]) => opt({ "data-pack": k }, t, M.pack === k, () => onPack(k))))),
    g("mine-meet", "Meeting point", h("div", { class: "mine-opts" }, MEET.map(([k, t]) => opt({ "data-meet": k }, t, M.meet === k, () => onMeet(k))))),
    g("mine-else", "Somewhere else", placeRow(inSheet)),
  ];
}
function openSheet() {
  const S = window.BoardSheets;
  if (!S) { say("The sheet is not available on this page."); return; }
  seeded();
  S.open({ id: "mine-night", title: "Your launch night", snaps: ["peek", "full"], peek: 0.6, start: "peek",
    build(body) { body.append(h("div", { class: "mine-sheet" }, ...groups(true), h("p", { class: "mine-status", id: "mine-sheet-status", role: "status", "aria-live": "polite", text: M.say }))); } });
}
function paint() {
  for (const n of document.querySelectorAll(".mine-opt")) {
    const w = n.getAttribute("data-when"), p = n.getAttribute("data-pack"), m = n.getAttribute("data-meet");
    if (w != null) n.setAttribute("aria-pressed", String(M.when === w)); else if (p != null) n.setAttribute("aria-pressed", String(M.pack === p)); else if (m != null) n.setAttribute("aria-pressed", String(M.meet === m));
    if (w != null || p != null || m != null) { if (live()) n.removeAttribute("aria-disabled"); else n.setAttribute("aria-disabled", "true"); }
  }
}
function renderSignups() {
  const act = $("#dsu-act"); if (!act) return;
  const old = $("#mine-act"); if (old && old.parentNode) old.parentNode.removeChild(old);
  seeded();
  const status = h("p", { class: "mine-status", id: "mine-status", role: "status", "aria-live": "polite", text: M.say });
  const body = phone()
    ? [h("button", { type: "button", class: "lib-btn mine-night", id: "mine-night-btn", "aria-haspopup": "dialog", onclick: openSheet }, "Your launch night"), status]
    : [...groups(false), status];
  act.append(h("div", { class: "mine-act", id: "mine-act" }, ...body));
}

/* ---------- Looks wrong? ---------- */
function pageId() {
  const m = /^#?library\.([a-z0-9_.\-]+?)(?:~.*)?$/.exec(String(location.hash || "")); if (!m) return null;
  const id = m[1].replace(".", "/"); return /^[a-z0-9/_.-]{1,80}$/.test(id) ? id : null;
}
function factRows(page) {
  const out = [];
  for (const n of page.querySelectorAll(".lf")) { const key = n.getAttribute("data-key"), v = n.querySelector(".lf-v"); if (key && /^[a-z0-9_.-]{1,80}$/.test(key)) out.push({ key, text: cut(String(v ? v.textContent : "").replace(/\s+/g, " ").trim(), 80) }); }
  return out;
}
function fixBody(rows, status) {
  M.fixKey = null; let note = "";
  const list = h("div", { class: "mine-facts", role: "radiogroup", "aria-label": "Which line looks wrong" }, rows.map((r, i) => {
    const inp = h("input", { type: "radio", name: "mine-fact", value: r.key, id: `mine-fact-${i}` });
    inp.addEventListener("change", () => { M.fixKey = r.key; for (const l of list.querySelectorAll(".mine-fact")) l.classList.toggle("on", l.getAttribute("for") === `mine-fact-${i}`); });
    return h("label", { class: "mine-fact", for: `mine-fact-${i}` }, inp, h("span", {}, h("b", { text: r.key.replace(/[._]/g, " ") }), h("small", { text: r.text })));
  }));
  const ta = h("textarea", { class: "mine-note", maxlength: "200", rows: "3", "aria-label": "A note, optional, 200 characters", placeholder: "A note, optional, 200 characters" });
  ta.addEventListener("input", () => { note = cut(clean(ta.value), 200); });
  const send = h("button", { type: "button", class: "lib-btn strong mine-send", onclick: async () => {
    const page = pageId();
    if (!live()) { status(NO_FIX_KEY); hap("refusal"); return; }
    if (!page || !M.fixKey) { status(page ? "Pick the line that looks wrong first." : "This view has no page to report on."); hap("refusal"); return; }
    const r = await BB().reportFact({ page, key: M.fixKey, ...(note ? { note } : {}) });
    if (r && r.ok) { status("Sent. The librarian checks it against the sources."); hap("confirm"); }
    else if (r && r.why === "not-yet") { status(NOT_YET); hap("select"); }
    else { status("Not sent. Nothing changed on the page."); hap("refusal"); }
  } }, "Send");
  return [list, ta, send];
}
function openFix(page) {
  const rows = factRows(page), S = window.BoardSheets;
  if (phone() && S) {
    S.open({ id: "mine-fix-sheet", title: "Something here looks wrong?", snaps: ["peek", "full"], peek: 0.6, start: "peek",
      build(body) { const st = h("p", { class: "mine-status", role: "status", "aria-live": "polite", text: live() ? "" : NO_FIX_KEY }); body.append(h("div", { class: "mine-sheet" }, ...fixBody(rows, (t) => { st.textContent = t; }), st)); } });
    return;
  }
  const old = $("#mine-fix-card"); if (old && old.parentNode) { old.parentNode.removeChild(old); return; }
  const st = h("p", { class: "mine-status", role: "status", "aria-live": "polite", text: live() ? "" : NO_FIX_KEY });
  const card = h("div", { class: "mine-card", id: "mine-fix-card", role: "group", "aria-label": "Something here looks wrong?" }, h("h4", { class: "lib-h", text: "Which line looks wrong?" }), ...fixBody(rows, (t) => { st.textContent = t; }), st);
  page.appendChild(card);
}
function footer() {
  const main = $("#lib-main"); if (!main) return;
  const page = main.querySelector(".lib-page"), have = $("#mine-fix");
  if (!page) { if (have && have.parentNode) have.parentNode.removeChild(have); return; }
  if (have && page.contains(have)) return;
  if (have && have.parentNode) have.parentNode.removeChild(have);
  page.appendChild(h("div", { class: "lib-row mine-foot" }, h("button", { type: "button", class: "lib-btn lib-tool", id: "mine-fix", onclick: () => openFix(page) }, "Something here looks wrong?")));
}
let watching = false;
function watch() {
  const main = $("#lib-main"); footer(); if (watching || !main || typeof MutationObserver !== "function") return;
  try { new MutationObserver(() => footer()).observe(main, { childList: true }); watching = true; } catch (e) {}
}

K.on("signups", renderSignups);
K.on("scene", (key) => { if (key === "signups") renderSignups(); if (key === "library") watch(); });
K.on("rendered", () => { renderSignups(); watch(); });
let rz = 0; const rs = () => { clearTimeout(rz); rz = setTimeout(renderSignups, 120); };
try { addEventListener("resize", rs, { passive: true }); } catch (e) {}
window.__mine = Object.freeze({ state: () => ({ ...M }), render: renderSignups, footer, status: () => ({ live: live(), phone: phone() }) });
})();
