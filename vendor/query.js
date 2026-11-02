export const OPERATORS = ["shelf", "level", "race", "class", "src", "since"];
const HELP = [
  ['"exact phrase"', "Only facts whose title, key or text hold the phrase, in any case."],
  ["-word", "Leaves out every fact that has the word anywhere (title, key, text, aliases)."],
  ["shelf:classes", "One shelf: classes, dungeons, races, raids, systems, professions, pvp, leveling and so on."],
  ["level:40  level:30-40", "Facts that name that level, or any level in the range."],
  ["race:orc  class:mage", "Facts on that race or class page, or that name it."],
  ["src:blizzard", "Facts with a source whose host holds the text (blizzard, wowhead, icy-veins)."],
  ["since:2026-10-20", "Facts read from a source on that date or later (the page's check date when no source has one)."],
];
export const help = () => HELP.map(([op, text]) => `${op}  ${text}`);
export const helpRows = () => HELP.map(([op, text]) => ({ op, text }));
const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
export function parse(q) {
  const out = { terms: [], phrases: [], not: [], filters: {}, plain: false };
  let s = String(q == null ? "" : q);
  s = s.replace(/"([^"]+)"/g, (_, p) => { const t = p.trim().toLowerCase().replace(/\s+/g, " "); if (t) out.phrases.push(t); return " "; });
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^-([^\s:-][^\s]*)$/)) && /[a-z0-9]/i.test(m[1])) { out.not.push(m[1].toLowerCase()); continue; }
    if ((m = tok.match(/^([a-z]+):(.+)$/i)) && OPERATORS.includes(m[1].toLowerCase())) {
      const op = m[1].toLowerCase(), v = m[2].toLowerCase();
      if (op === "level") { const r = v.match(/^(\d{1,3})(?:-(\d{1,3}))?$/); if (r) { const a = num(r[1]), b = r[2] == null ? a : num(r[2]); out.filters.level = [Math.min(a, b), Math.max(a, b)]; continue; } }
      else if (op === "since") { if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { out.filters.since = v; continue; } }
      else { (out.filters[op] ||= []).push(v); continue; }
    }
    out.terms.push(tok);
  }
  out.plain = !out.phrases.length && !out.not.length && !Object.keys(out.filters).length;
  return out;
}
export const rankText = (p) => [...p.terms, ...p.phrases].join(" ");
const hayOf = (r) => `${r.title || (r.p && r.p.title) || ""} ${String(r.key || "").replace(/[._]/g, " ")} ${r.value || ""} ${((r.p && r.p.aliases) || []).join(" ")} ${String(r.page || "").replace(/[/-]/g, " ")}`.toLowerCase();
const shown = (r) => `${(r.p && r.p.title) || r.title || ""} ${String(r.key || "").replace(/[._]/g, " ")} ${r.key || ""} ${r.value || ""}`.toLowerCase();
const has = (hay, w) => hay.includes(w);
const refsOf = (r) => (r.f && r.f.refs) || r.refs || [];
export const readDate = (r) => { const d = refsOf(r).map((x) => x.accessed).filter(Boolean).sort().pop(); return d || (r.p && (r.p.checked || r.p.as_of)) || ""; };
export function levelsOf(r) {
  const v = String(r.value || ""), got = new Set();
  const add = (n) => { n = Number(n); if (n >= 1 && n <= 70) got.add(n); };
  for (const m of v.matchAll(/\b(?:levels?|lvls?)\s*(\d{1,2})(?:\s*(?:to|-|through|and)\s*(\d{1,2}))?/gi)) { add(m[1]); if (m[2]) add(m[2]); }
  if (/level|lvl/.test(String(r.key))) for (const m of v.matchAll(/\b\d{1,2}\b/g)) add(m[0]);
  return [...got];
}
export function matches(r, p) {
  const hay = hayOf(r), f = p.filters;
  for (const w of p.not) if (has(hay, w)) return false;
  if (p.phrases.length) { const sh = shown(r); for (const ph of p.phrases) if (!has(sh, ph)) return false; }
  if (f.shelf && !f.shelf.some((s) => String((r.p && r.p.category) || r.category || String(r.page).split("/")[0]) === s)) return false;
  if (f.class && !f.class.some((c) => String(r.page) === `classes/${c}` || new RegExp(`\\b${c.replace(/[^a-z0-9]/g, "")}\\b`).test(hay))) return false;
  if (f.race && !f.race.some((c) => String(r.page) === `races/${c}` || new RegExp(`\\b${c.replace(/[^a-z0-9]/g, "")}\\b`).test(hay))) return false;
  if (f.src && !f.src.some((s) => refsOf(r).some((x) => String(x.host || "").toLowerCase().includes(s)))) return false;
  if (f.since && !(readDate(r) >= f.since)) return false;
  if (f.level) { const [a, b] = f.level; if (!levelsOf(r).some((n) => n >= a && n <= b)) return false; }
  return true;
}
export const apply = (rows, p) => (p.plain ? rows : rows.filter((r) => matches(r, p)));
const allRows = (pages) => pages.flatMap((p) => p.facts.map((f) => ({ score: 0, page: p.id, key: f.key, value: f.value, open: false, p, f })));
export function run(core, pages, q, opts = {}) {
  const p = parse(q);
  if (p.plain) return { parsed: p, words: [], hits: core.rank(q, pages, opts).hits };
  const rt = rankText(p), ranked = rt.trim() ? core.rank(rt, pages, opts) : null;
  const rows = ranked ? ranked.hits : allRows(pages);
  return { parsed: p, words: ranked ? ranked.words : [], hits: apply(rows, p) };
}
