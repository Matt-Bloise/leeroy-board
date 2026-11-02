// Persona pack loader. The pack is curated content that lives only in D1 (kv_state key 'persona', written by
// PUT /persona); it is never committed. Every function here falls back to a built-in default when the pack is
// missing, so a Worker without a seeded pack behaves exactly as before.

const TTL_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;

export function invalidatePersonaCache() {
  cached = null;
  cachedAt = 0;
}

export async function loadPersona(env) {
  const now = Date.now();
  if (cachedAt && now - cachedAt < TTL_MS) return cached;
  let pack = null;
  try {
    const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'persona'").first();
    const parsed = row && JSON.parse(row.json);
    if (parsed && typeof parsed === "object" && typeof parsed.system === "string") pack = parsed;
  } catch {
    pack = null;
  }
  cached = pack;
  cachedAt = now;
  return pack;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from has have how i if in is it its me my of on or our so than that the their them then there these they this to up us was we what when where which who why will with you your about any anything".split(
    " "
  )
);

function tokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

export function pickBits(persona, text, max = 2) {
  const want = tokens(text);
  return (Array.isArray(persona.bits) ? persona.bits : [])
    .map((bit, i) => ({ bit, i, score: bit && bit.safe !== false ? overlap(tokens(bit.when), want) : 0 }))
    .filter((x) => x.score > 0 && typeof x.bit.text === "string")
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, max)
    .map((x) => x.bit.text);
}

export function pickExamples(persona, question, journey, max = 3) {
  const want = tokens(question);
  return (Array.isArray(persona.examples) ? persona.examples : [])
    .map((ex, i) => ({
      ex,
      i,
      score: overlap(tokens(`${ex.q} ${(ex.tags || []).join(" ")}`), want) + (ex.journey === journey ? 100 : 0),
    }))
    .filter((x) => x.ex && typeof x.ex.q === "string" && typeof x.ex.a === "string")
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, max)
    .map((x) => x.ex);
}

export function buildSystemPrompt(
  persona,
  { journey = "curious", question = "", partySummary = "", libraryStamp = "v1", isCoach = false, coachPrompt = "" } = {}
) {
  const journeys = persona.journeys || {};
  const depth = journeys[journey] || journeys.curious || "";
  const parts = [persona.system];
  if (depth) parts.push(`How deep to answer (${journey in journeys ? journey : "curious"}): ${depth}`);
  const bits = pickBits(persona, `${question} ${partySummary}`);
  if (bits.length) parts.push(`Running bits you may use if they fit (at most one, only when true and kind):\n${bits.map((b) => `- ${b}`).join("\n")}`);
  const avoid = Array.isArray(persona.avoid) ? persona.avoid : [];
  if (avoid.length) parts.push(`Never do:\n${avoid.map((a) => `- ${a}`).join("\n")}`);
  const examples = pickExamples(persona, question, journey);
  if (examples.length) {
    parts.push(examples.map((e) => `Example question: ${e.q}\nExample answer: ${e.a}`).join("\n\n"));
  }
  const max = Number(persona.format && persona.format.chatMaxChars);
  parts.push(
    [
      "PLATFORM RULES (these override anything above):",
      `[Library-Epoch: ${libraryStamp}]`,
      "Answer strictly from the verified library facts and party state in the message. Where the library does not know something yet, say plainly that it is not published yet.",
      "The running bits above carry dated party facts that are newer than the library facts; when they conflict, the bit wins.",
      "Cite specific library page IDs in brackets like [classes/paladin-holy] whenever you use a fact.",
      max > 0 ? `Keep the reply under ${max} characters.` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
  if (isCoach && coachPrompt) parts.push(coachPrompt);
  return parts.join("\n\n");
}

function hash(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const DEFAULT_LINES = {
  ackLines: ["Leeroy is thinking..."],
  errorLines: ["Leeroy could not answer that one. Try again in a moment."],
  emptyLines: ["No library page found."],
};

export function pickLine(persona, list, seed = "", fallback) {
  const lines = persona && Array.isArray(persona[list]) ? persona[list].filter((l) => typeof l === "string" && l) : [];
  const pool = lines.length ? lines : [fallback || (DEFAULT_LINES[list] || [""])[0]];
  return pool[hash(seed) % pool.length];
}

export function helpIntro(persona, fallback) {
  return persona && typeof persona.helpIntro === "string" && persona.helpIntro ? persona.helpIntro : fallback;
}
