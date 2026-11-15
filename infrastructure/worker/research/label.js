// /ask research mode (ASK_RESEARCH on): the finishing steps that replace the old deleters. Pure: no I/O, no clock, never throws on text.
//   labelClassic      supportCheck / groundedOrNotPublished DELETED a sentence holding a number or name the library never gave; this one TAGS it
//                     ("Classic value, not confirmed for Forever") and keeps it. Advice is kept. Nothing is cut. Code fences, table rows, link labels
//                     and inline code are never edited inside: the tag goes outside them.
//   neutraliseMentions / defuseLinks   mention and link safety for anything the model wrote or echoed from a library or fetched title.
//   researchPrepare   the whole text step (refusal sentences out, labels, safety, one sources/confidence line, whole-sentence trim).
//   fitToCap          the final length guarantee, run on the assembled answer.
// Blind spots (see the W4a report): a wrong number that equals a grounded number, "a dozen"/fractions, lower-case or single-word names, a false claim with no number or capitalised name.
import { unsupportedIn, allowedValues, sourceIdsOf } from "../self-rag.js";
import { badPhrases, HOUSE } from "../ask-build.js";
import { isRefusalSentence, refusalRemainder, contentSentences, splitBanter, splitSentenceText } from "../answer-lint.js";
import { RESEARCH_DOWN_ANSWER } from "./provider.js";

export const CLASSIC_TAG = "Classic value, not confirmed for Forever";
export const CLASSIC_NAME_TAG = "Classic-era name, not confirmed for Forever";
export const CLASSIC_SHORT_TAG = "Classic";
export const MAX_INPUT_CHARS = 20000; // a model answer is a few hundred characters; this bounds every regex below

const ZWSP = "​";
// Control characters 0x00-0x08 are used as internal placeholders; strip them from any input so a forged placeholder can never be restored.
const stripCtl = (t) => String(t == null ? "" : t).replace(/[\u0000-\u0008]/g, "");

// ---- mentions ---------------------------------------------------------------------------------------------------------------
// @everyone, @here, <@id>, <@!id>, <@&id>: a zero-width space breaks the token (allowed_mentions is none as well; this is the second lock).
export function neutraliseMentions(text) {
  return String(text == null ? "" : text)
    .replace(/@(everyone|here)\b/gi, `@${ZWSP}$1`)
    .replace(/<@([!&]?)(\d+)>/g, `<${ZWSP}@$1$2>`);
}

// ---- links ------------------------------------------------------------------------------------------------------------------
// The label class excludes "[" so a run of "[" is linear (each one stops at the next), and the input is capped.
const MASKED_RE = /\[([^\[\]\n]{0,300})\]\(\s*<?([^)>\s]{0,600})>?\s*\)/g;
const HOSTISH_RE = /(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
const BARE_URL_RE = /<?https?:\/\/[^\s<>)\]]+>?/gi;
const INVITE_RE = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/gi;
const bareHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
// Hosts a masked link may point at without a label check against the board: official game sources. The board's own host is passed in by the caller.
export const LINK_ALLOW_DEFAULT = ["wowhead.com", "classic.wowhead.com", "blizzard.com", "news.blizzard.com", "us.forums.blizzard.com", "worldofwarcraft.blizzard.com", "battle.net"];
function parseHttp(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null; // https://trusted.example@evil.test/ reads as trusted.example
    return u;
  } catch { return null; }
}
// A label with whitespace, zero-width characters and look-alike dots removed ("github․com" -> "github.com").
const normLabel = (l) => String(l).replace(/[․。．﹒‥·]/g, ".").replace(/[\s​-‏⁠﻿­]+/g, "");
// A masked link stays only when its target is plain http(s) with no userinfo, the host is on the allow-list (the board host plus LINK_ALLOW_DEFAULT) and no host-looking
// text in the label names a different host (exact comparison: a subdomain is a different host). Anything else is shown as its label plus the real host in a code span,
// not clickable. A bare address and a bare Discord invite become their host in a code span.
export function defuseLinks(text, { allow = [] } = {}) {
  const allowed = new Set([...LINK_ALLOW_DEFAULT, ...allow].map(bareHost));
  const kept = [];
  let out = stripCtl(text).slice(0, MAX_INPUT_CHARS).replace(MASKED_RE, (m, label, href) => {
    const clean = String(label).replace(/[`]/g, "");
    const u = parseHttp(href);
    if (!u) return clean;
    const host = bareHost(u.hostname);
    const shown = (normLabel(clean).match(HOSTISH_RE) || []).map(bareHost);
    if (!allowed.has(host) || shown.some((h) => h !== host)) return `${clean} (\`${host}\`)`;
    kept.push(`[${clean}](<${u.href}>)`);
    return `\u0000${kept.length - 1}\u0000`;
  });
  out = out.replace(BARE_URL_RE, (m) => {
    const u = parseHttp(m.replace(/^<|>$/g, "").replace(/[.,;:!?]+$/, ""));
    return u ? `\`${bareHost(u.hostname)}\`` : "";
  });
  out = out.replace(INVITE_RE, (m) => `\`${m.split("/")[0].toLowerCase()}\``);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)] ?? "");
}

// ---- markdown-aware sentence handling ---------------------------------------------------------------------------------------------
const ABBR_RE = /\b(?:e\.g|i\.e|approx|vs|etc|incl|cf|(?:Mr|Mrs|Ms|Dr|St|Mt|Lv|Lvl|No))\.|\b(?:[A-Za-z]\.){2,}/g; // also U.S. and the like
const LINK_SPAN_RE = /\[[^\[\]\n]{0,300}\]\([^)\n]{0,600}\)/g;
const CODE_SPAN_RE = /`[^`\n]*`/g;
// Hide link spans, inline code and abbreviation dots from the sentence splitter; returns { text, restore, plain }. Code is hidden first, so a code span inside a link label
// leaves a placeholder in the stored link: restore resolves placeholders recursively. plain() is the text the detectors read: links reduced to their label, code spans to their
// content, so a number inside a code span or a link label is still seen (and the tag is put on the sentence, outside the code or link).
function protect(line) {
  const store = [];
  const keep = (m) => { store.push(m); return `\u0001${store.length - 1}\u0001`; };
  const text = stripCtl(line).replace(CODE_SPAN_RE, keep).replace(LINK_SPAN_RE, keep).replace(ABBR_RE, (m) => m.replace(/\./g, "\u0002"));
  const restore = (s) => {
    let out = s.replace(/\u0002/g, ".");
    for (let i = 0; i < 6 && /\u0001\d+\u0001/.test(out); i++) out = out.replace(/\u0001(\d+)\u0001/g, (_m, k) => store[Number(k)] ?? "");
    return out.replace(/\u0001\d*\u0001?/g, "");
  };
  const plain = (s) => restore(s).replace(/\[([^\[\]\n]*)\]\([^)\n]*\)/g, "$1").replace(/`([^`\n]*)`/g, "$1");
  return { text, restore, plain };
}
const splitProtected = splitSentenceText; // bounded: a line over 5000 characters is one piece
export function splitSentences(line) {
  const p = protect(line);
  return splitProtected(p.text).map(p.restore);
}

const isFooter = (l) => /^\s*-#/.test(l);
const isSourcesFooter = (l) => SRC_LINE_RE.test(l);
// A fence line opens or closes a block only when it holds ONE fence marker ("```x```" is a one-line span, not a block).
const isFence = (l) => /^\s*(?:```|~~~)/.test(l) && (l.match(/```|~~~/g) || []).length === 1;
const isTableRow = (l) => /^\s*\|/.test(l) || (l.match(/\|/g) || []).length >= 2;
const BANTER_RE = /^\s*(?:(?<!\*)\*(?!\*)[^*\n]+\*|_[^_\n]+_)\s*$/;
const balanceBold = (s) => ((s.match(/\*\*/g) || []).length % 2 ? s.replace(/\*\*/g, "") : s);
// Open bold, open italics and an open code fence are closed by dropping the stray markers (or the open fence), never by leaving them to swallow the rest of the message.
function balanceMarkdown(text) {
  let s = text;
  if ((s.match(/^\s*(?:```|~~~)/gm) || []).length % 2) {
    const at = Math.max(s.lastIndexOf("\n```"), s.lastIndexOf("\n~~~"));
    s = at >= 0 ? s.slice(0, at) : s.replace(/^\s*(?:```|~~~).*$/m, "");
  }
  s = s.split("\n").map((l) => {
    if (isFence(l)) return l;
    let x = balanceBold(l);
    // Only a "*" that touches text can be an italic marker; a bullet ("* item") and a spaced operator ("5 * 3") are left alone.
    const italicLike = /(?<=[^*\s])\*(?!\*)|(?<!\*)\*(?=[^*\s])/g;
    if ((x.replace(/\*\*/g, "").match(italicLike) || []).length % 2) x = x.replace(italicLike, "");
    return x;
  }).join("\n");
  return s.trim();
}

// ---- refusals -----------------------------------------------------------------------------------------------------------------
// Drops a sentence only when the whole sentence is a refusal (answer-lint.js isRefusalSentence); a sentence that quotes or reports the wording stays.
export function stripRefusals(text) {
  const out = [];
  let inFence = false;
  for (const line of stripCtl(text).split("\n")) {
    if (isFence(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence || isFooter(line)) { out.push(line); continue; }
    const parts = splitSentences(line);
    // A refusal sentence goes; if it also carries advice after a comma ("..., so treat Frost as the safe pick."), the advice clause stays.
    const ok = parts.map((s) => (isRefusalSentence(s) ? refusalRemainder(s) : s)).filter(Boolean);
    if (ok.length === parts.length && ok.every((s, i) => s === parts[i])) out.push(line);
    else if (ok.length) out.push(balanceBold(ok.join(" ")));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// True when the text still says something after refusal sentences, "what would settle it" sentences, the outage note, footer lines (a "Sources:" line without "-#" too),
// bare addresses and trailing banter are set aside. A whole-italic answer is an answer.
export function usableAnswer(text) {
  const t = splitInlineSources(String(text || "").slice(0, MAX_INPUT_CHARS));
  const body = t.split("\n").map((l) => l.trim()).filter((l) => l && !isFooter(l) && !/^Sources?\s*:/i.test(l));
  return contentSentences(splitBanter(body).content).length > 0;
}

// ---- the labeller ------------------------------------------------------------------------------------------------------------
const DISCLAIMER_AFTER_RE = /^[^,;.()\n]{0,60}\((?:Classic|Classic value[^)]*|[^)]*not confirmed for Forever[^)]*)\)|^[^,;.()\n]{0,40}not confirmed for Forever/i;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A token is covered only when EVERY occurrence of it (on word/digit boundaries: "50" is not inside "450") is followed by a disclaimer for that clause.
const covered = (sent, token) => {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(token)}(?![A-Za-z0-9])`, "g");
  let any = false;
  for (const m of sent.matchAll(re)) {
    any = true;
    if (!DISCLAIMER_AFTER_RE.test(sent.slice(m.index + m[0].length))) return false;
  }
  return any;
};
// The tag goes before the sentence's tail: optional end punctuation with its closers, then trailing * and _, then whitespace. Found by walking back from the end, once:
// the old lazy regex /^([\s\S]*?)((?:[.!?]+["')\]]*)?[*_]*\s*)$/ retried the star-run tail at every start position, which is quadratic on a long run of "*" (70 ms at 5,000, 1.2 s at 20,000).
function tagSentence(sent, tag) {
  let e = sent.length;
  while (e > 0 && /\s/.test(sent[e - 1])) e--;
  let s = e;
  while (s > 0 && (sent[s - 1] === "*" || sent[s - 1] === "_")) s--;
  let c = s;
  while (c > 0 && `"')]`.includes(sent[c - 1])) c--;
  let p = c;
  while (p > 0 && ".!?".includes(sent[p - 1])) p--;
  const start = p < c ? p : s;
  return `${sent.slice(0, start)} (${tag})${sent.slice(start)}`;
}
// groundingText: the same text the deleters used (library facts as shown, build, party, the question). Returns the labelled text and what was tagged.
export function labelClassic(text, groundingText) {
  const allowedNums = allowedValues(groundingText);
  const allowedNames = `${groundingText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const tagged = { numbers: [], names: [] };
  let tags = 0;
  const nextTag = (nums) => { const tag = tags === 0 ? (nums.length ? CLASSIC_TAG : CLASSIC_NAME_TAG) : tags === 1 && nums.length ? CLASSIC_TAG : CLASSIC_SHORT_TAG; tags += 1; return tag; };
  // What is unsupported in one run of text. `clean` has links reduced to their label and code spans to their content (protect().plain), so a number in either is seen.
  const flagged = (clean) => {
    const nums = unsupportedIn(clean, allowedNums).filter((x) => !covered(clean, x));
    const names = badPhrases(clean, allowedNames).filter((x) => !covered(clean, x));
    return { nums, names, any: nums.length + names.length > 0 };
  };
  const out = [];
  let inFence = false;
  let fenceFlag = null;
  for (const line of stripCtl(text).split("\n")) {
    if (isFence(line)) {
      out.push(line);
      if (inFence && fenceFlag) { out.push(`(${nextTag(fenceFlag.nums)})`); fenceFlag = null; }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const f = flagged(line);
      if (f.any) { fenceFlag = fenceFlag || { nums: [], names: [] }; fenceFlag.nums.push(...f.nums); fenceFlag.names.push(...f.names); tagged.numbers.push(...f.nums); tagged.names.push(...f.names); }
      out.push(line);
      continue;
    }
    if (isSourcesFooter(line) || !line.trim()) { out.push(line); continue; } // every other line, a "-#" footer included, is labelled
    const p = protect(line);
    if (isTableRow(line)) {
      const f = flagged(p.plain(p.text));
      tagged.numbers.push(...f.nums); tagged.names.push(...f.names);
      out.push(f.any ? `${line.replace(/\s+$/, "")} (${nextTag(f.nums)})` : line);
      continue;
    }
    out.push(splitProtected(p.text).map((sent) => {
      const f = flagged(p.plain(sent));
      if (!f.any) return p.restore(sent);
      tagged.numbers.push(...f.nums); tagged.names.push(...f.names);
      return p.restore(tagSentence(sent, nextTag(f.nums)));
    }).join(" "));
  }
  if (inFence && fenceFlag) out.push(`(${nextTag(fenceFlag.nums)})`);
  return { text: out.join("\n"), tagged, labelled: tags > 0 };
}

// ---- length: whole sentences only -----------------------------------------------------------------------------------------------
// Keeps whole sentences (and whole lines) until the budget is used; only when not even the first sentence fits does it cut at a word, with an ellipsis. An open fence or
// stray bold/italic marker left by the cut is dropped (balanceMarkdown).
export function trimToSentences(text, budget) {
  const src = String(text || "");
  if (src.length <= budget) return src;
  const out = [];
  let used = 0;
  // A fenced block (with the tag line that follows it) and a table row are atomic: kept whole or dropped whole, so a trimmed answer never keeps a claim without its tag.
  const rows = src.split("\n");
  const units = [];
  for (let i = 0; i < rows.length; i++) {
    if (isFence(rows[i])) {
      const u = [rows[i]];
      while (++i < rows.length) { u.push(rows[i]); if (isFence(rows[i])) break; }
      if (i + 1 < rows.length && /^\(.*Classic.*\)$/.test(rows[i + 1])) u.push(rows[++i]);
      units.push({ parts: [u.join("\n")], fence: u });
    } else units.push({ parts: isTableRow(rows[i]) ? [rows[i]] : splitSentences(rows[i]) });
  }
  for (let ui = 0; ui < units.length; ui++) {
    let { parts } = units[ui];
    const { fence } = units[ui];
    // A fenced block too big for what is left is cut INSIDE: its opening line, as many code lines as fit, a closing fence, and its tag line; the prose around it is kept.
    if (fence && used + (out.length ? 1 : 0) + parts[0].length > budget) {
      const last = fence[fence.length - 1];
      const hasTag = !isFence(last) && /^\(.*Classic.*\)$/.test(last);
      const tail = hasTag ? "\n" + last : "";
      const body = hasTag ? fence.slice(0, -1) : fence;
      const closed = body.length > 1 && isFence(body[body.length - 1]);
      const code = body.slice(1, closed ? -1 : undefined);
      const next = units[ui + 1] && units[ui + 1].parts[0] ? Math.min(units[ui + 1].parts[0].length + 1, Math.floor(budget / 3)) : 0;
      const room = budget - used - (out.length ? 1 : 0) - next - tail.length - 4; // 4 = newline plus a closing fence
      const keptCode = [];
      let n = body[0].length;
      for (const c of code) { if (n + 1 + c.length > room) break; keptCode.push(c); n += 1 + c.length; }
      if (body[0].length > room) continue; // not even the opening line fits: the block is dropped whole
      parts = [[body[0], ...keptCode].join("\n") + "\n" + (closed ? body[body.length - 1] : "```") + tail];
    }
    const kept = [];
    for (const s of parts) {
      const add = (kept.length ? 1 : 0) + s.length + (out.length && !kept.length ? 1 : 0);
      if (used + add > budget) break;
      kept.push(s);
      used += add;
    }
    if (kept.length) out.push(kept.join(" "));
    if (kept.length < parts.length) break;
  }
  if (out.length) return balanceMarkdown(out.join("\n"));
  const first = src.replace(/\s+/g, " ").trim().slice(0, Math.max(40, budget - 1));
  const sp = first.lastIndexOf(" ");
  return `${balanceMarkdown(linkFragmentless((sp > budget * 0.5 ? first.slice(0, sp) : first).replace(/[\s,;:]+$/, "")))}…`;
}

// The final length guarantee on the assembled answer (body, Sources/confidence footer, fallback lines): footer lines are shortened to 300 characters (whole " · " items first),
// then the body is trimmed to whole sentences in what is left. Always returns at most `cap` characters.
// A hard cut must not leave the front of a masked link ("[Page](<https://leeroy.party/#li"): that reads as a bare address and can embed.
// It also breaks a "@everyone" the cut itself has just exposed at the end ("@everyone123..." has no word boundary, "@everyone…" does).
const linkFragmentless = (t) => t.replace(/\[[^\]\n]*(?:\]\([^)\n]*)?$/, "").replace(/<?https?:\/\/\S*$/i, "").trimEnd().replace(/@(everyone|here)$/i, `@${ZWSP}$1`);
// Always at most n characters INCLUDING the ellipsis (linkFragmentless can add a ZWSP, so shrink the slice until the result fits).
const cutClean = (text, n) => {
  for (let k = Math.max(0, n - 1); k > 0; k--) {
    const r = `${linkFragmentless(text.slice(0, k))}…`;
    if (r.length <= n) return r;
  }
  return "…".slice(0, n);
};
export function fitToCap(text, cap) {
  const src = String(text || "");
  if (src.length <= cap) return src;
  const lines = src.split("\n");
  const shorten = (l) => {
    if (l.length <= 300) return l;
    const parts = l.split(" · ");
    while (parts.length > 1 && parts.join(" · ").length > 300) parts.pop();
    const j = parts.join(" · ");
    return j.length > 300 ? cutClean(j, 300) : j;
  };
  const footer = lines.filter(isFooter).map(shorten);
  const body = lines.filter((l) => !isFooter(l)).join("\n").trim();
  const room = Math.max(60, cap - footer.join("\n").length - 1);
  let out = [trimToSentences(body, room), ...footer].filter(Boolean).join("\n");
  if (out.length > cap) out = cutClean(out, cap);
  return out;
}

// ---- the one sources line, one confidence word -----------------------------------------------------------------------------------
const CONF_ORDER = ["unconfirmed", "likely", "confirmed"]; // most conservative first
const CONF_RE = /\b(?:unconfirmed|confirmed|likely)\b/gi;
const SRC_LINE_RE = /^[^\S\n]*-#[^\S\n]*Sources?[^\S\n]*:[^\S\n]*(.*)$/i;
const SRC_INLINE_RE = /(\S)[^\S\n]+(-#[^\S\n]*Sources?[^\S\n]*:)/gi;
const LINK_ANY = /\[[^\[\]\n]{0,300}\]\(<?[^)>\s]{0,600}>?\)/g;
// "... tonight. -# Sources: x" on one line becomes two lines.
export const splitInlineSources = (t) => String(t || "").replace(SRC_INLINE_RE, "$1\n$2");
// Pull every "-# Sources:" line (and only those) out of the text; returns the text without them and the pieces: ids, free-text labels, the confidence words found.
export function takeSources(text) {
  const rests = [];
  const kept = [];
  for (const line of splitInlineSources(stripCtl(text)).split("\n")) {
    const m = SRC_LINE_RE.exec(line);
    if (m) rests.push(m[1]); else kept.push(line);
  }
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const rest = rests.join(" · ");
  const ids = sourceIdsOf(rest);
  const found = (rest.match(CONF_RE) || []).map((w) => w.toLowerCase());
  const labels = [];
  for (let seg of rest.replace(LINK_ANY, " ").split(/\s*[·|;]\s*/)) {
    seg = seg.replace(CONF_RE, " ").replace(/\bconfidence\s*:?/gi, " ");
    for (const id of ids) seg = seg.split(id).join(" ");
    seg = seg.replace(/[,\s]+/g, " ").replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "");
    if (!seg || /^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(seg) || labels.includes(seg)) continue;
    labels.push(seg.slice(0, 60));
  }
  return { body, ids, labels: labels.slice(0, 2), found, count: rests.length };
}
export function chooseConfidence({ found, hasLibraryIds, labelled, unverifiedCites = false }) {
  let c = CONF_ORDER.find((w) => found.includes(w)) || (hasLibraryIds ? "confirmed" : "unconfirmed");
  if (c === "confirmed" && !hasLibraryIds) c = "unconfirmed"; // model knowledge alone is never "confirmed"
  if (c === "confirmed" && (labelled || unverifiedCites)) c = "likely"; // a tagged Classic value, or a cited page the lookup never showed
  return c;
}
// One Sources line only: the first one gets the label and the confidence word, any further Sources lines are removed.
export function appendBasis(main, { labels, confidence }) {
  const label = labels.length ? labels.join(" · ") : "general Classic-era knowledge";
  const lines = String(main || "").split("\n");
  const at = lines.findIndex((l) => /^\s*-#\s*Sources?\s*:/i.test(l));
  if (at < 0) return `${String(main || "").trimEnd()}\n-# Sources: ${label} · ${confidence}`;
  const out = lines.filter((l, i) => i === at || !/^\s*-#\s*Sources?\s*:/i.test(l));
  out[out.indexOf(lines[at])] = `${lines[at].trimEnd()} · ${label} · ${confidence}`;
  return out.join("\n");
}

// The whole text step. `retrievedIds`: ids the prompt showed (a Set, or null for "no filter"). Returns { text, basis, labelled, tagged, usable, unverifiedCites }.
// `text` ends with a bare `-# Sources: id, id` line when library ids survive (the formatter turns it into links); the labels and the confidence word are appended after formatting (appendBasis).
// A cited page the prompt never showed is not deleted as a claim: its id leaves the link line, and the answer's confidence is capped at "likely".
export function researchPrepare(text, { groundingText = "", retrievedIds = null, budget = 1500, allow = [] } = {}) {
  const usable = usableAnswer(text);
  const src = takeSources(stripRefusals(String(text || "").slice(0, MAX_INPUT_CHARS)));
  const outage = !usable || String(text || "").trim() === RESEARCH_DOWN_ANSWER;
  let body = usable ? src.body : RESEARCH_DOWN_ANSWER; // callers retry or fall back to library facts before this; this keeps the eval and format paths from emitting nothing
  const lab = labelClassic(body, groundingText);
  body = trimToSentences(neutraliseMentions(defuseLinks(lab.text, { allow })), budget);
  const ids = retrievedIds ? src.ids.filter((id) => retrievedIds.has(id)) : src.ids;
  const unverifiedCites = src.ids.length > ids.length;
  const pre = ids.length ? `${body}\n-# Sources: ${ids.join(", ")}` : body;
  const labels = src.labels.map((l) => neutraliseMentions(defuseLinks(l)).replace(/[`\[\]()<>]/g, "")).filter(Boolean);
  // The outage line is not a researched answer: it carries no sources/confidence tag.
  return { text: pre, basis: outage ? null : { labels, confidence: chooseConfidence({ found: src.found, hasLibraryIds: ids.length > 0, labelled: lab.labelled, unverifiedCites }) }, labelled: lab.labelled, tagged: lab.tagged, usable, unverifiedCites };
}
