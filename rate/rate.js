// Blind rating page for the model bake-off. Classic script, no network calls, no analytics, no dependencies.
// The owner picks a results file from their own computer; nothing is fetched and nothing leaves the browser.
// The pure functions (seeded shuffle, pairing, Discord-style parser, Bradley-Terry) are exported through
// module.exports for tests/unit/rate.test.mjs; the page code runs only when a document exists.
(function () {
  "use strict";

  // ---------- pure helpers ----------

  function hashString(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32: small deterministic PRNG. Returns a function giving floats in [0, 1).
  function rng(seed) {
    var a = typeof seed === "number" ? seed >>> 0 : hashString(seed);
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fisher-Yates on a copy, seeded.
  function seededShuffle(list, seed) {
    var out = list.slice();
    var r = rng(seed);
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  // Accepts: one cell array, one response object ({results:[...]}), or an array of response objects (one per request of the loop).
  function collectCells(inputs) {
    var cells = [];
    function take(x) {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(take); return; }
      if (typeof x === "object" && Array.isArray(x.results)) { take(x.results); return; }
      if (typeof x === "object" && typeof x.questionId === "string" && typeof x.candidate === "string") cells.push(x);
    }
    take(inputs);
    // Keep the last usable cell per question and candidate.
    var byKey = {};
    cells.forEach(function (c) {
      var k = c.questionId + "\u0000" + c.candidate;
      if (!byKey[k] || (c.ok && typeof c.answer === "string" && c.answer)) byKey[k] = c;
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; });
  }

  // One or more pairs per question, balanced so every candidate is shown about equally often. Deterministic for a seed.
  // Order of pairs and which answer is A are both seeded.
  function makePairs(cells, seed, perQuestion) {
    perQuestion = perQuestion > 0 ? perQuestion : 1;
    var usable = cells.filter(function (c) { return c.ok && typeof c.answer === "string" && c.answer.trim(); });
    var qids = [];
    var byQ = {};
    usable.forEach(function (c) {
      if (!byQ[c.questionId]) { byQ[c.questionId] = []; qids.push(c.questionId); }
      byQ[c.questionId].push(c);
    });
    var r = rng(String(seed) + ":pairs");
    var shown = {};
    var pairs = [];
    qids.forEach(function (qid) {
      var group = seededShuffle(byQ[qid], String(seed) + ":" + qid);
      var used = {};
      for (var n = 0; n < perQuestion; n++) {
        var best = null;
        for (var i = 0; i < group.length; i++) {
          for (var j = i + 1; j < group.length; j++) {
            if (group[i].answer.trim() === group[j].answer.trim()) continue;
            var key = i + "|" + j;
            if (used[key]) continue;
            var cost = (shown[group[i].candidate] || 0) + (shown[group[j].candidate] || 0);
            if (!best || cost < best.cost) best = { i: i, j: j, key: key, cost: cost };
          }
        }
        if (!best) break;
        used[best.key] = true;
        var x = group[best.i], y = group[best.j];
        shown[x.candidate] = (shown[x.candidate] || 0) + 1;
        shown[y.candidate] = (shown[y.candidate] || 0) + 1;
        var flip = r() < 0.5;
        var a = flip ? y : x, b = flip ? x : y;
        pairs.push({
          questionId: qid,
          question: String(a.question || b.question || ""),
          a: { label: a.candidate, answer: a.answer },
          b: { label: b.candidate, answer: b.answer },
        });
      }
    });
    return seededShuffle(pairs, String(seed) + ":order");
  }

  // ---------- Discord-style text, parsed to a node tree (rendered with createElement and textContent only) ----------

  var INLINE_SRC = /\[([^\]\n]+)\]\(<?([^)>\s]+)>?\)|\*\*([^*\n]+?)\*\*|`([^`\n]+)`/g;

  function safeHref(href) {
    try {
      var u = new URL(href);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  function parseInline(text, allowBold) {
    if (allowBold === undefined) allowBold = true;
    var nodes = [];
    var last = 0;
    var m;
    var INLINE_RE = new RegExp(INLINE_SRC.source, "g");
    text = String(text);
    while ((m = INLINE_RE.exec(text))) {
      if (m.index > last) nodes.push({ t: "text", v: text.slice(last, m.index) });
      if (m[1] !== undefined) {
        var href = safeHref(m[2]);
        // An unsafe or malformed target is shown as plain text, never as a link.
        nodes.push(href ? { t: "link", href: href, v: m[1] } : { t: "text", v: m[0] });
      } else if (m[3] !== undefined) {
        if (allowBold) nodes.push({ t: "bold", children: parseInline(m[3], false) });
        else nodes.push({ t: "text", v: m[3] });
      } else {
        nodes.push({ t: "code", v: m[4] });
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push({ t: "text", v: text.slice(last) });
    return nodes;
  }

  // Blocks: { type: "p", lines: [nodes] } | { type: "ul", items: [nodes] } | { type: "small", nodes }
  function parseBlocks(text) {
    var blocks = [];
    var para = null;
    var list = null;
    function flush() { para = null; list = null; }
    String(text).replace(/\r\n?/g, "\n").split("\n").forEach(function (line) {
      if (!line.trim()) { flush(); return; }
      var small = /^\s*-#\s+(.*)$/.exec(line);
      if (small) { flush(); blocks.push({ type: "small", nodes: parseInline(small[1]) }); return; }
      var bullet = /^\s*(?:•|[*-](?=\s))\s*(.*)$/.exec(line);
      if (bullet) {
        para = null;
        if (!list) { list = { type: "ul", items: [] }; blocks.push(list); }
        list.items.push(parseInline(bullet[1]));
        return;
      }
      list = null;
      if (!para) { para = { type: "p", lines: [] }; blocks.push(para); }
      para.lines.push(parseInline(line));
    });
    return blocks;
  }

  // ---------- Bradley-Terry ----------

  // comparisons: [{ a, b, score }] where score is 1 (a won), 0 (b won) or 0.5 (tie).
  // Standard iterative MM update: p_i = W_i / sum_j n_ij / (p_i + p_j), then normalise so the strengths sum to 1.
  // prior > 0 adds a virtual opponent of strength 1 that every item draws against `prior` times; it keeps unbeaten and
  // winless items finite. The tests use prior 0 (the plain maximum-likelihood estimate); the page uses a small prior.
  function bradleyTerry(comparisons, opts) {
    opts = opts || {};
    var prior = opts.prior > 0 ? opts.prior : 0;
    var maxIter = opts.maxIterations || 10000;
    var tol = opts.tolerance || 1e-12;
    var VIRT = "\u0000prior";
    var items = [];
    var idx = {};
    function add(name) { if (!(name in idx)) { idx[name] = items.length; items.push(name); } return idx[name]; }
    var W = [], N = {};
    function ensure(i) { while (W.length <= i) W.push(0); }
    function pairKey(i, j) { return i < j ? i + "," + j : j + "," + i; }
    comparisons.forEach(function (c) {
      var i = add(c.a), j = add(c.b);
      ensure(Math.max(i, j));
      W[i] += c.score; W[j] += 1 - c.score;
      N[pairKey(i, j)] = (N[pairKey(i, j)] || 0) + 1;
    });
    var realCount = items.length;
    if (prior > 0 && realCount) {
      var v = add(VIRT);
      ensure(v);
      for (var i0 = 0; i0 < realCount; i0++) {
        W[i0] += prior; W[v] += prior;
        N[pairKey(i0, v)] = (N[pairKey(i0, v)] || 0) + 2 * prior;
      }
    }
    var n = items.length;
    var p = [];
    for (var k = 0; k < n; k++) p.push(1 / (n || 1));
    var neighbours = items.map(function () { return []; });
    Object.keys(N).forEach(function (key) {
      var parts = key.split(",").map(Number);
      neighbours[parts[0]].push([parts[1], N[key]]);
      neighbours[parts[1]].push([parts[0], N[key]]);
    });
    var iterations = 0;
    for (; iterations < maxIter; iterations++) {
      var next = [];
      var sum = 0;
      for (var a = 0; a < n; a++) {
        var denom = 0;
        neighbours[a].forEach(function (nb) { var s = p[a] + p[nb[0]]; if (s > 0) denom += nb[1] / s; });
        next[a] = denom > 0 ? W[a] / denom : 0;
        sum += next[a];
      }
      var delta = 0;
      for (var b = 0; b < n; b++) {
        next[b] = sum > 0 ? next[b] / sum : 1 / n;
        delta = Math.max(delta, Math.abs(next[b] - p[b]));
      }
      p = next;
      if (delta < tol) { iterations++; break; }
    }
    var strengths = {};
    var total = 0;
    for (var r = 0; r < realCount; r++) total += p[r];
    for (var q = 0; q < realCount; q++) strengths[items[q]] = total > 0 ? p[q] / total : 0;
    return { strengths: strengths, iterations: iterations };
  }

  // ratings: [{ a, b, choice }] with choice a | b | tie | bad. "Both bad" is counted but takes no part in Bradley-Terry.
  function summarize(ratings, opts) {
    var rows = {};
    function row(label) {
      return rows[label] || (rows[label] = { label: label, wins: 0, losses: 0, ties: 0, bothBad: 0, shown: 0 });
    }
    var comps = [];
    ratings.forEach(function (r) {
      if (!r.choice) return;
      var A = row(r.a), B = row(r.b);
      A.shown++; B.shown++;
      if (r.choice === "a") { A.wins++; B.losses++; comps.push({ a: r.a, b: r.b, score: 1 }); }
      else if (r.choice === "b") { B.wins++; A.losses++; comps.push({ a: r.a, b: r.b, score: 0 }); }
      else if (r.choice === "tie") { A.ties++; B.ties++; comps.push({ a: r.a, b: r.b, score: 0.5 }); }
      else if (r.choice === "bad") { A.bothBad++; B.bothBad++; }
    });
    var bt = bradleyTerry(comps, opts);
    var list = Object.keys(rows).map(function (k) {
      rows[k].strength = k in bt.strengths ? bt.strengths[k] : 0;
      return rows[k];
    });
    list.sort(function (x, y) { return y.strength - x.strength || y.wins - x.wins || (x.label < y.label ? -1 : 1); });
    return { rows: list, comparisons: comps.length, iterations: bt.iterations };
  }

  var api = {
    hashString: hashString, rng: rng, seededShuffle: seededShuffle, collectCells: collectCells, makePairs: makePairs,
    parseInline: parseInline, parseBlocks: parseBlocks, safeHref: safeHref, bradleyTerry: bradleyTerry, summarize: summarize,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---------- page ----------

  var $ = function (id) { return document.getElementById(id); };
  var state = { pairs: [], ratings: [], pos: 0, seed: "", perQuestion: 1, storeKey: "", cellCount: 0 };

  function renderNodes(parent, nodes) {
    nodes.forEach(function (n) {
      if (n.t === "text") parent.appendChild(document.createTextNode(n.v));
      else if (n.t === "bold") { var b = document.createElement("strong"); renderNodes(b, n.children); parent.appendChild(b); }
      else if (n.t === "code") { var c = document.createElement("code"); c.textContent = n.v; parent.appendChild(c); }
      else if (n.t === "link") {
        var a = document.createElement("a");
        a.textContent = n.v;
        a.setAttribute("href", n.href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        parent.appendChild(a);
      }
    });
  }

  function renderDiscord(el, text) {
    el.textContent = "";
    parseBlocks(text).forEach(function (blk) {
      if (blk.type === "small") { var s = document.createElement("p"); s.className = "small"; renderNodes(s, blk.nodes); el.appendChild(s); }
      else if (blk.type === "ul") {
        var ul = document.createElement("ul");
        blk.items.forEach(function (it) { var li = document.createElement("li"); renderNodes(li, it); ul.appendChild(li); });
        el.appendChild(ul);
      } else {
        var p = document.createElement("p");
        blk.lines.forEach(function (ln, i) { if (i) p.appendChild(document.createElement("br")); renderNodes(p, ln); });
        el.appendChild(p);
      }
    });
  }

  function say(msg) { $("live").textContent = msg; }

  function store(write) {
    try {
      if (!state.storeKey) return;
      if (write) localStorage.setItem(state.storeKey, JSON.stringify(state.ratings));
    } catch (e) { /* storage may be blocked; the page works without it */ }
  }
  function restore() {
    try {
      var raw = localStorage.getItem(state.storeKey);
      var arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length === state.pairs.length) state.ratings = arr;
    } catch (e) { /* ignore */ }
  }

  function done() { return state.ratings.filter(function (r) { return r && r.choice; }).length; }

  function show() {
    var total = state.pairs.length;
    var finished = state.pos >= total;
    $("pair").hidden = finished;
    $("progress").max = total;
    $("progress").value = Math.min(done(), total);
    $("progress-text").textContent = finished ? "All " + total + " pairs shown. Rated " + done() + "." : "Pair " + (state.pos + 1) + " of " + total + ". Rated " + done() + ".";
    if (finished) { $("summary-btn").focus(); return; }
    var pr = state.pairs[state.pos];
    $("q-id").textContent = pr.questionId;
    $("q-text").textContent = pr.question || "(question text not in the file)";
    renderDiscord($("ans-a"), pr.a.answer);
    renderDiscord($("ans-b"), pr.b.answer);
    var cur = state.ratings[state.pos];
    $("note").value = cur && cur.note ? cur.note : "";
    var chosen = cur && cur.choice;
    Array.prototype.forEach.call(document.querySelectorAll("[data-choice]"), function (btn) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-choice") === chosen));
    });
    $("back").disabled = state.pos === 0;
  }

  function rate(choice) {
    if (state.pos >= state.pairs.length) return;
    var pr = state.pairs[state.pos];
    state.ratings[state.pos] = {
      index: state.pos, questionId: pr.questionId, a: pr.a.label, b: pr.b.label, choice: choice,
      winner: choice === "a" ? pr.a.label : choice === "b" ? pr.b.label : null, note: $("note").value.trim(),
    };
    store(true);
    state.pos++;
    say("Saved. " + (state.pos < state.pairs.length ? "Pair " + (state.pos + 1) + " of " + state.pairs.length + "." : "That was the last pair."));
    show();
  }

  function back() {
    if (state.pos === 0) return;
    state.pos--;
    show();
    say("Back to pair " + (state.pos + 1) + ".");
  }

  function exportPayload() {
    var rated = state.ratings.filter(function (r) { return r && r.choice; });
    var sum = summarize(rated, { prior: 0.5 });
    return {
      version: 1, exportedAt: new Date().toISOString(), seed: state.seed, pairsPerQuestion: state.perQuestion,
      ratings: rated, summary: sum.rows.map(function (r) {
        return { candidate: r.label, wins: r.wins, losses: r.losses, ties: r.ties, bothBad: r.bothBad, shown: r.shown, bradleyTerry: Math.round(r.strength * 10000) / 10000 };
      }),
      comparisons: sum.comparisons,
    };
  }

  function download() {
    var blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ratings.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    say("Exported ratings.json.");
  }

  function showSummary() {
    var sum = summarize(state.ratings.filter(function (r) { return r && r.choice; }), { prior: 0.5 });
    var body = $("sum-body");
    body.textContent = "";
    sum.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      [r.label, r.wins, r.losses, r.ties, r.bothBad, (r.strength * 100).toFixed(1) + "%"].forEach(function (v, i) {
        var cell = document.createElement(i === 0 ? "th" : "td");
        if (i === 0) cell.setAttribute("scope", "row");
        cell.textContent = String(v);
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    $("sum-note").textContent = sum.comparisons + " decided comparisons (ties count half). Both bad is counted but left out of the strength score. Strength is a Bradley-Terry share with a small prior; shares sum to 100%.";
    $("summary").hidden = false;
    $("summary").scrollIntoView();
    say("Summary shown. Model names are now revealed.");
  }

  function start(cells) {
    state.seed = $("seed").value.trim() || "bake-off";
    state.perQuestion = Number($("per-q").value) || 1;
    state.pairs = makePairs(cells, state.seed, state.perQuestion);
    state.ratings = new Array(state.pairs.length);
    state.pos = 0;
    state.cellCount = cells.length;
    state.storeKey = "rate:v1:" + hashString(state.seed + "|" + state.perQuestion + "|" + cells.map(function (c) { return c.questionId + c.candidate + (c.chars || 0); }).join(",")).toString(16);
    restore();
    while (state.pos < state.pairs.length && state.ratings[state.pos] && state.ratings[state.pos].choice) state.pos++;
    $("summary").hidden = true;
    if (!state.pairs.length) {
      $("load-msg").textContent = "No question has two usable answers from different candidates in that file.";
      $("rate").hidden = true;
      return;
    }
    $("load-msg").textContent = state.pairs.length + " pairs from " + cells.length + " answers. Labels stay hidden until the summary.";
    $("rate").hidden = false;
    show();
    say("Ready. Pair " + (state.pos + 1) + " of " + state.pairs.length + ".");
  }

  function loadFiles(files) {
    var texts = [];
    var pending = files.length;
    var failed = false;
    Array.prototype.forEach.call(files, function (f, i) {
      var reader = new FileReader();
      reader.onload = function () { texts[i] = String(reader.result); if (--pending === 0) finish(); };
      reader.onerror = function () { failed = true; if (--pending === 0) finish(); };
      reader.readAsText(f);
    });
    function finish() {
      if (failed) { $("load-msg").textContent = "Could not read a file."; return; }
      try {
        var parsed = texts.map(function (t) { return JSON.parse(t); });
        var cells = collectCells(parsed);
        if (!cells.length) { $("load-msg").textContent = "That file has no results to rate."; return; }
        window.__rateCells = cells;
        start(cells);
      } catch (e) {
        $("load-msg").textContent = "That is not valid JSON.";
      }
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("file").addEventListener("change", function (e) { if (e.target.files && e.target.files.length) loadFiles(e.target.files); });
    $("seed").addEventListener("change", function () { if (window.__rateCells) start(window.__rateCells); });
    $("per-q").addEventListener("change", function () { if (window.__rateCells) start(window.__rateCells); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-choice]"), function (btn) {
      btn.addEventListener("click", function () { rate(btn.getAttribute("data-choice")); });
    });
    $("back").addEventListener("click", back);
    $("export-btn").addEventListener("click", download);
    $("summary-btn").addEventListener("click", showSummary);
    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target && e.target.tagName;
      if (t === "TEXTAREA" || t === "INPUT" || t === "SELECT") return;
      if ($("rate").hidden || $("pair").hidden) return;
      var k = String(e.key).toLowerCase();
      var map = { a: "a", "1": "a", b: "b", "2": "b", t: "tie", "3": "tie", x: "bad", "4": "bad" };
      if (map[k]) { e.preventDefault(); rate(map[k]); }
      else if (k === "u" || k === "backspace") { e.preventDefault(); back(); }
    });
  });
})();
