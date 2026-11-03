// Class crests with a fallback that needs no network. Painted crests (img/crests/<class>.png) exist for five classes only; the other four
// (hunter, rogue, shaman, warrior) used to be a 404 and a hole. For a class with no art, and for any crest image that fails to load, BoardCrest
// draws an inline SVG medallion instead: the same round frame as the painted crests (brass bezel, dark lip, four points) with the class colour
// as the enamel and the class initial in the middle. It is a data: URI, so it makes no request. Pure functions; no DOM is touched except in guard().
(() => {
"use strict";
const ART = ["druid", "priest", "paladin", "mage", "warlock"]; // the classes with a painted crest in img/crests/ (keep in step with that folder; tests/unit/crest.test.mjs checks)
// Class colours: the game's own (the same as the --c-<class> custom properties in css/board.css).
const CLASSES = {
  druid: ["#ff7c0a", "D"], priest: ["#ffffff", "P"], paladin: ["#f48cba", "P"], mage: ["#3fc7eb", "M"], warlock: ["#8788ee", "W"],
  hunter: ["#aad372", "H"], rogue: ["#fff468", "R"], shaman: ["#0070dd", "S"], warrior: ["#c69b6d", "W"],
};
const NONE = ["#8d7c60", "?"]; // --c-none: no class, or one the board does not know
const KEY = /^[a-z]{1,24}$/;
const norm = (k) => (typeof k === "string" && KEY.test(k) ? k : "");
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
const DARK = "#1d140d", CREAM = "#f6ecd2";
function medallion(key) {
  const k = norm(key), [col, ch] = CLASSES[k] || NONE;
  const enamel = mix(col, DARK, 0.5), lit = mix(col, DARK, 0.2);
  const point = (deg) => `<path transform="rotate(${deg} 32 32)" d="M32 .8l3.4 4.6L32 10l-3.4-4.6z" fill="${col}" stroke="${DARK}" stroke-width=".8"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`
    + `<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3c27a"/><stop offset="1" stop-color="#8a6c35"/></linearGradient>`
    + `<radialGradient id="e" cx=".38" cy=".3" r=".9"><stop offset="0" stop-color="${lit}"/><stop offset="1" stop-color="${enamel}"/></radialGradient></defs>`
    + `<circle cx="32" cy="32" r="28.5" fill="url(#b)" stroke="${DARK}" stroke-width="1"/>`
    + `<circle cx="32" cy="32" r="24.5" fill="${DARK}"/><circle cx="32" cy="32" r="23" fill="url(#e)"/>`
    + point(0) + point(90) + point(180) + point(270)
    + `<text x="32" y="41.5" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="27" font-weight="700" fill="${CREAM}" stroke="${DARK}" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">${ch}</text></svg>`;
}
const fallback = (key) => "data:image/svg+xml," + encodeURIComponent(medallion(key));
const hasArt = (key) => ART.includes(norm(key));
// The address to put in an <img src> or an <image href>: the painted crest where there is one, else the inline medallion (no request, so no 404).
const src = (key) => (hasArt(key) ? `img/crests/${norm(key)}.png` : fallback(key));
// If a crest that should exist fails to load (a missing file, a network error), swap in the medallion once. Works for <img> and SVG <image>.
function guard(el, key) {
  if (!el || !el.addEventListener) return el;
  el.addEventListener("error", () => { const f = fallback(key); if (el.tagName && el.tagName.toLowerCase() === "image") el.setAttribute("href", f); else el.src = f; }, { once: true });
  return el;
}
// Is this exactly one of the inline medallions this file makes (one per class, plus the neutral one)? js/board.js h() drops every other data: address from data, and lets only these through on an <img src>.
let OWN = null;
const isOwn = (v) => { if (typeof v !== "string" || v.slice(0, 19) !== "data:image/svg+xml,") return false; OWN ||= new Set([...Object.keys(CLASSES), ""].map(fallback)); return OWN.has(v); };
window.BoardCrest = Object.freeze({ src, fallback, isOwn, medallion, hasArt, guard, ART: Object.freeze(ART.slice()), CLASS_KEYS: Object.freeze(Object.keys(CLASSES)) });
})();
