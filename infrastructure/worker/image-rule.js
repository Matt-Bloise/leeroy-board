// Pure rule for when a plain /ask answer would get a picture card (the old bot's rule).
// Not wired into discord.js: the verdict in docs/roadmap/IMAGE-CARDS.md is no-go for rendering on the free plan,
// so this only decides, it never renders. No network, no D1, no AI.
//
// A picture is worth sending when
//   1. the question names a spell or item present in data/library/tooltips.json (its `names` keys, lower case), or
//   2. the best answer carries a number or a date.
// The caption stays the text answer; this function never changes it.

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const DATE_WORDS = new RegExp(`\\b(?:${MONTHS})\\b\\s+(?:\\d{1,2}(?:st|nd|rd|th)?\\b|[a-z]+(?:th|st|nd|rd)\\b)|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "i");
const NUMBER = /(?:^|[^\w])\d[\d,]*(?:\.\d+)?(?![\w])/;
const MIN_NAME = 4;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/** True when the question names a known spell or item. `names` is an array, Set or object of lower-case names. */
export function namesKnownTooltip(question, names) {
  const q = ` ${norm(question)} `;
  if (q.trim() === "") return false;
  const list = names instanceof Set ? [...names] : Array.isArray(names) ? names : names && typeof names === "object" ? Object.keys(names) : [];
  for (const n of list) {
    const k = norm(n);
    if (k.length >= MIN_NAME && q.includes(` ${k} `)) return true;
  }
  return false;
}

/** True when the text carries a number (7, 1,200, 3.5) or a date (November 4, 2026-11-04). */
export function carriesNumberOrDate(answer) {
  const a = String(answer || "");
  return NUMBER.test(a) || DATE_WORDS.test(a);
}

/** The rule: a picture only for a named tooltip, or an answer with a number or date. Empty answers never get one. */
export function shouldRenderImage(question, answer, names) {
  if (typeof answer !== "string" || answer.trim() === "") return false;
  return namesKnownTooltip(question, names) || carriesNumberOrDate(answer);
}
