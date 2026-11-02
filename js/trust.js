// "What we track and why": a plain-language card, reachable from the More menu and the footer. Copy lives in data/trust.json; every string is set with textContent.
// Opens a small modal over the board (role=dialog, focus moves in, Escape or Close returns focus to whatever opened it).
(() => {
"use strict";
const K = window.__boardKit; if (!K || !K.h) return;
const { h } = K;
let pop = null, from = null, copy = null;
const FALLBACK = { title: "What we track and why", lines: [] };
const load = () => copy ? Promise.resolve(copy) : fetch("data/trust.json").then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then((j) => (copy = j), () => FALLBACK);
function close() { if (!pop) return; pop.remove(); pop = null; document.removeEventListener("keydown", onKey, true); const f = from; from = null; if (f && f.isConnected) { try { f.focus(); } catch (e) {} } }
function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab" || !pop) return;
  const f = [...pop.querySelectorAll("button")]; if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function line(l) {
  const kids = [h("h3", { class: "tr-label", text: l.label }), h("p", { class: "tr-what", text: l.what }), h("p", { class: "tr-why" }, h("span", { class: "tr-whyk", text: "Why: " }), document.createTextNode(l.why))];
  if (l.link) kids.push(h("p", { class: "tr-erase" }, h("span", { class: "tr-link", "aria-disabled": "true", text: l.link }), h("span", { class: "tr-soon", text: ` (${l.soon || "coming soon"})` })));
  return h("li", { class: "tr-line", "data-line": l.id }, ...kids);
}
function open(opener) {
  if (pop) return;
  from = opener || document.activeElement;
  const c = copy || FALLBACK;
  const closeBtn = h("button", { class: "tr-close", type: "button", onclick: close, text: (c.close || "Close") });
  pop = h("div", { class: "tr-back", id: "trust-card", onclick: (e) => { if (e.target === pop) close(); } },
    h("section", { class: "tr-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "tr-title" },
      h("h2", { class: "tr-title", id: "tr-title", text: c.title }),
      c.intro ? h("p", { class: "tr-intro", text: c.intro }) : null,
      h("ol", { class: "tr-lines" }, ...c.lines.map(line)),
      closeBtn));
  document.body.append(pop); document.addEventListener("keydown", onKey, true); closeBtn.focus({ preventScroll: true });
}
// Opens at once; the copy is read first when it is not cached yet, so the first open never shows an empty card.
const show = (opener) => load().then(() => open(opener));
window.BoardTrust = Object.freeze({ open: show, close, label: () => (copy && copy.menu) || "What we track and why", footerLabel: () => (copy && copy.footer) || "What we track and why", open_: () => !!pop });
load();
})();
