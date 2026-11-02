// The group's votes on the board. Reads the public GET /api/votes (id, title, choices with counts, closes_at, open) and nothing else:
// the route never carries voter data, and this file renders only those fields, always through textContent.
// Two views share one fetch: the "Open votes" card on Next steps (open votes only, hidden when there are none)
// and the full list in What to decide (open, then recent). Polls every 60 s, only while one of the two panels is on screen.
(() => {
"use strict";
const K = window.__boardKit; if (!K || !K.h) return;
const { $, h } = K;
const EVERY = 60000, STALE = 15000, TIMEOUT = 8000, RECENT_MAX = 8;
const V = { list: null, failed: false, at: 0, busy: false, timer: 0 };
const EMPTY = "No open votes. Start one in Discord with /vote start.";
const HOW = "Vote in Discord with the buttons on the poll message.";

const baseHttp = () => { try { const B = window.BoardBrain; const st = B && B.status ? B.status() : null; return st && st.base ? st.base : null; } catch (e) { return null; } };
const num = (n) => (typeof n === "number" && isFinite(n) && n >= 0 ? Math.floor(n) : 0);
const clean = (raw) => {
  if (!raw || !Array.isArray(raw.votes)) return null;
  const out = [];
  for (const v of raw.votes.slice(0, 50)) {
    if (!v || typeof v.title !== "string" || !Array.isArray(v.choices)) continue;
    const at = Date.parse(v.closes_at);
    out.push({ id: String(v.id || out.length), title: v.title.slice(0, 200), open: v.open === true && isFinite(at) && at > Date.now() - 60000, closes: isFinite(at) ? at : null,
      choices: v.choices.slice(0, 5).filter((c) => c && typeof c.label === "string").map((c) => ({ label: c.label.slice(0, 100), count: num(c.count) })) });
  }
  return out;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function closesIn(ms) {
  const left = ms - Date.now();
  if (left <= 0) return "Closing now";
  if (left < 3600000) return `Closes in ${plural(Math.max(1, Math.ceil(left / 60000)), "minute")}`;
  return `Closes in ${plural(Math.ceil(left / 3600000), "hour")}`;
}
function closedOn(ms) {
  try { return `Closed ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms))}`; } catch (e) { return "Closed"; }
}

function block(v) {
  const total = v.choices.reduce((n, c) => n + c.count, 0), top = Math.max(0, ...v.choices.map((c) => c.count));
  const rows = v.choices.map((c) => {
    const fill = h("span", { class: "vt-fill" });
    fill.style.setProperty("--vt-w", `${total ? Math.round((c.count / total) * 100) : 0}%`);
    return h("li", { class: "vt-row", "data-lead": top > 0 && c.count === top ? "1" : "0" },
      h("span", { class: "vt-label", text: c.label }), h("span", { class: "vt-count", text: String(c.count) }),
      h("span", { class: "vt-bar", "aria-hidden": "true" }, fill));
  });
  const when = v.open && v.closes ? closesIn(v.closes) : (v.closes ? closedOn(v.closes) : "Closed");
  return h("article", { class: "vt-vote", "data-open": v.open ? "1" : "0" },
    h("h3", { class: "vt-title", text: v.title }),
    h("ul", { class: "vt-rows" }, ...rows),
    h("p", { class: "vt-meta", text: `${plural(total, "vote")}. ${when}.` }));
}

let tonight = null, full = null;
function ensureHosts() {
  const tp = $("#panel-tonight");
  if (tp && (!tonight || !tonight.isConnected)) {
    tonight = h("section", { class: "vt-card vt-tn", id: "vt-tonight", "aria-labelledby": "vt-tn-h", hidden: true });
    tp.insertBefore(tonight, tp.firstChild);
  }
  const dp = $("#panel-decide");
  if (dp && (!full || !full.isConnected)) {
    full = h("section", { class: "vt-card vt-full", id: "dc-votes", "aria-labelledby": "vt-dc-h" });
    const main = $("#dc-main");
    if (main && main.parentNode === dp) dp.insertBefore(full, main); else dp.appendChild(full);
  }
}
function render() {
  ensureHosts();
  const list = V.list || [], open = list.filter((v) => v.open), closed = list.filter((v) => !v.open).slice(0, RECENT_MAX);
  if (tonight) {
    if (open.length) {
      tonight.replaceChildren(h("h2", { class: "vt-h", id: "vt-tn-h", text: open.length === 1 ? "Open vote" : "Open votes" }), ...open.map(block), h("p", { class: "vt-how", text: HOW }));
      tonight.hidden = false;
    } else { tonight.hidden = true; tonight.replaceChildren(); }
  }
  if (full) {
    const kids = [h("h2", { class: "vt-h", id: "vt-dc-h", text: "Votes" })];
    if (V.list === null) kids.push(h("p", { class: "vt-note", role: "status", text: V.failed ? "The votes did not load. They will be tried again in a minute." : "Loading the votes." }));
    else {
      if (!open.length) kids.push(h("p", { class: "vt-note", text: EMPTY }));
      else kids.push(...open.map(block), h("p", { class: "vt-how", text: HOW }));
      if (closed.length) kids.push(h("h3", { class: "vt-sub", text: "Recent votes" }), ...closed.map(block));
      if (V.failed) kids.push(h("p", { class: "vt-note", text: "The latest check failed; this is the last list that loaded." }));
    }
    full.replaceChildren(...kids);
  }
}

async function load() {
  const base = baseHttp();
  if (!base || V.busy) { if (!base && V.list === null) { V.failed = true; render(); } return; }
  V.busy = true;
  const ac = typeof AbortController === "function" ? new AbortController() : null, t = ac ? setTimeout(() => ac.abort(), TIMEOUT) : 0;
  try {
    const r = await fetch(`${base}/votes`, { cache: "no-cache", credentials: "omit", signal: ac ? ac.signal : undefined });
    if (!r.ok) throw new Error(`votes answered ${r.status}`);
    const list = clean(await r.json()); if (!list) throw new Error("votes answered an unexpected shape");
    V.list = list; V.failed = false; V.at = Date.now();
  } catch (e) { V.failed = true; } finally { if (t) clearTimeout(t); V.busy = false; }
  render();
}
const shown = (id) => { const p = $(id); return !!p && !p.hidden; };
const wanted = () => !document.hidden && (shown("#panel-tonight") || shown("#panel-decide"));
function sync() {
  if (!wanted()) { if (V.timer) { clearInterval(V.timer); V.timer = 0; } return; }
  ensureHosts();
  if (!V.timer) {
    if (Date.now() - V.at > STALE) load(); else render();
    V.timer = setInterval(() => { if (wanted()) load(); else sync(); }, EVERY);
  }
}
function start() {
  ensureHosts();
  const mo = typeof MutationObserver === "function" ? new MutationObserver(sync) : null;
  for (const id of ["#panel-tonight", "#panel-decide"]) { const p = $(id); if (p && mo) mo.observe(p, { attributes: true, attributeFilter: ["hidden"] }); }
  document.addEventListener("visibilitychange", sync);
  K.on("scene", () => setTimeout(sync, 0)); K.on("booted", () => setTimeout(sync, 0)); K.on("tonight", () => setTimeout(sync, 0));
  sync();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
window.BoardVotes = { reload: load, clean };
})();
