/* The Leeroy audience chamber and Dispatch (notes/VISION-PARTY-SHEET.md 5.4; 2026-10-30). On the Leeroy scene, starting a talk
   spins the coin and turns the panel into a chamber: Leeroy's portrait slides down from the top left, the asker's portrait rises
   from the bottom right (their race and class, ringed in their class colour, their display name on a brass plate), his answer
   types out with a Skip, sources end it as numbered footnotes, and two or three follow-ups come from the library's own ranking
   (vendor/rank-core.js over the library index). His moods: thinking while an ask waits on him (he is checking a live source),
   sheepish when it failed or his answer corrects itself, delighted at a long question or an answer with two or more sources,
   smug otherwise. Sound only when it is on; reduced motion: no slides, no typing.
   Companion N6 (notes/companion/COMPANION-CONTRACT.md 6): the chamber is a conversation that remembers. Every turn (the asker's
   question, Leeroy's answer) is kept on this device only, per board key (localStorage board-chat: { key: 16 hex of the key's
   sha-256, turns: the last 20, 7 days }), cleared by Clear my name or a different key. The composer (#ch-form) sits at the
   panel's bottom with suggested questions from the next step, its trails and the library's examples; it asks through the same
   BoardBrain.ask as the ask box (one open ask at a time, six an hour), and an answer arrives pushed over the socket. "Bring this
   to the party" picks up to three answered turns for one Dispatch card, posted only on the asker's tap (BoardBrain.dispatch,
   POST /api/dispatch); a Worker without the route says the owner has not switched it on. Nothing else here ever posts.
   The owner's painted art (img/chamber, img/marks; board/img/chamber/CREDITS.md, original, no game assets) is the whole look of it:
   Leeroy's four moods, the five's race and class, a hooded visitor, the tavern alcove behind, the Dispatch seal. The images load
   only when the chamber opens, and a mood swaps only once its image is decoded; a picture that does not load leaves its brass
   name plate standing alone. Fake-DOM safe. */
(() => {
"use strict";
const K = window.__boardKit, B = window.BoardBrain; if (!K || !B || !B.onAsk || window.__chamber) return; /* built once, however often it runs */
const { $, h, D, MEM } = K;
const panel = $("#panel-librarian"), box = $("#ask-box"); if (!panel || !box) return;
const CH = { on: false, typed: {}, seen: {}, typing: null, mood: "smug", letter: false, follow: {}, cur: null, turns: [], kh: null, picked: [], pending: null, autoOpen: false, ended: false, refocus: false, sig: null, chips: "" };
const MAX = 280, MIN = 3, KEEP = 20, WEEK = 7 * 864e5, DISPATCH_MAX = 3, STORE = "board-chat";
const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
const snd = (n, o) => { try { if (window.BoardSound) return window.BoardSound.play(n, o); } catch (e) {} return false; };
const buzz = (n) => { try { if (window.BoardHaptics && window.BoardHaptics.fire) window.BoardHaptics.fire(n); } catch (e) {} };
const coarse = () => { try { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) { return false; } };
const liveOk = (st) => !!(st && st.base && st.key && !st.keyBad);
const busyOk = (st) => !!st && (st.state === "sending" || st.state === "queued");
/* the painted portraits that exist: Leeroy's moods and the five's race and class (anyone else is the hooded visitor) */
const MOODS = ["smug", "delighted", "sheepish", "thinking"], ASK_ART = ["undead-mage", "undead-paladin", "undead-priest", "troll-warlock", "tauren-druid"];
const ART = {};
function artLoad(url) {
  if (ART[url]) return ART[url];
  if (typeof Image !== "function") return (ART[url] = Promise.resolve(true));
  const im = new Image(); im.decoding = "async";
  const loaded = new Promise((r, j) => { im.onload = r; im.onerror = j; });
  im.src = url;
  return (ART[url] = (typeof im.decode === "function" ? im.decode() : loaded).then(() => true, () => false));
}
const moodUrl = (m) => `img/chamber/leeroy-${m}.webp`;
/* what each of Leeroy's four faces looks like, for a screen reader (the brass plate under it already says whose face it is) */
const MOOD_ALT = { smug: "Leeroy, a grinning paladin in battered plate, pleased with himself", delighted: "Leeroy laughing out loud", sheepish: "Leeroy wincing with a crooked smile, a little sheepish", thinking: "Leeroy with a gauntlet to his chin, thinking it over" };
/* a painted portrait in its round frame; the picture is the only art, so one that does not load leaves the plate alone */
function artImg(cls, url, alt) {
  const i = h("img", { class: cls, alt: alt || "", width: 240, height: 240, loading: "lazy", decoding: "async" });
  i.addEventListener("error", () => { const f = i.closest ? i.closest("figure") : null; if (f) f.classList.remove("has-art"); });
  if (url) i.setAttribute("src", url);
  return i;
}

/* ---------- who is asking ---------- */
function asker() {
  const st = B.status(), me = st && st.me, ms = D.party ? D.party.members : [];
  const m = (me && ms.find((x) => K.cleanName(x.name).toLowerCase() === K.cleanName(me.name).toLowerCase())) || MEM.member();
  return { m: m || null, name: me && me.name ? K.cleanName(me.name) : m ? m.name : "You" };
}

/* ---------- the talk, kept on this device per board key (never sent anywhere) ---------- */
const file = { get: () => { try { return localStorage.getItem(STORE); } catch (e) { return null; } }, set: (v) => { try { if (v === null) localStorage.removeItem(STORE); else localStorage.setItem(STORE, v); } catch (e) {} } };
/* 16 hex of the sha-256 of this board's key, "none" without one; where crypto.subtle is absent (the fake DOM) "fake" */
function keyHash() {
  let k = null; try { k = B.hasKey && B.hasKey() ? localStorage.getItem("board-key") : null; } catch (e) { k = null; }
  if (!k) return Promise.resolve("none");
  const sub = typeof crypto !== "undefined" && crypto ? crypto.subtle : null;
  if (!sub || typeof sub.digest !== "function" || typeof TextEncoder !== "function") return Promise.resolve("fake");
  return Promise.resolve().then(() => sub.digest("SHA-256", new TextEncoder().encode(k))).then((buf) => Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(""), () => "fake");
}
const fresh = (at) => { const t = Date.parse(at); return Number.isFinite(t) && Date.now() - t < WEEK; };
const turnOf = (t) => ({ id: t.id, text: String(t.text), answer: typeof t.answer === "string" && t.answer ? t.answer : null, sources: Array.isArray(t.sources) ? t.sources.map(String).slice(0, 8) : [], at: t.at, answeredAt: typeof t.answeredAt === "string" ? t.answeredAt : null, dispatched: t.dispatched ? String(t.dispatched) : null });
const byTime = (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id;
function save() {
  if (!CH.kh) return;
  CH.turns = CH.turns.slice(-KEEP);
  file.set(CH.turns.length ? JSON.stringify({ key: CH.kh, turns: CH.turns }) : null);
}
/* the file for this key (a different key's turns are dropped), merged with anything this page already holds */
function adopt(kh) {
  CH.kh = kh;
  let f = null; try { f = JSON.parse(file.get() || "null"); } catch (e) { f = null; }
  const kept = f && f.key === kh && Array.isArray(f.turns) ? f.turns.filter((t) => t && Number.isInteger(t.id) && typeof t.text === "string" && fresh(t.at)).map(turnOf) : [];
  for (const t of kept) if (!CH.turns.some((x) => x.id === t.id)) { CH.turns.push(t); if (t.answer) CH.typed[t.id] = true; }
  CH.turns.sort(byTime);
  if (f || CH.turns.length) save();
}
/* the one live ask (BoardBrain.askStatus().ask) joins the log: the same id updates its turn, a new id is a new turn */
function merge(st) {
  const a = st && st.ask; if (!a || !Number.isInteger(a.id) || !fresh(a.at)) return;
  let t = CH.turns.find((x) => x.id === a.id), changed = false;
  if (!t) { t = turnOf({ id: a.id, text: a.text || "", at: a.at }); CH.turns.push(t); CH.turns.sort(byTime); changed = true; }
  if (a.status === "queued") CH.seen[a.id] = true; /* seen waiting on this page: its answer types out when it lands */
  if (a.status === "answered" && a.answer && t.answer !== a.answer) { t.answer = a.answer; t.sources = (a.sources || []).map(String); t.answeredAt = a.answeredAt || null; changed = true; }
  if (a.dispatchedAt && !t.dispatched) { t.dispatched = String(a.dispatchedAt); changed = true; }
  if (changed) save();
}

/* ---------- the chamber's markup, built once ---------- */
const start = h("button", { type: "button", class: "lib-tool ch-start", id: "ch-start", hidden: true, onclick: () => open(true) }, "Sit down with Leeroy");
const head = box.querySelector(".ask-h"); box.insertBefore(start, head ? head.nextSibling : box.firstChild);
const leeImg = artImg("ch-art ch-art-lee", null, MOOD_ALT.smug);
const lee = h("figure", { class: "ch-lee has-art", "data-mood": "smug" }, h("span", { class: "ch-frame" }, leeImg), h("figcaption", { class: "ch-plate", text: "Leeroy" }));
const you = h("figure", { class: "ch-you has-art" }, h("span", { class: "ch-frame ch-silbox" }), h("figcaption", { class: "ch-plate ch-plate-you" }));
const log = h("div", { class: "ch-log", id: "ch-log" });
const live = h("p", { class: "sr-only", id: "ch-live", role: "status", "aria-live": "polite" });
const skip = h("button", { type: "button", class: "lib-tool ch-skip", hidden: true, onclick: () => finishTyping() }, "Skip");
const next = h("div", { class: "ch-next", id: "ch-next", hidden: true });
const bring = h("button", { type: "button", class: "lib-tool ch-bring", id: "ch-bring", hidden: true, onclick: () => letter(true) }, "Bring this to the party");
const leave = h("button", { type: "button", class: "lib-tool ch-leave", onclick: () => close(true) }, "End the talk");
const sheet = h("section", { class: "ch-letter", id: "ch-letter", hidden: true, "aria-labelledby": "ch-letter-h" });
const room = h("section", { class: "chamber", id: "chamber", hidden: true, "aria-label": "Talking with Leeroy", "data-state": "idle" },
  h("div", { class: "ch-stage" }, lee, log, you), skip, live, next, h("div", { class: "ch-end" }, bring, leave), sheet);
panel.insertBefore(room, box);
/* the composer: at the panel's bottom, sticky, outside the chamber so it also asks while the chamber is shut */
const input = h("input", { type: "text", id: "ch-text", class: "ch-text", maxlength: MAX, enterkeyhint: "send", autocomplete: "off", spellcheck: "true", "aria-describedby": "ch-say ch-note" });
const sendBtn = h("button", { type: "submit", class: "lib-tool ch-send", id: "ch-send" }, "Send");
const shareBox = h("input", { type: "checkbox", id: "ch-share-box" });
const sug = h("div", { class: "ch-sug", id: "ch-sug", role: "group", "aria-label": "Questions to start from", hidden: true });
const left = h("span", { class: "ch-left", id: "ch-left", hidden: true });
const sayEl = h("p", { class: "ch-say", id: "ch-say", role: "status", "aria-live": "polite" });
const note = h("p", { class: "ch-nokey", id: "ch-note", hidden: true });
const form = h("form", { class: "ch-form", id: "ch-form", novalidate: true, "aria-label": "Ask Leeroy" },
  h("div", { class: "ch-sugrow" }, sug, left),
  h("label", { class: "sr-only", for: "ch-text", text: "Your question for Leeroy" }),
  h("div", { class: "ch-row" }, input, sendBtn),
  h("div", { class: "ch-row ch-row2" }, h("label", { class: "ch-share", id: "ch-share", for: "ch-share-box" }, shareBox, h("span", { text: " also share in Discord" })), sayEl),
  note);
panel.append(form);
panel.classList.add("ch-chat");

/* ---------- moods ---------- */
const CORRECTED = /\b(correction|i was wrong|my mistake|scratch that|to correct (that|myself)|i had that wrong)\b/i;
function moodFor(st) {
  const a = st.ask;
  if (st.state === "sending" || st.state === "queued") return "thinking";
  if (st.state === "failed" || st.state === "error" || st.state === "limited") return "sheepish";
  if (st.state === "answered" && a) {
    if (CORRECTED.test(a.answer || "")) return "sheepish";
    if ((a.sources || []).length >= 2 || (/\?\s*$/.test(a.text || "") && String(a.text || "").split(/\s+/).length >= 8)) return "delighted";
  }
  return "smug";
}
/* the painted face changes with the mood once its image is decoded; its alt text says which face it is */
function setMood(m) {
  if (!(CH.mood === m && lee.dataset.mood === m)) { CH.mood = m; lee.dataset.mood = m; room.dataset.mood = m; }
  const url = moodUrl(m); if (leeImg.getAttribute("src") === url) return;
  artLoad(url).then((good) => { if (good && CH.mood === m) { leeImg.setAttribute("src", url); leeImg.setAttribute("alt", MOOD_ALT[m] || ""); } });
}

/* ---------- the talk ---------- */
const bubble = (who, cls, ...kids) => h("div", { class: `ch-b ${cls}` }, h("p", { class: "ch-who", text: who }), ...kids);
const line = (t) => h("p", { class: "ch-t", text: t });
const LINES = {
  idle: "Pull up a stool. Ask me anything about Forever; I answer from the same library this board searches.",
  guided: "Ask what to do next; Leeroy answers in a few plain sentences.",
  queued: "Checking the library and the live sources. One moment.",
  failed: "I did not get to that one in time. Sending it again is fine.",
  gone: "No answer came back for this one. Sending it again is fine.",
  error: "I cannot hear the board just now. Your question is still in the box.",
  limited: "That is six questions in the last hour. I open up again soon.",
};
const WAIT = "Leeroy is checking the library (about 20 to 40 seconds).";
const waitEl = () => bubble("Leeroy", "ch-a ch-wait", line(LINES.queued), h("p", { class: "ch-eta", text: WAIT }), h("span", { class: "ch-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
const askEl = (who, text) => bubble(who.name, "ch-q", line(text));
function paint(st) {
  CH.cur = st;
  const live0 = liveOk(st);
  merge(st);
  compose(st);
  start.hidden = !live0 || CH.on;
  if (!live0 && CH.on) close(false);
  if (!CH.on && live0 && (st.state === "sending" || (st.state === "queued" && CH.autoOpen))) { open(false); return; }
  room.dataset.state = st.state;
  if (CH.on) setMood(moodFor(st));
  if (busyOk(st)) closeLetter();
  draw(st);
}
/* the log: every turn oldest first, the live ask's wait or failure on its own turn, a refusal as the last word */
function draw(st) {
  const a = st.ask, liveId = a && Number.isInteger(a.id) ? a.id : null;
  const sig = [CH.turns.map((t) => `${t.id}.${t.answer ? 1 : 0}.${t.dispatched ? 1 : 0}`).join(","), st.state, liveId, a ? a.status : "", CH.pending || "", K.JR ? K.JR() : "", CH.on].join("|");
  if (sig === CH.sig) { bringPaint(); return; }
  CH.sig = sig;
  if (CH.typing) { const T = CH.typing; T.stop = true; clearTimeout(T.tm); CH.typing = null; CH.typed[T.turn.id] = true; skip.hidden = true; }
  const who = asker(), kids = [];
  let fresh0 = null;
  for (const t of CH.turns) {
    kids.push(askEl(who, t.text));
    if (t.answer) { const el = answerEl(t); kids.push(el); if (t.id === liveId && st.state === "answered" && CH.seen[t.id] && !CH.typed[t.id]) fresh0 = [t, el]; }
    else if (t.id === liveId && st.state === "queued") kids.push(waitEl());
    else if (t.id === liveId && st.state === "failed") kids.push(bubble("Leeroy", "ch-a", line(LINES.failed)));
    else kids.push(bubble("Leeroy", "ch-a ch-gone", line(LINES.gone)));
  }
  if (st.state === "sending") { if (CH.pending) kids.push(askEl(who, CH.pending)); kids.push(waitEl()); }
  if (st.state === "error" || st.state === "limited") kids.push(bubble("Leeroy", "ch-a", line(LINES[st.state])));
  if (!kids.length) kids.push(bubble("Leeroy", "ch-a", line(K.JR && K.JR() === "guided" ? LINES.guided : LINES.idle)));
  log.replaceChildren(...kids);
  next.hidden = true;
  /* the newest word comes into view only when the talk grew (not on a redraw for a dispatch mark, which would hide the letter) */
  const grew = kids.length > (CH.kids || 0); CH.kids = kids.length;
  if (CH.on && grew && kids.length > 1) { try { kids[kids.length - 1].scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }); } catch (e) {} }
  if (fresh0) {
    live.textContent = `Leeroy answered: ${fresh0[0].answer}`;
    if (!CH.on) { bringPaint(); return; } /* it types out when the chamber opens */
    if (!reduced()) { typeOut(fresh0[0], fresh0[1]); bringPaint(); return; }
    CH.typed[fresh0[0].id] = true;
  } else live.textContent = busyOk(st) ? WAIT : "";
  settle();
}
function answerEl(t) {
  const paras = String(t.answer).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const notes = t.sources.length ? h("ol", { class: "ch-notes", "aria-label": "Sources" }, t.sources.map((src, i) => h("li", { class: "ch-note" }, h("span", { class: "ch-seal", "aria-hidden": "true", text: String(i + 1) }), h("span", { text: src })))) : null;
  return bubble("Leeroy", "ch-a ch-done", h("div", { class: "ch-paras" }, paras.map((p) => h("p", { class: "ch-t", "data-full": p, text: p }))), notes, t.dispatched ? h("p", { class: "ch-sent", text: "Sent to the party" }) : null);
}
/* the answer types out, a few characters a frame; Skip, a new state or reduced motion shows it whole */
function typeOut(t, el) {
  const ps = [...el.querySelectorAll(".ch-t")], notes = el.querySelector(".ch-notes"), paras = el.querySelector(".ch-paras");
  if (!ps.length) { CH.typed[t.id] = true; settle(); return; }
  for (const p of ps) p.textContent = "";
  if (notes) notes.hidden = true;
  if (paras) paras.setAttribute("aria-hidden", "true"); /* #ch-live already said it whole */
  skip.hidden = false;
  let i = 0, n = 0; const T = { turn: t, el, stop: false };
  CH.typing = T;
  snd("quill", { rate: 1.6, db: -32 });
  const step = () => {
    if (T.stop || CH.typing !== T) return;
    const p = ps[i], full = p.dataset.full; n = Math.min(full.length, n + 3); p.textContent = full.slice(0, n);
    if (n >= full.length) { i++; n = 0; if (i < ps.length) snd("quill", { rate: 1.4 + Math.random() * 0.4, db: -32 }); }
    if (i >= ps.length) { finishTyping(); return; }
    T.tm = setTimeout(step, 18);
  };
  T.tm = setTimeout(step, 120);
}
function finishTyping() {
  const T = CH.typing; if (!T) return;
  T.stop = true; clearTimeout(T.tm); CH.typing = null;
  for (const p of T.el.querySelectorAll(".ch-t")) if (p.dataset.full) p.textContent = p.dataset.full;
  const notes = T.el.querySelector(".ch-notes"); if (notes) notes.hidden = false;
  const paras = T.el.querySelector(".ch-paras"); if (paras) paras.removeAttribute("aria-hidden");
  skip.hidden = true; CH.typed[T.turn.id] = true; settle();
}
/* once nothing is typing: Bring this to the party, and follow-ups for the last answer */
function settle() {
  bringPaint();
  const ans = CH.turns.filter((t) => t.answer);
  if (ans.length && CH.on && !busyOk(CH.cur)) follow(ans[ans.length - 1]);
}
function bringPaint() {
  const ans = CH.turns.filter((t) => t.answer), open0 = ans.filter((t) => !t.dispatched);
  bring.hidden = !ans.length || !!CH.typing;
  bring.textContent = open0.length ? "Bring this to the party" : "Sent to the party";
  bring.setAttribute("aria-disabled", String(!open0.length));
}

/* ---------- the composer ---------- */
const ERR = { offline: "The board could not reach Leeroy just now. Your question is still in the box.", busy: "The brain is busy right now. Your question is still in the box.", refused: `That could not be sent. After links and odd characters are removed it needs ${MIN} to ${MAX} characters.` };
const noteText = () => { const n = $("#ask-note"); return (n && n.textContent.replace(/\s+/g, " ").trim()) || "Asking from the board works with your own board link (My board link on the Sign-ups card). Without one, /ask in #wow-forever reaches the same Leeroy."; };
const minutes = (s) => { const m = Math.max(1, Math.ceil((Number(s) || 3600) / 60)); return `${m} minute${m === 1 ? "" : "s"}`; };
function refusal(r, st) {
  const why = r && r.why;
  if (why === "limited" || st.state === "limited") return `That is six questions in the last hour. Leeroy opens up again in about ${minutes(st.retryAfter || (r && r.retryAfter))}.`;
  if (why === "short") return `A question needs at least ${MIN} characters.`;
  if (why === "long") return `That is over the ${MAX} character limit.`;
  if (why === "open" || (why === "busy" && st.state !== "error")) return "One question at a time: Leeroy is still on the last one.";
  if (why === "no key" || why === "nowhere" || why === "key") return noteText();
  return ERR[why] || ERR[st.error] || ERR.busy;
}
function say(t) { if (sayEl.textContent !== t) sayEl.textContent = t; }
function compose(st) {
  const live0 = liveOk(st), busy = busyOk(st);
  note.hidden = live0; if (!live0) note.textContent = noteText();
  input.disabled = !live0 || busy; sendBtn.disabled = !live0 || busy; shareBox.disabled = !live0 || busy;
  sendBtn.textContent = st.state === "sending" ? "Sending" : "Send";
  form.setAttribute("aria-busy", String(busy));
  const n = typeof st.left === "number" ? st.left : null;
  left.hidden = !(live0 && n !== null && n < 3); left.textContent = n === null ? "" : `${n} left this hour`;
  chipsPaint(live0 && !busy);
  if (!live0 && sayEl.textContent) say("");
  /* back to the box once the answer is in, where a focus opens no on-screen keyboard over the answer (fine pointers only) */
  if (CH.refocus && !input.disabled) { CH.refocus = false; if (!coarse()) { try { input.focus({ preventScroll: true }); } catch (e) {} } }
}
async function ask(e) {
  if (e && e.preventDefault) e.preventDefault();
  const st = B.askStatus(); if (!liveOk(st) || busyOk(st)) return null;
  const t = String(input.value || "").replace(/\s+/g, " ").trim(), n = Array.from(t).length;
  if (n < MIN) { say(`A question needs at least ${MIN} characters.`); return null; }
  if (n > MAX) { say(`That is ${n - MAX} over the ${MAX} character limit.`); return null; }
  CH.pending = t; CH.autoOpen = true; CH.refocus = document.activeElement === input; say("");
  const r = await B.ask(t, shareBox.checked === true);
  CH.pending = null;
  if (r && r.ok) { input.value = ""; shareBox.checked = false; snd("chip"); }
  else { CH.autoOpen = false; say(refusal(r, B.askStatus())); }
  draw(B.askStatus());
  return r;
}
form.addEventListener("submit", ask);
/* a press on Send, a chip or the share tick keeps the focus in the box (and a phone's keyboard up): on phones a blur brings the shell's
   bar back (board.css hides it while a field has focus), which moves the composer between press and release, and the tap would land
   on the form instead of the button (measured: Send 52 px higher at mouseup, no submit) */
const keepFocus = (el) => el.addEventListener("mousedown", (e) => { if (e && e.preventDefault && document.activeElement === input) e.preventDefault(); });
for (const el of [sendBtn, sug, form.querySelector(".ch-share")]) if (el) keepFocus(el);

/* ---------- suggested questions: the next step, a trail from it, a library example ---------- */
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const plain = (s) => String(s || "").replace(/\s+/g, " ").trim();
function engineOut() {
  try {
    const R = window.__nextRules, N = window.__next;
    if (R && typeof R.nextSteps === "function" && N && typeof N.input === "function") { const inp = N.input(); if (inp && typeof inp.then !== "function") return R.nextSteps(inp, Date.now()); }
  } catch (e) {}
  return null;
}
function stepQ(out) {
  let title = out && out.step && !/^(rest|pick-name)$/.test(out.step.id) ? out.step.title : "";
  if (!title && !out) { let id = null; try { id = window.__next && window.__next.status ? window.__next.status().stepId : null; } catch (e) { id = null; } const t = $("#nx-t"); if (t && !/^(rest|pick-name)$/.test(String(id))) title = t.textContent; }
  title = plain(title).replace(/[.!?:]+$/, "");
  return title ? `What do I do about ${lowerFirst(title)}?` : "";
}
function trailQ(out) {
  const learn = out && out.queue ? out.queue.find((s) => s.id === "learn-role") : null, a = $("#nx-trails a");
  const t = plain(learn ? learn.title : a ? a.textContent : "").replace(/:\s*\d+\s+minutes?$/i, "").replace(/[.!?]+$/, "");
  if (!t) return "";
  const m = /^What (an?|the) (.+?) does\b(.*)$/i.exec(t);
  return m ? `What does ${m[1].toLowerCase()} ${m[2]} do${m[3]}?` : `What does the library say about ${lowerFirst(t.split(":")[0])}?`;
}
function exampleQ() {
  const ex = [...document.querySelectorAll("#lib-examples button")].map((b) => plain(b.textContent)).filter(Boolean);
  if (!ex.length) return "";
  const x = ex[CH.turns.length % ex.length].replace(/[.!?]+$/, "");
  return /^(what|when|where|who|how|which|why|do|does|is|are|can)\b/i.test(x) ? `${x.charAt(0).toUpperCase()}${x.slice(1)}?` : `What does the library say about ${x}?`;
}
function chipQs() {
  const out = engineOut(), step = stepQ(out), trail = trailQ(out), ex = exampleQ(), list = [];
  for (const q of K.JR && K.JR() === "guided" ? [step, trail, ex] : [trail, ex, step]) if (q && list.length < 3 && !list.includes(q) && Array.from(q).length <= MAX) list.push(q);
  return list;
}
function chipsPaint(on) {
  const list = on ? chipQs() : [], key = list.join("\n");
  sug.hidden = !list.length;
  if (key === CH.chips) return;
  CH.chips = key;
  sug.replaceChildren(...list.map((q) => h("button", { type: "button", class: "lib-tool ch-chip", onclick: () => { input.value = q; try { input.dispatchEvent(new Event("input")); } catch (e) {} try { input.focus(); } catch (e) {} snd("chip"); } }, q)));
}

/* ---------- follow-ups from the library's own ranking ---------- */
async function follow(t) {
  const key = `${t.id}`;
  if (!CH.follow[key]) CH.follow[key] = (async () => {
    if (!K.libCore || !K.libIndex) return [];
    const [core, ix] = await Promise.all([K.libCore(), K.libIndex().catch(() => null)]);
    if (!core || !ix || !Array.isArray(ix.pages)) return [];
    const pages = ix.pages.map((p) => ({ id: p.id, title: p.title, category: p.category, aliases: p.aliases || [], facts: [{ key: "title", value: p.title }, { key: "about", value: p.blurb || "" }], open: [] }));
    const seen = new Set(), out = [];
    for (const x of core.rank(t.text || "", pages).hits) { if (seen.has(x.page)) continue; seen.add(x.page); out.push({ id: x.page, title: x.p.title }); if (out.length === 3) break; }
    return out;
  })().catch(() => []);
  const list = await CH.follow[key];
  const ans = CH.turns.filter((x) => x.answer);
  if (!CH.on || CH.typing || busyOk(CH.cur) || !ans.length || ans[ans.length - 1].id !== t.id) return;
  if (!list.length) { next.hidden = true; return; }
  next.replaceChildren(h("h4", { class: "ch-next-h", text: "Ask next" }), h("ul", { class: "ch-next-l" }, list.map((x) => h("li", {},
    h("button", { type: "button", class: "lib-tool ch-ask", onclick: () => { if (!input.disabled) { input.value = `What else does the library say about ${x.title}?`; try { input.dispatchEvent(new Event("input")); } catch (e) {} try { input.focus(); } catch (e) {} } snd("chip"); } }, `More on ${x.title}`),
    h("a", { class: "tn-link ch-page", href: `#library.${String(x.id).replace("/", ".")}`, text: "the page" })))));
  next.hidden = false;
}

/* ---------- Dispatch: pick up to three answered turns, preview the card, post only on the asker's tap ---------- */
const DSAY = {
  ok: "Sent. Leeroy posts it in #wow-forever as one card. He delivers it within a minute; the rest of this talk stays here.",
  off: "The owner has not switched Dispatch on yet, so nothing was posted. The answer stays here.",
  already: "This one already went to the party.",
  unanswered: "Only an answered question can go to the party.",
  limited: "That is five dispatches today, so nothing was posted.",
  "no key": "Dispatch needs your own board link (My board link on the Sign-ups card). Nothing was posted.",
  offline: "The board could not reach Leeroy just now. Nothing was posted.",
  failed: "That did not go through. Nothing was posted.",
  none: "Nothing is ticked, so nothing was posted.",
  three: "Three at a time.",
};
const hours = (s) => { const n = Math.max(1, Math.round((Number(s) || 86400) / 3600)); return `${n} hour${n === 1 ? "" : "s"}`; };
const LT = { card: null, post: null, boxes: [] };
function letter(user) {
  const ans = CH.turns.filter((t) => t.answer), open0 = ans.filter((t) => !t.dispatched); if (!ans.length) return;
  if (!open0.length) { lsay(DSAY.already); return; }
  CH.picked = CH.picked.filter((id) => open0.some((t) => t.id === id));
  if (!CH.picked.length) CH.picked = [open0[open0.length - 1].id];
  LT.boxes = open0.map((t) => {
    const cb = h("input", { type: "checkbox", id: `ch-pick-${t.id}`, class: "ch-pick-box" });
    cb.checked = CH.picked.includes(t.id);
    cb.addEventListener("change", () => tick(t.id, cb));
    return cb;
  });
  const pick = h("fieldset", { class: "ch-pick", id: "ch-pick" }, h("legend", { class: "ch-pick-h", text: "On the card, up to three" }),
    ...open0.map((t, i) => h("label", { class: "ch-pick-row", for: `ch-pick-${t.id}` }, LT.boxes[i], h("span", { class: "ch-pick-q", text: t.text }))));
  LT.card = h("div", { class: "ch-card", "data-who": asker().name });
  LT.post = h("button", { type: "button", class: "lib-tool ch-post", id: "ch-post", onclick: () => send() }, "Post it to #wow-forever");
  const no = h("button", { type: "button", class: "lib-tool ch-no", onclick: () => { closeLetter(); try { bring.focus(); } catch (e) {} } }, "Not now");
  sheet.replaceChildren(
    h("h4", { class: "ch-letter-h", id: "ch-letter-h", text: "The Dispatch card" }), pick, LT.card,
    h("p", { class: "ch-letter-note", text: "Nothing posts until you tap Post. The back-and-forth never posts; only this card, once." }),
    h("div", { class: "ch-letter-row" }, LT.post, no),
    h("p", { class: "ch-letter-say", id: "ch-letter-say", role: "status", "aria-live": "polite" }));
  drawCard();
  sheet.hidden = false; CH.letter = true; snd("unfurl");
  if (user) { try { LT.post.focus(); } catch (e) {} }
}
/* a fourth tick is refused; the card redraws from the ticked turns, oldest first */
function tick(id, cb) {
  if (cb.checked && !CH.picked.includes(id)) {
    if (CH.picked.length >= DISPATCH_MAX) { cb.checked = false; lsay(DSAY.three); return; }
    CH.picked.push(id);
  } else if (!cb.checked) CH.picked = CH.picked.filter((x) => x !== id);
  lsay(""); drawCard();
}
function drawCard() {
  if (!LT.card) return;
  const who = asker(), turns = CH.turns.filter((t) => t.answer && CH.picked.includes(t.id));
  LT.card.replaceChildren(
    h("span", { class: "ch-bigseal-box" }, (() => { const i = h("img", { class: "ch-bigseal-img", src: "img/marks/source-dispatch.webp", alt: "", width: 72, height: 72, loading: "lazy", decoding: "async" }); i.addEventListener("error", () => { i.remove(); }); return i; })()),
    h("p", { class: "ch-card-from" }, h("b", { text: who.name }), " brings this to the party"),
    ...(turns.length ? turns.map((t) => h("div", { class: "ch-card-turn" },
      h("p", { class: "ch-card-q" }, h("b", { text: "Asked: " }), t.text),
      h("div", { class: "ch-card-a" }, h("b", { text: "Leeroy: " }), ...String(t.answer).split(/\n+/).map((x) => x.trim()).filter(Boolean).map((p) => h("p", { text: p }))),
      t.sources.length ? h("p", { class: "ch-card-src" }, h("b", { text: "Sources: " }), t.sources.join("; ")) : null)) : [h("p", { class: "ch-card-none", text: "Nothing is ticked yet." })]));
  if (LT.post && LT.post.textContent !== "Posted") LT.post.setAttribute("aria-disabled", String(!turns.length));
}
function closeLetter() { sheet.hidden = true; CH.letter = false; }
function lsay(t) { const n = $("#ch-letter-say"); if (n) n.textContent = t; else live.textContent = t; }
async function send() {
  const ids = CH.turns.filter((t) => t.answer && !t.dispatched && CH.picked.includes(t.id)).map((t) => t.id);
  if (!ids.length) { lsay(DSAY.none); return null; }
  const post = LT.post; if (post) { post.setAttribute("aria-disabled", "true"); post.textContent = "Posting"; }
  const r = B.dispatch ? await B.dispatch(ids) : { ok: false, why: "off" };
  if (r.ok || r.why === "already") {
    const at = (r && r.at) || new Date().toISOString();
    for (const t of CH.turns) if (ids.includes(t.id) && !t.dispatched) t.dispatched = at;
    CH.picked = []; save(); snd("stamp"); if (r.ok) buzz("success");
    for (const cb of LT.boxes) cb.disabled = true;
  }
  lsay(r.ok ? DSAY.ok : r.why === "limited" ? `${DSAY.limited} It opens up again in about ${hours(r.retryAfter)}.` : DSAY[r.why] || DSAY.failed);
  if (post) { post.textContent = r.ok ? "Posted" : "Post it to #wow-forever"; post.setAttribute("aria-disabled", String(!!r.ok || r.why === "already")); }
  draw(B.askStatus());
  K.emit("dispatch", r.ok ? "sent" : r.why);
  return r;
}

/* ---------- open and close ---------- */
function open(user) {
  if (CH.on) return;
  CH.on = true; CH.sig = null;
  const who = asker();
  for (const m of MOODS) artLoad(moodUrl(m));
  const art = who.m ? `${String(who.m.race).toLowerCase()}-${who.m.class_key}` : "";
  you.classList.add("has-art");
  you.querySelector(".ch-silbox").replaceChildren(artImg("ch-art ch-art-you", `img/chamber/${ASK_ART.includes(art) ? art : "visitor"}.webp`, ""));
  you.querySelector(".ch-plate-you").textContent = who.name;
  you.style.setProperty("--cc", who.m ? K.classVar(who.m.class_key) : "var(--c-none)");
  log.style.setProperty("--cc", who.m ? K.classVar(who.m.class_key) : "var(--c-none)"); /* the asker's turns edged in the same colour */
  room.hidden = false; panel.classList.add("chamber-on"); start.hidden = true;
  room.classList.remove("ch-in"); if (!reduced()) { void room.offsetWidth; room.classList.add("ch-in"); }
  if (window.BoardSeals && window.BoardSeals.spin && window.BoardSeals.status && window.BoardSeals.status().key === "librarian") { try { window.BoardSeals.spin({ land: "front" }); } catch (e) {} }
  snd("whoosh");
  paint(B.askStatus());
  if (user) { const ta = input.disabled ? null : input; if (ta) { try { ta.focus({ preventScroll: true }); } catch (e) {} } }
  K.emit("chamber", true);
}
function close(user) {
  if (!CH.on) return;
  if (CH.typing) finishTyping();
  CH.on = false; CH.sig = null; CH.autoOpen = false; if (user) CH.ended = true;
  room.hidden = true; panel.classList.remove("chamber-on"); room.classList.remove("ch-in"); closeLetter(); next.hidden = true;
  const st = B.askStatus(); start.hidden = !liveOk(st);
  if (user) { snd("close"); try { start.focus(); } catch (e) {} }
  K.emit("chamber", false);
}
/* a talk with history picks up where it was when the Leeroy scene opens (until End the talk on this page) */
function resume() {
  const st = B.askStatus();
  if (!CH.on && !CH.ended && CH.turns.length && liveOk(st) && K.SC && K.SC.open === "librarian") open(false); else paint(st);
}
/* a question sent from the old ask box opens the chamber on its own too */
const askForm = $("#ask-form"); if (askForm) askForm.addEventListener("submit", () => { CH.autoOpen = true; });
B.onAsk(paint);
K.on("closed", (k) => { if (k === "librarian") close(false); });
K.on("scene", (k) => { if (k === "librarian") { CH.chips = null; resume(); } });
K.on("tonight", () => { CH.chips = null; });
K.on("forget", () => { CH.turns = []; CH.typed = {}; CH.seen = {}; CH.picked = []; CH.follow = {}; CH.kh = "none"; CH.sig = null; file.set(null); closeLetter(); say(""); draw(B.askStatus()); });
window.__chamber = Object.freeze({ open, close, letter, send, ask, moodFor,
  status: () => { const st = B.askStatus(), a = st.ask; return { on: CH.on, mood: CH.mood, state: room.dataset.state, typing: !!CH.typing, letter: CH.letter, turns: CH.turns.length, live: a && busyOk(st) && Number.isInteger(a.id) ? a.id : null, picked: CH.picked.slice(), left: typeof st.left === "number" ? st.left : null }; } });
paint(B.askStatus());
keyHash().then((kh) => { adopt(kh); CH.sig = null; resume(); });
})();
