/* V15 (2026-10-30): launch night on the board (board/V15-LAUNCH-SPEC.md). From 24 hours before launch to 24 hours after, the
   Dates countdown tile grows into the Launch night hero on the wall: the Dates seal as a coin, the countdown (the page's own
   #clock, moved inside so its one-second tick keeps running), the group's agreed facts from the records (a missing record
   reads "not agreed yet" and points at #wow-forever; nothing is ever invented), the night-before checklist each viewer ticks
   for themselves (this browser only), the one-tap state (in the queue, in the game, done for tonight) through the shared
   brain with a saved-on-this-device fallback, Leeroy's own posting schedule and the way to ask him. From one hour before
   launch to twelve hours after, a visit without a scene link opens on the hero (K.openDepth, read by js/board.js boot). After
   6 PM ET the countdown becomes "live since" and the checklist folds. Everything informs; nothing assigns.
   Rides on window.__boardKit events and the data the page already loaded (K.D); data/launch.json is optional. Fake-DOM safe:
   no :scope, no child combinators, no Element.after, no MutationObserver, handlers never read event.target. */
(() => {
  "use strict";
  const K = window.__boardKit; if (!K) return;
  const $ = (q, r) => (r || document).querySelector(q);
  const h = (t, a, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a || {})) { if (v == null || v === false) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); } for (const c of kids.flat()) if (c != null && c !== false) e.append(c); return e; };
  const mq = (q) => { try { return matchMedia(q); } catch (e) { return { matches: false }; } };
  const reduceMQ = mq("(prefers-reduced-motion: reduce)");
  const sfx = (n) => { try { K.sfx(n); } catch (e) {} };
  const HOUR = 3600;
  /* the three words that may leave the page (js/brain.js safe), with the board's own labels */
  const STATES = [["queue", "In the queue", "waiting in the login queue"], ["in", "I'm in", "in the game"], ["done", "Done for tonight", "logged off for the night"]];
  const STATE_SAY = { queue: "In the queue", in: "In the game", done: "Done for tonight" };
  const WINDOW = { heroBefore: 24 * HOUR, heroAfter: 24 * HOUR, openBefore: 1 * HOUR, openAfter: 12 * HOUR };
  /* the night-before list the bot posts (notes/EVENTS.md "Launch is tomorrow"), used when data/launch.json is not there */
  const FALLBACK_LIST = [["names", "The reserved names, written down outside the game"], ["addons", "Addons updated for the Forever client, or a plan to play bare"], ["client", "The Battle.net app logged in and the client patched"], ["meet", "A meeting point (the party's so far: {signups:meet})"], ["voice", "Voice: {voice}"], ["snacks", "Snacks. Nobody has ever pulled well hungry."]].map(([id, text]) => ({ id, text }));
  const L = { el: null, phase: "", built: false, timer: 0, liveT: 0, coin: null, local: null, sent: null, launch: null };

  /* ---------- time: every phase comes from the timeline's launch epoch, never a typed date ---------- */
  const launchEpoch = () => { const t = K.D && K.D.timeline, e = t && t.events && t.events.find((x) => x.key === "launch"); return e && e.epoch ? e.epoch : null; };
  const nowS = () => Date.now() / 1000;
  /* "" | "soon" | "live" */
  function phaseAt(now) { const L0 = launchEpoch(); if (!L0 || now < L0 - WINDOW.heroBefore || now >= L0 + WINDOW.heroAfter) return ""; return now < L0 ? "soon" : "live"; }
  function opensHere(now) { const L0 = launchEpoch(); return !!L0 && now >= L0 - WINDOW.openBefore && now < L0 + WINDOW.openAfter; }
  K.openDepth = () => (opensHere(nowS()) ? "wall" : null);
  const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch (e) { return "America/New_York"; } };
  /* "6 PM ET" or "3 PM your time (6 PM ET)": the hour only, for a list of moments on one evening */
  function hourOf(epoch) {
    const f = (tz) => { try { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(epoch * 1000)).replace(":00", ""); } catch (e) { return ""; } };
    const et = f("America/New_York"), mine = f(viewerZone());
    return mine === et ? `${et} ET` : `${mine} your time (${et} ET)`;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  function elapsedWords(sec) { const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60); return hh ? `${plural(hh, "hour")}, ${plural(mm, "minute")}` : plural(mm, "minute"); }

  /* ---------- the records: facts, or "not agreed yet" ---------- */
  const names = (list) => (list || []).map((n) => K.cleanName(n));
  const channelUrl = () => (K.D.party && K.D.party.channel_url) || null;
  function voiceName() {
    const LJ = K.D.launch; if (LJ && LJ.voice) return LJ.voice;
    const P = K.D.party, o = P && P.open ? P.open.find((x) => /launch night/i.test(x.title)) : null;
    const m = o && o.detail ? o.detail.match(/voice in ([A-Z][A-Za-z' -]{0,40}?)(?:[.,;]|$)/) : null;
    return m ? m[1].trim() : null;
  }
  /* meeting point: every place the Sign-ups card has names for (write-ins included); [] when nobody has answered */
  function meetLines() {
    const S = K.D.signups, t = S && S.tallies && S.tallies.meet; if (!t) return [];
    const out = [];
    for (const [place, slot] of Object.entries(t)) {
      if (place === "other") { for (const p of slot.places || []) out.push(`${K.cleanName(p.place)}: ${K.cleanName(p.name)}`); }
      else if (slot && slot.count) out.push(`${place}: ${names(slot.names).join(", ")}`);
    }
    return out;
  }
  function whenLines() {
    const S = K.D.signups, t = S && S.tallies && S.tallies.when; if (!t) return [];
    return [["6pm", "6 PM ET"], ["8pm", "around 8 PM ET"], ["later", "later"]].filter(([k]) => t[k] && t[k].count).map(([k, l]) => `${l}: ${names(t[k].names).join(", ")}`);
  }
  function inLines() {
    const S = K.D.signups, t = S && S.tallies && S.tallies.rsvp; if (!t) return [];
    return K.RSVP_KEYS.filter((k) => t[k] && t[k].count).map((k) => `${K.RSVP_SAY[k]}: ${names(t[k].names).join(", ")}`);
  }
  function startLines() {
    const P = K.D.party; if (!P) return [];
    const zones = {}; for (const m of P.members) (zones[m.start_zone || "somewhere"] ||= []).push(m.name);
    return Object.entries(zones).map(([z, ms]) => `${z}: ${ms.join(", ")}`);
  }
  const meetSummary = () => { const l = meetLines(); return l.length ? l.join("; ") : "nobody yet"; };
  /* "not agreed yet" always says where the talking happens */
  const notAgreed = (what) => { const u = channelUrl(); return [what || "not agreed yet", ". ", u ? h("a", { class: "tn-link lh-chan", href: u, target: "_blank", rel: "noopener noreferrer", "aria-label": "Talk about it in #wow-forever on Discord" }, "#wow-forever") : "#wow-forever", " is where it gets settled."]; };

  /* ---------- the hero ---------- */
  function say(text) { const n = $("#lh-say"); if (!n) return; n.textContent = text; n.classList.add("on"); clearTimeout(L.sayT); L.sayT = setTimeout(() => n.classList.remove("on"), 6000); }
  function pressCoin({ turn, face }) {
    const L0 = launchEpoch(); if (!L0) return;
    const live = nowS() >= L0;
    const words = live ? `Forever has been live since ${K.fmtWhen(L0)}: ${elapsedWords(nowS() - L0)}.` : `Launch: ${K.fmtWhen(L0, { rel: true })}.`;
    turn("back", () => face(live ? "Live" : "Launch", live ? `since ${hourOf(L0)}` : K.relWhen(L0))).then(() => say(words));
  }
  function build() {
    const el = h("section", { class: "lh", id: "launch-hero", "aria-labelledby": "lh-title", "data-phase": L.phase });
    const BS = window.BoardSeals;
    L.coin = BS && BS.coin ? BS.coin({ key: "timeline", title: "Launch", back: "", label: "Dates seal. Press it to turn it over and read the countdown in words.", press: pressCoin }) : null;
    /* one column on a phone in this order; from 1000 px the main column (countdown, facts) sits beside the side column */
    el.append(
      h("div", { class: "lh-head" }, L.coin ? h("div", { class: "lh-coin" }, L.coin.el) : null,
        h("div", { class: "lh-titles" }, h("p", { class: "lh-kicker", id: "lh-kicker", text: "Launch night" }), h("h2", { class: "lh-title", id: "lh-title" }), h("p", { class: "lh-sub", id: "lh-sub" }), h("p", { class: "lh-say", id: "lh-say", role: "status", "aria-live": "polite" }))),
      h("div", { class: "lh-main" },
        h("div", { class: "lh-count", id: "lh-count" }, h("div", { class: "lh-live", id: "lh-live", hidden: true }, h("p", { class: "lh-live-k", text: "Live since" }), h("div", { class: "lh-live-digits", id: "lh-live-digits", "aria-hidden": "true" }), h("p", { class: "sr-only", id: "lh-live-sr" }))),
        h("dl", { class: "lh-facts", id: "lh-facts", "aria-label": "Launch night, as the group has it" })),
      h("div", { class: "lh-side" },
        h("div", { class: "lh-states", id: "lh-states", role: "group", "aria-labelledby": "lh-states-q" }, h("h3", { class: "lh-h", id: "lh-states-q", text: "Where are you tonight?" }), h("div", { class: "lh-st-row", id: "lh-st-row" }), h("p", { class: "lh-st-say", id: "lh-st-say", role: "status", "aria-live": "polite" }), h("p", { class: "lh-st-who", id: "lh-st-who" })),
        h("details", { class: "lh-check", id: "lh-check" }, h("summary", { class: "lh-check-sum", id: "lh-check-sum" }), h("ul", { class: "lh-check-list", id: "lh-check-list", "aria-label": "Before launch" }), h("p", { class: "lh-check-count", id: "lh-check-count", role: "status" })),
        h("div", { class: "lh-sched", id: "lh-sched", "data-j": "c e" }, h("h3", { class: "lh-h", text: "Leeroy posts in #wow-forever" }), h("ol", { class: "lh-moments", id: "lh-moments" }))),
      h("p", { class: "lh-ask", id: "lh-ask" }));
    return el;
  }
  function mount() {
    const header = $("#top"), title = header && $(".hero-title", header), clock = $("#clock"); if (!header || !clock) return false;
    L.el = build();
    const kids = title ? [...header.children] : [], ref = title ? kids[kids.indexOf(title) + 1] || null : null;
    header.insertBefore(L.el, ref);
    $("#lh-count", L.el).insertBefore(clock, $("#lh-live", L.el)); /* the page's own clock keeps ticking inside the hero */
    L.built = true;
    renderAll();
    return true;
  }
  function unmount() {
    const header = $("#top"), clock = $("#clock");
    if (clock && header && L.el && L.el.contains(clock)) header.append(clock);
    if (L.el && L.el.parentNode) L.el.parentNode.removeChild(L.el);
    L.el = null; L.built = false; L.coin = null;
    clearInterval(L.liveT); L.liveT = 0;
  }
  function renderAll() { renderHead(); renderLive(); renderFacts(); renderStates(); renderCheck(); renderSched(); renderAsk(); }
  function renderHead() {
    const L0 = launchEpoch(), t = K.D.timeline && K.D.timeline.events.find((e) => e.key === "launch"); if (!L.el || !L0) return;
    L.el.dataset.phase = L.phase;
    $("#lh-title").textContent = L.phase === "live" ? "World of Warcraft: Forever is live" : `Forever opens ${K.fmtWhen(L0)}`;
    $("#lh-sub").textContent = L.phase === "live" ? `Live since ${K.fmtWhen(L0)}.` : `${t && t.detail ? t.detail[0].toUpperCase() + t.detail.slice(1) : "One global moment"}. No early access.`;
    if (L.coin) L.coin.face(L.phase === "live" ? "Live" : "Launch", L.phase === "live" ? `since ${hourOf(L0)}` : K.relWhen(L0));
  }
  /* live since: hours, minutes and seconds, in the clock's own digit style, once a second while the tab is visible */
  function renderLive() {
    const box = $("#lh-live"), L0 = launchEpoch(); if (!box || !L0) return;
    const live = L.phase === "live";
    box.hidden = !live;
    L.el.classList.toggle("is-live", live);
    clearInterval(L.liveT); L.liveT = 0;
    if (!live) return;
    const digits = $("#lh-live-digits"), sr = $("#lh-live-sr");
    const tick = () => {
      if (document.hidden) return;
      const sec = Math.max(0, Math.floor(nowS() - L0)), parts = [["hours", Math.floor(sec / 3600)], ["minutes", Math.floor((sec % 3600) / 60)], ["seconds", sec % 60]];
      if (digits.childElementCount !== parts.length) digits.replaceChildren(...parts.map(([u]) => h("span", { class: "clock-unit" }, h("b", { "data-u": u }), h("span", { text: u }))));
      for (const [u, v] of parts) { const b = $(`[data-u="${u}"]`, digits); const s = String(v).padStart(2, "0"); if (b && b.textContent !== s) b.textContent = s; }
      const words = `Live for ${elapsedWords(sec)}`; if (sr.textContent !== words) sr.textContent = words;
    };
    tick(); L.liveT = setInterval(tick, 1000);
  }
  function renderFacts() {
    const dl = $("#lh-facts"); if (!dl) return;
    const row = (name, value) => h("div", { class: "lh-fact" }, h("dt", { text: name }), h("dd", {}, ...(Array.isArray(value) ? value : [value])));
    const v = voiceName(), meet = meetLines(), when = whenLines(), ins = inLines(), starts = startLines();
    dl.replaceChildren(
      row("Voice", v ? `${v} (Discord voice)` : notAgreed()),
      row("Meeting point", meet.length ? meet.join("; ") : notAgreed()),
      row("Getting on", when.length ? when.join("; ") : "nobody has said yet"),
      row("In tonight", ins.length ? [ins.join("; "), ". ", h("a", { class: "tn-link", href: "#signups", text: "Sign-ups" })] : ["nobody has answered yet. ", h("a", { class: "tn-link", href: "#signups", text: "Sign-ups" })]),
      row("Where the five start", starts.length ? starts.join("; ") : "not on the board yet"));
  }
  /* the state buttons: the mirror's row for the key's person wins, then this device's own choice */
  const meSlug = () => { const m = K.MEM.member(); return m ? K.MEM.slug(m.name) : "just-looking"; };
  const localState = () => { const v = K.MEM.get(`launch-${meSlug()}`); return STATES.some(([k]) => k === v) ? v : null; };
  function currentState() { const B = window.BoardBrain, mine = B && B.mineLaunch ? B.mineLaunch() : null; return (mine && mine.state) || localState(); }
  function renderStates() {
    const row = $("#lh-st-row"); if (!row) return;
    const cur = currentState();
    row.replaceChildren(...STATES.map(([k, label, line]) => h("button", { type: "button", class: "lh-st", "data-state": k, "aria-pressed": String(cur === k), onclick: () => choose(k) },
      h("span", { class: "lh-wax", "aria-hidden": "true" }, h("span", { class: "lh-wax-lit" })), h("b", { class: "lh-st-name", text: label }), h("span", { class: "lh-st-line", text: line }))));
    renderWho(); renderStateSay();
  }
  function renderWho() {
    const who = $("#lh-st-who"), B = window.BoardBrain; if (!who) return;
    const rows = B && B.launch ? B.launch() : [];
    const groups = STATES.map(([k]) => [STATE_SAY[k], rows.filter((r) => r.state === k).map((r) => K.cleanName(r.name))]).filter(([, n]) => n.length);
    who.textContent = groups.length ? groups.map(([l, n]) => `${l}: ${n.join(", ")}.`).join(" ") : (B && B.status && B.status().base ? "Nobody has tapped a state yet." : "");
  }
  function renderStateSay() {
    const out = $("#lh-st-say"), B = window.BoardBrain; if (!out) return;
    const st = B && B.status ? B.status() : { base: null, key: false }, p = st.launchPending || null, local = localState();
    let text = "";
    if (p && p.state === "sending") text = `${STATE_SAY[p.value]}: sending.`;
    else if (p && p.state === "waiting") text = `${STATE_SAY[p.value]}: waiting for Discord.`;
    else if (p && p.state === "saved") text = `${STATE_SAY[p.value]}: saved. Leeroy tells #wow-forever.`;
    else if (p && p.state === "stored") text = `${STATE_SAY[p.value]}: saved. Discord catches up when Leeroy is back.`;
    else if (p && p.state === "failed") text = `${STATE_SAY[p.value]}: not sent, saved on this device.`;
    else if (local && (!st.base || !st.key || st.launchRefused || (p && p.state === "local"))) text = `${STATE_SAY[local]}: saved on this device.${!st.base ? "" : !st.key ? " With My board link from the Sign-ups card it reaches Discord too." : st.launchRefused || (p && p.state === "local") ? " Discord hears it once Leeroy's brain is updated." : ""}`;
    else if (local) text = `${STATE_SAY[local]}: saved.`;
    if (out.textContent !== text) out.textContent = text;
  }
  function choose(k) {
    if (!STATES.some(([x]) => x === k)) return;
    K.MEM.set(`launch-${meSlug()}`, k);
    L.local = k; sfx("stamp");
    const B = window.BoardBrain;
    const sent = B && B.setLaunch ? B.setLaunch(k) : Promise.resolve({ ok: false, local: true, why: "no brain" });
    renderStates();
    Promise.resolve(sent).then((r) => { L.sent = r || null; renderStates(); }).catch(() => renderStateSay());
  }
  /* the night-before list: the bot's own lines, ticked per viewer and per picked person in this browser only */
  const ticks = (slug) => { try { const a = JSON.parse(K.MEM.get(`launch-list-${slug}`) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch (e) { return []; } };
  function checkItems() {
    const LJ = K.D.launch, list = LJ && Array.isArray(LJ.checklist) && LJ.checklist.length ? LJ.checklist : FALLBACK_LIST, v = voiceName();
    return list.map((c) => ({ id: c.id, text: String(c.text).replace("{signups:meet}", meetSummary()).replace("{voice}", v || "not agreed yet") }));
  }
  function renderCheck() {
    const det = $("#lh-check"), list = $("#lh-check-list"), sum = $("#lh-check-sum"), count = $("#lh-check-count"); if (!det || !list) return;
    const slug = meSlug(), items = checkItems(), on = new Set(ticks(slug)), member = K.MEM.member();
    const upd = () => { const n = items.filter((i) => on.has(i.id)).length; sum.textContent = `Before launch: ${n} of ${items.length} ticked`; count.textContent = `${n} of ${items.length} ticked on this device${member ? ` for ${member.name}` : ""}. Nothing here leaves your browser.`; };
    list.replaceChildren(...items.map((i) => { const id = `lh-ck-${i.id}`; const li = h("li", { class: "lh-ck", "data-on": on.has(i.id) ? "1" : "0" });
      const input = h("input", { type: "checkbox", id, checked: on.has(i.id) ? true : null, onchange: () => { if (input.checked) on.add(i.id); else on.delete(i.id); li.dataset.on = input.checked ? "1" : "0"; K.MEM.set(`launch-list-${slug}`, on.size ? JSON.stringify([...on]) : null); upd(); sfx(input.checked ? "latch" : "chip"); } });
      li.append(h("label", { class: "lh-ck-tick", for: id }, input, h("span", { text: i.text }))); return li; }));
    /* open before launch where there is room for it (phones, tall screens); folded after launch; a hand that opened or closed it wins */
    if (!det.dataset.touched) det.open = L.phase !== "live" && (innerWidth < 1000 || innerHeight >= 900);
    if (!det.dataset.wired) { det.dataset.wired = "1"; det.addEventListener("toggle", () => { det.dataset.touched = "1"; }); }
    upd();
  }
  function renderSched() {
    const ol = $("#lh-moments"), box = $("#lh-sched"), LJ = K.D.launch; if (!ol || !box) return;
    const ms = LJ && Array.isArray(LJ.moments) ? LJ.moments.filter((m) => m && m.epoch).slice().sort((a, b) => a.epoch - b.epoch) : [];
    box.hidden = !ms.length;
    const now = nowS();
    ol.replaceChildren(...ms.map((m) => h("li", { class: "lh-moment", "data-past": m.epoch <= now ? "1" : "0" }, h("time", { class: "lh-m-when", datetime: new Date(m.epoch * 1000).toISOString(), text: hourOf(m.epoch) }), " ", h("span", { class: "lh-m-title", text: m.title }), m.ping === "all" ? h("span", { class: "lh-m-note", text: " (pings the five)" }) : m.kind === "countdown" ? h("span", { class: "lh-m-note", text: " (a card that counts down)" }) : null)));
  }
  function renderAsk() {
    const p = $("#lh-ask"); if (!p) return;
    const u = channelUrl();
    p.replaceChildren(K.emb("speech"), " ", h("b", { text: "Ask Leeroy: " }), "in ", u ? h("a", { class: "tn-link", href: u, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open #wow-forever on Discord" }, "#wow-forever") : "#wow-forever", " type ", h("b", { text: "/ask" }), " and your question, or tag Leeroy Jenkins in a message. He answers from the same library this board searches. ", h("a", { class: "tn-link", href: "#librarian", text: "His numbers so far" }), ".");
  }

  /* ---------- the clock: which phase, now, and every 30 s ---------- */
  function refresh() {
    const ph = phaseAt(nowS());
    if (ph !== L.phase) {
      L.phase = ph;
      if (!ph) { unmount(); document.documentElement.removeAttribute("data-launch"); return; }
      document.documentElement.setAttribute("data-launch", ph);
      if (!L.built) { if (!mount()) return; } else { renderHead(); renderLive(); renderCheck(); }
      K.emit("launch", ph);
    } else if (L.built) renderSched();
  }
  function start() {
    refresh();
    clearInterval(L.timer); L.timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
  /* data/launch.json: the schedule, the voice channel and the night-before list; the page works without it */
  const launchP = (async () => { try { const r = await fetch("data/launch.json", { cache: "no-store" }); if (!r.ok) return null; const j = await r.json(); return j && typeof j === "object" && !j.error ? j : null; } catch (e) { return null; } })();
  K.on("rendered", () => { launchP.then((j) => { if (j) K.D.launch = j; start(); }); });
  K.on("signups", () => { if (L.built) { renderFacts(); renderCheck(); } });
  K.on("tonight", () => { if (L.built) { renderStates(); renderCheck(); } });
  /* Forget me: every person's state and ticks on this device go (the known slugs by name; the sweep catches the rest) */
  K.on("forget", () => {
    const slugs = [...(K.D.party ? K.D.party.members.map((m) => K.MEM.slug(m.name)) : []), "just-looking", meSlug()];
    for (const s of slugs) { K.MEM.set(`launch-${s}`, null); K.MEM.set(`launch-list-${s}`, null); }
    try { Object.keys(localStorage).filter((k) => k.startsWith("board-launch-")).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
    L.local = null; if (L.built) { renderStates(); renderCheck(); }
  });
  const B = window.BoardBrain;
  if (B && B.on) { B.on("launch", () => { if (L.built) renderStates(); }); B.on("launchPending", () => { if (L.built) renderStateSay(); }); B.on("me", () => { if (L.built) renderStates(); }); B.on("status", () => { if (L.built) renderStateSay(); }); }
  window.__v15 = Object.freeze({ phaseAt, opensHere, WINDOW, _refresh: refresh, status: () => ({ phase: L.phase, built: L.built, state: currentState(), local: localState(), slug: meSlug(), sent: L.sent }) });
})();
