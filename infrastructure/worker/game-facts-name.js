// One name normaliser for the game-facts store: the loader (worker/game-facts.js computes subject_norm and subject_base from the subject) and the lookup (worker/game-facts-lookup.js folds the question the same way) both use these
// functions, so a name and a question can only meet through one definition.
//   normName    case-folded, diacritics stripped, apostrophes removed (so "Light's Vigil" and "Lights Vigil" are one key), every other punctuation run (colon, hyphen, dot, comma, slash ...) is one space, spaces collapsed.
//               "Polymorph: Chicken" -> "polymorph chicken"; "Engrave Pants - Envenom" -> "engrave pants envenom"; "Curse of Thule" keeps its "of".
//   baseName    the name without a trailing rank suffix, or "" when there is none: "frostbolt rank 4" -> "frostbolt", "frostbolt rank iv" -> "frostbolt", "arcane spirit iii" -> "arcane spirit".
//               A roman numeral is only a suffix when something precedes it; the full key (subject_norm) always keeps it, because it can be part of the name. "rank" alone, trailing digits alone and a name that is only a numeral have no base.
export const ROMAN = new Set(["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]);
const APOSTROPHES = /['\u2018\u2019\u02bc\u00b4`]/g;

export function normName(s) {
  return String(s == null ? "" : s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(APOSTROPHES, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export const tokensOfNorm = (norm) => (norm ? norm.split(" ") : []);

export function baseName(norm) {
  const t = tokensOfNorm(norm);
  const n = t.length;
  if (n >= 3 && t[n - 2] === "rank" && (/^[0-9]{1,3}$/.test(t[n - 1]) || ROMAN.has(t[n - 1]))) return t.slice(0, n - 2).join(" ");
  if (n >= 2 && ROMAN.has(t[n - 1])) return t.slice(0, n - 1).join(" ");
  return "";
}
