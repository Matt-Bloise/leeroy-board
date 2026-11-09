// js/ask.js life cues: the answer card wiggles when an answer lands after a wait, the typing tick goes through BoardSound only when not quiet,
// and both stand down under prefers-reduced-motion and html.calm. A small fake DOM; no network, no real timers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = fs.readFileSync(path.join(ROOT, "js/ask.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "css/ask.css"), "utf8");

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.value = ""; this.checked = false; this.options = []; this.textContent = ""; this.parentNode = null;
    const self = this; this.classList = { toggle() {}, contains: (c) => (self.attrs.class || "").split(/\s+/).includes(c) }; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "hidden") this.hidden = true; }
  getAttribute(k) { return this.attrs[k]; }
  append(...k) { for (const c of k) { if (c && typeof c === "object") { c.parentNode = this; this.children.push(c); if (this.tag === "select" && c.tag === "option") this.options.push(c); } else this.textContent += c; } }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  insertBefore(n) { n.parentNode = this; this.children.push(n); }
  addEventListener(t, f) { this.listeners[t] = f; }
  all(out = []) { out.push(this); for (const c of this.children) c.all(out); return out; }
}

function boot({ calm = "", reduce = false, soundOn = true } = {}) {
  const els = { "ask-box": new Node("section"), "ask-note": new Node("p"), "ask-out": new Node("div") };
  els["ask-box"].append(els["ask-note"]);
  const doc = { getElementById: (id) => els[id] || null, createElement: (t) => new Node(t), hidden: false, documentElement: { className: calm } };
  const timers = [], plays = [];
  let handler = null;
  const brain = { onAsk: (f) => { handler = f; }, askStatus: () => ({ state: "idle", base: true, key: "k" }), ask: async () => ({ ok: true }), askRead() {}, getAiProvider: () => "workers-ai" };
  const win = { BoardBrain: brain, matchMedia: () => ({ matches: reduce }), BoardSound: { play: (n, o) => { if (!soundOn) return false; plays.push([n, o]); return true; } } };
  const ctx = { window: win, document: doc, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: (id) => { if (id) timers[id - 1] = null; }, Date, Math, Array, String, console };
  vm.runInNewContext(SRC, ctx);
  const status = (state, extra = {}) => ({ state, base: true, key: "k", provider: "workers-ai", ask: { id: "q1", at: new Date().toISOString(), text: "Where is the tavern", status: state === "queued" ? "queued" : "answered", answer: "Here.", provider: "workers-ai", ...extra } });
  const card = () => els["ask-out"].all().find((n) => n.classList.contains("ask-card"));
  const fire = () => { const f = timers.shift(); if (f) f(); };
  return { handler: () => handler, status, card, plays, timers, fire, out: els["ask-out"] };
}

test("an answer that lands after a wait gets the wiggle class and the crest", () => {
  const t = boot();
  t.handler()(t.status("queued"));
  t.handler()(t.status("answered"));
  const c = t.card();
  assert.ok(c.classList.contains("ask-wiggle"));
  assert.ok(t.out.all().some((n) => n.tag === "img" && n.attrs.class === "ask-crest" && n.attrs.alt === ""), "decorative crest beside the badge");
  assert.ok(fs.existsSync(path.join(ROOT, "img/marks/source-leeroy.webp")));
});

test("an old answer on page load does not wiggle", () => {
  const t = boot();
  t.handler()(t.status("answered"));
  assert.ok(!t.card().classList.contains("ask-wiggle"));
});

test("reduced motion and Calm remove the wiggle and the tick", () => {
  for (const o of [{ reduce: true }, { calm: "calm" }, { calm: "still" }]) {
    const t = boot(o);
    t.handler()(t.status("queued"));
    t.fire(); t.fire();
    assert.equal(t.plays.length, 0, "no tick when quiet " + JSON.stringify(o));
    t.handler()(t.status("answered"));
    assert.ok(!t.card().classList.contains("ask-wiggle"), JSON.stringify(o));
  }
  assert.match(CSS, /prefers-reduced-motion: reduce\) \{[^}]*ask-wiggle[^}]*animation: none/);
  assert.match(CSS, /html\.calm, html\.still\) \.ask-card\.ask-wiggle \{ animation: none/);
});

test("the typing tick plays through BoardSound while queued, and stops after the answer", () => {
  const t = boot();
  t.handler()(t.status("queued"));
  t.fire(); t.fire();
  assert.ok(t.plays.length >= 1 && t.plays.every(([n, o]) => n === "tick" && o.db <= -30));
  t.handler()(t.status("answered"));
  const n = t.plays.length; t.fire(); t.fire();
  assert.equal(t.plays.length, n, "no tick after the answer");
});

test("the tick is skipped when sound is muted (BoardSound.play refuses)", () => {
  const t = boot({ soundOn: false });
  t.handler()(t.status("queued"));
  t.fire(); t.fire(); t.fire();
  assert.equal(t.plays.length, 0);
});

test("the wiggle is transform and opacity only, within 400 ms by token", () => {
  const rule = /@keyframes ask-wiggle \{([^]*?)\n/.exec(CSS)[1];
  assert.ok(!/(width|height|top|left|margin|background|box-shadow)\s*:/.test(rule));
  assert.match(CSS, /\.ask-card\.ask-wiggle \{ animation: ask-wiggle var\(--t-enter\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "css/board.css"), "utf8"), /--t-enter: 400ms/);
});
