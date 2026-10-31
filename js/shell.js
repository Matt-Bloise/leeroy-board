(() => {
"use strict";
const K = window.__boardKit; if (!K || typeof document === "undefined") return;
const { $, h } = K;
const MQS = ["(max-width: 699px)", "(max-height: 500px) and (orientation: landscape) and (pointer: coarse)"], PHONE_MQ = `${MQS[0]}, (${MQS[1]})`;
const PLACES = ["tonight", "five", "sheet", "librarian", "more"];
const LABEL = { tonight: "Next", five: "The five", sheet: "My sheet", librarian: "Leeroy", more: "More" };
const PHONE_ORDER = ["tonight", "five", "signups", "librarian", "timeline", "roads", "racials", "legacy", "buffs", "ledger", "decide", "library"];
const REST = PHONE_ORDER.filter((k) => !["tonight", "five", "librarian"].includes(k));
const ICO = { tonight: "icons/tab-tonight.png", five: "icons/tab-five.png", sheet: "emblems/dates/scroll.webp", librarian: "icons/tab-librarian.png", more: "emblems/chips/seal.webp" };
const raf = (f) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : setTimeout(f, 16));
const HTML = document.documentElement;
const S = { phone: false, built: false, saved: null, place: null, coinKey: null, spring: null, toastT: 0, scrollSp: null, pick: false };
const mm = (q) => { try { return matchMedia(q); } catch (e) { return { matches: false }; } };
const reduced = () => !!(K.reduceMQ && K.reduceMQ.matches);
const coarse = () => mm("(pointer: coarse)").matches;
const isPhone = () => MQS.some((q) => mm(q).matches);
const hap = (n) => { try { const H = window.BoardHaptics; if (H) H.fire(H.PAT && H.PAT[n] ? n : n === "select" ? "tab" : n); } catch (e) {} };
const bar = () => $("#bottombar");
const placeBtn = (p) => { const b = bar(); return b ? b.querySelector(`[data-place="${p}"]`) : null; };
const moveMs = () => (K.MOTION && K.MOTION.move) || 520;

const sheetView = () => { try { return !!(window.__sheet && window.__sheet.status().view === "sheet"); } catch (e) { return false; } };
function placeFor(key) {
  if (!key) return null;
  if (S.pick) return "sheet";
  if (key === "five") return sheetView() ? "sheet" : "five";
  return key === "tonight" || key === "librarian" ? key : "more";
}
function markPlaces() {
  const b = bar(), p = placeFor(K.SC.open), m = S.mine;
  if (m) m.setAttribute("aria-current", String(p === "sheet"));
  if (!b || !S.phone) return;
  refreshSheetIcon();
  const was = S.place; S.place = p;
  for (const x of b.querySelectorAll("[data-place]")) x.setAttribute("aria-current", String(x.dataset.place === p));
  if (p !== was) K.emit("place", p);
  if (K.SC.open !== null) setCoin(p === "sheet" ? "sheet" : K.SC.open);
  placeCoin();
}

function icon(place) {
  const m = place === "sheet" && K.MEM.member();
  return h("span", { class: "pl-ico", "aria-hidden": "true" }, m ? K.crestMark(m, "pl-img pl-crest") : h("img", { class: "pl-img", src: `img/${ICO[place]}`, alt: "", width: 22, height: 22, decoding: "async" }));
}
function refreshSheetIcon() {
  const b = placeBtn("sheet"); if (!b) return;
  const old = b.querySelector(".pl-ico"), m = K.MEM.member(), has = !!(old && old.querySelector(".pl-crest"));
  if (!!m === has && (m || old)) return;
  const fresh = icon("sheet"), txt = b.querySelector(".pl-txt"); b.replaceChildren(fresh, txt);
}
function build() {
  const b = bar(); if (!b || S.built) return;
  S.saved = [...b.children];
  const pl = PLACES.map((p) => h("button", { class: "pl", type: "button", "data-place": p, "aria-current": "false", "aria-haspopup": p === "more" ? "dialog" : null, "aria-expanded": p === "more" ? "false" : null }, icon(p), h("span", { class: "pl-txt", text: LABEL[p] })));
  const coin = h("button", { class: "bb-coin off", id: "bb-coin", type: "button", "aria-label": "The scene's coin: press it as you would the seal" }, h("img", { class: "bb-coin-img", alt: "", width: 36, height: 36, decoding: "async" }));
  b.replaceChildren(...pl, coin);
  b.setAttribute("aria-label", "Places");
  S.built = true; S.coinKey = null;
  markPlaces();
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
  const head = $(".sheet-head"); if (head) { for (const v of ["--sway", "--dye", "--crest"]) head.style.removeProperty(v); head.removeAttribute("data-pscene"); }
}

function coinImg() { const c = $("#bb-coin"); return c ? c.querySelector("img") : null; }
function placeCoin() {
  const c = $("#bb-coin"), p = placeBtn(S.place || "more"); if (!c || !p) return;
  const w = p.offsetWidth || 0; c.classList.toggle("off", !w); if (!w) return;
  const x = (p.offsetLeft || 0) + w / 2 - 18;
  const SP = window.BoardSpring;
  if (SP && !reduced() && coarse()) {
    if (!S.spring) S.spring = SP.spring({ preset: "firm", x, target: x, onFrame: (v) => { c.style.transform = `translateX(${v.toFixed(1)}px)`; } });
    else S.spring.set(x);
  } else { if (S.spring) { try { S.spring.stop(); } catch (e) {} S.spring = null; } c.style.transform = `translateX(${x}px)`; }
}
function face(img, key) {
  if (!key.startsWith("sheet")) { K.medalSet(img, key); return; }
  const m = K.MEM.member(); img.removeAttribute("data-medal"); img.setAttribute("src", m ? `img/crests/${m.class_key}.png` : `img/${ICO.sheet}`);
}
function setCoin(key0) {
  const c = $("#bb-coin"), img = coinImg(); if (!c || !img || !key0) return;
  const m = key0 === "sheet" && K.MEM.member(), key = m ? `sheet-${m.class_key}` : key0;
  if (S.coinKey === key) return;
  const first = !S.coinKey; S.coinKey = key;
  if (first) { face(img, key); return; }
  if (reduced()) { c.classList.add("fade"); face(img, key); setTimeout(() => c.classList.remove("fade"), 120); return; }
  c.classList.add("spin");
  const swap = () => { if (S.coinKey === key) face(img, key); };
  const ld = key0 === "sheet" ? { ok: true } : K.medalLoad(key);
  setTimeout(() => { if (ld.ok) swap(); else ld.p.then(swap); }, Math.round(moveMs() / 2));
  setTimeout(() => { c.classList.remove("spin"); }, moveMs());
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

function headFor(key) {
  const head = $(".sheet-head"); if (!head || !S.phone) return;
  const k = PHONE_ORDER.includes(key) ? key : "tonight"; head.setAttribute("data-pscene", k);
  head.style.setProperty("--sway", "0"); head.style.setProperty("--dye", `var(--dye-${k})`); head.style.setProperty("--crest", "url" + "(" + String(location.href).replace(/[#?].*$/, "").replace(/[^/]*$/, "") + "img/icons/tab-" + k + ".png)");
  const nm = $(".sheet-name"); if (nm) { nm.classList.remove("unroll"); void nm.offsetWidth; nm.classList.add("unroll"); }
}

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
  const open = () => { if (!window.__sheet) return false; window.__sheet.openSheet(K.MEM.slug(m.name), true); return true; };
  if (m && open()) return;
  if (m && window.__scenes) { window.__scenes.load("sheet").then(() => { if (!open()) K.goScene("five"); }); return; }
  pickSheet();
}
function pickSheet() {
  const B = window.BoardSheets, P = K.D && K.D.party; if (!B || !P) { K.goScene("five"); return; }
  const mb = placeBtn("sheet") || S.mine;
  const pick = (m) => { K.MEM.setMe(K.MEM.slug(m.name)); unpick(); try { K.render.tonight(); } catch (e) {} openMySheet(); };
  S.pick = true; markPlaces();
  B.open({
    id: "pick", title: "Whose sheet?", start: "peek", peek: 0.4, returnTo: mb || undefined,
    onClose: () => { if (S.pick) { S.pick = false; markPlaces(); } },
    build(body) {
      body.append(h("div", { class: "tn-pick sh-pick", id: "sh-pick", role: "group", "aria-label": "Whose sheet? Pick a name." },
        ...P.members.map((m) => h("button", { type: "button", class: "lib-tool tn-name", style: `--cc: ${K.classVar(m.class_key)}`, onclick: () => pick(m) }, K.crestMark(m), m.name))));
    },
  });
  const first = $("#sh-pick button"); if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) {} }
}
function unpick() {
  const B = window.BoardSheets; if (B && B.status().open === "pick") B.close("pick");
  if (S.pick) { S.pick = false; markPlaces(); }
}
const quietTab = () => typeof K.switchTab === "function" && /quiet/.test(String(K.switchTab));
function go(place) {
  hap("select");
  if (place !== "sheet") unpick();
  if (place === "more") { openMore(); return; }
  const current = S.place === place && K.SC.open !== null;
  if (current) { toTop(); return; }
  if (place === "sheet") openMySheet(); else if (K.SC.open !== null && quietTab()) K.switchTab(place, { quiet: true }); else K.goScene(place);
}

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
  const row = (label, f, lead, cls) => h("button", { class: `bsheet-row${cls ? ` ${cls}` : ""}`, type: "button", onclick: act(f) }, typeof lead === "string" ? h("img", { class: "more-medal", src: `img/emblems/${lead}.webp`, alt: "", width: 36, height: 36, decoding: "async" }) : lead, h("span", { class: "bsheet-row-txt", text: label }));
  const roomTxt = () => { const r = $("#more-room"), v = ((r && r.textContent) || "").replace(/^\s*Room:\s*/, "").trim() || "auto"; return `Tavern room: ${v === "auto" ? "automatic" : v}`; };
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
        if (k === "roads" && window.BoardAtlas) list.append(row("Atlas", () => window.BoardAtlas.open(), "ornaments/compass"));
      }
      const util = h("div", { class: "more-list more-util", role: "group", "aria-label": "This board" });
      util.append(
        row("Home (the wall)", () => K.requestClose(), "ornaments/banner"),
        row(`Sound: ${soundOn() ? "on" : "off"}`, () => { try { window.__board.sound(!soundOn()); } catch (e) {} }, "dates/horn"),
        row(`Play mode: ${document.documentElement.classList.contains("play") ? "on" : "off"}`, () => { const r = $("#mode-btn"); if (r) r.click(); }, "ornaments/candle"),
        row(roomTxt(), () => { const r = $("#more-room"); if (r) r.click(); }, "ornaments/tankard"),
        row("Sound and feel", () => { const r = $("#sense-btn"); if (r) r.click(); }, "chips/voice"),
        row("What this phone can do", () => { location.hash = "#probe"; }, "chips/question"),
        row("Forget me on this browser", () => { const r = $("#lib-forget"); if (r) r.click(); }, "chips/lock"));
      body.append(list, util);
    },
  });
}

function dockMine() {
  const sc = K.SC.open !== null, peek = $("#scene-peek"), pill = $("#sense-btn"), par = S.phone ? 0 : !sc ? $("#footer") : innerWidth >= 1024 && peek && peek.parentNode;
  let b = S.mine; if (!par) { if (b) b.remove(); return; }
  b = b || (S.mine = h("button", { class: "lib-tool my-sheet", type: "button", "aria-label": "Open my sheet", onclick: () => openMySheet() }, LABEL.sheet));
  const c = [...par.childNodes], nx = (n) => c[c.indexOf(n) + 1] || null, at = pill && pill.parentNode === par && (!sc || nx(peek) === pill) ? pill : sc && peek, ref = at ? nx(at) : c[0] || null;
  if (ref !== b) par.insertBefore(b, ref);
  markPlaces();
}
function apply() {
  const on = isPhone();
  if (on === S.phone) { if (on) placeCoin(); return; }
  S.phone = on;
  HTML.classList.toggle("phone-shell", on);
  if (on) { if (K.SC.open !== null) { build(); headFor(K.SC.open); raf(placeCoin); } }
  else teardown();
  dockMine();
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
  if (t.closest("#bb-coin")) { if (S.place === "more") go("more"); else pressCoin(); }
}

sceneHooksInit();
function sceneHooksInit() {
  K.sceneHooks.push((open) => { if (open && S.phone && !S.built) { build(); } });
  K.on("scene", (key) => { dockMine(); if (!S.phone) return; build(); headFor(key); markPlaces(); setTimeout(markPlaces, 0); raf(placeCoin); });
  const five = $("#panel-five"); if (five) five.addEventListener("click", () => { if (S.phone) setTimeout(markPlaces, 60); }, true);
  K.on("sheet", markPlaces);
  K.on("rendered", dockMine);
  K.on("closed", () => { unpick(); dockMine(); if (S.phone) closeMore(); });
  K.on("sheetview", (v) => { if (v === "sheet") unpick(); markPlaces(); });
}
const b0 = bar();
if (b0) { b0.addEventListener("click", onClick); b0.addEventListener("keydown", onKey); }
for (const ev of ["resize", "orientationchange"]) addEventListener(ev, () => { apply(); dockMine(); if (S.phone) { placeCoin(); markPlaces(); raf(placeCoin); } });
addEventListener("hashchange", () => { if (S.phone) markPlaces(); });
for (const q of MQS) { const m = mm(q); if (m && m.addEventListener) m.addEventListener("change", apply); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.phone) placeCoin(); }, () => {});
apply();

window.BoardShell = Object.freeze({
  phone: () => S.phone,
  ownsSwipe: () => S.phone && coarse() && !reduced(),
  place: () => S.place,
  status: () => ({ phone: S.phone, place: S.place, coin: { key: S.coinKey }, more: !!(window.BoardSheets && window.BoardSheets.status().open === "more"), bar: S.built ? (bar() ? bar().querySelectorAll(".pl").length : 0) : 0 }),
  PHONE_MQ,
});
})();
