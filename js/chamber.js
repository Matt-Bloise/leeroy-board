/* The Leeroy audience chamber and Dispatch (notes/VISION-PARTY-SHEET.md 5.4; 2026-10-30). On the Leeroy scene, starting a talk
   spins the coin and turns the panel into a chamber: Leeroy's portrait slides down from the top right, the asker's portrait rises
   from the bottom left (their race and class, ringed in their class colour, their display name on a brass plate), his answer
   types out with a Skip, sources end it as numbered footnotes, and two or three follow-ups come from the library's own ranking
   (vendor/rank-core.js over the library index). It runs on the ask box (js/ask.js, BoardBrain.ask): one open ask at a time, the
   same limits. His moods: thinking while an ask waits on him (he is checking a live source), sheepish when it failed or his
   answer corrects itself, delighted at a long question or an answer with two or more sources, smug otherwise. "Bring this to the
   party" previews the Dispatch card and posts only on the asker's tap (BoardBrain.dispatch, POST /api/dispatch); a Worker
   without the route says the owner has not switched it on. Sound only when it is on; reduced motion: no slides, no typing.
   The owner's painted art (img/chamber, img/marks; board/img/chamber/CREDITS.md, original, no game assets) is the whole look of it:
   Leeroy's four moods, the five's race and class, a hooded visitor, the tavern alcove behind, the Dispatch seal. Nothing is drawn
   in SVG any more (2026-10-30; the drawn portrait, silhouettes and seals are gone, the page is lighter for it). The images load
   only when the chamber opens, and a mood swaps only once its image is decoded; a picture that does not load leaves its brass
   name plate standing alone. Fake-DOM safe. */
(() => {
"use strict";
const K = window.__boardKit, B = window.BoardBrain; if (!K || !B || !B.onAsk) return;
const { $, h, D, MEM } = K;
const panel = $("#panel-librarian"), box = $("#ask-box"); if (!panel || !box) return;
const CH = { on: false, typed: {}, typing: null, mood: "smug", ask: null, letter: false, sent: {}, follow: {}, cur: null };
const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
const snd = (n, o) => { try { if (window.BoardSound) return window.BoardSound.play(n, o); } catch (e) {} return false; };
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
const LINES = {
  idle: "Pull up a stool. Ask me anything about Forever; I answer from the same library this board searches.",
  queued: "Checking the library and the live sources. One moment.",
  failed: "I did not get to that one in time. Sending it again is fine.",
  error: "I cannot hear the board just now. Your question is still in the box.",
  limited: "That is six questions in the last hour. I open up again soon.",
};
function paint(st) {
  CH.cur = st;
  const live0 = st.base && st.key && !st.keyBad;
  start.hidden = !live0 || CH.on;
  if (!live0 && CH.on) close(false);
  if (!CH.on) { if (live0 && (st.state === "sending" || (st.state === "queued" && CH.autoOpen))) open(false); else return; }
  room.dataset.state = st.state;
  setMood(moodFor(st));
  const a = st.ask, who = asker();
  const sig = `${st.state}|${a ? a.id : ""}|${a ? a.status : ""}`;
  if (sig === CH.sig) { bring.hidden = !(a && a.status === "answered" && !CH.typing); return; }
  CH.sig = sig;
  const kids = [];
  if (a && (st.state !== "idle")) kids.push(bubble(who.name, "ch-q", h("p", { class: "ch-t", text: a.text })));
  if (!a || st.state === "idle") kids.push(bubble("Leeroy", "ch-a", h("p", { class: "ch-t", text: LINES.idle })));
  else if (st.state === "sending" || st.state === "queued") kids.push(bubble("Leeroy", "ch-a ch-wait", h("p", { class: "ch-t", text: LINES.queued }), h("span", { class: "ch-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i"))));
  else if (st.state === "answered" && a.answer) kids.push(answerEl(a));
  else kids.push(bubble("Leeroy", "ch-a", h("p", { class: "ch-t", text: LINES[st.state] || LINES.error })));
  log.replaceChildren(...kids);
  next.hidden = true; bring.hidden = true; closeLetter();
  if (st.state === "answered" && a && a.answer) {
    live.textContent = `Leeroy answered: ${a.answer}`;
    if (!CH.typed[a.id] && !reduced()) typeOut(a); else { CH.typed[a.id] = true; done(a); }
  } else live.textContent = st.state === "queued" ? "Leeroy is checking." : "";
}
function answerEl(a) {
  const paras = String(a.answer).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const notes = (a.sources || []).length ? h("ol", { class: "ch-notes", "aria-label": "Sources" }, a.sources.map((src, i) => h("li", { class: "ch-note" }, h("span", { class: "ch-seal", "aria-hidden": "true", text: String(i + 1) }), h("span", { text: src })))) : null;
  return bubble("Leeroy", "ch-a ch-done", h("div", { class: "ch-paras", "aria-hidden": "true" }, paras.map((p) => h("p", { class: "ch-t", "data-full": p, text: p }))), notes);
}
/* the answer types out, a few characters a frame; Skip, a new state or reduced motion shows it whole */
function typeOut(a) {
  const ps = [...log.querySelectorAll(".ch-a .ch-t")], notes = log.querySelector(".ch-notes"); if (!ps.length) { done(a); return; }
  for (const p of ps) p.textContent = "";
  if (notes) notes.hidden = true;
  skip.hidden = false;
  let i = 0, n = 0; const T = { a, stop: false };
  CH.typing = T;
  snd("quill", { rate: 1.6, db: -32 });
  const step = () => {
    if (T.stop || CH.typing !== T) return;
    const p = ps[i], full = p.dataset.full; n = Math.min(full.length, n + 3); p.textContent = full.slice(0, n);
    if (n >= full.length) { i++; n = 0; if (i < ps.length) snd("quill", { rate: 1.4 + Math.random() * 0.4, db: -32 }); }
    if (i >= ps.length) { finishTyping(); return; }
    T.t = setTimeout(step, 18);
  };
  T.t = setTimeout(step, 120);
}
function finishTyping() {
  const T = CH.typing; if (!T) return;
  T.stop = true; clearTimeout(T.t); CH.typing = null;
  for (const p of log.querySelectorAll(".ch-a .ch-t")) if (p.dataset.full) p.textContent = p.dataset.full;
  const notes = log.querySelector(".ch-notes"); if (notes) notes.hidden = false;
  skip.hidden = true; CH.typed[T.a.id] = true; done(T.a);
}
function done(a) {
  bring.hidden = false;
  bring.textContent = a.dispatchedAt || CH.sent[a.id] ? "Sent to the party" : "Bring this to the party";
  bring.setAttribute("aria-disabled", String(!!(a.dispatchedAt || CH.sent[a.id])));
  follow(a);
}

/* ---------- follow-ups from the library's own ranking ---------- */
async function follow(a) {
  const key = `${a.id}`;
  if (!CH.follow[key]) CH.follow[key] = (async () => {
    if (!K.libCore || !K.libIndex) return [];
    const [core, ix] = await Promise.all([K.libCore(), K.libIndex().catch(() => null)]);
    if (!core || !ix || !Array.isArray(ix.pages)) return [];
    const pages = ix.pages.map((p) => ({ id: p.id, title: p.title, category: p.category, aliases: p.aliases || [], facts: [{ key: "title", value: p.title }, { key: "about", value: p.blurb || "" }], open: [] }));
    const seen = new Set(), out = [];
    for (const x of core.rank(a.text || "", pages).hits) { if (seen.has(x.page)) continue; seen.add(x.page); out.push({ id: x.page, title: x.p.title }); if (out.length === 3) break; }
    return out;
  })().catch(() => []);
  const list = await CH.follow[key];
  if (!CH.on || !CH.cur || !CH.cur.ask || CH.cur.ask.id !== a.id) return;
  if (!list.length) { next.hidden = true; return; }
  const ta = $("#ask-text");
  next.replaceChildren(h("h4", { class: "ch-next-h", text: "Ask next" }), h("ul", { class: "ch-next-l" }, list.map((x) => h("li", {},
    h("button", { type: "button", class: "lib-tool ch-ask", onclick: () => { if (ta) { ta.value = `What else does the library say about ${x.title}?`; try { ta.dispatchEvent(new Event("input")); } catch (e) {} ta.focus(); } snd("chip"); } }, `More on ${x.title}`),
    h("a", { class: "tn-link ch-page", href: `#library.${String(x.id).replace("/", ".")}`, text: "the page" })))));
  next.hidden = false;
}

/* ---------- Dispatch: the card preview, posted only on the asker's tap ---------- */
const DSAY = {
  ok: "Sent. Leeroy posts it in #wow-forever as one card. The rest of this talk stays here.",
  off: "The owner has not switched Dispatch on yet, so nothing was posted. The answer stays here.",
  already: "This one already went to the party.",
  unanswered: "Only an answered question can go to the party.",
  limited: "That is five dispatches today, so nothing was posted. It opens up again tomorrow.",
  "no key": "Dispatch needs your own board link (My board link on the Sign-ups card). Nothing was posted.",
  offline: "The board could not reach Leeroy just now. Nothing was posted.",
  failed: "That did not go through. Nothing was posted.",
};
function letter(user) {
  const st = CH.cur, a = st && st.ask; if (!a || a.status !== "answered") return;
  if (a.dispatchedAt || CH.sent[a.id]) { say(DSAY.already); return; }
  const who = asker(), paras = String(a.answer).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const post = h("button", { type: "button", class: "lib-tool ch-post", id: "ch-post", onclick: () => send(a) }, "Post it to #wow-forever");
  const no = h("button", { type: "button", class: "lib-tool ch-no", onclick: () => { closeLetter(); bring.focus(); } }, "Not now");
  sheet.replaceChildren(
    h("h4", { class: "ch-letter-h", id: "ch-letter-h", text: "The Dispatch card" }),
    h("div", { class: "ch-card", "data-who": who.name },
      h("span", { class: "ch-bigseal-box" }, (() => { const i = h("img", { class: "ch-bigseal-img", src: "img/marks/source-dispatch.webp", alt: "", width: 72, height: 72, loading: "lazy", decoding: "async" }); i.addEventListener("error", () => { i.remove(); }); return i; })()),
      h("p", { class: "ch-card-from" }, h("b", { text: who.name }), " brings this to the party"),
      h("p", { class: "ch-card-q" }, h("b", { text: "Asked: " }), a.text),
      h("div", { class: "ch-card-a" }, h("b", { text: "Leeroy: " }), ...paras.map((p) => h("p", { text: p }))),
      (a.sources || []).length ? h("p", { class: "ch-card-src" }, h("b", { text: "Sources: " }), a.sources.join("; ")) : null),
    h("p", { class: "ch-letter-note", text: "Nothing posts until you tap Post. The back-and-forth never posts; only this card, once." }),
    h("div", { class: "ch-letter-row" }, post, no),
    h("p", { class: "ch-letter-say", id: "ch-letter-say", role: "status", "aria-live": "polite" }));
  sheet.hidden = false; CH.letter = true; snd("unfurl");
  if (user) post.focus();
}
function closeLetter() { sheet.hidden = true; CH.letter = false; }
function say(t) { const n = $("#ch-letter-say"); if (n) n.textContent = t; else live.textContent = t; }
async function send(a) {
  const post = $("#ch-post"); if (post) { post.setAttribute("aria-disabled", "true"); post.textContent = "Posting"; }
  const r = B.dispatch ? await B.dispatch([a.id]) : { ok: false, why: "off" };
  if (r.ok || r.why === "already") { CH.sent[a.id] = true; done(a); snd("stamp"); }
  say(r.ok ? DSAY.ok : DSAY[r.why] || DSAY.failed);
  if (post) { post.textContent = r.ok ? "Posted" : "Post it to #wow-forever"; post.setAttribute("aria-disabled", String(!!r.ok || r.why === "already")); }
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
  room.hidden = false; panel.classList.add("chamber-on"); start.hidden = true;
  room.classList.remove("ch-in"); if (!reduced()) { void room.offsetWidth; room.classList.add("ch-in"); }
  if (window.BoardSeals && window.BoardSeals.spin && window.BoardSeals.status && window.BoardSeals.status().key === "librarian") { try { window.BoardSeals.spin({ land: "front" }); } catch (e) {} }
  snd("whoosh");
  paint(B.askStatus());
  if (user) { const ta = $("#ask-text"); if (ta) ta.focus({ preventScroll: true }); }
  K.emit("chamber", true);
}
function close(user) {
  if (!CH.on) return;
  if (CH.typing) finishTyping();
  CH.on = false; CH.sig = null; CH.autoOpen = false;
  room.hidden = true; panel.classList.remove("chamber-on"); room.classList.remove("ch-in"); closeLetter();
  const st = B.askStatus(); start.hidden = !(st.base && st.key && !st.keyBad);
  if (user) { snd("close"); start.focus(); }
  K.emit("chamber", false);
}
/* a question sent from the box opens the chamber on its own */
const form = $("#ask-form"); if (form) form.addEventListener("submit", () => { CH.autoOpen = true; });
B.onAsk(paint);
K.on("closed", (k) => { if (k === "librarian") close(false); });
K.on("scene", (k) => { if (k === "librarian") paint(B.askStatus()); });
window.__chamber = Object.freeze({ open, close, letter, send, moodFor, status: () => ({ on: CH.on, mood: CH.mood, state: room.dataset.state, typing: !!CH.typing, letter: CH.letter }) });
paint(B.askStatus());
})();
