// The door: renders the reimagined first screen (docs/cinematic/door.md) from the board's own bootstrap document.
// - Data: window.BoardBrain.bootstrap() from js/brain.js, so the door talks to the same API origin as the board (production, a PR preview's own Worker,
//   or ?brain= locally) and sends no key and no cookie. After launch night sign-ups are counted by js/signups-week.js (window.BoardWeek), the board's own
//   weekly rule, loaded only then (before launch the server's tallies are the count and the script is not needed on the first frame).
// - It writes nothing itself: no storage, no API write (js/brain.js, shared with the board, keeps a board key from a #k= link, as it does everywhere). It reads the board's board-me / board-as keys to know a returning member.
// - Zero idle loops: no timer and no animation frame runs after the first render. The date words are recomputed when the tab comes back into view.
// - The map (door/map.js, Canvas 2D) loads when its card nears the viewport; the tavern room (door/room.js, WebGL) loads only when a person steps in.
import { meFrom, nextEvent, eventLabel, openWords, whenWords, signupView, partyView, discordUrl, launchMs, RSVP_SAY, sameName } from "./model.js?v=231bef223f";

const $ = (s) => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
const KNOWN = new Set(["druid", "priest", "paladin", "mage", "warlock", "hunter", "rogue", "shaman", "warrior"]);
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
const store = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "text") n.textContent = v; else if (k === "style") n.style.cssText = v; else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false && c !== "") n.append(c);
  return n;
}
function svgUse(cls, href, box) {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
  if (box) s.setAttribute("viewBox", box);
  const u = document.createElementNS(SVGNS, "use"); u.setAttribute("href", href); s.append(u);
  return s;
}
// A class crest: the brass medallion (enamel in the class colour) and the class glyph, both from the sprite in index.html.
function crest(key) {
  const s = svgUse("crest", "#crest", "0 0 64 64");
  const g = document.createElementNS(SVGNS, "use");
  g.setAttribute("href", `#g-${KNOWN.has(key) ? key : "none"}`);
  for (const [k, v] of Object.entries({ x: 16, y: 16, width: 32, height: 32 })) g.setAttribute(k, String(v));
  s.append(g);
  return s;
}
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));
const MIX = typeof CSS !== "undefined" && CSS.supports && CSS.supports("color", "color-mix(in srgb, red 50%, blue)");

function renderNext(j) {
  const what = $("#next-what"), when = $("#next-when"), now = Date.now(), ev = nextEvent(j.timeline, now);
  if (!ev) { what.textContent = "No new date on the board yet"; when.textContent = "The Dates page has everything that is known."; return; }
  const w = whenWords(ev, now);
  what.textContent = eventLabel(ev, j.tonight);
  // an open window says what the board says ("Open now, until the end of Nov 3, Pacific time"): its end is a calendar day in one zone, not a moment
  when.textContent = ev.isOpen ? openWords(ev, j.tonight) || `${w.rel.charAt(0).toUpperCase()}${w.rel.slice(1)}` : [w.date, w.time ? `${w.time} your time` : "", w.rel].filter(Boolean).join(" · ");
}

const SEAT = { in: "p-full", late: "p-half", maybe: "p-half", out: "p-out" };
const SEAT_ORDER = ["in", "late", "maybe", null, "out"];
function renderSignups(j, me) {
  const v = signupView(j.signups, j.party, j.timeline, Date.now(), window.BoardWeek && window.BoardWeek.week);
  const who = $("#su-who"), you = $("#su-you"), tally = $("#su-tally"), seats = $("#su-seats");
  if (!v) { who.textContent = "The sign-up card has no answers on the board yet."; tally.hidden = true; return null; }
  $("#su-sub").textContent = v.phase === "week" ? "This week's answers" : "Answers for launch night";
  const c = v.counts, big = (n, label) => h("p", { class: "big" }, h("b", { text: String(n) }), h("span", { text: label }));
  tally.replaceChildren(big(c.in, "in"), big(c.none, c.none === 1 ? "has not answered" : "not answered"));
  const order = (s) => SEAT_ORDER.indexOf(s.state);
  seats.replaceChildren(...v.seats.slice().sort((a, b) => order(a) - order(b)).map((s) => h("li", { class: `seat ${s.state || "none"}` }, svgUse("", `#${SEAT[s.state] || "p-empty"}`, "0 0 24 24"))));
  const groups = [["in", "In"], ["late", "Running late"], ["maybe", "Tentative"], ["out", "Out"], [null, "Not answered yet"]]
    .map(([k, label]) => [label, v.seats.filter((s) => s.state === k).map((s) => s.name)]).filter(([, ns]) => ns.length);
  // nobody has answered this week: the board's own two lines (nobody yet, and when the last answers were) instead of a list of everyone
  if (v.empty && !c.in && !c.late && !c.maybe && !c.out) who.replaceChildren(h("b", { text: v.empty.nobody }), " ", v.empty.last);
  else who.replaceChildren(...groups.flatMap(([label, ns], i) => [i ? " " : "", h("b", { text: `${label}:` }), ` ${andList(ns)}.`]));
  const mine = me ? v.mine(me) : null;
  if (me) {
    you.textContent = mine && mine.state ? `You said ${RSVP_SAY[mine.state]}${mine.when && mine.state !== "out" ? `, for ${mine.when}` : ""}.` : `You have not answered ${v.phase === "week" ? "for this week" : "for launch night"} yet.`;
  }
  return mine;
}

function renderParty(j, me) {
  const v = partyView(j.party), list = $("#pt-list");
  if (!v) { list.replaceChildren(h("li", { class: "pm pm-wait", text: "The party is not on the board yet." })); return; }
  $("#pt-h").textContent = v.title;
  list.replaceChildren(...v.list.map((m) => {
    const cc = KNOWN.has(m.classKey) ? `var(--c-${m.classKey})` : "var(--c-none)";
    const build = [m.race, m.cls].filter(Boolean).join(" ");
    return h("li", { class: "pm", style: `--cc: ${cc}; --enamel: ${MIX ? `color-mix(in srgb, ${cc} 58%, #1d140d)` : cc}` },
      crest(m.classKey),
      h("span", { class: "pm-name", text: me && sameName(me.name, m.name) ? `${m.name} (you)` : m.name }),
      h("span", { class: "pm-build" }, build, m.role ? h("span", { class: "pm-role", text: ` · ${m.role}` }) : null));
  }));
  $("#pt-roles").textContent = v.roleLine ? `Roles: ${v.roleLine}` : "";
}

// The one action: answer the sign-up card in Discord (first visit, or a member who has not answered), else see who is coming.
function renderGo(j, me, mine) {
  const go = $("#go"), text = $("#go-text"), ico = $("#go-ico");
  const url = discordUrl(j.party && j.party.signup_url) || discordUrl(j.tonight && j.tonight.links && j.tonight.links.signup);
  if (me && mine && mine.state) {
    go.setAttribute("href", "#c-signups"); go.removeAttribute("target"); go.removeAttribute("rel");
    text.textContent = "See who is coming"; ico.setAttribute("href", "#i-down");
    return;
  }
  if (url) {
    go.setAttribute("href", url); go.setAttribute("target", "_blank"); go.setAttribute("rel", "noopener noreferrer");
    text.replaceChildren("Answer the sign-up card", h("span", { class: "sr-only", text: " (opens Discord)" })); ico.setAttribute("href", "#i-out");
  }
}

// Light means relevance: the member's own answer is the hero once the door knows who they are; on a first visit the invitation is.
function setTiers(me) {
  $(".title-card").dataset.tier = me ? "2" : "1";
  $("#c-signups").dataset.tier = me ? "1" : "2";
}

function lazyRoads(j) {
  const card = $("#c-roads"), list = $("#rd-list");
  let io = null, started = false;
  const start = () => {
    if (started) return; started = true; if (io) io.disconnect();
    import("./map.js?v=46e6da5568")
      .then((m) => m.drawRoads({ canvas: $("#map"), list, caption: $("#rd-cap"), heading: $("#rd-h"), party: j.party, reduce: () => reduceMQ.matches }))
      .catch(() => { list.replaceChildren(h("li", { class: "road road-wait", text: "The map did not load. The board has it under Three roads." })); });
  };
  if ("IntersectionObserver" in window) { io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) start(); }, { rootMargin: "320px 0px" }); io.observe(card); } else start();
}

function wireRoom() {
  const btn = $("#room-go");
  btn.addEventListener("click", () => {
    btn.setAttribute("aria-busy", "true"); // not disabled: a disabled button cannot take focus back when the dialog closes while the room is still loading
    import("./room.js?v=8f90f4660f")
      .then((m) => m.openRoom({ dialog: $("#room"), opener: btn }))
      .catch(() => { $("#rm-say").textContent = "The room did not load. Try again in a moment."; })
      .finally(() => { btn.removeAttribute("aria-busy"); });
  });
}

// The map is static data (world.json, routes.json), so it is drawn even when the API is down or slow; the roads then carry no names.
const BOOT_MS = 10000;
function offline() {
  $("#next-what").textContent = "The dates did not load";
  $("#next-when").textContent = "The board may still have them.";
  $("#su-who").textContent = "The sign-up card did not load.";
  $("#su-tally").hidden = true;
  $("#pt-list").replaceChildren(h("li", { class: "pm pm-wait", text: "The party did not load." }));
  lazyRoads({ party: null });
}

// the board's weekly sign-up rule, a classic script that sets window.BoardWeek; on failure the count falls back to the server's tallies
const WEEK = new URL("../js/signups-week.js?v=a788265af1", import.meta.url).href;
function weekRule() {
  if (window.BoardWeek) return Promise.resolve();
  return new Promise((done) => { const s = document.createElement("script"); s.src = WEEK; s.onload = s.onerror = () => done(); document.head.append(s); });
}

async function main() {
  document.documentElement.classList.add("js");
  wireRoom();
  const table = $("#table");
  let j = null;
  try { const B = window.BoardBrain; j = B && typeof B.bootstrap === "function" ? await Promise.race([B.bootstrap(), new Promise((r) => setTimeout(() => r(null), BOOT_MS))]) : null; } catch (e) { j = null; }
  if (!j || typeof j !== "object") { offline(); table.setAttribute("aria-busy", "false"); return; }
  const me = meFrom(store, j.party);
  if (Date.now() >= launchMs(j.timeline)) await weekRule();
  renderNext(j);
  const mine = renderSignups(j, me);
  renderParty(j, me);
  renderGo(j, me, mine);
  setTiers(me);
  table.setAttribute("aria-busy", "false");
  lazyRoads(j);
  // the date words and this week's count are recomputed when the person comes back to the tab (no timer runs meanwhile)
  const again = () => { if (!document.hidden) { renderNext(j); renderGo(j, me, renderSignups(j, me)); } };
  document.addEventListener("visibilitychange", again);
  addEventListener("pageshow", (e) => { if (e.persisted) again(); });
}
main();
