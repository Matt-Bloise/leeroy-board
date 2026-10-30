/* Ask Leeroy box (Leeroy scene); fake-DOM safe plain DOM. */
(() => {
"use strict";
const B = window.BoardBrain, box = document.getElementById("ask-box"), note = document.getElementById("ask-note"), out = document.getElementById("ask-out");
if (!B || !B.onAsk || !box || !note || !out) return;
const MAX = 280, MIN = 3;
const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const k in attrs || {}) { const v = attrs[k]; if (v === null || v === undefined || v === false) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : String(v)); } for (const c of kids) if (c) e.append(c); return e; };
const NOTE = {
  off: "Asking here works from the shared board links. In Discord, /ask in #wow-forever or a tag on Leeroy Jenkins reaches the same Leeroy.",
  none: "Asking from the board works with your own board link (My board link on the Sign-ups card). Without one, /ask in #wow-forever or a tag on Leeroy Jenkins reaches the same Leeroy.",
  bad: "This board link is not valid any more. My board link on the Sign-ups card makes a new one.",
};
const FAIL = { no_answer: "Leeroy did not get to that one in time.", held: "Leeroy held that answer back for a check.", error: "Leeroy could not finish that one." };
const ERR = { offline: "The board could not reach Leeroy just now. Your question is still in the box.", busy: "The brain is busy right now. Your question is still in the box.", refused: `That could not be sent. After links and odd characters are removed it needs ${MIN} to ${MAX} characters.`, key: NOTE.bad };

const ta = el("textarea", { id: "ask-text", rows: 3, "aria-describedby": "ask-count ask-status", "aria-keyshortcuts": "Control+Enter", autocomplete: "off", spellcheck: "true" });
const count = el("span", { id: "ask-count", class: "ask-count" });
const share = el("input", { type: "checkbox", id: "ask-share" });
const btn = el("button", { type: "submit", class: "ask-send", text: "Send" });
const stat = el("p", { id: "ask-status", class: "ask-status", role: "status", "aria-live": "polite" });
const check = el("button", { type: "button", class: "ask-check", text: "Check now", hidden: true });
const form = el("form", { class: "ask-form", id: "ask-form", novalidate: true, hidden: true },
  el("label", { for: "ask-text", class: "ask-label", text: "Your question for Leeroy" }), ta,
  el("div", { class: "ask-row" }, el("label", { class: "ask-share", for: "ask-share" }, share, el("span", { text: " Also share the answer in #wow-forever" })), count),
  el("div", { class: "ask-row" }, btn, check), stat);
note.parentNode.insertBefore(form, note);

let cur = null, shown = "";
const len = () => Array.from(ta.value.replace(/\s+/g, " ").trim()).length;
function tally() { const n = len(); count.textContent = `${n} / ${MAX}`; count.classList.toggle("over", n > MAX); }
function say(t) { if (stat.textContent !== t) stat.textContent = t; }
function paint(s) {
  cur = s;
  const live = s.base && s.key && !s.keyBad;
  note.hidden = live; form.hidden = !live;
  note.textContent = !s.base ? NOTE.off : s.keyBad ? NOTE.bad : NOTE.none;
  if (!live) return;
  const busy = s.state === "sending" || s.state === "queued", a = s.ask;
  btn.setAttribute("aria-disabled", busy ? "true" : "false"); btn.textContent = s.state === "sending" ? "Sending" : "Send";
  form.setAttribute("aria-busy", busy ? "true" : "false");
  const old = a && s.state !== "queued" && Date.now() - Date.parse(a.at) > 864e5;
  const slow = s.state === "queued" && a && Date.now() - Date.parse(a.at) > 6e5;
  check.hidden = s.state !== "queued";
  say(s.state === "sending" ? "Sending."
    : s.state === "queued" ? (slow ? "Still waiting. Check now looks again." : "Sent. Leeroy has it and is looking; the answer appears below.")
    : s.state === "answered" && !old ? "Leeroy answered."
    : s.state === "failed" && !old ? `${FAIL[a && a.reason] || FAIL.error} Sending it again is fine.`
    : s.state === "error" ? ERR[s.error] || ERR.busy
    : s.state === "limited" ? `That is six questions in the last hour. Leeroy opens up again in about ${Math.max(1, Math.ceil(s.retryAfter / 60))} minute${Math.ceil(s.retryAfter / 60) === 1 ? "" : "s"}.`
    : "");
  const sig = `${s.state === "limited" || s.state === "error" || s.state === "sending" ? "x" : s.state}|${a ? `${a.id}|${a.status}` : ""}|${old}`;
  if (sig === shown) return;
  shown = sig;
  out.replaceChildren();
  if (!a || old || s.state === "idle") return;
  const card = el("div", { class: `ask-card ${a.status}` }, el("p", { class: "ask-q" }, el("b", { text: "You asked: " }), a.text));
  if (a.status === "answered" && a.answer) {
    card.append(el("p", { class: "ask-who", text: "Leeroy" }));
    for (const para of String(a.answer).split(/\n+/)) if (para.trim()) card.append(el("p", { class: "ask-a", text: para }));
    if (a.sources && a.sources.length) card.append(el("p", { class: "ask-src" }, el("b", { text: "Sources: " }), a.sources.join("; ")));
    if (a.share) card.append(el("p", { class: "ask-src", text: "This one was also posted in #wow-forever." }));
  } else if (a.status === "queued") card.append(el("p", { class: "ask-wait", text: "Waiting for Leeroy." }));
  out.append(card);
}
async function send() {
  if (!cur || cur.state === "sending" || cur.state === "queued") return;
  const n = len();
  if (n < MIN) { say(`A question needs at least ${MIN} characters.`); return; }
  if (n > MAX) { say(`That is ${n - MAX} over the ${MAX} character limit.`); return; }
  const r = await B.ask(ta.value, share.checked);
  if (r && r.ok) { ta.value = ""; share.checked = false; tally(); }
}
ta.addEventListener("input", tally);
ta.addEventListener("keydown", (e) => { if (e && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { if (e.preventDefault) e.preventDefault(); send(); } });
form.addEventListener("submit", (e) => { if (e && e.preventDefault) e.preventDefault(); send(); });
check.addEventListener("click", () => { B.askRead(); });
B.onAsk(paint);
tally();
paint(B.askStatus());
})();
