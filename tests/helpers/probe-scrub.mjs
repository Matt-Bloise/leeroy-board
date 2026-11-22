// The production probe's roster scrub as a function, so a unit test can pin it (tests/unit/probe-scrub.test.mjs).
// Tokens are every roster-derived token of 3+ characters (full name, slug, each word, each slug component). They are replaced as WHOLE WORDS, case-insensitively: a letter or digit on either side means
// the match is part of a longer word and is left alone (a name "Ember" must not turn "members" into "m<member>s"); punctuation, an apostrophe, a slash, a hyphen or the end of the text are boundaries.
export function buildScrub(tokens, placeholder = "<member>") {
  const list = [...new Set((tokens || []).map((t) => String(t).trim()).filter((t) => t.length >= 3))].sort((a, b) => b.length - a.length);
  if (!list.length) return (t) => String(t);
  const alt = list.map((t) => t.split("").map((ch) => (/[A-Za-z0-9 _-]/.test(ch) ? ch : "\\" + ch)).join("")).join("|");
  const re = new RegExp("(?<![A-Za-z0-9])(?:" + alt + ")(?![A-Za-z0-9])", "gi");
  return (t) => String(t).replace(re, placeholder);
}
