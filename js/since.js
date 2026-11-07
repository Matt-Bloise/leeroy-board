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
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const epochDay = () => new Date(epoch).toISOString().slice(0, 10);
/* A date-only value (the library's changes[].date) has no time of day, so it is compared by calendar day with the visit's UTC day: newer only when STRICTLY a later day. (Reading it as the end of its day would
   mark a change that already existed when the visitor left mid-day as new on every visit that day.) A full timestamp (a sign-up answer's updated) is compared exactly. */
const newer = (v) => { if (!(epoch > 0) || !v) return false; const s = String(v); return DAY.test(s) ? s > epochDay() : Date.parse(s) > epoch; };
const order = (v) => { const s = String(v || ""); const t = DAY.test(s) ? Date.parse(`${s}T23:59:59Z`) : Date.parse(s); return Number.isFinite(t) ? t : 0; };
const save = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} };
addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

/* Per item (a key), when it was first marked in this page load and whether the mark has cooled. A list that is rebuilt while a mark is still warm gets it again on the new element for the time that is left;
   once a mark has cooled the item is never marked again in this page load. */
const state = new Map();
const cooled = (key) => { const st = state.get(key); return !!(st && st.cooled); };
const mark = (el, key) => {
  if (!el || el.dataset.since) return false;
  let st = state.get(key); if (st && st.cooled) return false;
  if (!st) { st = { at: Date.now(), cooled: false }; state.set(key, st); }
  const left = COOL_MS - (Date.now() - st.at); if (left <= 0) { st.cooled = true; return false; }
  el.dataset.since = "1"; el.classList.add("since");
  setTimeout(() => { el.classList.remove("since"); st.cooled = true; }, left);
  return true;
};
const pick = (list, room) => list.filter((x) => newer(x.v)).sort((a, b) => order(b.v) - order(a.v)).slice(0, Math.max(0, room));
const marked = (root) => (root ? root.querySelectorAll("[data-since]").length : 0);

function tiles() {
  if (!epoch) return;
  const cand = [], S = K.D.signups;
  if (S) { const all = [S.updated, ...(S.entries || []).map((e) => e.updated)].filter(Boolean).sort((a, b) => order(b) - order(a)); if (all[0]) cand.push({ key: "signups", v: all[0] }); }
  const finish = () => { let room = CAP - marked(document.querySelector("#wall")); for (const c of pick(cand.filter((x) => !cooled(`tile:${x.key}`)), room)) { if (mark(document.querySelector(`#wall > li.t-${c.key}`), `tile:${c.key}`)) room--; } };
  if (K.libIndex) K.libIndex().then((ix) => { const d = ix && ix.changes && ix.changes[0]; if (d) cand.push({ key: "library", v: d.date }); finish(); }, finish);
  else finish();
}
function rows() {
  if (!epoch) return;
  const open = K.SC.open;
  if (open === "signups") {
    const S = K.D.signups, root = document.querySelector("#dsu-body"); if (!S || !S.entries || !root) return;
    const when = new Map(S.entries.map((e) => [K.cleanName(e.name).toLowerCase(), e.updated]));
    const chips = [...root.querySelectorAll(".trow-who .who")].map((el) => ({ el, name: el.textContent.trim().toLowerCase(), v: when.get(el.textContent.trim().toLowerCase()) }));
    /* a person can appear in several rows (a pack answer, a meeting point, an RSVP): one mark per person, on the first place their name shows, never one per row */
    const first = new Map(); for (const c of chips) if (!first.has(c.name)) first.set(c.name, c);
    for (const c of pick([...first.values()].filter((x) => !x.el.dataset.since && !cooled(`who:${x.name}`)), CAP - marked(root))) mark(c.el, `who:${c.name}`);
  } else if (open === "library") {
    const root = document.querySelector("#panel-library ol.ribbon"); if (!root) return; /* ol: a details with the class ribbon (the spell-diff note) comes first in some pages */
    const li = [...root.children].filter((el) => el.tagName === "LI").map((el) => { const t = el.querySelector("time[datetime]"); return { el, v: t ? t.getAttribute("datetime") : null, key: `chg:${t ? t.getAttribute("datetime") : ""}:${el.textContent.slice(0, 40)}` }; });
    for (const c of pick(li.filter((x) => !x.el.dataset.since && !cooled(x.key)), CAP - marked(root))) mark(c.el, c.key);
  }
}
/* Rows are marked when the scene opens and again whenever its panel gets new content (a list that renders late, a rebuild after a live update): a MutationObserver on the open panel, throttled,
   stopped when the scene closes or changes. Throttled to one pass per 120 ms. Element-level dedupe (data-since, and the done set) keeps a row from being marked twice or after it has cooled. */
let mo = null, deb = 0, watching = null;
const stop = () => { if (mo) mo.disconnect(); mo = null; watching = null; clearTimeout(deb); deb = 0; };
const watch = () => {
  const key = K.SC.open; // the scene that is open NOW: the board also emits "scene" while it pre-renders other panels in idle time, which must not move the observer
  if (!epoch || (key !== "signups" && key !== "library")) { stop(); return; }
  if (mo && watching === key) return;
  stop(); watching = key;
  const root = document.querySelector(`#panel-${key}`); if (!root) return;
  mo = new MutationObserver(() => { if (deb) return; deb = setTimeout(() => { deb = 0; try { rows(); } catch (e) { console.error("since", e); } }, 120); }); /* throttled, not debounced: a panel that keeps changing must still get its marks */
  mo.observe(root, { childList: true, subtree: true });
};
K.on("scene", () => { try { rows(); } catch (e) { console.error("since", e); } watch(); });
K.on("closed", stop);
K.whenSettled(() => { try { tiles(); } catch (e) { console.error("since", e); } });
/* clear() and run() let a test re-apply the marks on a quiet page and measure the layout shift across exactly that (the board has its own late font-swap shift on the five tile). */
const clear = () => { document.querySelectorAll("[data-since]").forEach((el) => { delete el.dataset.since; el.classList.remove("since"); }); state.clear(); };
const run = () => { tiles(); rows(); };
window.BoardSince = Object.freeze({ epoch: () => epoch, isNew: newer, key: KEY, cap: CAP, coolMs: COOL_MS, clear, run });
})();
