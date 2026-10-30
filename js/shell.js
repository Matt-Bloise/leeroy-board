/* The phone shell (notes/VISION-MOBILE.md M1; contract section 4; 2026-10-30): on a phone the scene's bottom bar ... Full note: board/MOBILE-NOTES.md, file notes. */
(() => {
"use strict";
const K = window.__boardKit; if (!K || typeof document === "undefined") return;
const { $, h } = K;
const PHONE_MQ = "(max-width: 699px), ((max-height: 500px) and (orientation: landscape) and (pointer: coarse))";
const PLACES = ["tonight", "five", "sheet", "librarian", "more"];
const LABEL = { tonight: "Tonight", five: "The five", sheet: "My sheet", librarian: "Leeroy", more: "More" };
const PHONE_ORDER = ["tonight", "five", "signups", "librarian", "timeline", "roads", "racials", "legacy", "buffs", "ledger", "decide", "library"];
const REST = PHONE_ORDER.filter((k) => !["tonight", "five", "librarian"].includes(k));
const ICON_OF = { tonight: "tonight", five: "five", sheet: "five", librarian: "librarian" };
const BANNER = { timeline: "indigo", five: "royal", roads: "burnt-orange", racials: "crimson", legacy: "copper", buffs: "plum", ledger: "wine", signups: "forest", librarian: "slate", library: "ochre", decide: "olive", tonight: "teal" };
const HTML = document.documentElement;
const S = { phone: false, built: false, saved: null, place: null, coinKey: null, coinSpin: false, coinX: 0, spring: null, firstFillMs: 0, toastT: 0, scrollSp: null };
const mm = (q) => { try { return matchMedia(q); } catch (e) { return { matches: false }; } };
const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
const coarse = () => mm("(pointer: coarse)").matches;
const isPhone = () => mm("(max-width: 699px)").matches || mm("(max-height: 500px) and (orientation: landscape) and (pointer: coarse)").matches;
const hap = (n) => { try { const H = window.BoardHaptics; if (H) H.fire(H.PAT && H.PAT[n] ? n : n === "select" ? "tab" : n); } catch (e) {} };
const bar = () => $("#bottombar");
const placeBtn = (p) => { const b = bar(); return b ? b.querySelector(`[data-place="${p}"]`) : null; };
const moveMs = () => (K.MOTION && K.MOTION.move) || 520;

/* ---- which place a scene lights ---- */
const sheetView = () => { try { return !!(window.__sheet && window.__sheet.status().view === "sheet"); } catch (e) { return false; } };
function placeFor(key) {
  if (!key) return null;
  if (key === "five") return sheetView() ? "sheet" : "five";
  return key === "tonight" || key === "librarian" ? key : "more";
}
function markPlaces() {
  const b = bar(); if (!b || !S.phone) return;
  const p = placeFor(K.SC.open), was = S.place; S.place = p;
  for (const x of b.querySelectorAll("[data-place]")) x.setAttribute("aria-current", String(x.dataset.place === p));
  if (p !== was) K.emit("place", p);
  placeCoin();
}

/* ---- the bar ---- */
function icon(place) {
  const wrap = h("span", { class: "pl-ico", "aria-hidden": "true" });
  if (place === "sheet") { const m = K.MEM.member(); if (m) { wrap.append(K.crestMark(m, "pl-crest")); return wrap; } }
  if (place === "more") { wrap.append(K.emb("seal")); return wrap; }
  const src = $(`#tab-${ICON_OF[place]} .tab-ico`), first = src && src.firstChild;
  wrap.append(first && first.cloneNode ? first.cloneNode(true) : K.emb("seal"));
  return wrap;
}
function refreshSheetIcon() {
  const b = placeBtn("sheet"); if (!b) return;
  const old = b.querySelector(".pl-ico"), m = K.MEM.member(), has = !!(old && old.querySelector(".pl-crest"));
  if (!!m === has && (m || old)) return;
  const fresh = icon("sheet"), txt = b.querySelector(".pl-txt"); b.replaceChildren(fresh, txt);
}
function build() {
  const b = bar(); if (!b || S.built) return;
  const t0 = performance.now();
  S.saved = [...b.children];
  const pl = PLACES.map((p) => h("button", { class: "pl", type: "button", "data-place": p, "aria-current": "false", "aria-haspopup": p === "more" ? "dialog" : null, "aria-expanded": p === "more" ? "false" : null }, icon(p), h("span", { class: "pl-txt", text: LABEL[p] })));
  const coin = h("button", { class: "bb-coin", id: "bb-coin", type: "button", "aria-label": "The scene's coin: press it as you would the seal" }, h("img", { class: "bb-coin-img", alt: "", width: 36, height: 36, decoding: "async" }));
  b.replaceChildren(...pl, coin);
  b.setAttribute("aria-label", "Places");
  S.built = true; S.coinKey = null;
  markPlaces();
  S.firstFillMs = Math.round((performance.now() - t0) * 10) / 10;
}
function teardown() {
  const b = bar();
  closeMore();
  if (S.spring) { try { S.spring.stop(); } catch (e) {} S.spring = null; }
  if (b && S.built && S.saved) {
    b.replaceChildren(...S.saved);
    b.setAttribute("aria-label", "Scene shortcuts");
    for (const x of b.querySelectorAll("[data-go]")) x.setAttribute("aria-current", String(x.dataset.go === K.SC.open));
  }
  S.built = false; S.saved = null; S.place = null; S.coinKey = null;
  const head = $(".sheet-head"); if (head) { head.style.removeProperty("--sway"); head.removeAttribute("data-pscene"); }
}

/* ---- the coin ---- */
function coinImg() { const c = $("#bb-coin"); return c ? c.querySelector("img") : null; }
function placeCoin() {
  const c = $("#bb-coin"), p = placeBtn(S.place || "more"); if (!c || !p) return;
  const x = (p.offsetLeft || 0) + (p.offsetWidth || 0) / 2 - 18;
  S.coinX = x;
  const SP = window.BoardSpring;
  if (SP && !reduced() && coarse()) {
    if (!S.spring) S.spring = SP.spring({ preset: "firm", x, target: x, onFrame: (v) => { c.style.transform = `translateX(${v.toFixed(1)}px)`; } });
    else S.spring.set(x);
  } else { if (S.spring) { try { S.spring.stop(); } catch (e) {} S.spring = null; } c.style.transform = `translateX(${x}px)`; }
}
function setCoin(key) {
  const c = $("#bb-coin"), img = coinImg(); if (!c || !img || !key) return;
  if (S.coinKey === key) return;
  const first = !S.coinKey; S.coinKey = key;
  if (first) { K.medalSet(img, key); return; }
  if (reduced()) { c.classList.add("fade"); K.medalSet(img, key); setTimeout(() => c.classList.remove("fade"), 120); return; }
  c.classList.add("spin"); S.coinSpin = true;
  const swap = () => { if (S.coinKey === key) K.medalSet(img, key); };
  const m = K.medalLoad(key); /* the back face is decoded before the coin turns edge-on */
  setTimeout(() => { if (m.ok) swap(); else m.p.then(swap); }, Math.round(moveMs() / 2));
  setTimeout(() => { c.classList.remove("spin"); S.coinSpin = false; }, moveMs());
}
function say(msg) {
  const t = $("#toast"); if (!t) return;
  clearTimeout(S.toastT); t.replaceChildren(h("span", { text: msg })); t.hidden = false;
  S.toastT = setTimeout(() => { t.hidden = true; }, 2400);
}
function pressCoin() {
  const btn = $("#seal .seal-btn"); if (btn) btn.click();
  setTimeout(() => { const n = $("#seal .seal-say"), t = n && n.textContent.trim(); if (t) say(t); }, moveMs() + 200);
}

/* ---- the head on a phone ---- */
function headFor(key) {
  const head = $(".sheet-head"); if (!head || !S.phone) return;
  head.setAttribute("data-pscene", BANNER[key] ? key : "tonight");
  head.style.setProperty("--sway", "0"); /* a scene change ends any swipe, so the sway is at rest */
}

/* ---- going to a place ---- */
function toTop() {
  const body = $("#sheet-body"); if (!body) return;
  const SP = window.BoardSpring, from = body.scrollTop || 0;
  if (!from) return;
  if (S.scrollSp) { try { S.scrollSp.stop(); } catch (e) {} S.scrollSp = null; }
  if (SP && !reduced()) S.scrollSp = SP.spring({ preset: "firm", x: from, target: 0, onFrame: (v) => { body.scrollTop = v; }, onRest: () => { body.scrollTop = 0; S.scrollSp = null; } });
  else body.scrollTop = 0;
}
function openMySheet() {
  const m = K.MEM.member();
  if (m && window.__sheet) { window.__sheet.openSheet(K.MEM.slug(m.name), true); return; }
  K.goScene("tonight");
  say("Pick who you are on Tonight and this place opens your sheet.");
  setTimeout(() => { const f = $("#tn-me .tn-name") || $("#tn-me"); if (f && f.focus) f.focus({ preventScroll: true }); }, moveMs() / 2);
}
function go(place) {
  hap("select");
  if (place === "more") { openMore(); return; }
  const current = S.place === place && K.SC.open !== null;
  if (current) { toTop(); return; }
  if (place === "sheet") openMySheet(); else K.goScene(place);
}

/* ---- the More sheet ---- */
function closeMore() {
  const B = window.BoardSheets, mb = placeBtn("more");
  if (B && B.status().open === "more") B.close("more");
  if (mb) mb.setAttribute("aria-expanded", "false");
}
function soundOn() { try { return !!window.__board.sound(); } catch (e) { return false; } }
function newDot(key) { return !!document.querySelector(`#board [data-scene="${key}"] .new-badge`); }
function openMore() {
  const B = window.BoardSheets, mb = placeBtn("more"); if (!B) return Promise.resolve();
  const act = (f) => () => { B.close("more"); if (mb) mb.setAttribute("aria-expanded", "false"); f(); };
  const row = (label, f, lead, cls) => h("button", { class: `bsheet-row${cls ? ` ${cls}` : ""}`, type: "button", onclick: act(f) }, lead || null, h("span", { class: "bsheet-row-txt", text: label }));
  const roomTxt = () => { const r = $("#more-room"); return (r && r.textContent.trim()) || "Room: auto"; };
  if (mb) mb.setAttribute("aria-expanded", "true");
  return B.open({
    id: "more", title: "More places", start: "full", returnTo: mb || undefined,
    onClose: () => { if (mb) mb.setAttribute("aria-expanded", "false"); },
    build(body) {
      const list = h("div", { class: "more-list", role: "group", "aria-label": "Places" });
      for (const k of REST) {
        if (!K.SCENES.includes(k)) continue;
        const img = h("img", { class: "more-medal", alt: "", width: 36, height: 36, decoding: "async" }); K.medalSet(img, k);
        list.append(row(K.TITLES[k] || k, () => K.goScene(k), img, K.SC.open === k ? "now" : ""));
        if (newDot(k)) list.lastChild.append(h("span", { class: "new-dot", text: "New" }));
      }
      const util = h("div", { class: "more-list more-util", role: "group", "aria-label": "This board" });
      util.append(
        row("The wall", () => K.requestClose()),
        row(`Sound: ${soundOn() ? "on" : "off"}`, () => { try { window.__board.sound(!soundOn()); } catch (e) {} }),
        row(roomTxt(), () => { const r = $("#more-room"); if (r) r.click(); }),
        row("Sound and feel", () => { const r = $("#sense-btn"); if (r) r.click(); }),
        row("What this phone can do", () => { location.hash = "#probe"; }),
        row("Clear my name", () => { const r = $("#lib-forget"); if (r) r.click(); }));
      body.append(list, util);
    },
  });
}

/* ---- mode changes ---- */
function apply() {
  const on = isPhone();
  if (on === S.phone) { if (on) placeCoin(); return; }
  S.phone = on;
  HTML.classList.toggle("phone-shell", on);
  if (on) { if (K.SC.open !== null) { build(); headFor(K.SC.open); setCoin(K.SC.open); } }
  else teardown();
}
function onKey(e) {
  const t = e && e.target; if (!t || !t.closest || !t.closest("[data-place]")) return;
  const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
  const list = PLACES.map(placeBtn).filter(Boolean), i = list.indexOf(t.closest("[data-place]")); if (i < 0) return;
  e.preventDefault(); list[(i + d + list.length) % list.length].focus();
}
function onClick(e) {
  const t = e && e.target; if (!S.phone || !t || !t.closest) return;
  const p = t.closest("[data-place]"); if (p) { go(p.dataset.place); return; }
  if (t.closest("#bb-coin")) pressCoin();
}

sceneHooksInit();
function sceneHooksInit() {
  K.sceneHooks.push((open) => { if (open && S.phone && !S.built) { build(); } });
  K.on("scene", (key) => { if (!S.phone) return; build(); headFor(key); setCoin(key); refreshSheetIcon(); markPlaces(); setTimeout(markPlaces, 0); });
  const five = $("#panel-five"); if (five) five.addEventListener("click", () => { if (S.phone) setTimeout(markPlaces, 60); }, true); /* The five folds between its cards and a sheet */
  K.on("sheet", () => { if (S.phone) { refreshSheetIcon(); markPlaces(); } });
  K.on("closed", () => { if (S.phone) closeMore(); });
}
const b0 = bar();
if (b0) { b0.addEventListener("click", onClick); b0.addEventListener("keydown", onKey); }
addEventListener("resize", () => { apply(); if (S.phone) { placeCoin(); markPlaces(); } });
addEventListener("hashchange", () => { if (S.phone) markPlaces(); });
for (const q of ["(max-width: 699px)", "(max-height: 500px) and (orientation: landscape) and (pointer: coarse)"]) { const m = mm(q); if (m && m.addEventListener) m.addEventListener("change", apply); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.phone) placeCoin(); }, () => {});
apply();

window.BoardShell = Object.freeze({
  phone: () => S.phone,
  ownsSwipe: () => S.phone && coarse() && !reduced(),
  place: () => S.place,
  status: () => ({ phone: S.phone, place: S.place, coin: { key: S.coinKey, spinning: S.coinSpin, x: S.coinX }, more: !!(window.BoardSheets && window.BoardSheets.status().open === "more"), bar: S.built ? (bar() ? bar().querySelectorAll(".pl").length : 0) : 0, firstFillMs: S.firstFillMs }),
  PHONE_MQ,
});
})();
