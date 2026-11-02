// Renders docs/privacy.md and docs/terms.md into privacy/index.html and terms/index.html. Node 22, no dependencies.
//
//   node tools/render-legal.mjs           write both pages
//   node tools/render-legal.mjs --check   exit 1 if either committed page is stale (CI runs this)
//
// The markdown subset is small on purpose: headings, paragraphs, lists (flat), tables, links, **bold**, `code`.
// Everything else is escaped as text. Raw HTML in the source never reaches the page. Link targets must be http(s), mailto, a relative path or a #fragment.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/|\.{0,2}\/|[A-Za-z0-9_-][A-Za-z0-9_./#-]*$)/;

// Inline: code spans first (their text is literal), then links and bold on the escaped remainder.
export function inline(src) {
  const out = [];
  String(src).split(/(`[^`]+`)/).forEach((part) => {
    if (/^`[^`]+`$/.test(part)) { out.push(`<code>${esc(part.slice(1, -1))}</code>`); return; }
    let t = esc(part);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const raw = href.replace(/&amp;/g, "&");
      return SAFE_HREF.test(raw) && !/^(?:javascript|data|vbscript):/i.test(raw) ? `<a href="${esc(raw)}">${label}</a>` : m;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out.push(t);
  });
  return out.join("");
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function render(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0, title = "";
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const hm = /^(#{1,4})\s+(.*?)\s*#*$/.exec(line);
    if (hm) {
      const n = hm[1].length;
      if (n === 1 && !title) title = hm[2];
      html.push(`<h${n}>${inline(hm[2])}</h${n}>`); i++; continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      html.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const lm = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (lm) {
      const ordered = /\d/.test(lm[1]), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "")); i++; }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isSep(lines[i + 1]))) para.push(lines[i++].trim());
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: html.join("\n"), title };
}

const CSS = `:root{--bg:#14100c;--text:#f3ead6;--dim:#d8caa8;--brass:#eecd8c;--line:#7a5a2c;--link:#eecd8c;--head:#2a2118}
@media (prefers-color-scheme:light){:root{--bg:#f6efde;--text:#2b1d10;--dim:#46331f;--brass:#7a3a12;--line:#b79a62;--link:#7a3a12;--head:#e9dcbd}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:dark light}
body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top,main,.foot{max-width:44rem;margin:0 auto;padding:0 16px}
.top{padding-top:16px}
.brand{margin:0}
a{color:var(--link)}
a:focus-visible{outline:3px solid var(--text);outline-offset:3px}
.back{display:inline-block;min-height:44px;padding:10px 0;font-weight:700}
h1{font-size:1.8rem;line-height:1.2;margin:1rem 0 .8rem;overflow-wrap:anywhere}
h2{font-size:1.2rem;color:var(--brass);margin:2rem 0 .6rem}
h3,h4{font-size:1.05rem;color:var(--brass);margin:1.4rem 0 .4rem}
p,li{overflow-wrap:anywhere}
ul,ol{padding-left:1.3rem}
li{margin:.25rem 0}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em;background:var(--head);padding:0 .25em;border-radius:3px}
.tbl{overflow-x:auto;margin:1rem 0;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:30rem;font-size:.95rem}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
th{background:var(--head);color:var(--brass)}
tr:last-child td{border-bottom:0}
.foot{margin-top:2.5rem;padding-top:1rem;padding-bottom:2rem;border-top:1px solid var(--line);color:var(--dim);font-size:.95rem}
@media (min-width:768px){h1{font-size:2.3rem}}`;

export function page({ title, docTitle, body, other }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(docTitle)} for the Leeroy board and Discord guild companion.">
<meta name="color-scheme" content="dark light">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><a class="back" href="/">Back to the board</a></header>
<main id="main">
${body}
</main>
<footer class="foot">
<p>Also: <a href="${esc(other.href)}">${esc(other.label)}</a>. This page is generated from <code>${esc(other.src)}</code> in the project repository. This site is not affiliated with or endorsed by Blizzard Entertainment.</p>
</footer>
</body>
</html>
`;
}

export const TARGETS = [
  { src: "docs/privacy.md", out: "privacy/index.html", name: "Privacy notice", other: { href: "/terms/", label: "Terms of use" } },
  { src: "docs/terms.md", out: "terms/index.html", name: "Terms of use", other: { href: "/privacy/", label: "Privacy notice" } },
];

export function build(root) {
  return TARGETS.map((t) => {
    const { html, title } = render(fs.readFileSync(path.join(root, t.src), "utf8"));
    return { out: t.out, html: page({ title: `${t.name} - Leeroy board`, docTitle: t.name, body: html, other: { ...t.other, src: t.src } }), heading: title };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const { out, html } of build(root)) {
    const file = path.join(root, out);
    const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (check) { if (have !== html) { stale++; console.log(`STALE ${out} (run: node tools/render-legal.mjs)`); } }
    else if (have !== html) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, html); console.log(`wrote ${out}`); }
  }
  if (check) { console.log(stale ? `${stale} legal page(s) stale` : "legal pages up to date"); process.exit(stale ? 1 : 0); }
}
