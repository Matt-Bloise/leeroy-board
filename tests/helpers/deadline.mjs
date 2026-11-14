// Deadlines for browser sweeps. A Playwright call with no timeout of its own (page.evaluate, context.close, browser.close) can
// wait forever when the page or the engine hangs: Cross-engine QA runs 43253520683 (2026-11-12) and 43603335149 (2026-11-14)
// sat in a Firefox layout sweep at a faked clock until the 50 minute job limit, then were cancelled with no failure line and
// no issue. These helpers turn such a hang into a named failure. Helper only (not a test).

export class DeadlineError extends Error {
  constructor(label, ms) {
    super(`${label} did not finish within ${Math.round(ms / 1000)} s`);
    this.name = "DeadlineError";
    this.label = label;
    this.ms = ms;
  }
}

// Resolves or rejects like `promise`, or rejects with DeadlineError after `ms`. The timer is cleared as soon as `promise` settles.
export function withDeadline(promise, ms, label = "call") {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

// Last-resort guard for a whole run: after `ms`, calls onFire(list of labels still running) once. Returns { add, remove, stop }.
// The timer is not unref'd: a hung run must still end through it.
export function watchdog(ms, onFire, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const running = new Set();
  let fired = false;
  const t = setTimer(() => { fired = true; onFire([...running]); }, ms);
  return {
    add: (label) => running.add(label),
    remove: (label) => running.delete(label),
    stop: () => { if (!fired) clearTimer(t); },
    get running() { return [...running]; },
  };
}
