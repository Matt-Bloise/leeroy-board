(() => {
"use strict";
const BUILD = { v: "" };
const q2 = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
const linkOf = (id) => "#library." + String(id).replace("/", ".");
const COLS = ["id", "link", "title", "key", "fact", "kind", "host", "read", "build"];
function toRow(h, build) {
  const p = h.p || {}, refs = (h.f && h.f.refs) || h.refs || [], r = refs.slice().sort((a, b) => (a.tier || 9) - (b.tier || 9))[0] || {};
  const read = refs.map((x) => x.accessed).filter(Boolean).sort().pop() || p.checked || p.as_of || "";
  const page = h.page || p.id || "";
  return { id: `${page}~${h.key}`, link: linkOf(`${page}~${h.key}`), title: h.title || p.title || "", key: h.key, fact: h.value, kind: r.label || "", host: r.host || "", read, build: build || BUILD.v || "" };
}
const markdown = (r) => `**${r.title}** (${r.key}): ${r.fact}\nSource: ${r.kind || "no source"}, ${r.host || "no host"}, read ${r.read || "date unknown"}, game build ${r.build || "unknown"}\n${r.link}`;
const jsonOf = (r) => JSON.stringify({ id: r.id, link: r.link, title: r.title, key: r.key, fact: r.fact, source: { kind: r.kind, host: r.host, read: r.read }, build: r.build }, null, 2);
const csv = (rows) => "﻿" + [COLS.join(","), ...rows.map((r) => COLS.map((c) => q2(r[c])).join(","))].join("\r\n") + "\r\n";
function parseCsv(t) {
  t = String(t).replace(/^﻿/, ""); const out = []; let row = [], cell = "", inq = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inq) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else inq = false; } else cell += c; }
    else if (c === '"') inq = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  const [head, ...body] = out; return body.filter((b) => b.length === head.length).map((b) => Object.fromEntries(head.map((k, i) => [k, b[i]])));
}
const flagCard = (r, reason, proposedSource) => `Looks wrong: ${r.id}\nFact: ${r.fact}\nWhy: ${reason || "(no reason given)"}\nBetter source: ${proposedSource || "(none given)"}\nRead ${r.read || "unknown"}, game build ${r.build || "unknown"}`;
function saveFlag(r, reason, proposedSource) {
  const f = { id: r.id, reason: String(reason || "").slice(0, 500), proposedSource: String(proposedSource || "").slice(0, 300) };
  try { const all = JSON.parse(localStorage.getItem("board-flags") || "[]"); all.push({ ...f, at: new Date().toISOString().slice(0, 10) }); localStorage.setItem("board-flags", JSON.stringify(all.slice(-100))); } catch (e) {}
  try { const B = typeof window !== "undefined" && window.BoardBrain; if (B && typeof B.reportFact === "function") { const [page, key] = r.id.split("~"); Promise.resolve(B.reportFact({ page, key, note: `${f.reason} ${f.proposedSource}`.trim() })).catch(() => {}); } } catch (e) {}
  return f;
}
globalThis.BoardData = { toRow, markdown, jsonOf, csv, parseCsv, flagCard, saveFlag, linkOf, COLS, setBuild: (b) => { BUILD.v = b; } };
if (typeof window === "undefined" || typeof document === "undefined" || typeof addEventListener !== "function") return;

const HERE = (document.currentScript && document.currentScript.src) || "";
const U = (rel) => (HERE ? new URL(`../${rel}`, HERE).href : rel);
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const k in attrs || {}) { const v = attrs[k]; if (v === null || v === undefined || v === false) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const dl = (name, mime, text) => { try { const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name }); document.body.append(a); a.click(); a.remove(); } catch (e) {} };
const copy = async (text, btn) => { try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); } } catch (e) { window.prompt("Copy this", text); } };
const ST = { schema: null, index: null, pages: null, core: null, qm: null, hays: null, res: [], q: "" };
const get = (rel) => fetch(U(rel), { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(rel); return r.json(); });
async function load() {
  if (ST.pages) return;
  const [schema, index, core, qm] = await Promise.all([get("data/library/schema.json"), get("data/library/index.json"), import(U("vendor/rank-core.js?v=c24a6bb221")), import(U("vendor/query.js?v=6750bb2138"))]);
  ST.schema = schema; ST.index = index; ST.core = core; ST.qm = qm; BUILD.v = index.build || schema.build || "";
  const cats = await Promise.all(index.categories.map((c) => get(`data/library/${c.key}.json`).catch(() => ({ pages: [] }))));
  ST.pages = cats.flatMap((c) => c.pages).map((p) => ({ ...p, aliases: p.aliases || [], open: p.open || [] }));
  ST.hays = core.factHays(ST.pages);
}
const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
function filesSection() {
  const s = ST.schema;
  return el("section", { class: "dt-sec" }, el("h3", { text: "The files" }),
    el("p", { class: "dt-note", text: `Game build ${s.build}. Data generated ${String(s.generated).slice(0, 10)}. Every file is plain JSON beside the page, under data/library/.` }),
    el("table", { class: "dt-t" }, el("thead", null, el("tr", null, el("th", { text: "File" }), el("th", { text: "Size" }), el("th", { text: "Fields" }))),
      el("tbody", null, s.files.map((f) => el("tr", null, el("td", null, el("a", { href: U(`data/library/${f.file}`), text: f.file })), el("td", { text: kb(f.bytes) }), el("td", { text: String(f.fields.length) }))))));
}
function schemaSection() {
  return el("section", { class: "dt-sec" }, el("h3", { text: "The schema" }), el("p", { class: "dt-note", text: "One table per file: the field path, its type, an example and the share of rows that carry it. [] marks a list, {} a dictionary." }),
    ST.schema.files.map((f) => el("details", { class: "dt-file" }, el("summary", { text: `${f.file} (${f.fields.length} fields)` }),
      el("table", { class: "dt-t" }, el("thead", null, el("tr", null, el("th", { text: "Field" }), el("th", { text: "Type" }), el("th", { text: "Example" }), el("th", { text: "Share" }))),
        el("tbody", null, f.fields.map((x) => el("tr", null, el("td", { text: x.field }), el("td", { text: x.type }), el("td", { text: x.example || "" }), el("td", { text: `${Math.round(x.share * 100)}%` }))))))));
}
function idsSection() {
  const r = ST.schema.idRule;
  return el("section", { class: "dt-sec" }, el("h3", { text: "Stable ids" }),
    el("p", { text: `A fact is named ${r.form}. Its deep link is ${r.link}. ${r.note}` }),
    r.example ? el("p", null, "Example: ", el("code", { text: r.example.id }), " opens ", el("a", { href: r.example.link, text: r.example.link }), ".") : null,
    el("p", { class: "dt-note", text: `${ST.schema.ids.length} ids are listed in schema.json under "ids".` }));
}
function opsSection() {
  return el("section", { class: "dt-sec" }, el("h3", { text: "Search operators" }), el("dl", { class: "dt-ops" }, ST.qm.helpRows().flatMap((o) => [el("dt", null, el("code", { text: o.op })), el("dd", { text: o.text })])), el("p", { class: "dt-note", text: "Words that are not an operator stay plain words. With no operator, the order is the library's own ranking." }));
}
function rowCard(r) {
  const form = el("form", { class: "dt-flag", hidden: true });
  const why = el("input", { type: "text", maxlength: "500", "aria-label": "What looks wrong", placeholder: "What looks wrong" }), src = el("input", { type: "text", maxlength: "300", "aria-label": "A better source (optional)", placeholder: "A better source, if you have one" });
  const card = el("textarea", { readonly: true, rows: "4", "aria-label": "Card to copy", hidden: true });
  form.append(why, src, el("button", { type: "submit", text: "Make card" }), card);
  form.addEventListener("submit", (e) => { e.preventDefault(); saveFlag(r, why.value, src.value); card.value = flagCard(r, why.value, src.value); card.hidden = false; copy(card.value); });
  const b = (label, f) => el("button", { type: "button", class: "dt-b", text: label, onclick: (e) => copy(f(), e.currentTarget) });
  return el("li", { class: "dt-row", id: `dt-${r.id.replace(/[^a-z0-9]+/gi, "-")}` },
    el("p", { class: "dt-fact" }, el("a", { href: r.link, text: r.title }), ": ", r.fact),
    el("p", { class: "dt-meta", text: `${r.kind || "no source"}, ${r.host || "no host"}, read ${r.read || "unknown"}, game build ${r.build} (${r.id})` }),
    el("p", { class: "dt-acts" }, b("Link", () => (HERE ? location.origin + location.pathname + r.link : r.link)), b("Markdown", () => markdown(r)), b("JSON", () => jsonOf(r)), el("button", { type: "button", class: "dt-b", text: "Looks wrong?", onclick: () => { form.hidden = !form.hidden; } })), form);
}
function searchSection() {
  const box = el("input", { id: "dt-q", type: "search", "aria-label": "Search the facts with operators", placeholder: 'mage -fire  shelf:dungeons  level:30-40  "exact phrase"' });
  const count = el("p", { class: "dt-note", id: "dt-count", role: "status" }), list = el("ol", { class: "dt-list", id: "dt-list" });
  const exp = el("p", { class: "dt-acts" }, el("button", { type: "button", class: "dt-b", id: "dt-csv", text: "Export CSV", onclick: () => dl("library-search.csv", "text/csv;charset=utf-8", csv(ST.res)) }), el("button", { type: "button", class: "dt-b", id: "dt-json", text: "Export JSON", onclick: () => dl("library-search.json", "application/json", JSON.stringify(ST.res, null, 2)) }));
  const go = () => {
    const t = box.value.trim(); ST.q = t;
    if (!t) { ST.res = []; list.replaceChildren(); count.textContent = ""; return; }
    const { hits } = ST.qm.run(ST.core, ST.pages, t, { hays: ST.hays });
    ST.res = hits.filter((h) => !h.open).map((h) => toRow(h, BUILD.v));
    count.textContent = `${ST.res.length} facts (full read date and game build shown on every row)`;
    list.replaceChildren(...ST.res.slice(0, 50).map(rowCard));
    if (ST.res.length > 50) list.append(el("li", { class: "dt-note", text: `Showing 50 of ${ST.res.length}. The exports hold all of them.` }));
  };
  let tm = 0; box.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(go, 200); });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(tm); go(); } });
  return el("section", { class: "dt-sec" }, el("h3", { text: "Search with operators" }), box, count, exp, list);
}
let sheet = null;
const open = () => { try { return decodeURIComponent(location.hash.replace(/^#/, "")) === "data"; } catch (e) { return false; } };
async function show() {
  if (!open()) { if (sheet) sheet.hidden = true; return; }
  if (!sheet) { sheet = el("div", { id: "data-sheet", class: "dt", role: "dialog", "aria-label": "Data", tabindex: "-1" }); document.body.append(sheet); }
  sheet.hidden = false; sheet.replaceChildren(el("p", { text: "Loading the data files..." }));
  try { await load(); } catch (e) { sheet.replaceChildren(el("p", { text: "The data files did not load." }), el("button", { type: "button", class: "dt-b", text: "Try again", onclick: show })); return; }
  if (!open()) return;
  sheet.replaceChildren(el("header", { class: "dt-head" }, el("img", { class: "dt-art", src: U("img/data/ledger.svg"), alt: "", width: "48", height: "48" }), el("h2", { text: "Data" }), el("a", { class: "dt-b", href: "#", text: "Close", onclick: (e) => { e.preventDefault(); location.hash = ""; } })),
    el("p", { class: "dt-note", text: `As of ${String(ST.schema.generated).slice(0, 10)}, game build ${ST.schema.build}. The library is public JSON; this page says what is in it.` }),
    searchSection(), filesSection(), idsSection(), opsSection(), schemaSection());
  try { sheet.focus({ preventScroll: true }); } catch (e) {}
}
addEventListener("hashchange", show);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open()) location.hash = ""; });
if (open()) show();
})();
