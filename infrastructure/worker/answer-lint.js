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
// Strong refusal wording (a refusal wherever it stands) and weak wording (a pointer such as "check Wowhead", a refusal only when nothing else is said).
const STRONG_REFUSAL_RE = /does not (?:cover|have) that yet|doesn'?t confirm that figure|not published yet|won'?t guess|ask (?:someone|somebody|a party member|the party|an? officers?|the officers?|anyone)\b|(?:cannot|can'?t|can not) (?:answer|help with|confirm) (?:that|this)|nothing on this question/i;
const WEAK_REFUSAL_RE = /(?:check|try|see|consult|look at) (?:wowhead|google|the wiki|the forums|blizzard|the official)/i;
const REFUSAL_OPENER_RE = /^(?:no idea|i (?:do not|don'?t) know|sorry|unfortunately,? i|i(?: am|'m) (?:unable|not able)|as an ai|i (?:cannot|can'?t|can not|couldn'?t|could not) (?:answer|help|provide|find|confirm)|i (?:have|has) no (?:information|details|data|idea))\b/i;
// The generic rule needs the ASSISTANT or its KNOWLEDGE SOURCE as the subject: "I cannot / am unable / have no information ...", "the library / the available material /
// my notes does not have / contains no ...", "no information is available". A negation about the game ("a hunter cannot use wands", "you can't respec for free") is an answer.
const GENERIC_REFUSAL_RE = /^(?:i|we)\b[^.!?]*?\b(?:cannot|can'?t|can not|am unable|are unable|unable to|have no|has no|do not have|don'?t have|could not|couldn'?t)\b|\b(?:the |my |our )?(?:library|available (?:material|information|sources?|data)|sources?|notes|knowledge|data|material)\b[^.!?]*?\b(?:does not|doesn'?t|do not|don'?t|contains? no|has no|have no|cannot|can'?t|is not available|not available)\b|^no (?:relevant )?(?:information|details|data)\b|\bno (?:relevant )?(?:information|details|data) (?:is |are )?(?:available|provided|found)\b/i;
const INTERJECTION_RE = /^(?:oh|ah+|ha+h*|heh|hah|well|aww?|ooh|hmm+|ahem|ugh|lol)\b/i;
const REPORTING_RE = /\b(?:says?|said|reads?|shows?|states?|tooltip|label|quote[sd]?|reads as|written)\b/i;
const OUTAGE_RE = /out of reach right now|^try me again in a bit\b/i;
const SETTLE_RE = /would settle it/i;
// Sentence split that also breaks after a closing * _ " ) ] ("**Frost.** Check Wowhead." is two sentences). A line over 5000 characters is not split (bounds the regex).
export const splitSentenceText = (line) => { const s = String(line || ""); return s.length > 5000 ? [s] : s.split(/(?<=[.!?][*_"')\]]*)\s+/); };
// Digit, or a capitalised word after the first (not "I"): something concrete is being said.
const hasConcrete = (s) => /\d/.test(s) || s.split(/\s+/).slice(1).some((w) => /^[A-Z][a-z]/.test(w) && w !== "I");
// "strong" | "weak" | null. A sentence IS a refusal when it opens with a refusal opener, or holds strong refusal wording and is short (18 words or fewer), or
// quotes/reports that wording and ENDS with it (nothing after it but two words: "The tooltip says the library does not cover that yet."), or says it cannot
// / has no information and carries no concrete content (no digit, no capitalised word after the first). "the tooltip says not published yet, so use the shield build"
// is advice and stays; a long sentence that merely contains the wording is kept.
export function refusalKind(sentence) {
  const plain = String(sentence || "").replace(/[*_`>#]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  const words = plain.split(" ");
  if (REFUSAL_OPENER_RE.test(plain)) return "strong";
  const m = STRONG_REFUSAL_RE.exec(plain);
  if (m) {
    const before = plain.slice(0, m.index);
    const after = plain.slice(m.index + m[0].length).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
    const guarded = (before.match(/["“”]/g) || []).length % 2 === 1 || REPORTING_RE.test(before);
    if (guarded ? after <= 2 : words.length <= 18) return "strong";
    return null;
  }
  if (WEAK_REFUSAL_RE.test(plain) && words.length <= 12) return "weak";
  if (words.length <= 30 && GENERIC_REFUSAL_RE.test(plain) && !hasConcrete(plain)) return "strong";
  return null;
}
// For a refusal sentence that has more in it than the refusal ("Blizzard has not published yet the numbers, so treat Frost as the safe pick."): the clauses that are not
// themselves refusals, joined and re-capitalised, or "" when nothing is left. null when the sentence is not a refusal at all.
export function refusalRemainder(sentence) {
  const s = String(sentence || "").trim();
  if (refusalKind(s) === null) return null;
  const clauses = s.split(/,\s+(?=(?:so|but|and|then|however|though|still)\b)|;\s+/i);
  if (clauses.length < 2) return "";
  const keep = clauses.filter((c) => refusalKind(c) === null && hasSubstance(c)).map((c) => c.replace(/^(?:so|but|and|then|however|though|still)\s+/i, "").trim());
  if (!keep.length) return "";
  const out = keep.join(", ");
  const text = out.charAt(0).toUpperCase() + out.slice(1);
  return /[.!?*_"')\]]$/.test(text) ? text : `${text}.`;
}
export const isRefusalSentence = (s) => refusalKind(s) !== null;
export const hasSubstance = (text) => /[A-Za-z]{3,}/.test(String(text || "").replace(/https?:\/\/\S+/gi, " "));
// Lines (trimmed, non-empty, footers already removed) -> { content, banter }. Banter is the trailing run of whole-italic lines, and only when other content comes before it:
// a body that is italic from start to end is an answer ("_Go to Blackrock Depths._"), its first line is content.
export function splitBanter(lines) {
  const ls = lines.filter((l) => l && l.trim());
  let k = ls.length;
  while (k > 0 && BANTER_LINE_RE.test(ls[k - 1])) k--;
  if (k === ls.length) return { content: ls, banter: [] };
  if (k === 0) {
    // Italic from start to end is an answer ("_Go to Blackrock Depths._"), unless it is an interjection with nothing concrete in it ("*Oh, you sweet summer child.*").
    const first = ls[0].replace(/^[\s*_]+|[\s*_]+$/g, "");
    if (INTERJECTION_RE.test(first) && !hasConcrete(first)) return { content: [], banter: ls };
    return { content: ls.slice(0, 1), banter: ls.slice(1) };
  }
  return { content: ls.slice(0, k), banter: ls.slice(k) };
}
// Sentences that say something: not a refusal, not only "what would settle it", not only the outage note, not a bare address.
export function contentSentences(lines) {
  const out = [];
  for (const line of lines) for (const s of splitSentenceText(line.replace(/^\s*(?:[-*•]\s+)/, ""))) {
    if (!hasSubstance(s) || SETTLE_RE.test(s) || OUTAGE_RE.test(s)) continue;
    if (!isRefusalSentence(s) || refusalRemainder(s)) out.push(s);
  }
  return out;
}
export function lintResearchAnswer(answer) {
  const text = typeof answer === "string" ? answer : "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sourceLines = lines.filter((l) => SOURCES_LINE_RE.test(l));
  const footerish = (l) => /^-#/.test(l) || /^Sources?\s*:/i.test(l);
  const body = lines.filter((l) => !footerish(l));
  const { content, banter } = splitBanter(body);
  const said = contentSentences(content);
  // Library-backed: a library link, or a Sources line that is nothing but page ids ("classes/tanking, professions/mining"); "wowhead/classic guides" and "and/or" are words, not ids.
  const libraryBacked = sourceLines.some((l) => {
    if (/\]\(<?[^)]*#library\./.test(l)) return true;
    const toks = l.replace(/^\s*-#\s*Sources?\s*:/i, "").replace(CONFIDENCE_RE, " ").split(/[\s,;·|]+/).filter(Boolean);
    return toks.length > 0 && toks.every((t) => /^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(t) && !/^(?:and|or|w|n|b|s)\/[a-z]{1,3}$/i.test(t));
  });
  const failures = [];
  if (!text.trim()) failures.push("empty");
  if (sourceLines.length === 0) failures.push("no_sources_line");
  else if (sourceLines.length > 1) failures.push("multiple_sources_lines");
  const conf = sourceLines.flatMap((l) => l.match(CONFIDENCE_RE) || []);
  if (sourceLines.length && conf.length === 0 && !libraryBacked) failures.push("no_confidence_word");
  if (conf.length > 1) failures.push("two_confidence_words");
  if (lines.filter((l) => /^-#\s*Confidence\s*:/i.test(l)).length) failures.push("second_confidence_footer");
  if (text.trim() && said.length === 0) failures.push("no_answer");
  if (banter.length > 1) failures.push("multiple_banter");
  if (body.some((l) => splitSentenceText(l).some((s) => refusalKind(s) === "strong")) || (said.length === 0 && body.some((l) => splitSentenceText(l).some(isRefusalSentence)))) failures.push("refusal");
  if (said.length === 0 && body.some((l) => OUTAGE_RE.test(l))) failures.push("outage_line");
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
