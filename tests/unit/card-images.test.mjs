// Picture cards (docs/runbooks/card-images.md): the committed PNGs and manifest, the freshness and privacy rules, and the Worker's decision
// to attach a card (infrastructure/worker/card-images.js) behind CARD_IMAGES. No browser here: the pixel check against a fresh render runs in
// .github/workflows/cards.yml. No network: every fetch is stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, pixelHash } from "../../tools/cards/png.mjs";
import { cardJobs, SIGNUP_VARIANTS, SIGNUP_ANSWERS, MAP_PLACE_CHOICES, libraryPages, pageRow, loadAtlas, namedTooltips, tooltipNameOk } from "../../tools/cards/sources.mjs";
import { uncoveredChars, CARD_FONTS } from "../../tools/cards/fonts.mjs";
import { inputsHash, MANIFEST_PATH, WIDTH, SCALE, CHROMIUM_ARGS, DRAWING_FILES, FONT_FILES } from "../../tools/cards/render.mjs";
import { cardImageUrl, isPublished, pageCardUrl, tooltipCardUrl, mapCardKey, mapCardUrl, signupCardUrl, cardSiteBase, _forgetPublished, MISS_TTL_MS, PUBLISHED_TIMEOUT_MS } from "../../infrastructure/worker/card-images.js";
import { modelHash, pageModel, signupModel, cardText, factLabel, cardSlug, PAGE_FACTS, ATTRIBUTION_HOSTS, needsAttribution } from "../../infrastructure/worker/card-models.js";
import { DEFAULT_MEET, DEFAULT_WHEN, RSVP_BUTTON_LABELS, renderSignupCard, loadCardState } from "../../infrastructure/worker/cards.js";
import { researchMembers, genericAliases } from "../../infrastructure/worker/privacy/roster-config.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_PATH), "utf8"));
const BASE = "https://board.test";
const ON = { getBooleanValue: async (k) => k === "CARD_IMAGES" };
const OFF = { getBooleanValue: async () => false };

// ---- the committed set ------------------------------------------------------------------------------------------------------------
test("manifest: every card names a PNG under cards/<kind>/ whose name ends in its pixel hash, at 2x the CSS width", () => {
  const entries = Object.entries(MANIFEST.cards);
  assert.ok(entries.length > 200, `${entries.length} cards`);
  for (const [key, e] of entries) {
    const kind = key.split(":")[0];
    assert.match(e.file, new RegExp(`^cards/${kind}/[a-z0-9]+(?:-[a-z0-9]+)*-${e.px.slice(0, 12)}\\.png$`), key);
    assert.match(e.px, /^[0-9a-f]{64}$/, key);
    assert.match(e.model, /^[0-9a-f]{64}$/, key);
    assert.equal(e.w, WIDTH[kind] * SCALE, `${key}: ${e.w} px wide`);
    assert.ok(Number.isInteger(e.h) && e.h > 0 && e.h % SCALE === 0, `${key}: height ${e.h}`);
  }
  assert.equal(new Set(entries.map(([, e]) => e.file)).size, entries.length, "no two cards share a file");
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/cards/package.json"), "utf8")).dependencies["playwright-core"];
  assert.equal(MANIFEST.renderer.playwright, pin, "drawn with the pinned playwright-core");
  const browser = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/cards/chromium.json"), "utf8"));
  assert.equal(MANIFEST.renderer.browser, browser.version, "drawn with the pinned browser");
  assert.equal(MANIFEST.renderer.sha256, browser.sha256);
  assert.match(browser.sha256, /^[0-9a-f]{64}$/);
  assert.match(browser.url, /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/[0-9.]+\/linux64\/chrome-headless-shell-linux64\.zip$/);
  assert.ok(browser.url.includes(`/${browser.version}/`), "the URL is the pinned version");
  assert.deepEqual(MANIFEST.renderer.args, CHROMIUM_ARGS, "drawn with today's launch flags (a change needs --write, and CI then checks the pixels)");
  assert.equal(MANIFEST.renderer.scale, 2);
});

test("every committed card file is in the manifest, is a strict PNG (IHDR, IDAT, IEND only) and decodes to exactly the manifest's pixels", () => {
  const files = [];
  for (const kind of fs.readdirSync(path.join(ROOT, "cards"))) for (const f of fs.readdirSync(path.join(ROOT, "cards", kind))) files.push(`cards/${kind}/${f}`);
  const listed = new Set(Object.values(MANIFEST.cards).map((e) => e.file));
  for (const f of files) assert.ok(listed.has(f), `${f} is committed but not in the manifest (run node tools/cards/render.mjs --write)`);
  for (const [key, e] of Object.entries(MANIFEST.cards)) {
    const d = decodePng(fs.readFileSync(path.join(ROOT, e.file)), { strict: true }); // an animation or tRNS chunk could show other pixels than the ones hashed
    assert.equal(`${d.width}x${d.height}`, `${e.w}x${e.h}`, key);
    assert.equal(pixelHash(d), e.px, `${key}: ${e.file} does not decode to the manifest's pixels`);
  }
});

test("the template, the drawing code and the fonts are the ones the cards were drawn with (a change needs a full node tools/cards/render.mjs --write)", () => {
  assert.deepEqual(MANIFEST.inputs, inputsHash());
  for (const f of ["tools/cards/sources.mjs", "tools/cards/render.mjs", "tools/cards/png.mjs", "tools/cards/fonts.mjs", "tools/cards/chromium.json", "infrastructure/worker/card-models.js"]) assert.ok(DRAWING_FILES.includes(f), f);
});

test("every character on every card is in all of the board's fonts (no fallback font, no empty box)", async () => {
  const { jobs } = await cardJobs();
  for (const j of jobs) assert.deepEqual(uncoveredChars({ model: j.model, view: j.view }), [], j.key);
  assert.deepEqual(uncoveredChars({ a: "Fireball \u4e2d", b: ["\u2192", "fine \u2026 \u00b7 \u00e9"] }), ["U+2192 \u2192", "U+4E2D \u4e2d"], "the check sees a character no card font has");
});

test("freshness: the manifest holds exactly the cards the repository's data gives today, with the same models", async () => {
  const { jobs, aliases } = await cardJobs();
  assert.deepEqual(Object.keys(MANIFEST.cards).sort(), jobs.map((j) => j.key).sort(), "card set (run node tools/cards/render.mjs --write)");
  for (const j of jobs) assert.equal(MANIFEST.cards[j.key].model, await modelHash(j.model), `${j.key}: the data changed since it was drawn (run node tools/cards/render.mjs --write)`);
  assert.deepEqual(MANIFEST.aliases, aliases);
});

test("the sign-up picture shows the pinned card's own buttons, and the /map choices cover the autocomplete list in discord.js", () => {
  assert.deepEqual(SIGNUP_VARIANTS[0].meet, DEFAULT_MEET.slice(0, 2));
  assert.deepEqual(SIGNUP_VARIANTS[0].when, DEFAULT_WHEN.slice(0, 5));
  assert.deepEqual(SIGNUP_ANSWERS, [...RSVP_BUTTON_LABELS]);
  const card = renderSignupCard({ entries: [], options: {} });
  assert.deepEqual(card.components[0].components.map((b) => b.label), [...RSVP_BUTTON_LABELS], "the first row of the pinned card says what the picture says");
  assert.deepEqual(card.components[1].components.slice(2, 4).map((b) => b.label), DEFAULT_MEET.slice(0, 2));
  assert.deepEqual(card.components[2].components.map((b) => b.label), DEFAULT_WHEN.map((w) => `Arrive ${w}`));
  const src = fs.readFileSync(path.join(ROOT, "infrastructure/worker/discord.js"), "utf8");
  const block = src.slice(src.indexOf('if (cmd === "map") {\n      const places = ['), src.indexOf("].filter((p) => p.name.toLowerCase().includes(query)"));
  const values = [...block.matchAll(/value: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 5, "found the /map autocomplete list");
  assert.deepEqual([...values].sort(), [...MAP_PLACE_CHOICES].sort());
});

// ---- privacy ------------------------------------------------------------------------------------------------------------------------
test("privacy: no card carries a member's name, alias or character name, a Discord id, or anything from the sign-up entries", async () => {
  const { jobs } = await cardJobs();
  const text = (o) => JSON.stringify(o).toLowerCase();
  const names = new Set();
  for (const m of researchMembers()) {
    if (m.display) names.add(m.display.toLowerCase());
    for (const a of m.aliases) if (!genericAliases.includes(a.toLowerCase())) names.add(a.toLowerCase());
  }
  const signups = JSON.parse(fs.readFileSync(path.join(ROOT, "data/signups.json"), "utf8"));
  for (const e of signups.entries || []) if (e && e.name) names.add(String(e.name).toLowerCase());
  // The party document's members: their own name fields only (a member's professions also have a "name", and "Enchanting" is not a person).
  const party = JSON.parse(fs.readFileSync(path.join(ROOT, "data/party.json"), "utf8"));
  for (const m of party.members || []) for (const k of ["name", "character", "main", "display"]) if (m && typeof m[k] === "string" && m[k].length > 2) names.add(m[k].toLowerCase());
  assert.ok(names.size >= 3, `checked ${names.size} names`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const j of jobs) {
    const t = text({ model: j.model, view: j.view });
    for (const n of names) assert.doesNotMatch(t, new RegExp(`(^|[^a-z0-9])${esc(n)}([^a-z0-9]|$)`), `${j.key} contains a member name`);
    assert.doesNotMatch(t, /\d{15,}/, `${j.key} has an id-shaped number`);
  }
  for (const j of jobs.filter((x) => x.kind === "signup")) assert.deepEqual(Object.keys(j.model), ["kind", "v", "answers", "meet", "when"], "a sign-up card is the buttons' words only");
});

test("privacy: map cards draw no routes, and no start area as a town dot (start areas are cards only where /map offers them as places)", async () => {
  const { jobs } = await cardJobs();
  const atlas = loadAtlas();
  const startNames = new Set(atlas.places.filter((p) => p.kind === "start").map((p) => p.name));
  for (const j of jobs.filter((x) => x.kind === "map")) {
    for (const l of j.model.scene.labels) assert.ok(!(l.cls.startsWith("hlabel") && startNames.has(l.text)), `${j.key} marks the start point ${l.text}`);
    assert.deepEqual(Object.keys(j.model.scene).sort(), ["grid", "h", "labels", "land", "pin", "w", "zones"].sort(), `${j.key}: no route layer`);
  }
});

test("licences: a page card never draws a fact that cites a host whose text needs attribution (CC BY-SA), and the host list matches the sources file", () => {
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "data/library-sources.json"), "utf8")).hosts;
  assert.deepEqual([...ATTRIBUTION_HOSTS].sort(), Object.entries(sources).filter(([, v]) => v && v.storedText === "attribution-required").map(([k]) => k).sort());
  let skipped = 0;
  for (const p of libraryPages()) {
    const facts = p.facts.filter((f) => f && f.key);
    const shown = facts.filter((f) => !needsAttribution(f)).slice(0, PAGE_FACTS).map((f) => cardText(f.value, 140));
    assert.deepEqual(pageModel(pageRow(p)).facts.map((f) => f.value), shown, p.id);
    skipped += facts.slice(0, PAGE_FACTS).filter(needsAttribution).length;
  }
  assert.ok(skipped > 0, "the data has wiki-sourced facts among the first ones, and they are skipped");
  assert.equal(needsAttribution({ refs: [{ url: "https://warcraft.wiki.gg/wiki/X" }] }), true);
  assert.equal(needsAttribution({ refs: [{ host: "www.wowhead.com" }] }), false);
});

test("tooltips: no card for \"blizzard\" or a malformed key, and no game prose (Equip:, Use:) on any card", async () => {
  const { jobs } = await cardJobs();
  const keys = jobs.filter((j) => j.kind === "tooltip").map((j) => j.key);
  assert.ok(!keys.includes("tooltip:blizzard"));
  assert.ok(keys.every((k) => tooltipNameOk(k.slice("tooltip:".length))), "every key is a clean name");
  assert.equal(tooltipNameOk("ancestral spirit | rank:  | level:"), false);
  assert.ok(namedTooltips().list.length >= 120);
  for (const j of jobs.filter((x) => x.kind === "tooltip")) for (const l of j.model.lines) assert.doesNotMatch(l.text, /^(Equip:|Use:|Chance on hit:|Set\s*:)/, j.key);
  for (const f of Object.values(MANIFEST.cards).map((e) => e.file)) assert.doesNotMatch(f, /blizzard|warcraft|\bwow\b/i, "no mark in a file name");
});

// ---- models -------------------------------------------------------------------------------------------------------------------------
test("models: text is cleaned and clipped on a word, labels read well, slugs are file-safe", () => {
  assert.equal(cardText("  a\u200bb \u0007c\n d  ", 40), "a b c d");
  assert.equal(cardText("one two three four five six", 15), "one two three\u2026");
  assert.equal([...cardText("x".repeat(300), 50)].length, 50);
  assert.equal(factLabel("druid.role"), "Role");
  assert.equal(factLabel("mage.spellbook.trainer_prices"), "Trainer prices");
  assert.equal(factLabel("x.level6.cap"), "Level6 cap");
  assert.equal(cardSlug("Ahn'Qiraj Temple / Ruins"), "ahn-qiraj-temple-ruins");
  assert.equal(cardSlug("\u00c9clair"), "eclair");
  const m = pageModel({ id: "x/y", category: "c", title: "T", blurb: "B", facts_json: JSON.stringify([{ key: "a.one", value: 1 }, { value: "no key" }, { key: "a.two", value: "2" }, { key: "a.three", value: "3" }]) });
  assert.equal(m.facts.length, PAGE_FACTS);
  assert.deepEqual(m.facts.map((f) => f.value), ["1", "2"]);
  assert.deepEqual(pageModel({ id: "x", facts_json: "{not json" }).facts, []);
});

// ---- the Worker's decision ----------------------------------------------------------------------------------------------------------
function headStub(status = 200, type = "image/png") {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), method: init && init.method }); return new Response(null, { status, headers: { "content-type": type } }); };
  return { calls, fetchImpl };
}
const druid = libraryPages().find((p) => p.id === "classes/druid");

test("flag off (no binding and no [vars] value, or \"off\", or the binding says false): no card and no request", async () => {
  for (const env of [{ BOARD_PUBLIC_URL: BASE }, { BOARD_PUBLIC_URL: BASE, CARD_IMAGES: "off" }, { BOARD_PUBLIC_URL: BASE, FLAGS: OFF, CARD_IMAGES: "on" }]) {
    _forgetPublished();
    const h = headStub();
    assert.equal(await pageCardUrl(env, pageRow(druid), { fetchImpl: h.fetchImpl }), null);
    assert.equal(await tooltipCardUrl(env, "Fireball", { fetchImpl: h.fetchImpl }), null);
    assert.equal(await mapCardUrl(env, "crossroads", "", { fetchImpl: h.fetchImpl }), null);
    assert.equal(await signupCardUrl(env, RSVP_BUTTON_LABELS, DEFAULT_MEET, DEFAULT_WHEN, { fetchImpl: h.fetchImpl }), null);
    assert.equal(h.calls.length, 0);
  }
});

test("flag on: the card's URL on BOARD_PUBLIC_URL, after one HEAD that answered 200 image/png", async () => {
  _forgetPublished();
  const h = headStub();
  const env = { BOARD_PUBLIC_URL: `${BASE}/`, FLAGS: ON };
  const url = await pageCardUrl(env, pageRow(druid), { fetchImpl: h.fetchImpl });
  assert.equal(url, `${BASE}/${MANIFEST.cards["page:classes/druid"].file}`);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "HEAD");
  assert.match(h.calls[0].url, new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?probe=[0-9a-f-]{36}$`), "the HEAD carries a one-off query, so a 404 is never cached under the card's own URL");
  assert.equal(await pageCardUrl(env, pageRow(druid), { fetchImpl: h.fetchImpl }), url);
  assert.equal(h.calls.length, 1, "a published file is remembered");
  assert.equal(await tooltipCardUrl(env, "  FIREBALL ", { fetchImpl: h.fetchImpl }), `${BASE}/${MANIFEST.cards["tooltip:fireball"].file}`);
  assert.equal(await signupCardUrl(env, RSVP_BUTTON_LABELS, DEFAULT_MEET, DEFAULT_WHEN, { fetchImpl: h.fetchImpl }), `${BASE}/${MANIFEST.cards[Object.keys(MANIFEST.cards).find((k) => k.startsWith("signup:"))].file}`);
});

test("freshness at reply time: a /page row that differs from the drawn one in anything the card shows gets no card", async () => {
  _forgetPublished();
  const h = headStub();
  const env = { BOARD_PUBLIC_URL: BASE, FLAGS: ON };
  const row = pageRow(druid);
  const facts = JSON.parse(row.facts_json);
  for (const changed of [{ ...row, title: "Druid (updated)" }, { ...row, blurb: `Changed. ${row.blurb}` }, { ...row, category: "misc" }, { ...row, facts_json: JSON.stringify([{ ...facts[0], value: "changed" }, ...facts.slice(1)]) }]) {
    assert.equal(await pageCardUrl(env, changed, { fetchImpl: h.fetchImpl }), null);
  }
  assert.equal(h.calls.length, 0, "no HEAD for a stale card");
  const later = [...facts];
  later[PAGE_FACTS] = { ...later[PAGE_FACTS], value: "a fact the card does not show" };
  assert.ok(await pageCardUrl(env, { ...row, facts_json: JSON.stringify(later) }, { fetchImpl: h.fetchImpl }), "a change the card does not show keeps the card");
  assert.ok([...row.blurb].length > 230, "the druid blurb is longer than the card shows");
  assert.ok(await pageCardUrl(env, { ...row, blurb: `${row.blurb} More.` }, { fetchImpl: h.fetchImpl }), "text past the card's clip is not on the card, so the card stays");
  assert.equal(await signupCardUrl(env, RSVP_BUTTON_LABELS, ["Somewhere else"], DEFAULT_WHEN, { fetchImpl: h.fetchImpl }), null, "other sign-up choices: no card until drawn");
  assert.equal(await signupCardUrl(env, ["In", "Maybe", "Late", "Out"], DEFAULT_MEET, DEFAULT_WHEN, { fetchImpl: h.fetchImpl }), null, "other button words: no card");
  assert.equal(await tooltipCardUrl(env, "Not A Spell", { fetchImpl: h.fetchImpl }), null);
  assert.equal(await mapCardUrl(env, "stormwind-city", "", { fetchImpl: h.fetchImpl }), null);
});

test("an unknown key never asks Flagship; a missing file, a non-PNG answer, a timeout or an http origin means no card", async () => {
  let asked = 0;
  const counting = { getBooleanValue: async () => { asked++; return true; } };
  assert.equal(await cardImageUrl({ BOARD_PUBLIC_URL: BASE, FLAGS: counting }, "page:no/such-page"), null);
  assert.equal(asked, 0);
  _forgetPublished();
  for (const [status, type] of [[404, "text/html"], [200, "text/html; charset=utf-8"], [301, "image/png"], [500, "image/png"]]) {
    _forgetPublished();
    assert.equal(await tooltipCardUrl({ BOARD_PUBLIC_URL: BASE, FLAGS: ON }, "fireball", { fetchImpl: headStub(status, type).fetchImpl }), null, `${status} ${type}`);
  }
  _forgetPublished();
  const t0 = Date.now();
  const hang = () => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), PUBLISHED_TIMEOUT_MS + 50));
  assert.equal(await tooltipCardUrl({ BOARD_PUBLIC_URL: BASE, FLAGS: ON }, "fireball", { fetchImpl: (u, init) => new Promise((res, rej) => { init.signal.addEventListener("abort", () => rej(new Error("aborted"))); hang().catch(() => {}); }) }), null);
  assert.ok(Date.now() - t0 < PUBLISHED_TIMEOUT_MS + 1000, "the HEAD is cut off");
  for (const b of ["http://board.test", "board.test", "https://board.test/path", "javascript:alert(1)", ""]) assert.equal(cardSiteBase({ BOARD_PUBLIC_URL: b }), null, b);
  assert.equal(await tooltipCardUrl({ BOARD_PUBLIC_URL: "http://board.test", FLAGS: ON }, "fireball", { fetchImpl: headStub().fetchImpl }), null);
  assert.equal(await cardImageUrl({ BOARD_PUBLIC_URL: BASE, FLAGS: ON }, "page:x", { manifest: { cards: { "page:x": { file: "../../etc/passwd.png", model: "0" } } } }), null, "a manifest file outside cards/ is refused");
});

test("a miss is asked again after a minute; a throwing fetch is a miss", async () => {
  _forgetPublished();
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error("network"); return new Response(null, { status: 200, headers: { "content-type": "image/png" } }); };
  const url = `${BASE}/cards/page/x-000000000000.png`;
  assert.equal(await isPublished(url, { fetchImpl: flaky, now: 1_000_000 }), false);
  assert.equal(await isPublished(url, { fetchImpl: flaky, now: 1_000_000 + MISS_TTL_MS - 1 }), false);
  assert.equal(n, 1, "remembered as a miss");
  assert.equal(await isPublished(url, { fetchImpl: flaky, now: 1_000_000 + MISS_TTL_MS }), true);
  assert.equal(n, 2);
});

test("/map keys: aliases, the plan wins over the place, nothing means the whole atlas", () => {
  assert.equal(mapCardKey("crossroads", ""), "map:the-crossroads");
  assert.equal(mapCardKey("xroads", ""), "map:the-crossroads");
  assert.equal(mapCardKey("vos", ""), "map:valley-of-strength");
  assert.equal(mapCardKey("orgrimmar", "brill"), "map:brill");
  assert.equal(mapCardKey("", ""), "map:atlas");
  assert.equal(mapCardKey("__proto__", ""), "map:__proto__");
  for (const k of ["map:the-crossroads", "map:valley-of-strength", "map:brill", "map:atlas"]) assert.ok(MANIFEST.cards[k], k);
});

test("the pinned sign-up card carries the picture only when loadCardState set one; otherwise it is unchanged", () => {
  const state = { entries: [], options: {}, siteBase: BASE };
  const plain = renderSignupCard(state);
  const withCard = renderSignupCard({ ...state, cardImage: `${BASE}/cards/signup/x-000000000000.png` });
  assert.equal(withCard.embeds[0].image.url, `${BASE}/cards/signup/x-000000000000.png`);
  delete withCard.embeds[0].image;
  assert.deepEqual(withCard, plain);
  assert.equal(JSON.stringify(renderSignupCard({ ...state, cardImage: null })), JSON.stringify(plain));
});

// ---- the Discord handlers ----------------------------------------------------------------------------------------------------------
const signer = createDiscordSigner();
const MEMBERS = [{ slug: "fixture-tester", name: "Fixture Tester", match: ["fixture tester"], id: "fixture-user-0001" }];
function stubDb(pageFor) {
  const seeds = { discord_members: MEMBERS, signups: { entries: [{ slug: "fixture-tester", name: "Fixture Tester", rsvp: "in" }] } };
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        if (/FROM kv_state/i.test(sql)) { const key = /key = '([a-z_]+)'/.exec(sql)?.[1] ?? args[0]; return key in seeds ? { json: JSON.stringify(seeds[key]) } : null; }
        if (/FROM lib_pages/i.test(sql)) return pageFor(args);
        if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return stmt;
  };
  return { prepare, batch: async (s) => s.map(() => ({ success: true, results: [], meta: { changes: 1 } })) };
}
const druidRow = () => ({ ...pageRow(druid), aliases_json: "[]" });
function interaction(name, options) {
  return {
    id: "fixture-interaction-0001", application_id: "fixture-app-0001", token: "fixture-token-not-real", version: 1, guild_id: "fixture-guild-0001", channel_id: "fixture-channel-0001", locale: "en-US",
    member: { user: { id: "fixture-user-0001", username: "fixture_tester", global_name: "Fixture Tester" }, nick: null, roles: [] },
    type: 2, data: { id: `fixture-cmd-${name}`, name, type: 1, options },
  };
}
async function reply(payload, envExtra, head = headStub()) {
  _forgetPublished();
  const env = { DB: stubDb(() => druidRow()), DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: BASE, USER_SALT: "fixture-salt-0123456789", BOARD_ROOM: { idFromName: () => "room", get: () => ({ fetch: async () => new Response("ok") }) }, ...envExtra };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith(`${BASE}/cards/`) ? head.fetchImpl(url, init) : new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    const res = await handleDiscordInteraction(signer.signedRequest(payload), env, { waitUntil: () => {} }, "https://worker.test");
    return { body: await res.json(), head };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const CASES = [
  { name: "page", options: [{ name: "title", type: 3, value: "classes/druid" }], key: "page:classes/druid", at: (b) => b.data.embeds[0] },
  { name: "tooltip", options: [{ name: "name", type: 3, value: "Fireball" }], key: "tooltip:fireball", at: (b) => b.data.embeds[0] },
  { name: "map", options: [{ name: "place", type: 3, value: "crossroads" }], key: "map:the-crossroads", at: (b) => b.data.embeds && b.data.embeds[0] },
  { name: "map", options: [{ name: "plan", type: 3, value: "orgrimmar" }], key: "map:orgrimmar", at: (b) => b.data.embeds && b.data.embeds[0] },
  { name: "map", options: [], key: "map:atlas", at: (b) => b.data.embeds && b.data.embeds[0] },
];
const strip = (body) => {
  const b = structuredClone(body);
  if (b.data.embeds) {
    for (const e of b.data.embeds) delete e.image;
    b.data.embeds = b.data.embeds.filter((e) => Object.keys(e).some((k) => k !== "color"));
    if (!b.data.embeds.length) delete b.data.embeds;
  }
  return b;
};

for (const c of CASES) {
  const label = `/${c.name}${c.options.length ? ` ${c.options[0].name}:${c.options[0].value}` : ""}`;
  test(`${label}: flag off is the same reply with or without the fallback var and makes no card request; on adds exactly the card`, async () => {
    const unset = await reply(interaction(c.name, c.options), {});
    const off = await reply(interaction(c.name, c.options), { CARD_IMAGES: "off" });
    const offBinding = await reply(interaction(c.name, c.options), { FLAGS: OFF, CARD_IMAGES: "on" });
    assert.deepEqual(off.body, unset.body);
    assert.deepEqual(offBinding.body, unset.body);
    for (const r of [unset, off, offBinding]) assert.equal(r.head.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(unset.body), /\/cards\//);
    const on = await reply(interaction(c.name, c.options), { FLAGS: ON });
    const target = c.at(on.body);
    assert.ok(target && target.image, `${label}: an image with the flag on`);
    assert.equal(target.image.url, `${BASE}/${MANIFEST.cards[c.key].file}`);
    assert.deepEqual(strip(on.body), unset.body, "nothing else changes");
    const missing = await reply(interaction(c.name, c.options), { FLAGS: ON }, headStub(404, "text/html"));
    assert.deepEqual(missing.body, unset.body, "flag on but the file is not on the site: the reply without a card");
  });
}

test("/page for a row that is not the drawn one: flag on, no card", async () => {
  _forgetPublished();
  const head = headStub();
  const env = { DB: stubDb(() => ({ id: "classes/druid", category: "classes", title: "Druid", blurb: "Made-up blurb for a test.", facts_json: "[]" })), DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: BASE, USER_SALT: "fixture-salt-0123456789", FLAGS: ON };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => head.fetchImpl(url, init);
  try {
    const res = await handleDiscordInteraction(signer.signedRequest(interaction("page", [{ name: "title", type: 3, value: "classes/druid" }])), env, { waitUntil: () => {} }, "https://worker.test");
    const body = await res.json();
    assert.equal(body.data.embeds[0].image, undefined);
    assert.equal(head.calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the model hashed by the renderer for a page is the one the Worker rebuilds from the seeded row", async () => {
  const row = pageRow(druid);
  assert.equal(await modelHash(pageModel(row)), MANIFEST.cards["page:classes/druid"].model);
  assert.equal(await modelHash(signupModel(RSVP_BUTTON_LABELS, DEFAULT_MEET, DEFAULT_WHEN)), MANIFEST.cards[Object.keys(MANIFEST.cards).find((k) => k.startsWith("signup:"))].model);
});

test("/signup (no options) never carries a picture: its own buttons are not the pinned card's", async () => {
  const off = await reply(interaction("signup", []), {});
  const on = await reply(interaction("signup", []), { FLAGS: ON });
  assert.deepEqual(on.body, off.body);
  assert.equal(on.head.calls.length, 0);
});

test("the pinned sign-up card gets its picture from loadCardState only with the flag on and the file published", async () => {
  const signups = { entries: [{ slug: "fixture-tester", name: "Fixture Tester", rsvp: "in" }] };
  const db = { prepare: (sql) => ({ bind: () => ({ first: async () => null }), first: async () => (/key = 'signups'/.test(sql) ? { json: JSON.stringify(signups) } : null) }) };
  const realFetch = globalThis.fetch;
  const head = headStub();
  globalThis.fetch = async (u, init) => head.fetchImpl(u, init);
  try {
    _forgetPublished();
    const off = await loadCardState({ DB: db, BOARD_PUBLIC_URL: BASE });
    assert.equal(off.cardImage, undefined);
    assert.equal(head.calls.length, 0);
    const on = await loadCardState({ DB: db, BOARD_PUBLIC_URL: BASE, FLAGS: ON });
    const file = MANIFEST.cards[Object.keys(MANIFEST.cards).find((k) => k.startsWith("signup:"))].file;
    assert.equal(on.cardImage, `${BASE}/${file}`);
    assert.equal(renderSignupCard(on).embeds[0].image.url, `${BASE}/${file}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- second review of PR 437 ------------------------------------------------------------------------------------------------------
test("fonts: one list serves the page, hashes into the inputs and checks coverage; card.css loads exactly those files and draws no CSS-generated text", () => {
  assert.equal(FONT_FILES, CARD_FONTS, "render.mjs uses the list fonts.mjs checks");
  const css = fs.readFileSync(path.join(ROOT, "tools/cards/card.css"), "utf8");
  const loaded = [...css.matchAll(/url\("\/fonts\/([a-z0-9-]+\.woff2)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(loaded)].sort(), [...CARD_FONTS].sort(), "every @font-face file is a checked font, and every checked font is loaded");
  for (const f of CARD_FONTS) assert.ok(fs.existsSync(path.join(ROOT, "fonts", f)), f);
  // text from `content:` never reaches textContent, which is what render.mjs checks for glyph coverage: only empty strings are allowed
  for (const m of css.matchAll(/(?<![-\w])content\s*:\s*([^;}]*)/g)) assert.match(m[1].trim(), /^(""|''|none|normal)$/, `card.css content: ${m[1]}`);
  const js = fs.readFileSync(path.join(ROOT, "tools/cards/card.js"), "utf8");
  assert.match(js, /text: card\.textContent/, "renderCard reports the card's text so every drawn character is checked");
});

test("the file check can wait longer and ignore a remembered miss (the deferred redraw of the pinned card), while replies keep the short wait", async () => {
  const url = `${BASE}/cards/page/x-000000000000.png`;
  const slow = (ms, status = 200) => async (u, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(null, { status, headers: { "content-type": "image/png" } })), ms);
    init.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
  });
  _forgetPublished();
  assert.equal(await isPublished(url, { fetchImpl: slow(150), timeoutMs: 40 }), false, "too slow for the short wait");
  assert.equal(await isPublished(url, { fetchImpl: slow(150), timeoutMs: 400, retryMiss: true }), true, "the longer wait on a remembered miss answers");
  _forgetPublished();
  assert.equal(await isPublished(url, { fetchImpl: slow(0, 404) }), false);
  assert.equal(await isPublished(url, { fetchImpl: slow(0) }), false, "without retryMiss a remembered miss stays a miss for a minute");
  assert.equal(await isPublished(url, { fetchImpl: slow(0), retryMiss: true }), true, "with retryMiss it asks again");
  assert.equal(await isPublished(url, { fetchImpl: slow(0, 404), retryMiss: true }), true, "a remembered hit is kept");
});

test("loadCardState waits for a slow file check (up to 3 s) and retries a remembered miss, so one slow answer cannot take the picture off the pinned card", async () => {
  const signups = { entries: [] };
  const db = { prepare: (sql) => ({ bind: () => ({ first: async () => null }), first: async () => (/key = 'signups'/.test(sql) ? { json: JSON.stringify(signups) } : null) }) };
  const file = MANIFEST.cards[Object.keys(MANIFEST.cards).find((k) => k.startsWith("signup:"))].file;
  const realFetch = globalThis.fetch;
  let delay = PUBLISHED_TIMEOUT_MS + 150;
  globalThis.fetch = async (u, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(null, { status: 200, headers: { "content-type": "image/png" } })), delay);
    init.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
  });
  try {
    _forgetPublished();
    const env = { DB: db, BOARD_PUBLIC_URL: BASE, FLAGS: ON };
    assert.equal((await loadCardState(env)).cardImage, `${BASE}/${file}`, "an answer slower than a reply would wait still gets the picture");
    _forgetPublished();
    assert.equal(await isPublished(`${BASE}/${file}`, { fetchImpl: () => Promise.reject(new Error("down")) }), false); // a miss is now remembered
    delay = 0;
    assert.equal((await loadCardState(env)).cardImage, `${BASE}/${file}`, "a remembered miss is asked again by the redraw");
  } finally {
    globalThis.fetch = realFetch;
  }
});
