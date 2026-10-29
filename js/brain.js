/* V13d: the board side of the shared brain (notes/SHARED-BRAIN-DESIGN.md section 3, stage 3; cloudflare/STAGE12-NOTES.md).
   window.BoardBrain reads the bot's mirror from the leeroy-brain Worker (GET /api/state, then the /api/live WebSocket, with a
   15 s poll when the socket is not there; V13e: the socket only with a key, keyless boards poll) and, with a personal board key, sends one person's sign-up state and journey
   (POST /api/intent). It never sends a name, an id or anything but the fixed answer words, plus (Ask Leeroy, 2026-10-29) the
   one question a person types into the ask box and its share tick; the answer comes back with GET /api/ask.
   - V15 (2026-10-30, board/V15-LAUNCH-SPEC.md 5): the launch-night state (queue, in, done) goes the same way as a third kind;
     the Worker keeps it per key and mirrors it as `launch` rows in GET /api/state. Without a Worker, a key, or against the
     Worker deployed before this change (which answers 400), setLaunch reports local: the page keeps the state on the device.
   - The key arrives once in the address bar (#k=<key>&signups from "My board link" on the Sign-ups card); this file runs
     before the board and the gate, stores it as board-key and takes it out of the address bar at once.
   - Where it talks: relative /api on Discord's proxy (*.discordsays.com), the workers.dev URL on the public host, relative
     /api on 127.0.0.1 only with ?brain=local (the local fake for the tests). Anywhere else it makes no request. */
(() => {
"use strict";
const WORKER = "https://leeroy-brain.jmattbloise.workers.dev";
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const RSVP = ["in", "maybe", "late", "out"], JOURNEYS = ["guided", "curious", "everything"], LAUNCH = ["queue", "in", "done"]; /* V15: the launch-night state */
const POLL_MS = 15000, PING_MS = 45000, WS_RETRY_MS = 120000, SLOW_MS = 30000;
const B = { key: null, base: null, ver: 0, at: null, signups: null, me: null, keyBad: false, ws: null, via: "off", started: false, pend: {}, h: {}, subs: {}, pollT: 0, pingT: 0, wsT: 0, journeyRefused: false, mirrorJ: undefined, jWant: null, jWantAt: 0, errors: 0, sent: 0, polls: 0, wsMsgs: 0, launch: [], lPend: null, launchRefused: false };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
};
/* the board's own handlers (start) and any later listener (on, V15: js/v15.js hears the launch rows without owning start) */
const emit = (n, ...a) => { for (const f of [B.h[n], ...(B.subs[n] || [])]) if (typeof f === "function") { try { f(...a); } catch (e) { console.error("brain", n, e); } } };
function on(n, f) { if (typeof f === "function") (B.subs[n] ||= []).push(f); }

/* the key: read from the address bar once, kept in this browser, never shown or logged */
(function capture() {
  const saved = store.get("board-key");
  B.key = saved && KEY_RE.test(saved) ? saved : null;
  const raw = String(location.hash || "").replace(/^#/, "");
  if (!/(^|&)k=/.test(raw)) return;
  let key = null; const rest = [];
  for (const p of raw.split("&")) { if (p.slice(0, 2) === "k=") { try { key = decodeURIComponent(p.slice(2)); } catch (e) { key = null; } } else if (p) rest.push(p); }
  if (key && KEY_RE.test(key)) { store.set("board-key", key); B.key = key; B.fresh = true; }
  const keep = rest.find((x) => /^[A-Za-z0-9._~-]{1,100}$/.test(x)) || "";
  try { history.replaceState(null, "", `${location.pathname}${location.search || ""}${keep ? `#${keep}` : ""}`); } catch (e) {}
})();

function baseFor() {
  const host = location.hostname || "";
  if (/\.discordsays\.com$/.test(host)) return { http: "/api", ws: `wss://${host}/api/live` };
  if (host === "matt-bloise.github.io") return { http: `${WORKER}/api`, ws: `${WORKER.replace(/^https:/, "wss:")}/api/live` };
  if ((host === "127.0.0.1" || host === "localhost") && /(^|[?&])brain=local(&|$)/.test(location.search || "")) return { http: "/api", ws: `ws://${location.host || host}/api/live` };
  return null;
}
B.base = baseFor();

/* only these bodies ever leave the page: a kind, one answer word from that kind's fixed list, and the mirror version */
function safe(body) {
  if (body && body.kind === "ask") {
    const p = body.patch, okAsk = Object.keys(body).every((k) => k === "kind" || k === "patch") && p && typeof p === "object" && typeof p.text === "string" && p.text.length <= 1200
      && Object.keys(p).every((k) => k === "text" || (k === "share" && typeof p.share === "boolean"));
    if (!okAsk || /\d{17,20}/.test(p ? p.text : "")) throw new Error("refused: an ask carries only its text and the share tick");
    return body;
  }
  const p = body && body.patch, one = p && typeof p === "object" && Object.keys(p).length === 1;
  const word = !one ? false : body.kind === "signup" ? RSVP.includes(p.rsvp) : body.kind === "journey" ? JOURNEYS.includes(p.journey) : body.kind === "launch" ? LAUNCH.includes(p.state) : false;
  const ok = word && Object.keys(body).every((k) => ["kind", "patch", "ver"].includes(k))
    && (body.ver === undefined || (Number.isInteger(body.ver) && body.ver >= 0));
  if (!ok || /\d{17,20}/.test(JSON.stringify(body))) throw new Error("refused: only an answer word may leave the board");
  return body;
}
async function call(method, route, body) {
  const headers = {};
  if (B.key && (route === "/me" || route === "/intent" || route === "/ask")) headers.Authorization = `Board ${B.key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${B.base.http}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(safe(body)), cache: "no-store", credentials: "omit" });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

/* the mirror: a newer version replaces what the page shows; a pending answer settles against it */
const nameOf = (n) => String(n || "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
function mine() {
  const S = B.signups, me = B.me; if (!S || !me || !Array.isArray(S.entries)) return null;
  return S.entries.find((e) => e.slug && e.slug === me.slug) || S.entries.find((e) => nameOf(e.name) === nameOf(me.name)) || null;
}
function settle() {
  const e = mine(); let moved = false;
  for (const [f, p] of Object.entries(B.pend)) {
    if (!e || p.state === "sending" || p.state === "failed" || p.state === "saved" || p.state === "newer") continue;
    if (e[f] === p.value) { p.state = "saved"; p.done = Date.now(); moved = true; }
    else if (p.at && e.updated && Date.parse(e.updated) > Date.parse(p.at)) { p.state = "newer"; p.other = e[f]; moved = true; }
  }
  if (moved) emit("pending", pending());
}
/* V15: the Worker's own launch-night rows ride beside the bot's snapshot; an older Worker sends none and the list stays empty */
const launchRow = (r) => r && typeof r.slug === "string" && typeof r.name === "string" && LAUNCH.includes(r.state) && !/\d{17,20}/.test(`${r.slug} ${r.name}`);
function mineLaunch() { const me = B.me; return me ? B.launch.find((r) => r.slug === me.slug) || null : null; }
function settleLaunch() {
  const p = B.lPend, r = mineLaunch(); if (!p || !r || p.state === "sending" || p.state === "failed" || p.state === "local" || p.state === "saved") return;
  if (r.state === p.value && (!p.at || !r.at || Date.parse(r.at) >= Date.parse(p.at) - 1000)) { p.state = "saved"; emit("launchPending", launchPending()); }
}
function onState(m) {
  if (!m || typeof m.ver !== "number" || m.unchanged || m.ver < B.ver || (m.ver === B.ver && B.signups)) return false;
  B.ver = m.ver; B.at = m.at || null;
  if (Array.isArray(m.launch)) { B.launch = m.launch.filter(launchRow).map((r) => ({ slug: r.slug, name: r.name, state: r.state, at: r.at || null })); emit("launch", B.launch.slice()); settleLaunch(); }
  if (!m.signups) return false;
  B.signups = m.signups;
  emit("state", m.signups, m.ver);
  settle();
  journeyFromMirror();
  return true;
}
function journeyFromMirror() {
  const me = B.me, J = B.signups && B.signups.journeys; if (!me || !Array.isArray(J)) return;
  const row = J.find((j) => j.slug && j.slug === me.slug) || J.find((j) => nameOf(j.name) === nameOf(me.name));
  const v = row && JOURNEYS.includes(row.journey) ? row.journey : null;
  /* while this board's own pick is on its way, an older mirror row must not flip the page back (V13e) */
  if (B.jWant) { if (v === B.jWant || Date.now() - B.jWantAt > 60000) B.jWant = null; else return; }
  if (v && v !== B.mirrorJ) { B.mirrorJ = v; emit("journey", v); }
}

/* reading: one GET at start, then the socket; the poll only while there is no socket and the tab is visible */
const hidden = () => typeof document !== "undefined" && (document.hidden || document.visibilityState === "hidden");
function schedulePoll(ms) { clearTimeout(B.pollT); B.pollT = setTimeout(pollOnce, ms); }
async function pollOnce() {
  if (!B.base) return;
  if (B.via === "ws") return;
  if (hidden()) { schedulePoll(POLL_MS); return; }
  try {
    const r = await call("GET", `/state${B.ver ? `?ver=${B.ver}` : ""}`); B.polls++;
    if (r.status === 200) { onState(r.data); B.errors = 0; } else B.errors++;
  } catch (e) { B.errors++; }
  emit("status", status());
  if (B.via !== "ws") schedulePoll(POLL_MS);
}
function openWs() {
  clearTimeout(B.wsT);
  if (!B.base || !B.key || typeof WebSocket !== "function" || B.ws) return false;
  let ws; try { ws = new WebSocket(B.base.ws); } catch (e) { return false; }
  B.ws = ws; let opened = false;
  ws.onopen = () => { if (B.ws !== ws) return; opened = true; B.via = "ws"; clearTimeout(B.pollT); clearInterval(B.pingT); B.pingT = setInterval(() => { try { ws.send("ping"); } catch (e) {} }, PING_MS); emit("status", status()); };
  ws.onmessage = (e) => { const d = typeof e.data === "string" ? e.data : ""; if (d === "pong") return; let m; try { m = JSON.parse(d); } catch (er) { return; } B.wsMsgs++; if (m && m.type === "state") onState(m); };
  const down = () => {
    if (B.ws !== ws) return;
    B.ws = null; clearInterval(B.pingT); B.via = "poll";
    emit("status", status());
    schedulePoll(opened ? 0 : POLL_MS);
    if (B.key) B.wsT = setTimeout(openWs, WS_RETRY_MS);
  };
  ws.onclose = down; ws.onerror = () => { down(); try { ws.close(); } catch (e) {} };
  return true;
}
async function me() {
  if (!B.base || !B.key) { B.me = null; emit("me", null); return null; }
  try {
    const r = await call("GET", "/me");
    if (r.status === 200 && r.data && r.data.slug) {
      B.me = { slug: r.data.slug, name: r.data.name }; B.keyBad = false;
      /* waiting changes from an earlier visit show as waiting again */
      for (const p of r.data.pending || []) for (const [f, v] of Object.entries(p.patch || {})) { if (f === "rsvp") B.pend.rsvp = { value: v, at: p.at, state: "waiting", seq: p.seq }; if (p.kind === "launch" && f === "state" && LAUNCH.includes(v)) B.lPend = { value: v, at: p.at, state: "waiting", seq: p.seq }; }
    } else if (r.status === 401) { B.me = null; B.keyBad = true; }
  } catch (e) { B.errors++; }
  emit("me", B.me);
  settle(); journeyFromMirror(); settleLaunch();
  emit("pending", pending());
  emit("launchPending", launchPending());
  if (B.me) askRead(); else askEmit();
  return B.me;
}

function pending() { const out = {}; for (const [f, p] of Object.entries(B.pend)) out[f] = { value: p.value, state: p.state, ...(p.other ? { other: p.other } : {}), ...(p.error ? { error: p.error } : {}) }; return out; }
function launchPending() { const p = B.lPend; return p ? { value: p.value, state: p.state, ...(p.error ? { error: p.error } : {}) } : null; }
function status() { return { via: B.via, base: B.base ? B.base.http : null, key: !!B.key, keyBad: B.keyBad, me: B.me ? { ...B.me } : null, ver: B.ver, pending: pending(), errors: B.errors, polls: B.polls, wsMsgs: B.wsMsgs, sent: B.sent, journeyRefused: B.journeyRefused, launch: B.launch.length, launchPending: launchPending(), launchRefused: B.launchRefused }; }

async function setRsvp(v) {
  if (!B.base) return { ok: false, why: "nowhere to send" };
  if (!B.key) return { ok: false, why: "no key" };
  if (!RSVP.includes(v)) return { ok: false, why: "not an answer" };
  const p = B.pend.rsvp = { value: v, state: "sending", t: Date.now() };
  emit("pending", pending());
  try {
    const r = await call("POST", "/intent", { kind: "signup", patch: { rsvp: v }, ...(B.ver ? { ver: B.ver } : {}) }); B.sent++;
    if (B.pend.rsvp !== p) return { ok: r.status === 200 };
    if (r.status === 200) {
      p.state = "waiting"; p.at = (r.data && r.data.at) || new Date().toISOString(); p.seq = r.data && r.data.seq;
      setTimeout(() => { if (B.pend.rsvp === p && p.state === "waiting") { p.state = "stored"; emit("pending", pending()); } }, SLOW_MS);
      settle();
    } else { p.state = "failed"; p.error = r.status === 401 ? "key" : r.status === 429 ? "busy" : "refused"; if (r.status === 401) B.keyBad = true; }
  } catch (e) { p.state = "failed"; p.error = "offline"; B.errors++; }
  emit("pending", pending());
  return { ok: p.state !== "failed", state: p.state };
}
/* the journey goes the same way (V13e: the Worker takes { kind: "journey" }, last one per key wins, and the bot stores it in
   journeys.json and mirrors it); an older Worker answers 400, which is remembered for the visit, and the choice stays local */
async function setJourney(j) {
  if (!B.base || !B.key || !JOURNEYS.includes(j) || B.journeyRefused) return { ok: false, refused: B.journeyRefused };
  try {
    B.jWant = j; B.jWantAt = Date.now();
    const r = await call("POST", "/intent", { kind: "journey", patch: { journey: j } }); B.sent++;
    if (r.status !== 200 && B.jWant === j) B.jWant = null;
    if (r.status === 400) { B.journeyRefused = true; emit("status", status()); return { ok: false, refused: true }; }
    return { ok: r.status === 200 };
  } catch (e) { B.errors++; return { ok: false }; }
}
/* V15: the launch-night state. local: true means the page keeps it on this device only (no Worker, no key, or a Worker that
   does not know the kind yet); waiting means the Worker has it and the mirror will confirm; saved once a launch row carries it */
async function setLaunch(v) {
  if (!LAUNCH.includes(v)) return { ok: false, why: "not a state" };
  if (!B.base) return { ok: false, local: true, why: "nowhere to send" };
  if (!B.key) return { ok: false, local: true, why: "no key" };
  if (B.launchRefused) return { ok: false, local: true, why: "refused" };
  const p = B.lPend = { value: v, state: "sending", t: Date.now() };
  emit("launchPending", launchPending());
  try {
    const r = await call("POST", "/intent", { kind: "launch", patch: { state: v }, ...(B.ver ? { ver: B.ver } : {}) }); B.sent++;
    if (B.lPend !== p) return { ok: r.status === 200 };
    if (r.status === 200) {
      p.state = "waiting"; p.at = (r.data && r.data.at) || new Date().toISOString(); p.seq = r.data && r.data.seq;
      setTimeout(() => { if (B.lPend === p && p.state === "waiting") { p.state = "stored"; emit("launchPending", launchPending()); } }, SLOW_MS);
      settleLaunch();
    } else if (r.status === 400) { B.launchRefused = true; p.state = "local"; emit("status", status()); }
    else { p.state = "failed"; p.error = r.status === 401 ? "key" : r.status === 429 ? "busy" : "refused"; if (r.status === 401) B.keyBad = true; }
  } catch (e) { p.state = "failed"; p.error = "offline"; B.errors++; }
  emit("launchPending", launchPending());
  return { ok: p.state === "waiting" || p.state === "saved", local: p.state === "local", state: p.state };
}
/* Ask Leeroy (2026-10-29): one ask at a time via the "ask" intent, the answer read back with GET /ask. States: idle sending queued answered failed error limited. */
const AK = { st: "idle", ask: null, left: null, retry: 0, err: "", h: [], t: 0, since: 0 };
const askStatus = () => ({ state: AK.st, ask: AK.ask ? { ...AK.ask, sources: (AK.ask.sources || []).slice() } : null, left: AK.left, retryAfter: AK.retry, error: AK.err, base: !!B.base, key: !!B.key, keyBad: B.keyBad, me: B.me ? B.me.name : null });
const askEmit = () => { const s = askStatus(); for (const f of AK.h) { try { f(s); } catch (e) { console.error("brain ask", e); } } };
const askAdopt = (a) => { AK.ask = a || null; AK.st = !a ? "idle" : a.status === "queued" ? "queued" : a.status === "answered" ? "answered" : "failed"; AK.err = ""; AK.retry = 0; if (AK.st === "queued") { if (!AK.since) AK.since = Date.now(); } else AK.since = 0; };
async function askRead() {
  clearTimeout(AK.t);
  if (!B.base || !B.key || AK.st === "sending") return;
  let again = false;
  try {
    const r = await call("GET", "/ask");
    if (r.status === 200 && r.data) {
      if (r.data.limit) AK.left = r.data.limit.left;
      if (AK.st !== "sending") askAdopt(r.data.ask);
      again = AK.st === "queued";
    } else if (r.status === 401) { B.keyBad = true; AK.st = "error"; AK.err = "key"; } else if (r.status !== 429) { again = AK.st === "queued"; }
    else again = AK.st === "queued";
  } catch (e) { B.errors++; again = AK.st === "queued"; }
  askEmit();
  const waited = Date.now() - AK.since;
  if (again && AK.st === "queued" && waited < 600000) AK.t = setTimeout(askRead, hidden() ? 20000 : waited < 120000 ? 4000 : waited < 300000 ? 10000 : 20000);
}
async function ask(text, share) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim(), n = Array.from(t).length;
  if (!B.base || !B.key) return { ok: false, why: B.key ? "nowhere" : "no key" };
  if (n < 3) return { ok: false, why: "short" };
  if (n > 280) return { ok: false, why: "long" };
  if (AK.st === "sending" || AK.st === "queued") return { ok: false, why: "busy" };
  AK.st = "sending"; AK.err = ""; AK.retry = 0; clearTimeout(AK.t); askEmit();
  try {
    const r = await call("POST", "/intent", { kind: "ask", patch: { text: t, share: share === true } }); B.sent++;
    if (r.status === 200 && r.data && r.data.ok) {
      AK.left = typeof r.data.left === "number" ? r.data.left : AK.left;
      AK.ask = { id: r.data.id, status: "queued", text: t, share: share === true, at: r.data.at, answer: null, sources: [] };
      AK.st = "queued"; AK.since = Date.now(); askEmit(); AK.t = setTimeout(askRead, 3000);
      return { ok: true, state: "queued" };
    }
    if (r.status === 409) { AK.st = "idle"; await askRead(); return { ok: false, why: "open" }; }
    if (r.status === 429) { AK.st = "limited"; AK.retry = Math.max(1, Number(r.data && r.data.retryAfter) || 3600); AK.left = 0; }
    else if (r.status === 401) { B.keyBad = true; AK.st = "error"; AK.err = "key"; }
    else if (r.status === 400) { AK.st = "error"; AK.err = "refused"; }
    else { AK.st = "error"; AK.err = "busy"; }
  } catch (e) { B.errors++; AK.st = "error"; AK.err = "offline"; }
  askEmit();
  return { ok: false, why: AK.st === "limited" ? "limited" : AK.err };
}
function start(handlers) {
  B.h = handlers || {};
  if (B.started) return status();
  B.started = true;
  if (!B.base) { B.via = "off"; emit("status", status()); return status(); }
  B.via = "poll";
  pollOnce();
  /* V13e (retest defect 3): only a board with a key opens the socket. A keyless board reads the mirror with the 15 s poll
     while visible, so a public viewer never opens /api/live and never logs a failed socket (the 503 seen on github.io). */
  if (B.key) openWs();
  if (B.key) me(); else emit("me", null);
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", () => { if (!hidden() && B.via !== "ws") pollOnce(); });
  if (typeof addEventListener === "function") addEventListener("focus", () => { if (B.via !== "ws") pollOnce(); });
  return status();
}
function forget() { clearTimeout(B.wsT); if (B.ws) { const w = B.ws; B.ws = null; clearInterval(B.pingT); try { w.close(); } catch (e) {} B.via = "poll"; schedulePoll(0); } store.set("board-key", null); B.key = null; B.me = null; B.keyBad = false; B.pend = {}; B.lPend = null; B.launchRefused = false; clearTimeout(AK.t); AK.st = "idle"; AK.ask = null; AK.err = ""; AK.since = 0; emit("me", null); emit("pending", {}); emit("launchPending", null); askEmit(); }
window.BoardBrain = Object.freeze({ start, on, status, setRsvp, setJourney, setLaunch, ask, askStatus, askRead, onAsk: (f) => { if (typeof f === "function") AK.h.push(f); }, forget, me, hasKey: () => !!B.key, mine: () => { const e = mine(); return e ? { ...e } : null; }, launch: () => B.launch.map((r) => ({ ...r })), mineLaunch: () => { const r = mineLaunch(); return r ? { ...r } : null; }, launchPending, _state: onState, _poll: pollOnce });
})();
