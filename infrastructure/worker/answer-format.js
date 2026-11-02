// Pure answer formatter (`worker/answer-format.js`). Runs on model output before it is stored or sent, for every
// provider and surface. No I/O, never throws, idempotent: formatAnswer(formatAnswer(x)) === formatAnswer(x).
//
// Shape it produces:
//   **Headline sentence.**
//
//   • **Name** · value
//   • **Name** · value
//
//   Any other body paragraph
//
//   -# Sources: [Page title](<https://leeroy.party/#library.cat.slug>) · [Page title](<...>)
//   -# [Open on the board](<https://...>)
//
//   Closing signature

const DEFAULT_BOARD = "https://leeroy.party";
const DEFAULT_MAX = 1200;
const MEMBER_NAMES = ["Santa", "Bible Boi", "Street Rat", "Bloise", "Handsome Squidward"];

const ID_RE = /^[a-z0-9_-]+\/[a-z0-9_.-]+$/i;
const SOURCES_RE = /^\s*(?:-#\s*)?Sources?\s*:\s*(.*)$/i;
const URL_LINE_RE = /^\s*(?:-#\s*)?(?:\[[^\]\n]*\]\(<?(https?:\/\/[^)>\s]+)>?\)|<?(https?:\/\/\S+?)>?)\s*$/i;
const FOOTER_LINE_RE = /^\s*-#(?:\s|$)/;
// Name · value  or  Name - value, optionally already a bullet with a bold name.
const FACT_RE = /^\s*(?:(?:[•*]|-(?=\s))\s*)?(?:\*\*)?([^·\n*]{1,50}?)(?:\*\*)?\s+(?:·|-|–|—)\s+(\S.*)$/;
const NAME_BAD_RE = /[.!?:]/;
const BRACKET_ID_RE = /\s*\[[a-z0-9_-]+\/[a-z0-9_.~-]+\](?!\()/gi;

const NAMES_ALT = MEMBER_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
// A sentence that opens by addressing a member by name plus a comma, at line start or right after a sentence end.
const ADDRESS_RE = new RegExp(
  `(?<=^|[.!?]["')]?\\*{0,2}\\s+)(?:${NAMES_ALT}),[^\\n]*?(?:[.!?](?=\\s|$)|$)`,
  "g"
);

function factOf(line) {
  const m = FACT_RE.exec(line);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || NAME_BAD_RE.test(name)) return null;
  return { name, value: m[2].trim() };
}

function idFromLibraryHref(href) {
  const m = /#library\.([a-z0-9_-]+)\.([a-z0-9_.-]+)$/i.exec(href);
  return m ? `${m[1]}/${m[2]}` : null;
}

function parseSourceIds(text) {
  const ids = [];
  const links = [...text.matchAll(/\]\(<?([^)>\s]+)>?\)/g)];
  if (links.length) {
    for (const l of links) {
      const id = idFromLibraryHref(l[1]);
      if (id) ids.push(id);
    }
  } else {
    const bracketed = [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const tokens = bracketed.length ? bracketed : text.split(/[,;·\s]+/);
    for (const t of tokens) {
      const id = String(t).trim().replace(/~.*$/, "").replace(/^[("'`]+|[)"'`.]+$/g, "");
      if (ID_RE.test(id)) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

function cleanTitle(t) {
  return String(t).replace(/[\[\]()<>]/g, "").trim();
}

function tidy(line) {
  return line
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/g, "");
}

function format(raw, ctx) {
  const pages = Array.isArray(ctx.pages) ? ctx.pages : [];
  const byId = new Map();
  for (const p of pages) if (p && typeof p.id === "string") byId.set(p.id, p);
  const base = String(ctx.boardUrl || DEFAULT_BOARD).replace(/\/+$/, "");
  const maxChars = Number(ctx.maxChars) > 0 ? Number(ctx.maxChars) : DEFAULT_MAX;
  const asker = ctx.asker || {};
  const isMember = asker.isMember !== false && String(asker.name || "").trim().toLowerCase() !== "visitor";

  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  // Pass 1: pull out sources, the board link and other footer lines; find the last footer line.
  let sourceIds = null;
  let boardLink = null;
  const otherFooter = [];
  let lastFooter = -1;
  const bodyIdx = [];
  lines.forEach((line, i) => {
    const s = SOURCES_RE.exec(line);
    if (s) {
      sourceIds = (sourceIds || []).concat(parseSourceIds(s[1]));
      lastFooter = i;
      return;
    }
    const u = URL_LINE_RE.exec(line);
    if (u) {
      if (!boardLink) boardLink = (u[1] || u[2]).replace(/[.,;)]+$/, "");
      lastFooter = i;
      return;
    }
    if (FOOTER_LINE_RE.test(line)) {
      otherFooter.push(line.trim());
      lastFooter = i;
      return;
    }
    bodyIdx.push(i);
  });

  const cleaned = (i) => {
    let l = lines[i].replace(BRACKET_ID_RE, "");
    if (!isMember) l = l.replace(ADDRESS_RE, "");
    return tidy(l);
  };

  let bodyLines = [];
  let tailLines = [];
  for (const i of bodyIdx) {
    const l = cleaned(i);
    (i > lastFooter && lastFooter >= 0 ? tailLines : bodyLines).push(l);
  }

  // Paragraphs of the body.
  const toParas = (arr) => {
    const paras = [];
    let cur = [];
    for (const l of arr) {
      if (l.trim() === "") {
        if (cur.length) paras.push(cur);
        cur = [];
      } else cur.push(l);
    }
    if (cur.length) paras.push(cur);
    return paras;
  };
  let paras = toParas(bodyLines);
  let tailParas = toParas(tailLines);

  // No footer in the original: a short last line glued onto a multi-line paragraph is the signature.
  if (lastFooter < 0 && paras.length >= 1) {
    const last = paras[paras.length - 1];
    if (last.length > (paras.length > 1 ? 1 : 2)) {
      const sig = last[last.length - 1];
      if (sig.length <= 80 && !factOf(sig) && !/^\s*[•*-]\s/.test(sig)) {
        last.pop();
        tailParas = [[sig]];
      }
    }
  }

  // Facts to bullets.
  const outParas = [];
  paras.forEach((para, pi) => {
    const isFact = para.map(factOf);
    if (pi === 0) {
      const head = para[0];
      let k = 1;
      const bullets = [];
      while (k < para.length && isFact[k]) {
        bullets.push(`• **${isFact[k].name}** · ${isFact[k].value}`);
        k++;
      }
      outParas.push([head]);
      if (bullets.length) outParas.push(bullets);
      if (k < para.length) outParas.push(para.slice(k));
    } else if (para.length >= 2 && isFact.every(Boolean)) {
      outParas.push(isFact.map((f) => `• **${f.name}** · ${f.value}`));
    } else {
      outParas.push(para);
    }
  });

  // Footer block.
  const footer = [];
  if (sourceIds) {
    const links = sourceIds
      .filter((id) => byId.has(id))
      .map((id) => `[${cleanTitle(byId.get(id).title || id) || id}](<${base}/#library.${id.replace("/", ".")}>)`);
    if (links.length) footer.push(`-# Sources: ${links.join(" · ")}`);
  }
  if (boardLink) footer.push(`-# [Open on the board](<${boardLink}>)`);
  for (const f of otherFooter) footer.push(f);

  const sigParas = tailParas.map((p) => p.join("\n"));
  const bodyBlocks = outParas.map((p) => p.map((l) => l));

  const assemble = (blocks, sig) => {
    const parts = blocks.map((p) => p.join("\n"));
    if (footer.length) parts.push(footer.join("\n"));
    for (const s of sig) parts.push(s);
    return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  };

  let text = assemble(bodyBlocks, sigParas);
  if (text.length > maxChars) {
    // Drop the signature first, then body lines from the end, keeping the headline and the footer lines.
    let sig = sigParas.slice();
    let blocks = bodyBlocks.map((b) => b.slice());
    text = assemble(blocks, sig);
    if (text.length > maxChars) {
      sig = [];
      text = assemble(blocks, sig);
    }
    while (text.length > maxChars && blocks.length) {
      const lastBlock = blocks[blocks.length - 1];
      if (blocks.length === 1 && lastBlock.length === 1) break;
      lastBlock.pop();
      if (!lastBlock.length) blocks.pop();
      text = assemble(blocks, sig);
    }
    if (text.length > maxChars && blocks.length) {
      const footerLen = footer.join("\n").length + 2;
      const room = Math.max(40, maxChars - footerLen - 1);
      const head = blocks[0][0];
      let cut = head.slice(0, room);
      const sp = cut.lastIndexOf(" ");
      if (sp > room * 0.5) cut = cut.slice(0, sp);
      blocks[0][0] = `${cut.replace(/[\s,;:]+$/, "")}…`;
      text = assemble([blocks[0]], sig);
    }
  }
  return text;
}

export function formatAnswer(raw, ctx = {}) {
  if (typeof raw !== "string") return raw;
  try {
    const out = format(raw, ctx && typeof ctx === "object" ? ctx : {});
    return typeof out === "string" && out.length ? out : raw;
  } catch {
    return raw;
  }
}

// Page ids a raw or formatted answer cites: bracketed ids anywhere, plus ids on a Sources line (plain or linked).
export function extractCitedIds(text) {
  try {
    const s = String(text || "");
    const ids = [];
    for (const m of s.matchAll(/\[([a-z0-9_-]+\/[a-z0-9_.-]+)(?:~[^\]]+)?\](?!\()/gi)) ids.push(m[1]);
    for (const line of s.split(/\r?\n/)) {
      const sm = SOURCES_RE.exec(line);
      if (sm) ids.push(...parseSourceIds(sm[1]));
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function answerFormatEnabled(env) {
  return String((env && env.ANSWER_FORMAT) || "on").toLowerCase().trim() !== "off";
}
