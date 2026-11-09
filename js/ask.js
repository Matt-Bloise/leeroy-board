(() => {
"use strict";
const B = window.BoardBrain, box = document.getElementById("ask-box"), note = document.getElementById("ask-note"), out = document.getElementById("ask-out");
if (!B || !B.onAsk || !box || !note || !out) return;
const MAX = 280, MIN = 3;
const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const k in attrs || {}) { const v = attrs[k]; if (v === null || v === undefined || v === false) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : String(v)); } for (const c of kids) if (c) e.append(c); return e; };
const NOTE = {
  off: "Asking from this copy of the board is off; the board link in Discord has it.",
  none: "Asking from here needs your own board link; it is on the Sign-ups card in Discord.",
  bad: "This board link is not valid any more. The Sign-ups card in Discord makes a new one.",
};
const FAIL = { no_answer: "Leeroy did not get to that one in time.", held: "Leeroy held that answer back for a check.", error: "Leeroy could not finish that one." };
const ERR = { offline: "The board could not reach Leeroy just now. Your question is still in the box.", busy: "The brain is busy right now. Your question is still in the box.", refused: `That could not be sent. After links and odd characters are removed it needs ${MIN} to ${MAX} characters.`, key: NOTE.bad };
const LABELS = {
  claude: "Leeroy · Claude",
  gemini: "Leeroy · Gemini Free Tier",
  "workers-ai": "Leeroy · Cloudflare Workers AI (Llama 3.3 70B)",
  groq: "Leeroy · Groq Free Tier (Llama 3.3 70B)",
  cerebras: "Leeroy · Cerebras Free Tier (Llama 3.3 70B)",
  github: "Leeroy · GitHub Models (GPT-4o)",
  openrouter: "Leeroy · OpenRouter Free (DeepSeek V3)",
};

const ta = el("textarea", { id: "ask-text", rows: 3, "aria-describedby": "ask-count ask-status", "aria-keyshortcuts": "Control+Enter", autocomplete: "off", spellcheck: "true" });
const count = el("span", { id: "ask-count", class: "ask-count" });
const share = el("input", { type: "checkbox", id: "ask-share" });
const modelSel = el("select", { id: "ask-model", class: "ask-model", "aria-label": "AI model for Leeroy" },
  el("option", { value: "claude", text: "Model: Claude (Anthropic)" }),
  el("option", { value: "gemini", text: "Model: Gemini Free Tier" }),
  el("option", { value: "workers-ai", text: "Model: Cloudflare Workers AI (Llama 3.3 70B · Free)" }),
  el("option", { value: "groq", text: "Model: Groq Free Tier (Llama 3.3 70B)" }),
  el("option", { value: "cerebras", text: "Model: Cerebras Free Tier (Llama 3.3 70B)" }),
  el("option", { value: "github", text: "Model: GitHub Models (GPT-4o · Free)" }),
  el("option", { value: "openrouter", text: "Model: OpenRouter Free (DeepSeek V3)" })
);
if (typeof B.getAiProvider === "function") modelSel.value = B.getAiProvider();
modelSel.addEventListener("change", () => { if (typeof B.setAiProvider === "function") B.setAiProvider(modelSel.value); });

const btn = el("button", { type: "submit", class: "ask-send", text: "Send" });
const stat = el("p", { id: "ask-status", class: "ask-status", role: "status", "aria-live": "polite" });
const check = el("button", { type: "button", class: "ask-check", text: "Check now", hidden: true });
const form = el("form", { class: "ask-form", id: "ask-form", novalidate: true, hidden: true },
  el("label", { for: "ask-text", class: "ask-label", text: "Your question for Leeroy" }), ta,
  el("div", { class: "ask-row" }, el("label", { class: "ask-share", for: "ask-share" }, share, el("span", { text: " Also share the answer in #wow-forever" })), modelSel, count),
  el("div", { class: "ask-row" }, btn, check), stat);
note.parentNode.insertBefore(form, note);

let cur = null, shown = "", waited = "", typer = 0;
// Life cues: a short wiggle when an answer lands and a quiet typing tick while a question waits. Both are off under reduced motion, Calm and Play mode (html.calm, html.still), and the tick goes through BoardSound, which stays silent while sound is off.
const quiet = () => { try { if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true; } catch (e) {} return /(^|\s)(calm|still|play)(\s|$)/.test(document.documentElement.className || ""); };
function typing(on) {
  if (!on) { clearTimeout(typer); typer = 0; return; }
  if (typer) return;
  const beat = () => { typer = setTimeout(beat, 380 + Math.random() * 520); if (quiet() || document.hidden) return; const S = window.BoardSound; if (S && typeof S.play === "function") S.play("tick", { db: -34 }); };
  typer = setTimeout(beat, 600);
}
const len = () => Array.from(ta.value.replace(/\s+/g, " ").trim()).length;
function tally() { const n = len(); count.textContent = `${n} / ${MAX}`; count.classList.toggle("over", n > MAX); }
function say(t) { if (stat.textContent !== t) stat.textContent = t; }
function paint(s) {
  cur = s;
  if (s && s.isPrPreview) { for (const opt of Array.from(modelSel.options)) { if (opt.value !== "workers-ai") { opt.disabled = true; opt.hidden = true; } else { opt.textContent = "Model: Cloudflare Workers AI (Llama 3.3 70B · Free)"; } } modelSel.value = "workers-ai"; } else if (s && s.provider && modelSel.value !== s.provider) { modelSel.value = s.provider; }
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
  typing(s.state === "queued");
  if (s.state === "queued" && a) waited = a.id;
  say(s.state === "sending" ? "Sending."
    : s.state === "queued" ? (slow ? "Still waiting. Check now looks again." : "Sent. Leeroy has it and is looking; the answer appears below.")
    : s.state === "answered" && !old ? "Leeroy answered."
    : s.state === "failed" && !old ? `${FAIL[a && a.reason] || FAIL.error} Sending it again is fine.`
    : s.state === "error" ? ERR[s.error] || ERR.busy
    : s.state === "limited" ? `That is six questions in the last hour. Leeroy opens up again in about ${Math.max(1, Math.ceil(s.retryAfter / 60))} minute${Math.ceil(s.retryAfter / 60) === 1 ? "" : "s"}.`
    : "");
  const sig = `${s.state === "limited" || s.state === "error" || s.state === "sending" ? "x" : s.state}|${a ? `${a.id}|${a.status}|${a.provider || ""}` : ""}|${old}`;
  if (sig === shown) return;
  shown = sig;
  out.replaceChildren();
  if (!a || old || s.state === "idle") return;
  const fresh = a.status === "answered" && waited === a.id && !quiet();
  if (a.status === "answered") waited = "";
  const card = el("div", { class: `ask-card ${a.status}${fresh ? " ask-wiggle" : ""}` }, el("p", { class: "ask-q" }, el("b", { text: "You asked: " }), a.text));
  if (a.status === "answered" && a.answer) {
    const badge = LABELS[a.provider] || "Leeroy";
    card.append(el("p", { class: "ask-who" }, el("img", { class: "ask-crest", src: "img/marks/source-leeroy.webp", alt: "", width: 24, height: 24, decoding: "async" }), el("span", { text: badge })));
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
  const r = await B.ask(ta.value, share.checked, modelSel.value);
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
