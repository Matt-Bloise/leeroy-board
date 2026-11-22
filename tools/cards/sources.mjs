// The finite set of picture cards, built from the repository's own data (no D1, no network, no clock):
//   page     one per library page (data/library/<category>.json), the model the Worker rebuilds from the lib_pages row
//   tooltip  one per named spell or item (data/library/tooltips.json `names`), numbers and the composed short line only (tooltips.text stays off)
//   map      the /map places a person can pick (the place list and every route-plan meeting point) plus the whole-atlas view; geography only
//   signup   the sign-up choices (meeting points, arrival times); never who signed up
// Each job is { key, kind, slug, model, view }. `model` is hashed into the manifest; `view` is drawing detail derived from the model or from
// fixed tables here, so the same model always draws the same card. tests/unit/card-images.test.mjs rebuilds these jobs and compares them
// with the committed manifest, so a data change without a re-render fails in the PR.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_MODEL_VERSION, cardText, pageModel, signupModel, pageKey, tooltipKey, mapKey, signupKey, MAP_OVERVIEW, cardSlug, modelHash } from "../../infrastructure/worker/card-models.js";
import { MAP_PLAN_PLACES, MAP_PLAN_ALIASES } from "../../infrastructure/worker/map-plan.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

// The /map place choices offered by autocomplete (infrastructure/worker/discord.js, the `place` list). tests/unit/card-images.test.mjs
// reads that list from discord.js and fails if a value is missing here.
export const MAP_PLACE_CHOICES = ["orgrimmar", "crossroads", "valley-of-strength", "tirisfal-glades", "mulgore", "durotar", "brill", "bloodhoof-village", "razor-hill"];

// Library files that are not category page lists.
const NOT_PAGES = new Set(["index.json", "search.json", "open.json", "refresh.json", "tooltips.json", "glossary.json", "schema.json", "diff.json", "plainwords.json", "news.json"]);

// ---- page ------------------------------------------------------------------------------------------------------------------------
const CLASS_COLOURS = { druid: "#ff7c0a", hunter: "#aad372", mage: "#3fc7eb", paladin: "#f48cba", priest: "#ffffff", rogue: "#fff468", shaman: "#0070dd", warlock: "#8788ee", warrior: "#c69b6d" };
const CATEGORY_COLOURS = { classes: "#6f6250", dungeons: "#7a2e24", raids: "#5f4a8c", professions: "#275520", systems: "#2f4f63", events: "#8a6c35", history: "#5a4527", leveling: "#2f6156", pvp: "#8c2a2a", races: "#7d5a3a", ui: "#4a4f57" };
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");

export function pageView(model) {
  const cls = /^classes\/([a-z]+)$/.exec(model.id);
  const base = cls && CLASS_COLOURS[cls[1]] ? CLASS_COLOURS[cls[1]] : CATEGORY_COLOURS[model.category] || "#6f6250";
  const first = (model.title.match(/[A-Za-z]/) || [model.category.charAt(0) || "L"])[0].toUpperCase();
  return { medal: { colour: mix(base, "#1d140d", 0.45), letter: first }, footNote: "library" };
}

export function libraryPages() {
  const dir = path.join(ROOT, "data/library");
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !NOT_PAGES.has(n)).sort()) {
    const doc = readJson(`data/library/${f}`);
    const pages = doc && Array.isArray(doc.pages) ? doc.pages : [];
    for (const p of pages) if (p && typeof p.id === "string" && Array.isArray(p.facts)) out.push(p);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The row the seed writes for a repo page (infrastructure/scripts/library-seed.mjs): the same fields /page selects.
export const pageRow = (p) => ({ id: p.id, category: p.category, title: p.title, blurb: p.blurb || "", facts_json: JSON.stringify(p.facts || []) });

// ---- tooltip -----------------------------------------------------------------------------------------------------------------------
// The board's tooltip card (js/board.js ttCard), without links and without game prose: tooltips.text stays off (data/client.json).
const QUALITY = ["#a8a8a8", "#ffffff", "#3ce63c", "#4aa3ff", "#c17bff", "#ff9a2e"];
const TT_COST = /^(\d[\d,]* (?:Mana|Rage|Energy|Focus)|\d+% of base mana)/, TT_CAST = /(?:sec cast|^Instant|^Channeled)/, TT_RANGE = /(?:yd range|Melee Range|Unlimited range)$/i, TT_CD = /cooldown$/i;
const GREEN = /^(Equip:|Use:|Chance on hit:|Set\s*:|\(\d\) Set\s*:)/;
const WHITE = /^(Item Level|Requires|Sell Price|Durability|Classes:|Dropped by|Drop Chance|Binds|Unique)/;

// Game prose never goes on a card (tooltips.text stays off, docs/roadmap/IMAGE-CARDS.md): item effect lines (Equip:, Use:, Chance on hit:,
// set bonuses) are left out, which today drops nothing from the named set. No capture date either: a re-capture that changes no number
// must not redraw (and re-commit) every tooltip card.
export function tooltipModel(t) {
  const lines = (Array.isArray(t.lines) ? t.lines : []).map((l) => cardText(l, 60)).filter((l) => l && !GREEN.test(l));
  const take = (re) => { const k = lines.findIndex((l) => re.test(l)); return k >= 0 ? lines.splice(k, 1)[0] : ""; };
  const cost = take(TT_COST), cast = take(TT_CAST), range = take(TT_RANGE), cd = take(TT_CD);
  const rows = [];
  if (cost || cast) rows.push([cost, cast]);
  if (range || cd) rows.push([range, cd]);
  const rest = [];
  for (const l of lines.slice(0, 12)) {
    const two = l.split(/\s{2,}/);
    if (two.length === 2) { rows.push([two[0], two[1]]); continue; }
    rest.push({ tone: WHITE.test(l) ? "w" : t.kind === "spell" ? "y" : "w", text: l });
  }
  return {
    kind: "tooltip",
    v: CARD_MODEL_VERSION,
    id: String(t.id),
    name: cardText(t.name, 40),
    rank: cardText(t.rank, 16),
    colour: t.kind === "item" ? QUALITY[t.quality] || QUALITY[1] : "#ffffff",
    rows,
    lines: rest,
    desc: cardText(t.desc, 160),
    source: "tooltip data: Wowhead Forever",
  };
}

// The names a person can ask /tooltip for. Left out: "blizzard" (the board skips it too, js/board.js TT_SKIP, and a file name must not carry
// the mark) and malformed keys in the names map (three today, of the form "name | rank:  | level:").
export const TOOLTIP_SKIP = new Set(["blizzard"]);
export const tooltipNameOk = (name) => /^[a-z0-9][a-z0-9' :-]*$/.test(name) && !TOOLTIP_SKIP.has(name);
export function namedTooltips() {
  const doc = readJson("data/library/tooltips.json");
  const out = [];
  for (const name of Object.keys(doc.names).sort()) {
    const t = doc.tooltips[doc.names[name]];
    if (t && typeof t.name === "string" && tooltipNameOk(name)) out.push({ name, t });
  }
  return { list: out };
}

// ---- map ----------------------------------------------------------------------------------------------------------------------------
// Line art from data/atlas (atlas coordinates, y down, frame 30000 x 20000). Geography only: no class start points, no routes (which start
// a party uses says which classes it has, and the board keeps that private). Arithmetic only (+ - * /, rounding), so the scene is the same
// on every machine.
export const CHART = { w: 776, h: 346, grid: 97 };
const KIND_LABEL = { city: "city", hub: "town", meet: "meeting point", start: "starting area", zeppelin: "zeppelin tower", zone: "zone", flight: "flight point" };
const HUB_KINDS = { city: 0, hub: 1, zeppelin: 2, start: 3, meet: 3 };
const r1 = (v) => Math.round(v * 10) / 10;
const ringPath = (ring, tx) => {
  let d = "";
  for (let i = 0; i < ring.length; i++) { const [x, y] = tx(ring[i]); d += `${i ? "L" : "M"}${r1(x)} ${r1(y)}`; }
  return d + "Z";
};

function view(x0, y0, x1, y1) {
  // Grow the box to the chart's aspect ratio around its centre.
  let w = x1 - x0, h = y1 - y0;
  const want = CHART.w / CHART.h;
  if (w / h < want) w = h * want; else h = w / want;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const k = CHART.w / w;
  const vx = cx - w / 2, vy = cy - h / 2;
  return { k, vx, vy, w, h, tx: ([x, y]) => [(x - vx) * k, (y - vy) * k] };
}

export function mapScene(place, atlas) {
  const { world, places } = atlas;
  const zones = world.zones;
  const focusZone = place && zones.find((z) => z.id === (place.kind === "zone" ? place.id : place.zone));
  // Frame what is drawn: the land of both continents for the whole map, a zone's own outline for a zone, a fixed window around a place.
  const bounds = (rings) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rings) for (const [x, y] of ring) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  };
  let v;
  if (!place) {
    const [x0, y0, x1, y1] = bounds(world.continents.flatMap((c) => c.land || []));
    const px = (x1 - x0) * 0.06, py = (y1 - y0) * 0.1;
    v = view(x0 - px, y0 - py, x1 + px, y1 + py * 1.8);
  } else if (place.kind === "zone" && focusZone) {
    const [x0, y0, x1, y1] = bounds(focusZone.rings);
    const px = (x1 - x0) * 0.6, py = (y1 - y0) * 0.45;
    v = view(x0 - px, y0 - py, x1 + px, y1 + py);
  } else {
    const [x, y] = place.a;
    v = view(x - 3600, y - 1600, x + 3600, y + 1600);
  }
  const inView =([x, y], m = 0) => { const [sx, sy] = v.tx([x, y]); return sx >= -m && sy >= -m && sx <= CHART.w + m && sy <= CHART.h + m; };
  const land = [];
  for (const c of world.continents) for (const ring of c.land || []) land.push(ringPath(ring, v.tx));
  const zoneShapes = [];
  for (const z of zones) {
    const [x0, y0, x1, y1] = z.a_rect;
    if (!inView([x0, y0], 2000) && !inView([x1, y1], 2000) && !inView([x0, y1], 2000) && !inView([x1, y0], 2000)) continue;
    for (const ring of z.rings) zoneShapes.push({ d: ringPath(ring, v.tx), on: !!(focusZone && z.id === focusZone.id) });
  }
  // Focused zone last, so its outline is drawn over its neighbours'.
  zoneShapes.sort((a, b) => Number(a.on) - Number(b.on));
  const labels = [];
  if (!place) {
    // The whole map names the two continents (under their land) and nothing smaller.
    for (const c of world.continents) {
      const [x0, , x1, y1] = bounds(c.land || []);
      const [sx, sy] = v.tx([(x0 + x1) / 2, y1]);
      labels.push({ cls: "clabel", x: r1(sx), y: r1(sy + 30), text: cardText(c.name, 30) });
    }
  }
  const hubNames = new Set();
  for (const z of place ? zones : []) {
    if (!z.label || !Array.isArray(z.label.a) || !inView(z.label.a)) continue;
    const [sx, sy] = v.tx(z.label.a);
    labels.push({ cls: focusZone && z.id === focusZone.id ? "zlabel on" : "zlabel", x: r1(sx), y: r1(sy), text: cardText(z.name, 30), on: !!(focusZone && z.id === focusZone.id), zone: true });
  }
  // Focused zone's label first, then the rest by name: the label pass in card.js keeps the earlier one when two overlap.
  labels.sort((a, b) => Number(!!b.on) - Number(!!a.on) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const cx = place ? place.a[0] : 0, cy = place ? place.a[1] : 0;
  const near = places
    .filter((p) => p !== place && p.kind in HUB_KINDS && p.kind !== "start" && Array.isArray(p.a) && inView(p.a, -12) && (place || p.kind === "city"))
    .map((p) => ({ p, rank: HUB_KINDS[p.kind], d: (p.a[0] - cx) * (p.a[0] - cx) + (p.a[1] - cy) * (p.a[1] - cy) }))
    .sort((a, b) => a.rank - b.rank || a.d - b.d || (a.p.id < b.p.id ? -1 : 1))
    .slice(0, place ? 10 : 6);
  for (const { p } of near) {
    const [sx, sy] = v.tx(p.a);
    hubNames.add(p.name.toLowerCase());
    labels.push({ cls: place ? "hlabel" : "hlabel halo", x: r1(sx + 9), y: r1(sy + 5), anchor: "start", text: cardText(p.name, 32), dot: { x: r1(sx), y: r1(sy) } });
  }
  // A city is its own zone (Orgrimmar, Thunder Bluff): name it once, as the town with its dot.
  for (let i = labels.length - 1; i >= 0; i--) if (labels[i].zone && hubNames.has(labels[i].text.toLowerCase()) && !labels[i].on) labels.splice(i, 1);
  let pin = null;
  if (place && place.kind !== "zone") {
    const [sx, sy] = v.tx(place.a);
    pin = { x: r1(sx), y: r1(sy), label: cardText(place.name, 40) };
  }
  return { w: CHART.w, h: CHART.h, grid: CHART.grid, land, zones: zoneShapes, labels: labels.map(({ on, zone, ...l }) => l), pin };
}

export function mapModel(place, atlas) {
  const zone = place && atlas.world.zones.find((z) => z.id === (place.kind === "zone" ? place.id : place.zone));
  const continent = zone && atlas.world.continents.find((c) => c.id === zone.continent);
  const faction = place && typeof place.faction === "string" ? place.faction : "";
  const sub = !place ? "both continents" : place.kind === "zone" ? [continent && continent.name, faction].filter(Boolean).join(" \u00b7 ") : [zone && zone.name, faction].filter(Boolean).join(" \u00b7 ");
  return {
    kind: "map",
    v: CARD_MODEL_VERSION,
    id: place ? place.id : MAP_OVERVIEW,
    title: place ? cardText(place.name, 40) : "Azeroth Atlas",
    kicker: place ? KIND_LABEL[place.kind] || "place" : "the whole map",
    sub: cardText(sub, 60),
    scene: mapScene(place, atlas),
  };
}

export function loadAtlas() {
  return { world: readJson("data/atlas/world.json"), places: readJson("data/atlas/places.json").places, byAlias: readJson("data/atlas/places.json").by_alias };
}

// What the /map handler's `place` and `plan` values resolve to: a place id. The `place` option is slugged by the handler
// (lower case, anything else a hyphen), so aliases are stored in that form.
export function mapPlaceIds(atlas) {
  const ids = new Set(atlas.places.map((p) => p.id));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  const resolve = (v) => (ids.has(v) ? v : ids.has(MAP_PLAN_ALIASES[v]) ? MAP_PLAN_ALIASES[v] : atlas.byAlias[v.replace(/-/g, " ")] && ids.has(atlas.byAlias[v.replace(/-/g, " ")]) ? atlas.byAlias[v.replace(/-/g, " ")] : null);
  const wanted = [...MAP_PLACE_CHOICES, ...MAP_PLAN_PLACES.map((p) => p.value)];
  const out = new Set();
  const aliases = {};
  for (const v of wanted) {
    const id = resolve(slug(v));
    if (!id) throw new Error(`/map choice "${v}" is not a place in data/atlas/places.json`);
    out.add(id);
  }
  for (const id of out) {
    for (const [a, target] of Object.entries(MAP_PLAN_ALIASES)) if (target === id) aliases[a] = id;
    for (const [a, target] of Object.entries(atlas.byAlias)) if (target === id && slug(a) !== id) aliases[slug(a)] = id;
  }
  return { ids: [...out].sort(), aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

// ---- sign-up --------------------------------------------------------------------------------------------------------------------------
// The picture of the PINNED sign-up card's own buttons (cards.js renderSignupCard): its four answer labels (RSVP_BUTTON_LABELS), its first two
// meeting points and its arrival times. Copied from cards.js so the renderer does not load the Worker's card module and its manifest;
// tests/unit/card-images.test.mjs fails if they drift. An admin who configures other choices gets no picture until that set is added here.
export const SIGNUP_ANSWERS = ["I'm in", "Tentative", "Running late", "Out"];
export const SIGNUP_VARIANTS = [{ answers: SIGNUP_ANSWERS, meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] }];
// The colour of each answer's button on that card (success, secondary, primary, danger), in the answers' order.
export const signupView = () => ({ colours: ["#3ba55c", "#8d7c60", "#5865f2", "#ed4245"] });

// ---- all jobs --------------------------------------------------------------------------------------------------------------------------
export async function cardJobs() {
  const jobs = [];
  for (const p of libraryPages()) {
    const model = pageModel(pageRow(p));
    jobs.push({ key: pageKey(p.id), kind: "page", slug: cardSlug(p.id), model, view: pageView(model) });
  }
  const tips = namedTooltips();
  for (const { name, t } of tips.list) {
    const model = tooltipModel(t);
    jobs.push({ key: tooltipKey(name), kind: "tooltip", slug: cardSlug(name), model, view: { footNote: "tooltip" } });
  }
  const atlas = loadAtlas();
  const { ids, aliases } = mapPlaceIds(atlas);
  jobs.push({ key: mapKey(MAP_OVERVIEW), kind: "map", slug: "atlas", model: mapModel(null, atlas), view: { footNote: "open it on the atlas" } });
  for (const id of ids) {
    const place = atlas.places.find((p) => p.id === id);
    jobs.push({ key: mapKey(id), kind: "map", slug: cardSlug(id), model: mapModel(place, atlas), view: { footNote: "open it on the atlas" } });
  }
  for (const s of SIGNUP_VARIANTS) {
    const model = signupModel(s.answers, s.meet, s.when);
    const h = await modelHash(model);
    jobs.push({ key: signupKey(h), kind: "signup", slug: `signups-${h.slice(0, 8)}`, model, view: signupView() });
  }
  const seen = new Set();
  for (const j of jobs) {
    if (seen.has(j.key)) throw new Error(`two cards share the key ${j.key}`);
    seen.add(j.key);
  }
  return { jobs, aliases };
}
