/* Woven lettering for the ribbons (lane R, RIBBONS.md section 3, R3). The scene name is drawn once per ribbon into a canvas, filled with the
   gold satin-stitch tile and edged one shade darker, then uploaded by cloth.js as the ribbon's label texture, so the letters ride the cloth:
   they bend with the wave and take the fold light. No drop shadow, no blur. Imported by cloth.js; no other imports. */

export const LABEL_FONT = '700 {px}px "Alegreya Sans SC", "Alegreya Sans", Georgia, serif';

/* a canvas widthPx by 1.5 * fontPx css px (times dpr), the text centred; shrinks the font until it fits the ribbon between its selvedges */
export function bakeLabel({ text, widthPx, fontPx, dpr = 1, maxH = 0, gold = null, pale = false, stroke = "#9a7a2c" }) {
  const d = Math.max(1, Math.min(2, dpr)), fp = fontPx * 1.15;
  const c = document.createElement("canvas"), w = Math.max(8, Math.round(widthPx * d)); c.width = w;
  const x = c.getContext("2d"); if (!x) { c.height = 8; return c; }
  const room = w - 14 * d, setF = (p) => { x.font = LABEL_FONT.replace("{px}", String(p)); if ("letterSpacing" in x) x.letterSpacing = `${(p * 0.05).toFixed(2)}px`; };
  let px = fp * d; setF(px);
  let lines = [text];
  if (x.measureText(text).width > room && text.indexOf(" ") > 0) { /* too wide for one line: break at the space that balances the two halves, so the letters stay large */
    let best = 1e9; for (let i = text.indexOf(" "); i >= 0; i = text.indexOf(" ", i + 1)) { const a = text.slice(0, i), b = text.slice(i + 1), m = Math.max(x.measureText(a).width, x.measureText(b).width); if (m < best) { best = m; lines = [a, b]; } }
  }
  const widest = () => Math.max(...lines.map((l) => x.measureText(l).width));
  const m = widest(); if (m > room) { px = Math.max(7 * d, px * (room / m)); setF(px); }
  if (maxH > 0 && lines.length * px * 1.12 > maxH * d) { px = Math.max(7 * d, (maxH * d) / (lines.length * 1.12)); setF(px); }
  const lh = px * 1.12, hPx = Math.ceil(lh * lines.length + px * 0.5); c.height = Math.max(8, hPx);
  setF(px); x.textAlign = "center"; x.textBaseline = "middle"; x.lineJoin = "round";
  let fill = pale ? "#fff3cf" : "#e8c97c"; try { if (gold && !pale) fill = x.createPattern(gold, "repeat") || fill; } catch (e) { fill = "#e8c97c"; }
  lines.forEach((l, i) => {
    const cx = w / 2, cy = c.height / 2 + (i - (lines.length - 1) / 2) * lh + px * 0.04;
    x.lineWidth = 4 * d; x.strokeStyle = "rgba(24,14,4,0.9)"; x.strokeText(l, cx, cy); x.lineWidth = Math.max(1, d * 1.2); x.strokeStyle = stroke; x.strokeText(l, cx, cy);
    x.fillStyle = fill; x.fillText(l, cx, cy);
  });
  return c;
}
