// Pixel comparison for the visual baseline gate (tests/browser/visual-baseline.mjs). Pure functions over decoded RGBA images (tests/helpers/png.mjs).
//   diffImages(a, b, { tolerance })   -> { width, height, total, changed, ratio, maxDelta, box } or { sizeMismatch: "390x844 vs 390x900" }
//       a pixel is CHANGED when any of its four channels differs by more than `tolerance` (0 to 255); ratio = changed / total; maxDelta is the largest
//       channel difference seen anywhere (also below the tolerance), box the bounding box of the changed pixels ({ x, y, w, h }, null when none changed)
//   judge(result, { maxRatio })       -> { pass, why }   a size change always fails; otherwise pass when ratio <= maxRatio
//   diffImage(a, b, { tolerance })    -> RGBA image of b dimmed to a quarter of its grey, with every changed pixel painted red (brighter = larger change)
export function diffImages(a, b, { tolerance = 8 } = {}) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  const { width, height } = a, A = a.data, B = b.data;
  let changed = 0, maxDelta = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let i = 0, p = 0; i < A.length; i += 4, p++) {
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]), Math.abs(A[i + 3] - B[i + 3]));
    if (d > maxDelta) maxDelta = d;
    if (d > tolerance) {
      changed++;
      const x = p % width, y = (p / width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const total = width * height;
  return { width, height, total, changed, ratio: changed / total, maxDelta, box: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

export function judge(result, { maxRatio }) {
  if (result.sizeMismatch) return { pass: false, why: `size changed (${result.sizeMismatch})` };
  if (result.ratio > maxRatio) return { pass: false, why: `${(result.ratio * 100).toFixed(3)}% of pixels changed (${result.changed} px, limit ${(maxRatio * 100).toFixed(3)}%)` };
  return { pass: true, why: `${(result.ratio * 100).toFixed(3)}% of pixels changed (${result.changed} px, limit ${(maxRatio * 100).toFixed(3)}%)` };
}

export function diffImage(a, b, { tolerance = 8 } = {}) {
  const { width, height } = b, A = a.data, B = b.data, out = new Uint8Array(width * height * 4);
  for (let i = 0; i < B.length; i += 4) {
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]), Math.abs(A[i + 3] - B[i + 3]));
    if (d > tolerance) { out[i] = 128 + Math.min(127, d); out[i + 1] = 0; out[i + 2] = 0; }
    else { const g = Math.round((0.299 * B[i] + 0.587 * B[i + 1] + 0.114 * B[i + 2]) / 4); out[i] = out[i + 1] = out[i + 2] = g; }
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}
