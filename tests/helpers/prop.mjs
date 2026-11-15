// Tiny property-test kit. Zero dependencies. A seeded generator (mulberry32) plus `property()`, which runs a check over many generated
// cases and, on the first failure, throws an error that carries the seed, the case index and the shrunk-by-hand input so the failure
// replays exactly. Seed: PROP_SEED=<n> replays; otherwise a fresh seed per run (printed on failure only). PROP_RUNS scales the case count.
import test from "node:test";

export const BASE_SEED = (() => {
  const e = process.env.PROP_SEED;
  if (e !== undefined && e !== "" && Number.isFinite(Number(e))) return Number(e) >>> 0;
  return (Date.now() ^ (process.pid << 8)) >>> 0;
})();
const SCALE = Number(process.env.PROP_RUNS) > 0 ? Number(process.env.PROP_RUNS) : 1;

export function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    bool: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chars: (alphabet, n) => { let s = ""; for (let i = 0; i < n; i++) s += alphabet[Math.floor(next() * alphabet.length)]; return s; },
    shuffle: (arr) => { const a2 = arr.slice(); for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
  };
  return r;
}

const show = (v) => { try { const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v); return s.length > 600 ? s.slice(0, 600) + "...(cut)" : s; } catch { return String(v); } };

/**
 * property(name, gen, check, { runs })
 *   gen(rng, i) -> input; check(input, rng) throws (or returns false) when the property is broken.
 * Each case gets its own sub-seed (BASE_SEED + i) so one failing case replays alone: PROP_SEED=<base> reruns the same cases.
 */
export function property(name, gen, check, { runs = 200 } = {}) {
  test(`prop: ${name}`, () => {
    const n = Math.max(1, Math.round(runs * SCALE));
    for (let i = 0; i < n; i++) {
      const seed = (BASE_SEED + i) >>> 0;
      const rng = rngFrom(seed);
      let input;
      try {
        input = gen(rng, i);
        const ok = check(input, rng);
        if (ok === false) throw new Error("property returned false");
      } catch (err) {
        const e = new Error(`property "${name}" failed: ${err && err.message}\n  seed: ${seed} (replay: PROP_SEED=${BASE_SEED}) case ${i}\n  input: ${show(input)}`);
        e.cause = err;
        throw e;
      }
    }
  });
}

// ---- common generators ----
export const WORD_CHARS = "abcdefghijklmnopqrstuvwxyz";
export const word = (r, lo = 2, hi = 9) => r.chars(WORD_CHARS, r.range(lo, hi));
export const NASTY = ["", " ", "\n", "\t", "​", "‮", "<@123456789012345678>", "@everyone", "https://example.com/x", "**", "<<<", ">>>", "{P1.k7f2}", "\0", "\ud800", "é", "😀", "\r\n", "-# Sources: ", "[a/b]", "](", "<", ">", "{", "}"];
export const nastyString = (r, maxParts = 12) => { let s = ""; for (let i = r.range(0, maxParts); i > 0; i--) s += r.bool(0.4) ? r.pick(NASTY) : word(r); return s; };
