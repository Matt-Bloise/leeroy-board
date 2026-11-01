(() => {
"use strict";
const root = typeof window !== "undefined" ? window : globalThis;
const CLIENT_ID = "1561857940174938114";
const SESSION = "board-session", SYNC = "board-sync";
const DOCS = {
  journey: ["board-journey"],
  prefs: ["board-calm", "board-still", "board-screencare", "board-foley", "board-sense", "board-mode"],
  walked: ["board-walked"],
  seen: ["board-seen"],
  "signups-choice": ["board-me"],
};
const DEBOUNCE = 2000, WATCH = 5000, VALUE_MAX = 4096;

function make(d) {
  const store = d.storage, nowMs = d.now || (() => Date.now());
  const st = { session: null, expires: 0, busy: false, say: "", timer: null, watch: null, applied: false, pushing: false, again: false };
  const get = (k) => { try { return store.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v === null || v === undefined) store.removeItem(k); else store.setItem(k, v); } catch (e) {} };
  const tell = () => { try { if (d.onChange) d.onChange(); } catch (e) {} };
  const sdk = () => (typeof d.sdk === "function" ? d.sdk() : d.sdk) || null;
  const base = () => (sdk() ? d.activityBase : d.base) || null;
  let sync = { snap: {}, etag: {}, t: {} };
  try { const j = JSON.parse(get(SYNC) || "null"); if (j && typeof j === "object") sync = { snap: j.snap || {}, etag: j.etag || {}, t: j.t || {} }; } catch (e) {}
  const saveSync = () => put(SYNC, JSON.stringify(sync));
  const loadSession = () => {
    try { const j = JSON.parse(get(SESSION) || "null"); if (j && typeof j.s === "string" && Number(j.exp) > nowMs()) { st.session = j.s; st.expires = Number(j.exp); return true; } } catch (e) {}
    st.session = null; st.expires = 0; return false;
  };
  const clearLocal = () => { st.session = null; st.expires = 0; put(SESSION, null); put(SYNC, null); sync = { snap: {}, etag: {}, t: {} }; };
  const call = async (method, path, body, extra) => {
    const b = base(); if (!b) throw new Error("no api");
    const h = { ...(extra || {}) };
    if (st.session && path !== "/api/auth/discord") h.Authorization = `Bearer ${st.session}`;
    if (body !== undefined) h["Content-Type"] = "application/json";
    return d.fetch(`${b}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), mode: "cors", credentials: "omit", cache: "no-store" });
  };
  const localVal = (k) => { const v = get(k); return typeof v === "string" && v.length <= VALUE_MAX ? v : null; };
  const profileOk = () => { const p = get("board-profile"); return !p || p === "P1"; };

  async function pullDoc(doc) {
    const r = await call("GET", `/api/state/${doc}`);
    if (r.status === 404) { delete sync.etag[doc]; return; }
    if (!r.ok) throw new Error(`state ${doc} ${r.status}`);
    const body = await r.json(), tag = r.headers.get("ETag");
    if (tag) sync.etag[doc] = tag;
    for (const k of DOCS[doc]) {
      const e = body && body.keys && body.keys[k]; if (!e || !(e.v === null || typeof e.v === "string")) continue;
      const mine = localVal(k);
      const dirty = k in sync.snap ? mine !== sync.snap[k] : false;
      if (!dirty && e.v !== mine) { put(k, e.v); st.applied = true; }
      if (!dirty) sync.snap[k] = e.v;
      if (typeof e.t === "number") sync.t[k] = Math.max(sync.t[k] || 0, e.t);
    }
  }
  const synced = (k) => (k in sync.snap ? sync.snap[k] : null);
  const changed = (k) => localVal(k) !== synced(k);
  async function pushDoc(doc, retry) {
    const t = nowMs(), keys = {};
    for (const k of DOCS[doc]) {
      if (changed(k)) keys[k] = { v: localVal(k), t };
      else if (doc !== "prefs" && k in sync.snap) keys[k] = { v: synced(k), t: sync.t[k] || t };
    }
    if (!Object.keys(keys).length) return false;
    const r = await call("PUT", `/api/state/${doc}`, { keys }, sync.etag[doc] ? { "If-Match": sync.etag[doc] } : {});
    if (r.status === 409 && !retry) { const cur = r.headers.get("ETag"); if (cur) sync.etag[doc] = cur; else delete sync.etag[doc]; return pushDoc(doc, true); }
    if (r.status === 401) { clearLocal(); st.say = "Signed out: the saved session ended."; tell(); return false; }
    if (!r.ok) throw new Error(`put ${doc} ${r.status}`);
    const tag = r.headers.get("ETag"); if (tag) sync.etag[doc] = tag; else delete sync.etag[doc];
    for (const k of Object.keys(keys)) { sync.snap[k] = keys[k].v; sync.t[k] = keys[k].t; }
    return true;
  }
  const dirtyDocs = () => Object.keys(DOCS).filter((doc) => DOCS[doc].some(changed));

  async function push() {
    if (!st.session || !profileOk()) return false;
    if (st.pushing) { st.again = true; return false; }
    st.pushing = true;
    try {
      let did = false;
      for (const doc of dirtyDocs()) did = (await pushDoc(doc)) || did;
      saveSync(); return did;
    } catch (e) { return false; } finally { st.pushing = false; if (st.again) { st.again = false; notify(); } }
  }
  function notify() {
    if (!st.session || !profileOk()) return;
    if (st.timer) d.clearTimeout(st.timer);
    st.timer = d.setTimeout(() => { st.timer = null; push(); }, DEBOUNCE);
  }
  async function pull() {
    if (!st.session || !profileOk()) return false;
    try {
      st.applied = false;
      for (const doc of Object.keys(DOCS)) await pullDoc(doc);
      saveSync();
      if (st.applied) { st.say = "Your saved settings were loaded. Reload to use them."; tell(); }
      await push();
      return true;
    } catch (e) { return false; }
  }
  function watch() {
    if (st.watch || !d.setInterval) return;
    st.watch = d.setInterval(() => { try { if (st.session && !(d.hidden && d.hidden()) && dirtyDocs().length) notify(); } catch (e) {} }, WATCH);
  }
  function start() { if (loadSession()) { watch(); pull(); } tell(); return !!st.session; }

  async function signIn() {
    const s = sdk();
    if (!s) { st.say = "Sign-in works inside the Discord Activity for now."; tell(); return false; }
    if (st.busy) return false;
    st.busy = true; st.say = "Signing in"; tell();
    try {
      const { code } = await s.commands.authorize({ client_id: CLIENT_ID, response_type: "code", state: "", prompt: "none", scope: ["identify"] });
      if (typeof code !== "string" || !code) throw new Error("no code");
      const r = await call("POST", "/api/auth/discord", { code });
      if (!r.ok) throw new Error(`login ${r.status}`);
      const j = await r.json();
      if (!j || typeof j.session !== "string" || !Number.isFinite(j.expires_at)) throw new Error("bad login");
      st.session = j.session; st.expires = j.expires_at;
      put(SESSION, JSON.stringify({ s: j.session, exp: j.expires_at }));
      st.say = "Signed in."; watch(); tell();
      pull();
      return true;
    } catch (e) { st.say = "Sign-in did not work. Nothing was changed."; tell(); return false; }
    finally { st.busy = false; tell(); }
  }
  function signOut() { if (st.timer) { d.clearTimeout(st.timer); st.timer = null; } clearLocal(); st.say = "Signed out on this device. Saved data stays on the server until you delete it."; tell(); }
  async function erase() {
    if (!st.session) return false;
    try {
      const r = await call("DELETE", "/api/me");
      if (r.ok || r.status === 401) { signOut(); st.say = "Your saved data and every sign-in were deleted from the server."; tell(); return true; }
    } catch (e) {}
    st.say = "Could not reach the server, so nothing was deleted. Try again."; tell(); return false;
  }
  loadSession();
  return {
    signIn, signOut, erase, pull, push, notify, start,
    canSignIn: () => !!sdk() && !!base(), signedIn: () => !!st.session,
    status: () => ({ signedIn: !!st.session, expires: st.expires, busy: st.busy, say: st.say, inActivity: !!sdk(), dirty: dirtyDocs() }),
  };
}

root.__makeAccount = make;
const K = root.__boardKit;
if (K && K.api && typeof document !== "undefined" && typeof root.fetch === "function") {
  const A = make({
    fetch: (...a) => root.fetch(...a), storage: root.localStorage, base: K.api,
    activityBase: `${root.location.origin}/board-api`, sdk: () => root.__sdk || null,
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms),
    hidden: () => document.hidden, now: () => Date.now(),
    onChange: () => { try { root.dispatchEvent(new Event("board-account")); } catch (e) {} },
  });
  root.BoardAccount = A;
  for (const n of ["board-mode", "board-calm", "board-still", "board-screencare", "board-room"]) addEventListener(n, () => A.notify());
  A.start();
}
})();
