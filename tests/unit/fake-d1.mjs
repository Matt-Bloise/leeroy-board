// A tiny in-memory fake of the D1 statements the cards, board-line and noise code use. Not a SQL engine: each statement is matched by shape.
// Helper only (not a test). Fictional data everywhere.
export function fakeD1(seed = {}) {
  const kv = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const ledger = new Map();
  const log = [];
  return {
    kv, ledger, log,
    prepare(sql) {
      let a = [];
      const lit = /key = '([^']+)'/.exec(sql) || /VALUES \('([^']+)'/.exec(sql);
      const o = {
        bind: (...x) => { a = x; return o; },
        async first() {
          log.push(sql);
          if (/FROM kv_state/.test(sql)) { const k = lit ? lit[1] : a[0]; return kv.has(k) ? { json: kv.get(k) } : null; }
          if (/FROM noise_ledger/.test(sql)) { const n = ledger.get(`${a[0]}|${a[1]}`); return n === undefined ? null : { n }; }
          throw new Error(`fake D1: unhandled first(): ${sql}`);
        },
        async run() {
          log.push(sql);
          if (/^INSERT OR REPLACE INTO kv_state/.test(sql)) { kv.set(lit ? lit[1] : a[0], lit ? a[0] : a[1]); return { meta: { changes: 1 } }; }
          if (/^INSERT OR IGNORE INTO kv_state/.test(sql)) { if (kv.has(a[0])) return { meta: { changes: 0 } }; kv.set(a[0], a[1]); return { meta: { changes: 1 } }; }
          if (/^UPDATE kv_state SET json = \?, updated_at = \? WHERE key = \? AND json = \?/.test(sql)) {
            if (kv.get(a[2]) !== a[3]) return { meta: { changes: 0 } };
            kv.set(a[2], a[0]); return { meta: { changes: 1 } };
          }
          if (/^DELETE FROM kv_state WHERE key = \? AND json = \?/.test(sql)) {
            if (kv.get(a[0]) !== a[1]) return { meta: { changes: 0 } };
            kv.delete(a[0]); return { meta: { changes: 1 } };
          }
          if (/^INSERT INTO noise_ledger/.test(sql)) { const k = `${a[0]}|${a[1]}`; ledger.set(k, (ledger.get(k) || 0) + 1); return { meta: { changes: 1 } }; }
          throw new Error(`fake D1: unhandled run(): ${sql}`);
        },
      };
      return o;
    },
  };
}

// A fake fetch: records calls, answers from a handler(method, path, body) -> { status, json }.
export function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || "GET", path, body, auth: init.headers && init.headers.Authorization });
    const r = (await handler(init.method || "GET", path, body)) || { status: 200, json: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {} };
  };
  f.calls = calls;
  return f;
}
