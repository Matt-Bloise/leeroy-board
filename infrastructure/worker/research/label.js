// /ask research mode (ASK_RESEARCH on): the finishing steps that replace the old deleters. Pure: no I/O, no clock, never throws on text.
//   labelClassic      supportCheck / groundedOrNotPublished DELETED a sentence holding a number or name the library never gave; this one TAGS it
//                     ("Classic value, not confirmed for Forever") and keeps it. Advice is kept. Nothing is cut.
//   neutraliseMentions / defuseLinks   mention and link safety for anything the model wrote or echoed from a library or fetched title.
//   researchPrepare   the whole text step (refusal sentences out, labels, safety, one sources/confidence line, whole-sentence trim).
// What it cannot catch is listed in docs/answer-claims.md terms in the report of W4a: a wrong number that equals a grounded number, a fact in words the
// regexes do not read ("a dozen", fractions), a lower-case or single-word name, and any claim that is false but carries no number or capitalised name.
import { unsupportedIn, allowedValues, sourceIdsOf, stripUnretrievedCites } from "../self-rag.js";
import { badPhrases, HOUSE } from "../ask-build.js";

export const CLASSIC_TAG = "Classic value, not confirmed for Forever";
export const CLASSIC_NAME_TAG = "Classic-era name, not confirmed for Forever";
export const CLASSIC_SHORT_TAG = "Classic";
export const RESEARCH_EMPTY = "**I can't confirm that for Forever.**\nNothing in the library covers it, and a Classic guess would not be a Forever fact.";

const ZWSP = "​";
// ---- mentions ---------------------------------------------------------------------------------------------------------------
// @everyone, @here, <@id>, <@!id>, <@&id> in anything derived from a title or the model: a zero-width space breaks the token (allowed_mentions is none as well; this is the second lock).
export function neutraliseMentions(text) {
  return String(text == null ? "" : text)
    .replace(/@(everyone|here)\b/gi, `@${ZWSP}$1`)
    .replace(/<@([!&]?)(\d+)>/g, `<${ZWSP}@$1$2>`);
}

// ---- links ------------------------------------------------------------------------------------------------------------------
const MASKED_RE = /\[([^\]\n]*)\]\(\s*<?([^)>\s]*)>?\s*\)/g;
const HOSTISH_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const BARE_URL_RE = /<?https?:\/\/[^\s<>)\]]+>?/gi;
const bareHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
function parseHttp(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null; // https://trusted.example@evil.test/ reads as trusted.example
    return u;
  } catch { return null; }
}
const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
// A masked link stays only when its target is plain http(s) with no userinfo AND no host-looking text in the visible label names a different site.
// Anything else becomes the real host in a code span (not clickable, not auto-linked). A bare address becomes its host in a code span too.
export function defuseLinks(text) {
  const kept = [];
  let out = String(text == null ? "" : text).replace(MASKED_RE, (m, label, href) => {
    const u = parseHttp(href);
    if (!u) return String(label).replace(/[`]/g, "");
    const host = bareHost(u.hostname);
    const shown = (String(label).match(HOSTISH_RE) || []).map(bareHost);
    if (shown.some((h) => !sameSite(h, host))) return `\`${host}\``;
    kept.push(`[${String(label).replace(/[\[\]]/g, "")}](<${u.href}>)`);
    return `\u0000${kept.length - 1}\u0000`;
  });
  out = out.replace(BARE_URL_RE, (m) => {
    const u = parseHttp(m.replace(/^<|>$/g, "").replace(/[.,;:!?]+$/, ""));
    return u ? `\`${bareHost(u.hostname)}\`` : "";
  });
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
}

// ---- refusal sentences ---------------------------------------------------------------------------------------------------------
const REFUSAL_SENT_RE = /does not (?:cover|have) that yet|doesn'?t confirm that figure|not published yet|won'?t guess|ask (?:someone|somebody|a party member|the party) else|(?:cannot|can'?t|can not) (?:answer|help with) (?:that|this)|nothing on this question/i;
const BANTER_RE = /^\s*(?:(?<!\*)\*(?!\*)[^*\n]+\*|_[^_\n]+_)\s*$/;
const isFooter = (l) => /^\s*-#/.test(l);
const sentencesOf = (line) => line.split(/(?<=[.!?])\s+/);
const balanceBold = (s) => ((s.match(/\*\*/g) || []).length % 2 ? s.replace(/\*\*/g, "") : s);
export function stripRefusals(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (isFooter(line)) { out.push(line); continue; }
    const parts = sentencesOf(line);
    const ok = parts.filter((s) => !REFUSAL_SENT_RE.test(s));
    if (ok.length === parts.length) out.push(line);
    else if (ok.length) out.push(balanceBold(ok.join(" ")));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- the labeller ------------------------------------------------------------------------------------------------------------
const ALREADY_RE = /not confirmed for Forever|\(Classic\)/i;
function tagSentence(sent, tag) {
  const m = /^([\s\S]*?)((?:[.!?]+["')\]]*)?\**\s*)$/.exec(sent);
  const head = m ? m[1] : sent;
  const end = m ? m[2] : "";
  return `${head} (${tag})${end}`;
}
// groundingText: the same text the deleters used (library facts as shown, build, party, the question). Returns the labelled text and what was tagged.
export function labelClassic(text, groundingText) {
  const allowedNums = allowedValues(groundingText);
  const allowedNames = `${groundingText || ""} ${HOUSE.join(" ")}`.toLowerCase();
  const tagged = { numbers: [], names: [] };
  let tags = 0;
  const lines = String(text || "").split("\n").map((line) => {
    if (isFooter(line) || BANTER_RE.test(line) || !line.trim()) return line;
    return sentencesOf(line).map((sent) => {
      if (ALREADY_RE.test(sent)) return sent;
      const nums = unsupportedIn(sent, allowedNums);
      const names = badPhrases(sent, allowedNames);
      if (!nums.length && !names.length) return sent;
      tagged.numbers.push(...nums); tagged.names.push(...names);
      const tag = tags === 0 ? (nums.length ? CLASSIC_TAG : CLASSIC_NAME_TAG) : tags === 1 && nums.length ? CLASSIC_TAG : CLASSIC_SHORT_TAG;
      tags += 1;
      return tagSentence(sent, tag);
    }).join(" ");
  });
  return { text: lines.join("\n"), tagged, labelled: tags > 0 };
}

// ---- length: whole sentences only -----------------------------------------------------------------------------------------------
// Keeps whole sentences (and whole lines) until the budget is used; only when not even the first sentence fits does it cut at a word, with an ellipsis.
export function trimToSentences(text, budget) {
  const src = String(text || "");
  if (src.length <= budget) return src;
  const out = [];
  let used = 0;
  for (const line of src.split("\n")) {
    const kept = [];
    for (const s of sentencesOf(line)) {
      const add = (kept.length ? 1 : 0) + s.length + (out.length && !kept.length ? 1 : 0);
      if (used + add > budget) break;
      kept.push(s);
      used += add;
    }
    if (kept.length) out.push(balanceBold(kept.join(" ")));
    if (kept.length < sentencesOf(line).length) break;
  }
  if (out.length) return out.join("\n").trim();
  const first = src.replace(/\s+/g, " ").trim().slice(0, Math.max(40, budget - 1));
  const sp = first.lastIndexOf(" ");
  return `${balanceBold((sp > budget * 0.5 ? first.slice(0, sp) : first).replace(/[\s,;:]+$/, ""))}…`;
}

// ---- the one sources line, one confidence word -----------------------------------------------------------------------------------
const CONF_ORDER = ["unconfirmed", "likely", "confirmed"]; // most conservative first
const CONF_RE = /\b(?:unconfirmed|confirmed|likely)\b/gi;
const SOURCES_RE = /^\s*(?:-#\s*)?Sources?\s*:\s*(.*)$/gim;
const LINK_ANY = /\[[^\]\n]*\]\(<?[^)>\s]*>?\)/g;
// Pull every Sources line out of the text; returns the text without them and the pieces: ids (as written), free-text labels, the confidence words found.
export function takeSources(text) {
  const rests = [];
  const body = String(text || "").replace(SOURCES_RE, (_l, rest) => { rests.push(rest); return ""; }).replace(/\n{3,}/g, "\n\n").trim();
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
  return { body, ids, labels: labels.slice(0, 2), found };
}
export function chooseConfidence({ found, hasLibraryIds, labelled }) {
  let c = CONF_ORDER.find((w) => found.includes(w)) || (hasLibraryIds ? "confirmed" : "unconfirmed");
  if (c === "confirmed" && !hasLibraryIds) c = "unconfirmed"; // model knowledge alone is never "confirmed"
  if (c === "confirmed" && labelled) c = "likely"; // a tagged Classic value sits in the answer
  return c;
}
export function appendBasis(main, { labels, confidence }) {
  const label = labels.length ? labels.join(" · ") : "general Classic-era knowledge";
  const lines = String(main || "").split("\n");
  const at = lines.findLastIndex ? lines.findLastIndex((l) => /^\s*-#\s*Sources?\s*:/i.test(l)) : lines.map((l) => /^\s*-#\s*Sources?\s*:/i.test(l)).lastIndexOf(true);
  if (at >= 0) { lines[at] = `${lines[at].trimEnd()} · ${label} · ${confidence}`; return lines.join("\n"); }
  return `${String(main || "").trimEnd()}\n-# Sources: ${label} · ${confidence}`;
}

// The whole text step. `retrievedIds`: ids the prompt showed (a Set, or null for "no filter"). Returns { text, basis: { labels, confidence }, labelled }.
// `text` ends with a bare `-# Sources: id, id` line when library ids survive (the formatter turns it into links); the labels and the confidence word are appended after formatting (appendBasis).
export function researchPrepare(text, { groundingText = "", retrievedIds = null, budget = 1700 } = {}) {
  let t = stripRefusals(String(text || ""));
  const src = takeSources(t);
  let body = src.body;
  if (body.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2).length < 4) body = RESEARCH_EMPTY;
  const lab = labelClassic(body, groundingText);
  body = neutraliseMentions(defuseLinks(lab.text));
  const ids = retrievedIds ? src.ids.filter((id) => retrievedIds.has(id)) : src.ids;
  body = trimToSentences(body, budget);
  let pre = ids.length ? `${body}\n-# Sources: ${ids.join(", ")}` : body;
  if (retrievedIds) pre = stripUnretrievedCites(pre, retrievedIds).answer || body;
  const labels = src.labels.map((l) => neutraliseMentions(defuseLinks(l)).replace(/[`\[\]()<>]/g, "")).filter(Boolean);
  return { text: pre, basis: { labels, confidence: chooseConfidence({ found: src.found, hasLibraryIds: ids.length > 0, labelled: lab.labelled }) }, labelled: lab.labelled, tagged: lab.tagged };
}
