import { sdfLabel } from "./sdf-worker.js?v=07781af8ec";

const FONT_URL = new URL("../fonts/alegreya-sans-sc-700-latin.woff2", import.meta.url).href;
export function fontReady() { try { return !document.fonts || document.fonts.check('700 13px "Alegreya Sans SC"'); } catch (e) { return true; } }
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const idle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 50 }) : setTimeout(f, 16));

export function createBaker(done) {
  let w = null, dead = false, q = [], busy = 0;
  const sent = new Map();
  function run() {
    busy = 0; if (dead || !q.length) return;
    const j = q.shift();
    try { const r = sdfLabel(j, mk); r.id = j.id; r.font = fontReady(); done(r); } catch (e) {}
    if (q.length) busy = idle(run);
  }
  const later = (j) => { q = q.filter((x) => x.id !== j.id); q.push(j); if (!busy) busy = idle(run); };
  try {
    if (typeof OffscreenCanvas === "function" && typeof Worker === "function") {
      w = new Worker(new URL("./sdf-worker.js?v=07781af8ec", import.meta.url), { type: "module" });
      w.onmessage = (e) => { const r = e.data || {}; sent.delete(r.id); if (!dead && !r.error) done(r); };
      w.onerror = () => { try { w.terminate(); } catch (x) {} w = null; for (const j of sent.values()) later(j); sent.clear(); };
    }
  } catch (e) { w = null; }
  return {
    bake(job) { job.fontUrl = FONT_URL; if (w) { sent.set(job.id, job); w.postMessage(job); } else later(job); },
    mode: () => (w ? "worker" : "idle"),
    destroy() { dead = true; q = []; sent.clear(); if (w) { try { w.terminate(); } catch (e) {} } w = null; },
  };
}
