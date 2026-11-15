// Deterministic answer linter (`worker/answer-lint.js`). Pure: no I/O, no clock, never throws. It checks a FORMATTED answer
// (the text a person would see) against the house format, and is the machine half of the model bake-off. It never judges
// quality or voice: that is the blind human rating. Same input and context always give the same output.
//
//   lintAnswer(answer, { maxChars, minChars, maxEmoji, asker: { isMember }, forbidden: [] })
//   -> { chars, bracketIds, bareUrls, sources: { present, masked, items }, boardLink, boldSpans, firstSentenceBold,
//        lengthOk, forbidden: [], mentions, stockOpener, nonMemberAddressed, emoji, failures: [], warnings: [], pass }

export const MEMBER_NAMES = ["Santa", "Bible Boi", "Street Rat", "Bloise", "Handsome Squidward"];
export const DEFAULT_MAX_CHARS = 1200;

const BRACKET_ID_RE = /\[[a-z0-9_-]+\/[a-z0-9_.~-]+\](?!\()/gi;
const MASKED_LINK_RE = /\[([^\]\n]*)\]\(<?(https?:\/\/[^)>\s]+)>?\)/gi;
const URL_RE = /https?:\/\/[^\s<>)\]]+/gi;
const SOURCES_LINE_RE = /^\s*-#\s*Sources?\s*:\s*(.*)$/im;
const BOARD_LINK_RE = /^\s*-#\s*\[[^\]\n]+\]\(<?https?:\/\/[^)>\s]+>?\)\s*$/im;
const BOLD_RE = /\*\*[^*\n]+\*\*/g;
const MENTION_RE = /<@[!&]?\d+>|@(?:everyone|here)\b|(?<![\w/.])@[A-Za-z0-9_]{2,}/g;
const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/gu;
const STOCK_OPENERS = [
  /^great question\b/i,
  /^good question\b/i,
  /^excellent question\b/i,
  /^certainly\b/i,
  /^sure\b/i,
  /^of course\b/i,
  /^absolutely\b/i,
  /^as an ai\b/i,
  /^i'?d be happy\b/i,
  /^i would be happy\b/i,
  /^thanks? (?:for|you)\b/i,
  /^here(?:'s| is| are)\b/i,
  /^okay\b/i,
  /^ok\b/i,
  /^well\b/i,
  /^ah\b/i,
  /^(?:hello|hi|hey)\b/i,
  /^let me\b/i,
  /^i hope\b/i,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

// The first non-empty line without its bold markers, for opener checks.
function firstLine(text) {
  for (const line of text.split(/\r?\n/)) if (line.trim()) return line.trim();
  return "";
}

function checkSources(text) {
  const m = SOURCES_LINE_RE.exec(text);
  if (!m) return { present: false, masked: false, items: 0 };
  const rest = m[1];
  const links = [...rest.matchAll(MASKED_LINK_RE)];
  // Whatever is left after removing masked links and separators must be empty: no plain ids, no bare urls.
  const leftover = rest.replace(MASKED_LINK_RE, "").replace(/[\s·,;|]+/g, "");
  return { present: true, masked: links.length > 0 && leftover === "", items: links.length };
}

// ---- research-mode lint (ASK_RESEARCH on) -------------------------------------------------------------------------------------
// Pure and deterministic like lintAnswer. Checks the shape the research rules ask for (research/rules.js), not the truth of the content:
//   one sources line holding exactly one confidence word (confirmed | likely | unconfirmed), a body that is not banter alone (a banter line is a single
//   italic line), at most one banter line, and no refusal wording. -> { failures: [], pass }
const CONFIDENCE_RE = /\b(?:unconfirmed|confirmed|likely)\b/gi;
const BANTER_LINE_RE = /^\s*(?:(?<!\*)\*(?!\*)[^*\n]+\*|_[^_\n]+_)\s*$/;
const REFUSAL_PHRASE_RE = /does not (?:cover|have) that yet|doesn'?t confirm that figure|not published yet|won'?t guess|ask (?:someone|somebody|a party member|the party|an officer|anyone) else|(?:cannot|can'?t|can not) (?:answer|help with) (?:that|this)|nothing on this question|would settle it|(?:check|try|see|consult|look at) (?:wowhead|google|the wiki|the forums|blizzard|the official)/i;
const REFUSAL_START_RE = /^(?:no idea|i (?:do not|don'?t) know|sorry|unfortunately,? i)\b/i;
const REPORTING_RE = /\b(?:says?|said|reads?|shows?|states?|tooltip|label|quote[sd]?|reads as|written)\b/i;
// A sentence that IS a refusal: opens with a refusal opener, or is short (14 words or fewer) and holds refusal wording that is not being quoted or reported
// ("the tooltip says not published yet, so use the shield build" is advice and stays). A long sentence that merely contains the wording is kept.
export function isRefusalSentence(sentence) {
  const plain = String(sentence || "").replace(/[*_`>#]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return false;
  if (REFUSAL_START_RE.test(plain)) return true;
  const m = REFUSAL_PHRASE_RE.exec(plain);
  if (!m) return false;
  const before = plain.slice(0, m.index);
  if ((before.match(/["“”]/g) || []).length % 2 === 1 || REPORTING_RE.test(before)) return false;
  return plain.split(" ").length <= 18;
}
export const hasSubstance = (text) => /[A-Za-z]{3,}/.test(String(text || ""));
export function lintResearchAnswer(answer) {
  const text = typeof answer === "string" ? answer : "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sourceLines = lines.filter((l) => SOURCES_LINE_RE.test(l));
  const body = lines.filter((l) => !/^-#/.test(l));
  const banter = body.filter((l) => BANTER_LINE_RE.test(l));
  const substance = body.filter((l) => !BANTER_LINE_RE.test(l) && hasSubstance(l));
  const failures = [];
  if (!text.trim()) failures.push("empty");
  if (sourceLines.length === 0) failures.push("no_sources_line");
  else if (sourceLines.length > 1) failures.push("multiple_sources_lines");
  const conf = sourceLines.flatMap((l) => l.match(CONFIDENCE_RE) || []);
  if (sourceLines.length && conf.length === 0) failures.push("no_confidence_word");
  if (conf.length > 1) failures.push("two_confidence_words");
  if (text.trim() && substance.length === 0) failures.push(banter.length ? "banter_only" : "no_answer");
  if (banter.length > 1) failures.push("multiple_banter");
  if (body.some((l) => l.split(/(?<=[.!?])\s+/).some(isRefusalSentence))) failures.push("refusal");
  return { failures, pass: failures.length === 0, confidenceWords: conf.map((w) => w.toLowerCase()), banterLines: banter.length };
}

export function lintAnswer(answer, ctx = {}) {
  const text = typeof answer === "string" ? answer : "";
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const maxChars = Number(c.maxChars) > 0 ? Number(c.maxChars) : DEFAULT_MAX_CHARS;
  const minChars = Number(c.minChars) > 0 ? Number(c.minChars) : 0;
  const maxEmoji = Number.isFinite(Number(c.maxEmoji)) && Number(c.maxEmoji) >= 0 ? Number(c.maxEmoji) : 0;
  const isMember = !c.asker || c.asker.isMember !== false;

  const bracketIds = countMatches(text, BRACKET_ID_RE);
  const withoutMasked = text.replace(MASKED_LINK_RE, "");
  const bareUrls = countMatches(withoutMasked, URL_RE);
  const sources = checkSources(text);
  const boardLink = BOARD_LINK_RE.test(text);
  const boldSpans = countMatches(text, BOLD_RE);

  const head = firstLine(text);
  // First sentence bold: the first line opens with a bold span that holds a whole sentence (ends with . ! ? or a closing quote/paren).
  const hm = /^\*\*([^*\n]+)\*\*/.exec(head);
  const firstSentenceBold = Boolean(hm) && /[.!?…]["')”]?\s*$/.test(hm[1].trim());

  const chars = text.length;
  const lengthOk = chars > 0 && chars <= maxChars && chars >= minChars;

  const forbiddenWords = [...new Set([...(Array.isArray(c.forbidden) ? c.forbidden : []), "Skippy", "Matt"].map(String).filter(Boolean))];
  const forbidden = forbiddenWords.filter((w) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(w)}(?![A-Za-z0-9])`, "i").test(text));

  const mentions = countMatches(text, MENTION_RE);

  const opener = head.replace(/\*\*/g, "").replace(/^[•\-#\s]+/, "");
  const stock = STOCK_OPENERS.find((re) => re.test(opener));
  const stockOpener = stock ? stock.exec(opener)[0].toLowerCase() : null;

  let nonMemberAddressed = 0;
  if (!isMember) {
    const names = MEMBER_NAMES.map(escapeRe).join("|");
    const re = new RegExp(`(?:^|[.!?]["')]?\\*{0,2}\\s+|\\n)\\**(?:(?:hey|hi|hello|thanks?),?\\s+)?(?:${names})\\s*[,:!]`, "gi");
    nonMemberAddressed = countMatches(text, re);
  }

  const emoji = countMatches(text, EMOJI_RE);

  const failures = [];
  const warnings = [];
  if (!chars) failures.push("empty");
  if (bracketIds) failures.push("bracket_ids");
  if (bareUrls) failures.push("bare_urls");
  if (sources.present && !sources.masked) failures.push("sources_unmasked");
  if (!firstSentenceBold) failures.push("first_sentence_not_bold");
  if (!lengthOk) failures.push("length");
  if (forbidden.length) failures.push("forbidden_words");
  if (mentions) failures.push("mentions");
  if (stockOpener) failures.push("stock_opener");
  if (nonMemberAddressed) failures.push("non_member_addressed");
  if (emoji > maxEmoji) failures.push("emoji");
  if (!sources.present) warnings.push("no_sources_line");
  if (boldSpans > 6) warnings.push("heavy_bold");

  return {
    chars,
    bracketIds,
    bareUrls,
    sources,
    boardLink,
    boldSpans,
    firstSentenceBold,
    lengthOk,
    forbidden,
    mentions,
    stockOpener,
    nonMemberAddressed,
    emoji,
    failures,
    warnings,
    pass: failures.length === 0,
  };
}
