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
    } else if ((para.length >= 2 || /^\s*[•*-]\s/.test(para[0])) && isFact.every(Boolean)) {
      outParas.push(isFact.map((f) => `• **${f.name}** · ${f.value}`));
    } else {
      outParas.push(para);
    }
  });

  // Footer block.
  const footer = [];
  if (sourceIds) {
    const links = [...new Set(sourceIds)]
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

// ---- Deterministic voice guards (ANSWER_UX=on). Pure and idempotent: applyVoiceGuards(applyVoiceGuards(x)) === applyVoiceGuards(x).

const URL_SPLIT_RE = /(https?:\/\/[^\s<>)]+)/g;
// Mention syntax that would ping: @everyone, @here, <@id>, <@!id>, <@&id>.
const MENTION_RE = /@(?:everyone|here)\b|<@[!&]?\d+>/gi;
const STOCK_OPENER_RE =
  /(^|[.!?]["')*]*\s+|\n[ \t]*(?:•[ \t]+)?)(\*\*)?(honestly|on paper|the honest bit|the catch|short answer|great question)(\*\*)?(?:[ \t]*([,:;!.—–-]+))?(\*\*)?[ \t]*(\S)?/gi;
// Openers that read as an adverb and are safe to drop with or without punctuation after them.
const LOOSE_OPENERS = new Set(["honestly", "on paper"]);
const EMOJI_RE =
  /\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)\p{Emoji_Modifier}?(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?)\p{Emoji_Modifier}?)*/gu;
const SKIPPY_TEST_RE = /\bSkippy\b/i;
const SKIPPY_ALL_RE = /\bSkippy\b/gi;
// A sentence that, once renamed, says "Leeroy is not Leeroy" or "Leeroy, also known as Leeroy" cannot survive the rename.
const SELF_REF_RE =
  /\bLeeroy\b[^.!?\n]{0,40}?\b(?:and|or|vs\.?|versus|aka|a\.k\.a\.?|formerly|previously|not|isn't|is not|also known as|renamed|replaced|replaces)\b[^.!?\n]{0,40}?\bLeeroy\b|\bLeeroy\s*\((?:also |formerly |aka )?Leeroy\)/i;

export const DEFAULT_EGG = Object.freeze({ line: "At least I have chicken.", oneIn: 25 });

function eggHash(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export function eggSettings(egg) {
  const e = egg && typeof egg === "object" ? egg : {};
  const line = typeof e.line === "string" && e.line.trim() && e.line.length <= 200 ? e.line.trim() : DEFAULT_EGG.line;
  const n = Math.floor(Number(e.oneIn));
  return { line, oneIn: n >= 1 && n <= 100000 ? n : DEFAULT_EGG.oneIn };
}

// Whether the chicken line goes on this intent. Deterministic from a hash of the intent id, never random.
export function eggDue(intentId, egg) {
  const id = String(intentId == null ? "" : intentId);
  if (!id) return false;
  return eggHash(id) % eggSettings(egg).oneIn === 0;
}

// Apply fn to the parts of a text that are not URLs, so links survive renames.
function outsideUrls(text, fn) {
  return text
    .split(URL_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renameSkippy(text) {
  if (!SKIPPY_TEST_RE.test(text)) return text;
  const lines = text.split("\n").map((line) => {
    if (!SKIPPY_TEST_RE.test(line)) return line;
    const sentences = line.match(/[^.!?]+[.!?]*["')*]*\s*/g) || [line];
    const kept = sentences.filter((sent) => !SKIPPY_TEST_RE.test(sent) || !SELF_REF_RE.test(sent.replace(SKIPPY_ALL_RE, "Leeroy")));
    return kept.join("").replace(SKIPPY_ALL_RE, "Leeroy");
  });
  const out = lines.join("\n");
  return out.trim() ? out : text.replace(SKIPPY_ALL_RE, "Leeroy");
}

function applyRoster(text, roster) {
  if (!roster || typeof roster !== "object") return text;
  const pairs = Object.entries(roster)
    .filter(([alias, display]) => typeof alias === "string" && alias.trim() && typeof display === "string" && display.trim())
    .map(([alias, display]) => [alias.trim(), display.trim()])
    .filter(([alias, display]) => alias.toLowerCase() !== display.toLowerCase())
    .sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [alias, display] of pairs) {
    const at = display.toLowerCase().indexOf(alias.toLowerCase());
    const pre = at > 0 ? display.slice(0, at) : "";
    const post = at >= 0 ? display.slice(at + alias.length) : "";
    const re = new RegExp(
      `${pre ? `(?<!${escapeRe(pre)})` : ""}(?<![\\w-])${escapeRe(alias)}(?![\\w-])${post ? `(?!${escapeRe(post)})` : ""}`,
      "gi"
    );
    out = outsideUrls(out, (part) => part.replace(re, display));
  }
  return out;
}

function stripOpeners(text) {
  let out = text;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(STOCK_OPENER_RE, (m, pre, boldOpen, opener, boldMid, punct, boldEnd, nextCh) => {
      if (!punct && !LOOSE_OPENERS.has(String(opener).toLowerCase())) return m;
      if (!nextCh) return m; // nothing follows: keep it rather than leave an empty sentence
      const keepBold = boldOpen && !boldMid && !boldEnd ? "**" : "";
      return `${pre}${keepBold}${nextCh.toUpperCase()}`;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function limitBold(text) {
  let seen = false;
  return text.replace(/\*\*([^*\n]+)\*\*/g, (m, inner) => {
    if (!seen) {
      seen = true;
      return m;
    }
    return inner;
  });
}

function limitEmoji(text, max) {
  let n = 0;
  return text.replace(EMOJI_RE, (m) => (++n <= max ? m : ""));
}

// opts: roster ({ alias: display }), full (chat answers: also openers, bold, emoji and the chicken egg), intentId,
// egg ({ line, oneIn }), isCoach (no egg).
export function applyVoiceGuards(text, opts = {}) {
  if (typeof text !== "string" || !text) return text;
  try {
    let out = text.replace(/\r\n?/g, "\n");
    out = renameSkippy(out);
    out = outsideUrls(out, (part) => part.replace(/\bMatt\b/g, "Bloise"));
    out = applyRoster(out, opts.roster);
    out = out.replace(MENTION_RE, "");
    if (opts.full) {
      out = stripOpeners(out);
      out = limitBold(out);
      out = limitEmoji(out, 3);
    }
    out = out
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!out) return text;
    if (opts.full && !opts.isCoach && !opts.noEgg && eggDue(opts.intentId, opts.egg)) {
      const { line } = eggSettings(opts.egg);
      if (!out.toLowerCase().includes(line.toLowerCase())) out = `${out}\n\n${line}`;
    }
    return out;
  } catch {
    return text;
  }
}

// ---- "More" and "Sources" split. With ctx.ux the model may end its reply with `---more---` and/or `---sources---`
// markers, each on its own line. The channel keeps only the text before the first marker; the rest is stored for the buttons.

const MARKER_RE = /^[ \t]*---(more|sources)---[ \t]*$/gim;
export const MAX_DETAIL_CHARS = 7000;

export function splitAnswerParts(raw) {
  const text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
  const marks = [...text.matchAll(MARKER_RE)];
  if (!marks.length) return { main: text, more: "", sources: "" };
  const parts = { more: [], sources: [] };
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    parts[m[1].toLowerCase()].push(text.slice(m.index + m[0].length, end).trim());
  });
  return {
    main: text.slice(0, marks[0].index).trim(),
    more: parts.more.filter(Boolean).join("\n\n"),
    sources: parts.sources.filter(Boolean).join("\n"),
  };
}

function tidyDetail(text) {
  return String(text)
    .split("\n")
    .map((l) => tidy(l.replace(BRACKET_ID_RE, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Library ids become titled links; anything else is kept as a bullet with bare addresses wrapped so they do not embed.
function renderSourcesDetail(raw, ctx) {
  const byId = new Map();
  for (const p of Array.isArray(ctx.pages) ? ctx.pages : []) if (p && typeof p.id === "string") byId.set(p.id, p);
  const base = String(ctx.boardUrl || DEFAULT_BOARD).replace(/\/+$/, "");
  const out = [];
  for (const line of String(raw).split("\n")) {
    const t = line.replace(/^\s*(?:-#\s*)?(?:[-*•]\s+)?/, "").trim();
    if (!t) continue;
    const s = SOURCES_RE.exec(t);
    const body = s ? s[1] : t;
    const ids = parseSourceIds(body).filter((id) => byId.has(id));
    if (ids.length) {
      for (const id of ids) out.push(`• [${cleanTitle(byId.get(id).title || id) || id}](<${base}/#library.${id.replace("/", ".")}>)`);
      continue;
    }
    out.push(`• ${body.replace(BRACKET_ID_RE, "").replace(/(?<!<)(https?:\/\/[^\s<>)]+)/g, "<$1>")}`);
  }
  return [...new Set(out)].join("\n");
}

// { main, more, sources }. Without ctx.ux nothing is split or guarded and main is exactly what formatAnswer always returned.
export function formatAnswerParts(raw, ctx = {}) {
  if (typeof raw !== "string") return { main: raw, more: "", sources: "" };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  try {
    const guardOpts = { roster: c.roster, intentId: c.intentId, egg: c.egg, noEgg: Boolean(c.noEgg), isCoach: Boolean(c.isCoach) || c.journey === "guided" };
    const split = c.ux ? splitAnswerParts(raw) : { main: raw, more: "", sources: "" };
    // A reply that is only a marker section still gets a channel body.
    const mainRaw = split.main || split.more || split.sources || raw;
    let main = format(mainRaw, c);
    if (typeof main !== "string" || !main.length) main = raw;
    if (c.ux) main = applyVoiceGuards(main, { ...guardOpts, full: true });
    let more = "";
    let sources = "";
    if (c.ux) {
      if (split.main) {
        more = split.more ? applyVoiceGuards(tidyDetail(split.more), guardOpts).slice(0, MAX_DETAIL_CHARS) : "";
        sources = split.sources ? applyVoiceGuards(renderSourcesDetail(split.sources, c), guardOpts).slice(0, MAX_DETAIL_CHARS) : "";
      }
    }
    return { main, more, sources };
  } catch {
    return { main: raw, more: "", sources: "" };
  }
}

export function formatAnswer(raw, ctx = {}) {
  if (typeof raw !== "string") return raw;
  try {
    const out = formatAnswerParts(raw, ctx).main;
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

export function answerUxEnabled(env) {
  return String((env && env.ANSWER_UX) || "off").toLowerCase().trim() === "on";
}
