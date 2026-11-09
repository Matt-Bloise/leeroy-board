// Deterministic fallback for /ask refusals: when the answer is the exact "not published" refusal and the QUESTION names exactly one
// of the nine classes whose overview page exists in the library, append one line linking that page. Pure; no I/O.
// Link format matches answer-format.js: [Title](<base/#library.classes.mage>).
import { NOT_PUBLISHED_LINE } from "./ask-build.js";

const CLASS_RE = /\b(druid|hunter|mage|paladin|priest|rogue|shaman|warlock|warrior)(?:s|es)?\b/gi;

const isRefusal = (text) => String(text || "").replace(/^\*+|\*+$/g, "").trim() === NOT_PUBLISHED_LINE;

export function classPageFallback(answer, { question, pages, boardUrl } = {}) {
  if (typeof answer !== "string" || !isRefusal(answer)) return answer;
  const named = new Set([...String(question || "").matchAll(CLASS_RE)].map((m) => m[1].toLowerCase()));
  if (named.size !== 1) return answer;
  const id = `classes/${[...named][0]}`;
  const page = (Array.isArray(pages) ? pages : []).find((p) => p && p.id === id);
  if (!page) return answer;
  const base = String(boardUrl || "https://leeroy.party").replace(/\/+$/, "");
  const title = String(page.title || "").replace(/[\[\]<>()]/g, "").trim() || id;
  return `${answer.trimEnd()}\nThe library does have the [${title} page](<${base}/#library.${id.replace("/", ".")}>) if you want the overview.`;
}
