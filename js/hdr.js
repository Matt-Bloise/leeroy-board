(function hdr() {
  const root = document.documentElement; if (!root) return;
  const mq = (q) => { try { return !!(window.matchMedia && matchMedia(q).matches); } catch (e) { return false; } };
  const param = (k) => { try { const m = new RegExp("[?&]" + k + "=([01])(?:&|#|$)").exec(location.search || ""); return m ? m[1] : null; } catch (e) { return null; } };
  const KEY = "board-oled";
  const get = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const put = (v) => { try { localStorage.setItem(KEY, v); } catch (e) {} };
  const off = param("hdr") === "0";
  if (off) root.classList.add("hdr-off"); else root.classList.add("hdr-img");
  let forced = param("oled"); if (forced !== null) put(forced); else forced = get();
  let on = false, n = 0, idle = Date.now(), veil = null;
  const auto = () => mq("(dynamic-range: high)") && mq("(prefers-color-scheme: dark)");
  const apply = () => {
    on = forced === "1" || (forced !== "0" && auto());
    root.classList.toggle("oled-care", on);
    if (!on) { root.classList.remove("oled-dim"); return; }
    if (!veil && document.body) { veil = document.createElement("div"); veil.setAttribute("class", "oled-veil"); veil.setAttribute("aria-hidden", "true"); document.body.appendChild(veil); }
  };
  apply();
  for (const q of ["(dynamic-range: high)", "(prefers-color-scheme: dark)"]) { try { const m = matchMedia(q); if (m.addEventListener) m.addEventListener("change", apply); } catch (e) {} }
  setInterval(() => {
    if (!on || document.hidden) return; n += 1;
    root.style.setProperty("--x-oled-x", Math.round(Math.cos(n * 2.1) * 5) + "px"); root.style.setProperty("--x-oled-y", Math.round(Math.sin(n * 1.7) * 5) + "px");
  }, 60000);
  const wake = () => { idle = Date.now(); if (root.classList.contains("oled-dim")) root.classList.remove("oled-dim"); };
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"]) addEventListener(ev, wake, { passive: true, capture: true });
  setInterval(() => { if (on && !document.hidden && Date.now() - idle > 60000) root.classList.add("oled-dim"); }, 5000);
  window.__hdr = {
    state: () => ({ off, oled: on, forced, gamutP3: mq("(color-gamut: p3)"), rangeHigh: mq("(dynamic-range: high)"), dark: mq("(prefers-color-scheme: dark)"), drift: n,
      images: !off && root.classList.contains("hdr-img") && mq("(dynamic-range: high)"), limit: (() => { try { return CSS.supports("dynamic-range-limit", "no-limit"); } catch (e) { return false; } })(),
      loaded: (() => { try { return performance.getEntriesByType("resource").map((r) => r.name).filter((u) => /img\/hdr\//.test(u)).map((u) => u.replace(/^.*img\/hdr\//, "")); } catch (e) { return []; } })() }),
    oled: (v) => { forced = v === null || v === undefined ? null : v ? "1" : "0"; if (forced === null) { try { localStorage.removeItem(KEY); } catch (e) {} } else put(forced); apply(); return on; },
  };
})();
