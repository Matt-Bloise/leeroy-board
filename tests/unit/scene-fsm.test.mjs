// Unit tests for js/scene-fsm.js (cinematic slice 3): every transition, every interruption, the watchdog, instant (reduced) motion, and an effect that throws. Pure: a manual clock, no DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../js/scene-fsm.js"), "utf8");
const mod = { exports: {} };
vm.runInNewContext(src, { module: mod, setTimeout, clearTimeout });
const { create } = mod.exports;

function rig(extra = {}) {
  let now = 0, id = 0; const timers = new Map(), log = [];
  const clock = {
    setTimer: (f, ms) => { const t = ++id; timers.set(t, { at: now + ms, f }); return t; },
    clearTimer: (t) => { timers.delete(t); },
    advance: (ms) => { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].f(); } now = end; },
    pending: () => timers.size,
  };
  const effects = { enter: (s, c) => log.push(`enter:${s}:${c && c.key}`), retarget: (c) => log.push(`retarget:${c && c.key}`), settled: (s, i) => log.push(`settled:${s}${i.forced ? ":forced" : ""}`) };
  const fsm = create({ openMs: 500, closeMs: 600, effects, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra });
  return { fsm, clock, log };
}

test("starts closed with nothing armed", () => { const { fsm, clock } = rig(); assert.equal(fsm.state, "closed"); assert.equal(clock.pending(), 0); });

test("closed -> opening -> open on the animation end (not forced), watchdog disarmed", () => {
  const { fsm, clock, log } = rig();
  assert.equal(fsm.open({ key: "roads" }), "opening"); assert.equal(fsm.state, "opening"); assert.equal(clock.pending(), 1);
  fsm.transitionEnd(); assert.equal(fsm.state, "open"); assert.equal(clock.pending(), 0);
  assert.deepEqual(log, ["enter:opening:roads", "settled:open"]);
});

test("open -> closing -> closed on the animation end", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); fsm.transitionEnd(); log.length = 0;
  assert.equal(fsm.close(), "closing"); assert.equal(clock.pending(), 1); fsm.transitionEnd();
  assert.equal(fsm.state, "closed"); assert.deepEqual(log, ["enter:closing:a", "settled:closed"]);
});

test("watchdog: no animation event ever arrives, opening is forced to open at 1.5 x the opening time", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" });
  clock.advance(749); assert.equal(fsm.state, "opening"); clock.advance(2); assert.equal(fsm.state, "open");
  assert.deepEqual(log, ["enter:opening:a", "settled:open:forced"]);
});

test("watchdog: closing is forced to closed at 1.5 x the closing time", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); fsm.transitionEnd(); log.length = 0; fsm.close();
  clock.advance(899); assert.equal(fsm.state, "closing"); clock.advance(2); assert.equal(fsm.state, "closed");
  assert.deepEqual(log, ["enter:closing:a", "settled:closed:forced"]);
});

test("interruption: close while opening goes to closing and converges to closed (the opening watchdog is dead)", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); clock.advance(200); assert.equal(fsm.close(), "closing");
  clock.advance(700); // the old opening watchdog (750 from t=0) would have fired by now; the closing one (900 from t=200) has not
  assert.equal(fsm.state, "closing"); clock.advance(300); assert.equal(fsm.state, "closed");
  assert.deepEqual(log, ["enter:opening:a", "enter:closing:a", "settled:closed:forced"]);
});

test("interruption: open while closing goes back to opening and converges to open; the stale closing timer does nothing", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); fsm.transitionEnd(); fsm.close(); clock.advance(300);
  assert.equal(fsm.open({ key: "b" }), "opening"); clock.advance(700); // the old closing watchdog is stale now
  assert.equal(fsm.state, "opening"); clock.advance(100); assert.equal(fsm.state, "open");
  assert.deepEqual(log.filter((l) => l.startsWith("settled")), ["settled:open", "settled:open:forced"]);
  assert.ok(!log.includes("settled:closed"));
});

test("three rapid toggles end in the last requested state, with exactly one timer pending while a move is running", () => {
  const { fsm, clock } = rig();
  fsm.open({ key: "a" }); fsm.close(); fsm.open({ key: "a" }); fsm.close();
  assert.equal(fsm.state, "closing"); assert.equal(clock.pending(), 1);
  clock.advance(1000); assert.equal(fsm.state, "closed"); assert.equal(clock.pending(), 0);
});

test("open while already opening or open only retargets (no new transition, no new timer)", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); const g = fsm.generation;
  assert.equal(fsm.open({ key: "b" }), "opening"); assert.equal(fsm.generation, g); assert.equal(clock.pending(), 1);
  fsm.transitionEnd(); assert.equal(fsm.open({ key: "c" }), "open"); assert.equal(clock.pending(), 0);
  assert.deepEqual(log, ["enter:opening:a", "retarget:b", "settled:open", "retarget:c"]);
});

test("close while closed or closing is a no-op", () => {
  const { fsm, clock, log } = rig(); assert.equal(fsm.close(), "closed"); fsm.open({ key: "a" }); fsm.transitionEnd(); fsm.close();
  const g = fsm.generation; assert.equal(fsm.close(), "closing"); assert.equal(fsm.generation, g); assert.equal(clock.pending(), 1);
  assert.equal(log.filter((l) => l.startsWith("enter:closing")).length, 1);
});

test("a late animation end after the watchdog already settled does nothing", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); clock.advance(800); const n = log.length; fsm.transitionEnd(); fsm.transitionEnd();
  assert.equal(log.length, n); assert.equal(fsm.state, "open");
});

test("an animation end while open or closed does nothing", () => { const { fsm, log } = rig(); fsm.transitionEnd(); assert.deepEqual(log, []); assert.equal(fsm.state, "closed"); });

test("instant (reduced motion): open and close settle at once, no timer armed", () => {
  const { fsm, clock, log } = rig({ instant: () => true });
  assert.equal(fsm.open({ key: "a" }), "open"); assert.equal(clock.pending(), 0);
  assert.equal(fsm.close(), "closed"); assert.equal(clock.pending(), 0);
  assert.deepEqual(log, ["enter:opening:a", "settled:open", "enter:closing:a", "settled:closed"]);
});

test("an effect that throws never stops the state from converging", () => {
  const errs = []; const { fsm, clock } = rig({ effects: { enter() { throw new Error("boom"); }, settled() { throw new Error("boom2"); } }, onError: (n, e) => errs.push(`${n}:${e.message}`) });
  fsm.open({ key: "a" }); assert.equal(fsm.state, "opening"); clock.advance(800); assert.equal(fsm.state, "open");
  fsm.close(); clock.advance(1000); assert.equal(fsm.state, "closed"); assert.ok(errs.length >= 3);
});

test("the watchdog scales with the transition (factor 1.5) and a custom factor is honoured", () => {
  const { fsm, clock } = rig({ factor: 2 }); fsm.open({ key: "a" }); clock.advance(999); assert.equal(fsm.state, "opening"); clock.advance(2); assert.equal(fsm.state, "open");
});

test("every legal path ends in closed or open: a randomized interleaving of open, close, animation end and clock never leaves a move unfinished", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 200; run++) {
    const { fsm, clock } = rig();
    for (let i = 0; i < 30; i++) { const r = rnd(); if (r < 0.3) fsm.open({ key: "k" }); else if (r < 0.6) fsm.close(); else if (r < 0.75) fsm.transitionEnd(); else clock.advance(Math.floor(rnd() * 900)); }
    clock.advance(2000); // 1.5 x the longest move is 900: past that nothing may be mid-move
    assert.ok(fsm.state === "open" || fsm.state === "closed", `run ${run} ended ${fsm.state}`); assert.equal(clock.pending(), 0);
  }
});

test("destroy disarms the watchdog", () => { const { fsm, clock } = rig(); fsm.open({ key: "a" }); fsm.destroy(); assert.equal(clock.pending(), 0); clock.advance(5000); assert.equal(fsm.state, "opening"); });

test("reset: back to closed with no effects and no timer, a move in flight is forgotten, and the machine opens again normally", () => {
  const { fsm, clock, log } = rig(); fsm.open({ key: "a" }); const n = log.length; fsm.reset();
  assert.equal(fsm.state, "closed"); assert.equal(clock.pending(), 0); assert.equal(log.length, n); clock.advance(5000); assert.equal(log.length, n);
  assert.equal(fsm.open({ key: "b" }), "opening"); fsm.transitionEnd(); assert.equal(fsm.state, "open");
});
