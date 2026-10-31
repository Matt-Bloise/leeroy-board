(() => {
"use strict";
const WORKER = "https://leeroy-brain.jmattbloise.workers.dev";
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const WHEN = ["6pm", "8pm", "later"], PACK = ["yes", "no"], MEET = ["vos", "xroads", "other"], FIX_PAGE = /^[a-z0-9/_.-]{1,80}$/, FIX_KEY = /^[a-z0-9_.-]{1,80}$/, PLACE_MAX = 40, FIX_NOTE_MAX = 200;
const RSVP = ["in", "maybe", "late", "out"], JOURNEYS = ["guided", "curious", "everything"], LAUNCH = ["queue", "in", "done"];
const PROBE = {
  kind: ["probe"], v: [1, 1],
  engine: ["webkit", "blink", "gecko", "other"],
  platform: ["ios", "android", "windows", "mac", "linux", "other"],
  discordHost: "bool", discordUa: "bool", framed: "bool", standalone: "bool",
  vibrateApi: "bool", vibrateRan: "bool", switchHaptic: "bool",
  buzzRoute: [0, 3], buzzFelt: [0, 3],
  orientationApi: "bool", motionApi: "bool", motionNeedsPermission: "bool", motionPermission: [0, 4],
  orientationCount3s: [0, 5000], motionCount3s: [0, 5000],
  touchPoints: [0, 32], coarsePointer: "bool", hoverNone: "bool", pointerEvents: "bool",
  screenW: [0, 10000], screenH: [0, 10000], viewW: [0, 10000], viewH: [0, 10000], dpr100: [25, 1000], visualViewportApi: "bool",
  safeTop: [0, 400], safeRight: [0, 400], safeBottom: [0, 400], safeLeft: [0, 400],
  reducedMotion: "bool", saveData: "bool", hdrScreen: "bool", wideGamut: "bool", batteryApi: "bool", wakeLock: "bool",
};
const POLL_MS = 15000, PING_MS = 45000, WS_RETRY_MS = 120000, SLOW_MS = 30000;
const SHEET = ["race", "class", "spec_path", "spec_at_40", "professions", "level", "launch_state", "plan_zone", "goals"], SLUGGED = ["race", "class", "spec_path", "spec_at_40", "plan_zone"], SLUG = /^[a-z0-9-]{1,32}$/, GOALS_MAX = 140, PROF_MAX = 2, DISPATCH_MAX = 3;
const B = { vocab: null, sheet: null, party: [], sheetOff: false, key: null, base: null, ver: 0, at: null, signups: null, me: null, keyBad: false, ws: null, via: "off", started: false, pend: {}, h: {}, subs: {}, pollT: 0, pingT: 0, wsT: 0, journeyRefused: false, mirrorJ: undefined, jWant: null, jWantAt: 0, errors: 0, sent: 0, polls: 0, wsMsgs: 0, launch: [], lPend: null, launchRefused: false };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
};
const emit = (n, ...a) => { for (const f of [B.h[n], ...(B.subs[n] || [])]) if (typeof f === "function") { try { f(...a); } catch (e) { console.error("brain", n, e); } } };
function on(n, f) { if (typeof f === "function") (B.subs[n] ||= []).push(f); }

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

function probeOk(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const keys = Object.keys(PROBE);
  if (Object.keys(b).length !== keys.length) return false;
  return keys.every((k) => {
    const spec = PROBE[k], v = b[k];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (spec === "bool") return typeof v === "boolean";
    if (typeof spec[0] === "string") return typeof v === "string" && spec.includes(v);
    return Number.isInteger(v) && v >= spec[0] && v <= spec[1];
  });
}
function sheetVocab(v) {
  const out = {};
  for (const f of [...SLUGGED, "professions"]) { const l = v && v[f]; if (Array.isArray(l) && l.length <= 64 && l.every((x) => typeof x === "string" && SLUG.test(x))) out[f] = Object.freeze(l.slice()); }
  out.levelMax = v && Number.isInteger(v.levelMax) && v.levelMax > 0 && v.levelMax <= 60 ? v.levelMax : 60;
  B.vocab = Object.freeze(out);
  return Object.keys(out).length > 1;
}
const listed = (f, x) => !!(B.vocab && Array.isArray(B.vocab[f]) && B.vocab[f].includes(x));
function sheetValueOk(f, v) {
  if (v === null) return true;
  if (SLUGGED.includes(f)) return typeof v === "string" && SLUG.test(v) && listed(f, v);
  if (f === "professions") return Array.isArray(v) && v.length <= PROF_MAX && new Set(v).size === v.length && v.every((x) => typeof x === "string" && listed("professions", x));
  if (f === "level") return Number.isInteger(v) && v >= 1 && v <= (B.vocab ? B.vocab.levelMax : 60);
  if (f === "launch_state") return LAUNCH.includes(v);
  if (f === "goals") return typeof v === "string" && Array.from(v).length <= GOALS_MAX && !/[<>]|https?:|www\./i.test(v);
  return false;
}
function cleanPlace(raw) {
  const t = String(raw == null ? "" : raw).replace(/<[^>]*>/g, " ").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/[<>*_~`|#\[\]@]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(t).slice(0, PLACE_MAX).join("").trim();
}
const noteOk = (n) => typeof n === "string" && Array.from(n).length <= FIX_NOTE_MAX && !/[<>]|https?:|www\./i.test(n);
function mineOk(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  if (b.kind === "fix") return Object.keys(b).every((k) => k === "kind" || k === "page" || k === "key" || k === "note") && typeof b.page === "string" && FIX_PAGE.test(b.page) && typeof b.key === "string" && FIX_KEY.test(b.key) && (b.note === undefined || noteOk(b.note));
  if (b.kind !== "signup" || !Object.keys(b).every((k) => k === "kind" || k === "field" || k === "value" || k === "place" || k === "ver")) return false;
  if (b.ver !== undefined && !(Number.isInteger(b.ver) && b.ver >= 0)) return false;
  if (b.field === "when") return WHEN.includes(b.value) && b.place === undefined;
  if (b.field === "pack") return PACK.includes(b.value) && b.place === undefined;
  if (b.field === "meet") return MEET.includes(b.value) && (b.place === undefined || (b.value === "other" && typeof b.place === "string" && b.place.length > 0 && b.place === cleanPlace(b.place)));
  return false;
}
function safe(body, route) {
  if (route === "/sheet") {
    const b = body, ok = b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every((k) => k === "field" || k === "value" || k === "visible") && SHEET.includes(b.field)
      && (b.visible === undefined || typeof b.visible === "boolean") && (b.value === undefined || sheetValueOk(b.field, b.value)) && (b.value !== undefined || b.visible !== undefined);
    if (!ok || /\d{17,20}/.test(JSON.stringify(b))) throw new Error("refused: a sheet write carries one field, a value from the board's own lists and the party toggle");
    return body;
  }
  if (body && body.kind === "probe") {
    if (!probeOk(body)) throw new Error("refused: a capability report carries only its fixed yes/no answers and numbers");
    return body;
  }
  if (route === "/dispatch") {
    const b = body, ok = b && typeof b === "object" && Object.keys(b).length === 2 && b.yes === true && Array.isArray(b.ids) && b.ids.length >= 1 && b.ids.length <= DISPATCH_MAX
      && b.ids.every((x) => Number.isInteger(x) && x > 0) && new Set(b.ids).size === b.ids.length;
    if (!ok) throw new Error("refused: a dispatch carries the asker's ask ids and their yes, nothing else");
    return body;
  }
  if (body && body.kind === "ask") {
    const p = body.patch, okAsk = Object.keys(body).every((k) => k === "kind" || k === "patch") && p && typeof p === "object" && typeof p.text === "string" && p.text.length <= 1200
      && Object.keys(p).every((k) => k === "text" || (k === "share" && typeof p.share === "boolean"));
    if (!okAsk || /\d{17,20}/.test(p ? p.text : "")) throw new Error("refused: an ask carries only its text and the share tick");
    return body;
  }
  if (body && body.kind === "refresh") { if (Object.keys(body).length !== 1) throw new Error("refused: a refresh carries nothing but its kind"); return body; }
  if (body && (body.kind === "fix" || (body.kind === "signup" && body.field !== undefined))) {
    if (!mineOk(body) || /\d{17,20}/.test(JSON.stringify(body))) throw new Error("refused: a launch-night answer or a fact report carries only its fixed words, a short place or note");
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
  if (B.key && (route === "/me" || route === "/intent" || route === "/ask" || route === "/probe" || route === "/sheet" || route === "/dispatch")) headers.Authorization = `Board ${B.key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(safe(body, route));
  let r, data = null;
  try { r = await fetch(`${B.base.http}${route}`, { method, headers, body: payload, cache: "no-store", credentials: "omit" }); try { data = await r.json(); } catch (e) {} } catch (e) { B.offline = true; throw new Error("offline"); }
  B.offline = false;
  return { status: r.status, data };
}

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
const launchRow = (r) => r && typeof r.slug === "string" && typeof r.name === "string" && LAUNCH.includes(r.state) && !/\d{17,20}/.test(`${r.slug} ${r.name}`);
function mineLaunch() { const me = B.me; return me ? B.launch.find((r) => r.slug === me.slug) || null : null; }
function settleLaunch() {
  const p = B.lPend, r = mineLaunch(); if (!p || !r || p.state === "sending" || p.state === "failed" || p.state === "local" || p.state === "saved") return;
  if (r.state === p.value && (!p.at || !r.at || Date.parse(r.at) >= Date.parse(p.at) - 1000)) { p.state = "saved"; emit("launchPending", launchPending()); }
}
const partyRow = (r) => r && typeof r.slug === "string" && SLUG.test(r.slug) && typeof r.name === "string" && r.fields && typeof r.fields === "object" && !/\d{17,20}/.test(JSON.stringify(r));
const sheetFields = (f) => { const out = {}; for (const k of SHEET) { const e = f && f[k]; if (e && typeof e === "object" && "value" in e) out[k] = { value: e.value, visible: e.visible !== false, source: typeof e.source === "string" ? e.source : "board", at: e.at || null }; } return out; };
function takeParty(rows) { if (!Array.isArray(rows)) return; B.party = rows.filter(partyRow).map((r) => ({ slug: r.slug, name: r.name, fields: sheetFields(r.fields), updated: r.updated || null })); emit("party", B.party.slice()); }
function onState(m) {
  if (!m || typeof m.ver !== "number" || m.unchanged || m.ver < B.ver || (m.ver === B.ver && B.signups)) return false;
  B.ver = m.ver; B.at = m.at || null;
  takeParty(m.party);
  if (Array.isArray(m.launch)) { B.launch = m.launch.filter(launchRow).map((r) => ({ slug: r.slug, name: r.name, state: r.state, at: r.at || null })); emit("launch", B.launch.slice()); settleLaunch(); }
  if (!m.signups) return false;
  B.signups = m.signups;
  emit("state", m.signups, m.ver);
  setTimeout(mineFlush, 0);
  settle();
  journeyFromMirror();
  return true;
}
function journeyFromMirror() {
  const me = B.me, J = B.signups && B.signups.journeys; if (!me || !Array.isArray(J)) return;
  const row = J.find((j) => j.slug && j.slug === me.slug) || J.find((j) => nameOf(j.name) === nameOf(me.name));
  const v = row && JOURNEYS.includes(row.journey) ? row.journey : null;
  if (B.jWant) { if (v === B.jWant || Date.now() - B.jWantAt > 60000) B.jWant = null; else return; }
  if (v && v !== B.mirrorJ) { B.mirrorJ = v; emit("journey", v); }
}

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
  if (B.via !== "ws") schedulePoll(B.offline ? WS_RETRY_MS : POLL_MS);
}
function openWs() {
  clearTimeout(B.wsT);
  if (!B.base || !B.key || typeof WebSocket !== "function" || B.ws) return false;
  if (B.offline) { B.wsT = setTimeout(openWs, WS_RETRY_MS); return false; }
  let ws; try { ws = new WebSocket(B.base.ws); } catch (e) { return false; }
  B.ws = ws; let opened = false;
  ws.onopen = () => { if (B.ws !== ws) return; opened = true; B.via = "ws"; clearTimeout(B.pollT); clearInterval(B.pingT); B.pingT = setInterval(() => { try { ws.send("ping"); } catch (e) {} }, PING_MS); emit("status", status()); };
  ws.onmessage = (e) => { const d = typeof e.data === "string" ? e.data : ""; if (d === "pong") return; let m; try { m = JSON.parse(d); } catch (er) { return; } B.wsMsgs++; if (m && m.type === "state") onState(m); if (m && m.type === "ask" && B.me && m.slug === B.me.slug) askRead(); };
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
      for (const p of r.data.pending || []) for (const [f, v] of Object.entries(p.patch || {})) { if (f === "rsvp") B.pend.rsvp = { value: v, at: p.at, state: "waiting", seq: p.seq }; if (p.kind === "launch" && f === "state" && LAUNCH.includes(v)) B.lPend = { value: v, at: p.at, state: "waiting", seq: p.seq }; }
    } else if (r.status === 401) { B.me = null; B.keyBad = true; }
  } catch (e) { B.errors++; }
  emit("me", B.me);
  settle(); journeyFromMirror(); settleLaunch();
  emit("pending", pending());
  emit("launchPending", launchPending());
  if (B.me) { askRead(); sheetRead(); } else askEmit();
  return B.me;
}
async function sheetRead() {
  if (!B.base || !B.key || B.sheetOff) return null;
  try {
    const r = await call("GET", "/sheet");
    if (r.status === 200 && r.data && r.data.sheet) { B.sheet = { fields: sheetFields(r.data.sheet.fields), updated: r.data.sheet.updated || null }; takeParty(r.data.party); emit("sheet", sheetCopy()); return sheetCopy(); }
    if (r.status === 404 || r.status === 405) { B.sheetOff = true; emit("sheet", null); }
    else if (r.status === 401) B.keyBad = true;
  } catch (e) { B.errors++; }
  return null;
}
const sheetCopy = () => (B.sheet ? { fields: JSON.parse(JSON.stringify(B.sheet.fields)), updated: B.sheet.updated } : null);
async function setSheet(field, value, visible) {
  const body = { field }; if (value !== undefined) body.value = value; if (visible !== undefined) body.visible = visible;
  try { safe(body, "/sheet"); } catch (e) { return { ok: false, state: "refused", why: "not on the board's lists" }; }
  if (!B.base) return { ok: false, local: true, why: "nowhere to send" };
  if (!B.key || B.keyBad) return { ok: false, local: true, why: B.key ? "key" : "no key" };
  if (B.sheetOff) return { ok: false, local: true, why: "off" };
  try {
    const r = await call("POST", "/sheet", body); B.sent++;
    if (r.status === 200 && r.data && r.data.ok) {
      B.sheet = B.sheet || { fields: {}, updated: null };
      B.sheet.fields[field] = { value: r.data.value === undefined ? null : r.data.value, visible: r.data.visible !== false, source: "board", at: r.data.at || new Date().toISOString() };
      B.sheet.updated = B.sheet.fields[field].at; emit("sheet", sheetCopy());
      return { ok: true, state: "saved", at: B.sheet.fields[field].at };
    }
    if (r.status === 404 || r.status === 405) { B.sheetOff = true; emit("status", status()); return { ok: false, local: true, why: "off" }; }
    if (r.status === 401) { B.keyBad = true; return { ok: false, local: true, why: "key" }; }
    return { ok: false, local: true, why: r.status === 400 ? "refused" : r.status === 429 ? "busy" : "failed" };
  } catch (e) { B.errors++; return { ok: false, local: true, why: "offline" }; }
}
async function dispatch(ids) {
  const body = { ids: Array.isArray(ids) ? ids.slice() : [], yes: true };
  try { safe(body, "/dispatch"); } catch (e) { return { ok: false, why: "refused" }; }
  if (!B.base) return { ok: false, why: "nowhere" };
  if (!B.key || B.keyBad) return { ok: false, why: "no key" };
  try {
    const r = await call("POST", "/dispatch", body); B.sent++;
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, id: r.data.id, at: r.data.at };
    if (r.status === 404 || r.status === 405) return { ok: false, why: "off" };
    if (r.status === 409) return { ok: false, why: r.data && r.data.error === "already_dispatched" ? "already" : "unanswered" };
    if (r.status === 429) return { ok: false, why: "limited", retryAfter: Math.max(1, Number(r.data && r.data.retryAfter) || 3600) };
    if (r.status === 401) { B.keyBad = true; return { ok: false, why: "no key" }; }
    return { ok: false, why: "failed" };
  } catch (e) { B.errors++; return { ok: false, why: "offline" }; }
}

function pending() { const out = {}; for (const [f, p] of Object.entries(B.pend)) out[f] = { value: p.value, state: p.state, ...(p.other ? { other: p.other } : {}), ...(p.error ? { error: p.error } : {}) }; return out; }
function launchPending() { const p = B.lPend; return p ? { value: p.value, state: p.state, ...(p.error ? { error: p.error } : {}) } : null; }
function status() { return { via: B.offline && B.via !== "ws" ? "off" : B.via, offline: !!B.offline, base: B.base ? B.base.http : null, key: !!B.key, keyBad: B.keyBad, me: B.me ? { ...B.me } : null, ver: B.ver, pending: pending(), errors: B.errors, polls: B.polls, wsMsgs: B.wsMsgs, sent: B.sent, journeyRefused: B.journeyRefused, launch: B.launch.length, launchPending: launchPending(), launchRefused: B.launchRefused, sheetOff: B.sheetOff, party: B.party.length }; }

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
const MINE_KEY = "board-mine";
function mineRead() { try { const j = JSON.parse(localStorage.getItem(MINE_KEY) || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch (e) { return {}; } }
function mineWrite(o) { try { if (Object.keys(o).length) localStorage.setItem(MINE_KEY, JSON.stringify(o)); else localStorage.removeItem(MINE_KEY); } catch (e) {} }
function mineKeep(slot, body) { const o = mineRead(); if (slot === "fix") { o.fix = (Array.isArray(o.fix) ? o.fix : []).filter((x) => !(x.page === body.page && x.key === body.key)).concat([body]).slice(-5); } else o[slot] = body; mineWrite(o); }
function mineDrop(slot, body) { const o = mineRead(); if (slot === "fix") { o.fix = (o.fix || []).filter((x) => !(x.page === body.page && x.key === body.key)); if (!o.fix.length) delete o.fix; } else delete o[slot]; mineWrite(o); }
let MINE_NOT_YET = false;
async function mineSend(slot, body) {
  if (!B.base) return { ok: false, why: "nowhere to send" };
  if (!B.key) return { ok: false, why: "no key" };
  try { safe(body, "/intent"); } catch (e) { return { ok: false, why: "not an answer" }; }
  try {
    const r = await call("POST", "/intent", { ...body, ...(slot !== "fix" && B.ver ? { ver: B.ver } : {}) }); B.sent++;
    if (r.status === 200) { mineDrop(slot, body); return { ok: true, state: "waiting" }; }
    if (r.status === 401) { B.keyBad = true; return { ok: false, why: "key" }; }
    if (r.status === 429) return { ok: false, why: "busy" };
    const notYet = r.status === 400 && r.data && typeof r.data.error === "string" && /kind must be|unknown kind|unknown field/i.test(r.data.error);
    if (r.status === 404 || r.status === 405 || r.status === 501 || notYet) { mineKeep(slot, body); MINE_NOT_YET = true; return { ok: false, why: "not-yet" }; }
    if (r.status >= 400 && r.status < 500) { mineDrop(slot, body); return { ok: false, why: "refused" }; }
    return { ok: false, why: "failed" };
  } catch (e) { B.errors++; return { ok: false, why: "offline" }; }
}
const setWhen = (k) => mineSend("when", { kind: "signup", field: "when", value: k });
const setPack = (k) => mineSend("pack", { kind: "signup", field: "pack", value: k });
function setMeet(k, place) {
  const clean = k === "other" && place !== undefined ? cleanPlace(place) : undefined;
  return mineSend("meet", { kind: "signup", field: "meet", value: k, ...(clean ? { place: clean } : {}) });
}
const reportFact = (o) => mineSend("fix", { kind: "fix", page: o && o.page, key: o && o.key, ...(o && o.note ? { note: String(o.note) } : {}) });
async function refreshLibrary() {
  if (!B.base || !B.key) return { ok: false, why: B.key ? "nowhere to send" : "no key" };
  try { const r = await call("POST", "/intent", { kind: "refresh" }); B.sent++; if (r.status === 401) B.keyBad = true; return { ok: r.status === 200, status: r.status, data: r.data }; } catch (e) { B.errors++; return { ok: false, why: "offline" }; }
}
let mineFlushing = false;
async function mineFlush() {
  if (mineFlushing || MINE_NOT_YET || !B.base || !B.key) return; const o = mineRead(); if (!Object.keys(o).length) return;
  mineFlushing = true;
  try { for (const s of ["when", "pack", "meet"]) if (o[s]) { const r = await mineSend(s, o[s]); if (!r.ok) break; } for (const f of (o.fix || [])) { const r = await mineSend("fix", f); if (!r.ok) break; } } finally { mineFlushing = false; }
}
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
async function sendProbe(report) {
  if (!probeOk(report)) return { ok: false, local: true, why: "shape" };
  if (!B.base) return { ok: false, local: true, why: "nowhere" };
  try {
    const r = await call("POST", "/probe", report); B.sent++;
    if (r.status === 200) return { ok: true };
    return { ok: false, local: true, why: r.status === 404 ? "route" : r.status === 429 ? "busy" : "refused", status: r.status };
  } catch (e) { B.errors++; return { ok: false, local: true, why: "offline" }; }
}
function start(handlers) {
  B.h = handlers || {};
  if (B.started) return status();
  B.started = true;
  if (!B.base) { B.via = "off"; emit("status", status()); return status(); }
  B.via = "poll";
  pollOnce();
  if (B.key) openWs();
  if (B.key) me(); else emit("me", null);
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", () => { if (!hidden() && B.via !== "ws") pollOnce(); });
  if (typeof addEventListener === "function") addEventListener("focus", () => { if (B.via !== "ws") pollOnce(); });
  return status();
}
function forget() { clearTimeout(B.wsT); if (B.ws) { const w = B.ws; B.ws = null; clearInterval(B.pingT); try { w.close(); } catch (e) {} B.via = "poll"; schedulePoll(0); } store.set("board-key", null); B.key = null; B.me = null; B.keyBad = false; B.pend = {}; B.lPend = null; B.launchRefused = false; B.sheet = null; B.sheetOff = false; clearTimeout(AK.t); AK.st = "idle"; AK.ask = null; AK.err = ""; AK.since = 0; emit("me", null); emit("pending", {}); emit("launchPending", null); askEmit(); }
window.BoardBrain = Object.freeze({ start, on, status, setRsvp, setJourney, setLaunch, setWhen, setPack, setMeet, reportFact, refreshLibrary, cleanPlace, mineLocal: mineRead, sendProbe, _probeShape: PROBE, ask, askStatus, askRead, onAsk: (f) => { if (typeof f === "function") AK.h.push(f); }, forget, me, hasKey: () => !!B.key, mine: () => { const e = mine(); return e ? { ...e } : null; }, launch: () => B.launch.map((r) => ({ ...r })), mineLaunch: () => { const r = mineLaunch(); return r ? { ...r } : null; }, launchPending, sheetVocab, sheetRead, setSheet, sheet: sheetCopy, party: () => JSON.parse(JSON.stringify(B.party)), dispatch, _state: onState, _poll: pollOnce });
})();
