/* Next round lane C (NOTES-C.md): the Library head's "Checked {when}" line, the count of lines since board-lib-seen (written on
   close) and, with your own board link, the button that asks for a check. The head is rebuilt on every open: draw after that
   render and keep the line with a MutationObserver. */
(() => {
"use strict";
const K = window.__boardKit; if (!K) return;
const { $, h } = K, BB = () => window.BoardBrain;
const SEEN = "board-lib-seen", FILE = "data/library/refresh.json", NEWS = "data/library/news.json", LABEL = "Ask Leeroy's pipeline to check Blizzard now";
const POLL_MS = 20000, MAX_POLLS = 36; /* every 20 s, for 12 minutes */
const SAY = { none: "Not available yet.", key: "Your own board link lets you ask for a check.", bad: "This board link is no longer valid.", 409: "A check is already running.", run: "Asked.", late: "No answer from the pipeline yet.", play: "Asked. Reopen the Library to see the result." };
const R = { seen: null, busy: false, msg: "", polls: 0, timer: 0 };
const keyed = () => { const b = BB(); return !!(b && b.hasKey()); };
const getJson = (url, cache) => Promise.resolve().then(() => fetch(url, { cache })).then((r) => (r && r.ok ? r.json() : null)).catch(() => null);
const okFile = (j) => !!j && typeof j.checked === "string" && Number.isFinite(Date.parse(j.checked));
const when = (iso) => K.fmtWhen(Math.min(Date.parse(iso) / 1000, Date.now() / 1000), { rel: true }).replace(/, now$/, ", just now");
/* a dated line sits at noon UTC, as everywhere on the board: it counts when that noon is after the last look */
function count() {
  const ups = R.news && R.news.updates; if (!Array.isArray(ups)) return "";
  const n = ups.filter((u) => u && /^\d{4}-\d\d-\d\d$/.test(u.date) && (R.seen == null || Date.parse(`${u.date}T12:00:00Z`) > R.seen)).length;
  const since = R.seen == null ? "the library was built" : "you last looked";
  return n ? `${n} ${n === 1 ? "line" : "lines"} changed since ${since}.` : `Nothing changed since ${since}.`;
}
function text() {
  const f = R.file, gen = R.news && R.news.generated;
  const lead = f ? `Checked ${when(f.checked)}.` : Date.parse(gen) ? `Library built ${when(gen)}.` : "";
  return lead && [lead, count(), f && f.error ? "The last check did not finish." : ""].filter(Boolean).join(" ");
}
function paint() {
  R.line.textContent = text();
  const key = keyed(), has = R.go.parentNode === R.el;
  if (key && !has) R.el.insertBefore(R.go, R.say); else if (!key && has) R.el.removeChild(R.go);
  R.go.disabled = R.busy; R.go.textContent = R.busy ? "Running" : LABEL;
  if (R.busy) R.go.setAttribute("aria-busy", "true"); else R.go.removeAttribute("aria-busy");
  R.say.textContent = key ? R.msg : SAY.key;
}
function draw() {
  const box = $("#lib-head"); if (!box) return;
  if (!R.el) {
    R.line = h("p", { class: "lib-refresh-line" });
    R.go = h("button", { type: "button", class: "lib-tool lib-refresh-go", id: "lib-refresh-go", onclick: press }, LABEL);
    R.say = h("small", { class: "lib-refresh-say", role: "status", "aria-live": "polite" });
    R.el = h("div", { class: "lib-refresh", id: "lib-refresh" }, R.line, R.say);
  }
  paint();
  if (!text()) { if (R.el.parentNode) R.el.parentNode.removeChild(R.el); return; }
  if (R.el.parentNode !== box) box.append(R.el);
  if (!R.mo && typeof MutationObserver === "function") {
    R.mo = new MutationObserver(() => { const b = $("#lib-head"); if (R.inLib && b && R.el.parentNode !== b && text()) b.append(R.el); }); R.mo.observe(box, { childList: true });
  }
}
/* Running until refresh.json's checked moves (12 minutes at most); no polling in Play mode */
async function press() {
  if (R.busy || !keyed()) return;
  R.busy = true; R.msg = ""; R.base = R.file && R.file.checked; paint();
  let r = null; try { r = await BB().refreshLibrary(); } catch (e) {}
  const st = r && r.status, m = Math.ceil(Number(r && r.data && r.data.retryAfterMs) / 60000);
  if (st === 200 || st === 202) {
    if (document.documentElement.classList.contains("play")) { R.busy = false; R.msg = SAY.play; } else { R.msg = SAY.run; R.polls = 0; clearTimeout(R.timer); R.timer = setTimeout(tick, POLL_MS); }
  } else {
    R.busy = false;
    R.msg = st === 429 ? (m > 0 ? `Checked recently; the next check can run in about ${m} ${m === 1 ? "minute" : "minutes"}.` : "Checked recently.") : SAY[st === 401 ? "bad" : st] || SAY.none;
  }
  paint();
}
async function tick() {
  clearTimeout(R.timer); R.timer = 0;
  if (!R.busy) return;
  R.polls++;
  const j = await getJson(`${FILE}?t=${Date.now()}`, "no-store");
  if (!R.busy) return;
  if (okFile(j) && j.checked !== R.base) {
    R.file = j; R.busy = false; R.msg = "";
    const n = await getJson(`${NEWS}?t=${Date.now()}`, "no-cache");
    if (n && Array.isArray(n.updates)) R.news = n;
  } else if (R.polls >= MAX_POLLS) { R.busy = false; R.msg = SAY.late; }
  else { R.timer = setTimeout(tick, POLL_MS); return; }
  paint();
}
/* the Library renders its head from this same promise first, so the line is drawn from a later reaction */
function open() {
  R.inLib = true; R.seen = null;
  try { R.seen = Date.parse(localStorage.getItem(SEEN)) || null; } catch (e) {}
  K.libIndex().catch(() => null).then((i) => {
    if (!i) return;
    if (R.news || R.file) draw();
    const v = i.stamps && i.stamps["news.json"];
    return Promise.all([getJson(v ? `${NEWS}?v=${v}` : NEWS), getJson(FILE, "no-cache")]).then(([n, f]) => {
      if (n && typeof n === "object") R.news = n;
      if (okFile(f)) R.file = f;
      if (R.inLib) draw();
    });
  });
}
function leave() {
  if (!R.inLib) return;
  R.inLib = false;
  try { localStorage.setItem(SEEN, new Date().toISOString()); } catch (e) {}
}
K.on("scene", (key, prev) => { if (key === "library") open(); else if (prev === "library") leave(); });
K.on("closed", (key) => { if (key === "library") leave(); });
window.__libRefresh = Object.freeze({ state: () => ({ busy: R.busy, msg: R.msg, polls: R.polls, pending: !!R.timer, text: text() }), tick });
})();
