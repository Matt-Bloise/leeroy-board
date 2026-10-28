/* V13d: the board side of the shared brain (notes/SHARED-BRAIN-DESIGN.md section 3, stage 3; cloudflare/STAGE12-NOTES.md).
   window.BoardBrain reads the bot's mirror from the leeroy-brain Worker (GET /api/state, then the /api/live WebSocket, with a
   15 s poll when the socket is not there) and, with a personal board key, sends one person's sign-up state and journey
   (POST /api/intent). It never sends a name, an id or anything but the fixed answer words.
   - The key arrives once in the address bar (#k=<key>&signups from "My board link" on the Sign-ups card); this file runs
     before the board and the gate, stores it as board-key and takes it out of the address bar at once.
   - Where it talks: relative /api on Discord's proxy (*.discordsays.com), the workers.dev URL on the public host, relative
     /api on 127.0.0.1 only with ?brain=local (the local fake for the tests). Anywhere else it makes no request. */
(() => {
"use strict";
const WORKER = "https://leeroy-brain.jmattbloise.workers.dev";
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const RSVP = ["in", "maybe", "late", "out"], JOURNEYS = ["guided", "curious", "everything"];
const POLL_MS = 15000, PING_MS = 45000, WS_RETRY_MS = 120000, SLOW_MS = 30000;
const B = { key: null, base: null, ver: 0, at: null, signups: null, me: null, keyBad: false, ws: null, via: "off", started: false, pend: {}, h: {}, pollT: 0, pingT: 0, wsT: 0, journeyRefused: false, mirrorJ: undefined, errors: 0, sent: 0, polls: 0, wsMsgs: 0 };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
};
const emit = (n, ...a) => { const f = B.h[n]; if (typeof f === "function") { try { f(...a); } catch (e) { console.error("brain", n, e); } } };

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

/* only these bodies ever leave the page: a kind, one answer word from a fixed list, and the mirror version */
function safe(body) {
  const ok = body && (body.kind === "signup" || body.kind === "journey") && Object.keys(body).every((k) => ["kind", "patch", "ver"].includes(k))
    && body.patch && Object.keys(body.patch).length === 1
    && ((body.patch.rsvp !== undefined && RSVP.includes(body.patch.rsvp)) || (body.patch.journey !== undefined && JOURNEYS.includes(body.patch.journey)))
    && (body.ver === undefined || (Number.isInteger(body.ver) && body.ver >= 0));
  if (!ok || /\d{17,20}/.test(JSON.stringify(body))) throw new Error("refused: only an answer word may leave the board");
  return body;
}
async function call(method, route, body) {
  const headers = {};
  if (B.key && (route === "/me" || route === "/intent")) headers.Authorization = `Board ${B.key}`;
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
function onState(m) {
  if (!m || typeof m.ver !== "number" || m.unchanged || m.ver < B.ver || (m.ver === B.ver && B.signups)) return false;
  B.ver = m.ver; B.at = m.at || null;
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
  if (!B.base || typeof WebSocket !== "function" || B.ws) return false;
  let ws; try { ws = new WebSocket(B.base.ws); } catch (e) { return false; }
  B.ws = ws; let opened = false;
  ws.onopen = () => { if (B.ws !== ws) return; opened = true; B.via = "ws"; clearTimeout(B.pollT); clearInterval(B.pingT); B.pingT = setInterval(() => { try { ws.send("ping"); } catch (e) {} }, PING_MS); emit("status", status()); };
  ws.onmessage = (e) => { const d = typeof e.data === "string" ? e.data : ""; if (d === "pong") return; let m; try { m = JSON.parse(d); } catch (er) { return; } B.wsMsgs++; if (m && m.type === "state") onState(m); };
  const down = () => {
    if (B.ws !== ws) return;
    B.ws = null; clearInterval(B.pingT); B.via = "poll";
    emit("status", status());
    schedulePoll(opened ? 0 : POLL_MS);
    B.wsT = setTimeout(openWs, WS_RETRY_MS);
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
      for (const p of r.data.pending || []) for (const [f, v] of Object.entries(p.patch || {})) if (f === "rsvp") B.pend.rsvp = { value: v, at: p.at, state: "waiting", seq: p.seq };
    } else if (r.status === 401) { B.me = null; B.keyBad = true; }
  } catch (e) { B.errors++; }
  emit("me", B.me);
  settle(); journeyFromMirror();
  emit("pending", pending());
  return B.me;
}

function pending() { const out = {}; for (const [f, p] of Object.entries(B.pend)) out[f] = { value: p.value, state: p.state, ...(p.other ? { other: p.other } : {}), ...(p.error ? { error: p.error } : {}) }; return out; }
function status() { return { via: B.via, base: B.base ? B.base.http : null, key: !!B.key, keyBad: B.keyBad, me: B.me ? { ...B.me } : null, ver: B.ver, pending: pending(), errors: B.errors, polls: B.polls, wsMsgs: B.wsMsgs, sent: B.sent, journeyRefused: B.journeyRefused }; }

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
/* the journey goes the same way; the Worker of 2026-10-28 takes only sign-up changes, so a refusal is remembered for the
   visit and the board keeps the choice in this browser (V13D-NOTES.md has the Worker proposal) */
async function setJourney(j) {
  if (!B.base || !B.key || !JOURNEYS.includes(j) || B.journeyRefused) return { ok: false, refused: B.journeyRefused };
  try {
    const r = await call("POST", "/intent", { kind: "journey", patch: { journey: j } }); B.sent++;
    if (r.status === 400) { B.journeyRefused = true; emit("status", status()); return { ok: false, refused: true }; }
    return { ok: r.status === 200 };
  } catch (e) { B.errors++; return { ok: false }; }
}
function start(handlers) {
  B.h = handlers || {};
  if (B.started) return status();
  B.started = true;
  if (!B.base) { B.via = "off"; emit("status", status()); return status(); }
  B.via = "poll";
  pollOnce();
  openWs();
  if (B.key) me(); else emit("me", null);
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", () => { if (!hidden() && B.via !== "ws") pollOnce(); });
  if (typeof addEventListener === "function") addEventListener("focus", () => { if (B.via !== "ws") pollOnce(); });
  return status();
}
function forget() { store.set("board-key", null); B.key = null; B.me = null; B.keyBad = false; B.pend = {}; emit("me", null); emit("pending", {}); }
window.BoardBrain = Object.freeze({ start, status, setRsvp, setJourney, forget, me, hasKey: () => !!B.key, mine: () => { const e = mine(); return e ? { ...e } : null; }, _state: onState, _poll: pollOnce });
})();
