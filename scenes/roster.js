(() => {
"use strict";
/* Officer roster (flag roster.v1 in data/client.json). A raid group as role columns with seat cards, a bench strip and a one-line summary.
   Reads data/sample/roster.json (fictional) until the groups API exists; shaped like the groups and group_slots rows. Every string is set with textContent. */
const K = window.__boardKit; if (!K || typeof document === "undefined") return;
const { h } = K, root = document.documentElement;
const HERE = (document.currentScript && document.currentScript.src) || "";
const URL_ROSTER = HERE ? new URL("../data/sample/roster.json", HERE).href : "data/sample/roster.json";
const ROLES = [["tank", "Tanks", "tank", "tanks"], ["healer", "Healers", "healer", "healers"], ["dps", "Damage", "damage", "damage"], ["flex", "Flex", "flex", "flex"]];
const R = { el: null, data: null, opener: null };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const seats = (d) => (d && Array.isArray(d.slots) ? d.slots : []);
function summary(d) {
  const all = seats(d), filled = all.filter((s) => s.status === "filled" && s.character), open = all.filter((s) => s.status === "open").length;
  const bench = (d && Array.isArray(d.bench) ? d.bench : []).length + all.filter((s) => s.status === "bench").length;
  const parts = ROLES.map(([k, , one, many]) => [filled.filter((s) => s.role === k).length, one, many]).filter(([n], i) => n > 0 || i < 3)
    .map(([n, one, many]) => (one === "damage" ? `${n} damage` : plural(n, one, many)));
  let t = parts.join(", ");
  if (open) t += `, ${plural(open, "seat open", "seats open")}`;
  return `${t}; ${bench} on the bench`;
}
function card(s, tabbable) {
  const c = s.character, filled = s.status !== "open" && c;
  const li = h("li", { class: `rs-seat${filled ? "" : " rs-open"}`, tabindex: tabbable ? "0" : "-1", "data-seat": "1" });
  if (!filled) { li.append(h("span", { class: "rs-name", text: "Open seat" }), h("span", { class: "rs-sub", text: "Nobody in this seat yet" })); return li; }
  li.style.setProperty("--rs-cls", c.color || "var(--brass)");
  li.append(h("span", { class: "rs-name", text: c.name }), h("span", { class: "rs-sub", text: `${c.class}${c.spec ? `, ${c.spec}` : ""}` }));
  return li;
}
function column(key, label, list, first) {
  const id = `rs-h-${key}`;
  return h("section", { class: "rs-col", "aria-labelledby": id, "data-role": key },
    h("h3", { class: "rs-colh", id }, label, h("span", { class: "rs-count", text: ` ${list.length}` })),
    h("ul", { class: "rs-list" }, list.map((s, i) => card(s, first && i === 0))));
}
function paint() {
  const d = R.data; if (!d) return;
  const body = R.el.querySelector("#rs-body");
  R.el.querySelector("#rs-h").textContent = (d.group && d.group.name) || "Raid roster";
  R.el.querySelector("#rs-sum").textContent = summary(d);
  const cols = ROLES.map(([k, label]) => [k, label, seats(d).filter((s) => s.role === k)]).filter(([k, , l]) => l.length || k !== "flex");
  let first = true;
  const nodes = cols.map(([k, label, l]) => { const c = column(k, label, l, first && l.length > 0); if (l.length) first = false; return c; });
  const bench = (d.bench || []).slice();
  const strip = h("section", { class: "rs-bench", "aria-labelledby": "rs-h-bench" },
    h("h3", { class: "rs-colh", id: "rs-h-bench" }, "Bench", h("span", { class: "rs-count", text: ` ${bench.length}` })),
    bench.length ? h("ul", { class: "rs-bl" }, bench.map((s) => { const li = card(s, false); li.classList.add("rs-bchip"); const r = ROLES.find((x) => x[0] === s.role); li.append(h("span", { class: "rs-role", text: r ? r[2] : s.role })); return li; }))
      : h("p", { class: "rs-empty", text: "Nobody on the bench." }));
  body.replaceChildren(h("div", { class: "rs-cols" }, nodes), strip);
}
const seatList = () => [...R.el.querySelectorAll("[data-seat]")];
function moveFocus(cur, dir) {
  const cols = [...R.el.querySelectorAll(".rs-col, .rs-bench")].map((c) => [...c.querySelectorAll("[data-seat]")]).filter((c) => c.length);
  const ci = cols.findIndex((c) => c.includes(cur)); if (ci < 0) return;
  const col = cols[ci], i = col.indexOf(cur); let to = null;
  if (dir === "down") to = col[i + 1] || null; else if (dir === "up") to = col[i - 1] || null;
  else if (dir === "home") to = col[0]; else if (dir === "end") to = col[col.length - 1];
  else { const nc = cols[ci + (dir === "right" ? 1 : -1)]; if (nc) to = nc[Math.min(i, nc.length - 1)]; }
  if (to) { for (const s of seatList()) s.tabIndex = -1; to.tabIndex = 0; to.focus(); }
}
const KEYS = { ArrowDown: "down", ArrowUp: "up", ArrowRight: "right", ArrowLeft: "left", Home: "home", End: "end" };
function onKey(e) {
  e.stopPropagation(); /* the scene underneath has its own Tab trap and arrow shortcuts */
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key === "Tab") {
    const s = [...R.el.querySelectorAll('button, [href], [tabindex="0"]')].filter((b) => !b.disabled && !b.closest("[hidden]")); if (!s.length) return;
    const i = s.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); s[s.length - 1].focus(); } else if (!e.shiftKey && i === s.length - 1) { e.preventDefault(); s[0].focus(); }
    return;
  }
  const dir = KEYS[e.key], t = e.target;
  if (dir && t && t.hasAttribute && t.hasAttribute("data-seat")) { e.preventDefault(); moveFocus(t, dir); }
}
function build() {
  if (R.el) return R.el;
  R.el = h("section", { class: "rs", id: "roster", role: "dialog", "aria-modal": "true", "aria-labelledby": "rs-h", hidden: "" },
    h("div", { class: "rs-veil", onclick: () => close() }),
    h("div", { class: "rs-card", tabindex: "-1", id: "rs-card" },
      h("div", { class: "rs-head" }, h("h2", { id: "rs-h", text: "Raid roster" }), h("button", { class: "rs-x", id: "rs-close", type: "button", "aria-label": "Close roster", text: "Close", onclick: () => close() })),
      h("p", { class: "rs-sum", id: "rs-sum", role: "status", text: "Loading the roster." }),
      h("p", { class: "rs-note", id: "rs-note", text: "Made-up names, for showing what the roster looks like. Arrow keys move between seats." }),
      h("div", { class: "rs-body", id: "rs-body" })));
  R.el.addEventListener("keydown", onKey);
  document.body.appendChild(R.el);
  return R.el;
}
function fetchData() {
  if (R.data) return Promise.resolve(R.data);
  return fetch(URL_ROSTER, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then((d) => (R.data = d));
}
function open(from) {
  build();
  R.opener = from || (document.activeElement !== document.body ? document.activeElement : null);
  R.el.hidden = false; root.classList.add("roster-open");
  try { if (location.hash !== "#roster") history.replaceState(history.state, "", `${location.pathname}${location.search}#roster`); } catch (e) {}
  try { R.el.querySelector("#rs-close").focus({ preventScroll: true }); } catch (e) {}
  fetchData().then(() => { if (R.el.hidden) return; paint(); setTimeout(() => { if (!R.el.hidden && !R.el.contains(document.activeElement)) { try { R.el.querySelector("#rs-close").focus({ preventScroll: true }); } catch (e) {} } }, 400); }, () => { R.el.querySelector("#rs-sum").textContent = "The roster did not load. Close this and try again."; });
  return true;
}
function close() {
  if (!R.el || R.el.hidden) return false;
  R.el.hidden = true; root.classList.remove("roster-open");
  try { if (location.hash === "#roster") history.replaceState(history.state, "", `${location.pathname}${location.search}`); } catch (e) {}
  const o = R.opener; R.opener = null;
  const t = o && o.isConnected !== false && !o.closest("[hidden]") ? o : document.getElementById("main");
  try { if (t) { if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); } } catch (e) {}
  return true;
}
addEventListener("hashchange", () => { if (location.hash === "#roster") open(); else if (R.el && !R.el.hidden) close(); });
window.BoardRoster = Object.freeze({ open, close, summary, status: () => ({ open: !!(R.el && !R.el.hidden) }) });
})();
