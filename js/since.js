/* Cinematic slice 3: since-last-visit marks. A warm edge, at most 3 items, on what changed since this browser last left the board. The diff is client side only:
   the epoch is a localStorage stamp ("board-last-visit", written when the page is hidden or left), read once per page load, compared with timestamps the data already carries
   (sign-up answers: entries[].updated, the library: changes[].date). No server change, no network. A first visit (no stamp) marks nothing; a stamp in the future marks nothing.
   Marks are an outline and a pseudo-element edge (no layout), cool over 8 s (css/open-return.css), and a mark that is shown without motion (reduced motion) is removed at 8 s too.
   What is marked: wall tiles (Sign-ups, Library), the names in the Sign-ups scene whose answer changed, the library's "what changed" rows dated after the stamp. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const KEY = "board-last-visit", CAP = 3, COOL_MS = 8000;
let epoch = 0;
try { epoch = Number(localStorage.getItem(KEY)) || 0; } catch (e) { epoch = 0; }
if (epoch > Date.now()) epoch = 0; // a stamp from the future (clock moved back) is not a visit
const at = (v) => { if (!v) return 0; const s = String(v), t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59Z`) : Date.parse(s); return Number.isFinite(t) ? t : 0; };
const isNew = (v) => epoch > 0 && at(v) > epoch;
const save = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} };
addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

const mark = (el) => { if (!el || el.dataset.since) return; el.dataset.since = "1"; el.classList.add("since"); setTimeout(() => { el.classList.remove("since"); }, COOL_MS); };
const top = (list, n = CAP) => list.filter((x) => x.at > epoch).sort((a, b) => b.at - a.at).slice(0, n);

function tiles() {
  if (!epoch) return;
  const D = K.D, cand = [];
  const S = D.signups;
  if (S) { const t = Math.max(at(S.updated), ...(S.entries || []).map((e) => at(e.updated))); if (t) cand.push({ key: "signups", at: t }); }
  const done = () => { for (const c of top(cand)) { const li = document.querySelector(`#wall > li.t-${c.key}`); mark(li); } };
  if (K.libIndex) K.libIndex().then((ix) => { const d = ix && ix.changes && ix.changes[0]; if (d) cand.push({ key: "library", at: at(d.date) }); done(); }, done);
  else done();
}
function rows() {
  if (!epoch) return;
  const open = K.SC.open;
  if (open === "signups") {
    const S = K.D.signups; if (!S || !S.entries) return;
    const when = new Map(S.entries.map((e) => [K.cleanName(e.name).toLowerCase(), at(e.updated)]));
    const chips = [...document.querySelectorAll("#dsu-body .trow-who .who")].map((el) => ({ el, at: when.get(el.textContent.trim().toLowerCase()) || 0 }));
    const seen = new Set();
    for (const c of top(chips.map((x) => x), CAP * 4)) { const k = c.el.textContent.trim().toLowerCase(); if (seen.has(k)) continue; seen.add(k); if (seen.size > CAP) break; mark(c.el); }
  } else if (open === "library") {
    const li = [...document.querySelectorAll("#panel-library .ribbon > li")].map((el) => { const t = el.querySelector("time[datetime]"); return { el, at: t ? at(t.getAttribute("datetime")) : 0 }; });
    for (const c of top(li)) mark(c.el);
  }
}
let timers = [];
K.on("scene", () => { timers.forEach(clearTimeout); timers = [0, 350, 1100].map((ms) => setTimeout(rows, ms)); });
K.whenSettled(() => { try { tiles(); } catch (e) { console.error("since", e); } });
/* clear() and run() let a test re-apply the marks on a quiet page and measure the layout shift across exactly that (the board has its own late font-swap shift on the five tile). */
const clear = () => { document.querySelectorAll("[data-since]").forEach((el) => { delete el.dataset.since; el.classList.remove("since"); }); };
const run = () => { tiles(); rows(); };
window.BoardSince = Object.freeze({ epoch: () => epoch, isNew, key: KEY, cap: CAP, coolMs: COOL_MS, clear, run });
})();
