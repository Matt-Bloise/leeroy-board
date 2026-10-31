export const RANK = { confirmed: 0, likely: 1, speculative: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
const TRANSIT = new Set(["zeppelin", "boat"]);
const WAIT_PENALTY = 6; // routing only: minutes added to a transport edge's weight

export function buildGraph(routes) {
  const edges = new Map(), adj = new Map(), nodes = new Set(routes.nodes || []);
  const add = (a, edge, to) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to, edge }); };
  for (const e of routes.edges || []) {
    edges.set(e.id, e);
    nodes.add(e.from); nodes.add(e.to);
    add(e.from, e, e.to); add(e.to, e, e.from);
  }
  const transportOf = new Map();
  for (const t of routes.transports || []) {
    const s = t.stops || [];
    for (const e of routes.edges || []) if (TRANSIT.has(e.mode) && s.length >= 2 && ((e.from === s[0] && e.to === s[s.length - 1]) || (e.to === s[0] && e.from === s[s.length - 1]))) transportOf.set(e.id, t.id);
  }
  return { edges, adj, nodes, transportOf, routes };
}

const weight = (e) => (e.minutes || 0) + (TRANSIT.has(e.mode) ? WAIT_PENALTY : 0) + 0.01;

export function shortest(graph, from, to, opts = {}) {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null;
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let u = null, best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k; }
    if (u === null) return null;
    if (u === to) break;
    done.add(u);
    for (const { to: v, edge } of graph.adj.get(u) || []) {
      if (!opts.all && edge.day_one === false) continue;
      const nd = best + weight(edge);
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); prev.set(v, { u, edge }); }
    }
  }
  const route = [to], eids = [];
  for (let c = to; c !== from;) { const p = prev.get(c); eids.unshift(p.edge.id); route.unshift(p.u); c = p.u; }
  let yards = 0, minutes = 0, status = "confirmed";
  const transports = [];
  for (const id of eids) {
    const e = graph.edges.get(id);
    yards += e.yards || 0;
    if (TRANSIT.has(e.mode)) { const t = graph.transportOf.get(id); if (t && !transports.includes(t)) transports.push(t); status = worst(status, "speculative"); }
    else { minutes += e.minutes || 0; status = worst(status, (e.src && e.src.status) || "speculative"); }
  }
  return { route, edges: eids, yards: Math.round(yards), minutes: Math.round(minutes * 10) / 10, status, transports };
}

export function meetOf(routes) {
  const m = routes.day_one && routes.day_one.meet;
  return { place: (m && m.place) || null, status: (m && m.status) || "open" };
}

export function makePlan(graph, o = {}) {
  const day = graph.routes.day_one || {}, starts = day.starts || {};
  const m = meetOf(graph.routes), meet = o.meet || m.place || "valley-of-strength";
  let keys = Object.keys(starts);
  if (typeof o.who === "string") keys = keys.filter((k) => k === o.who);
  else if (Array.isArray(o.who)) keys = keys.filter((k) => o.who.includes(k));
  const who = [], crossings = [];
  for (const k of keys) {
    const r = shortest(graph, starts[k], meet);
    if (!r) continue;
    who.push({ class_key: k, from: starts[k], route: r.route, edges: r.edges, yards: r.yards, minutes: r.minutes, status: r.status });
    for (const t of r.transports) if (!crossings.includes(t)) crossings.push(t);
  }
  return { meet, meet_status: o.meet && o.meet !== m.place ? "chosen" : m.status, who, crossings };
}

export function pathLength(p) { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; }
export function pointAt(p, f) {
  if (!p.length) return null;
  if (p.length === 1 || f <= 0) return p[0].slice();
  if (f >= 1) return p[p.length - 1].slice();
  let want = pathLength(p) * f;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (want <= d && d > 0) { const t = want / d; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]; }
    want -= d;
  }
  return p[p.length - 1].slice();
}
export function slicePath(p, f) {
  if (f >= 1) return p;
  if (f <= 0 || p.length < 2) return [];
  const out = [p[0]]; let want = pathLength(p) * f;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (want <= d) { const t = d > 0 ? want / d : 0; out.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]); return out; }
    out.push(p[i]); want -= d;
  }
  return out;
}

export const edgeMs = (e) => Math.round(260 + Math.min(520, (e.yards || 0) / 18));
export function buildTimeline(graph, plan) {
  const drawnAt = new Map(), chains = [];
  for (const w of plan.who) {
    let t = 0; const segs = [];
    w.edges.forEach((id, i) => {
      const e = graph.edges.get(id), fwd = e.from === w.route[i];
      const shared = drawnAt.has(id);
      const t0 = shared ? Math.max(t, drawnAt.get(id)) : t, dur = shared ? 0 : edgeMs(e);
      if (!shared) drawnAt.set(id, t0 + dur);
      segs.push({ edge: id, fwd, t0, t1: t0 + dur, shared, mode: e.mode, transport: graph.transportOf.get(id) || null });
      t = t0 + dur;
    });
    chains.push({ class_key: w.class_key, segs, end: t });
  }
  let total = 0; for (const c of chains) total = Math.max(total, c.end);
  return { chains, total, drawnAt };
}

export function timelineAt(graph, plan, tl, t) {
  const prog = {}, marks = {};
  for (const c of tl.chains) {
    const w = plan.who.find((x) => x.class_key === c.class_key);
    let pos = null;
    for (const s of c.segs) {
      const e = graph.edges.get(s.edge), dur = s.t1 - s.t0;
      const p = dur <= 0 ? (t >= s.t0 ? 1 : 0) : Math.max(0, Math.min(1, (t - s.t0) / dur));
      prog[s.edge] = Math.max(prog[s.edge] || 0, p);
      if (p > 0) { const path = s.fwd ? e.a_path : e.a_path.slice().reverse(); pos = pointAt(path, p); }
    }
    marks[c.class_key] = pos ? { pos, done: t >= c.end } : null;
    if (!pos) marks[c.class_key] = null;
    void w;
  }
  return { prog, marks };
}
