// Discord rejects a whole reply when one component is invalid, and users then see "The application did not respond".
// Pins: every component in every reply we can drive is structurally valid; a throw after verification still answers;
// a bad signature stays 401; /launch stops after launch. Fictional data, no network.
// Run: node --test tests/unit/discord-components.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handleDiscordInteraction, LAUNCH_UTC } from "../../infrastructure/worker/discord.js";
import { LAUNCH_EPOCH } from "../../infrastructure/worker/tonight-copy.js";
import { readFileSync } from "node:fs";
import { SLASH_COPY } from "../../infrastructure/worker/slash-copy.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { fakeD1 } from "./fake-d1.mjs";

const URL_ = "https://board.test";
const signer = createDiscordSigner();
const CH = "100000000000000001", USER = "1".repeat(18);
const who = { user: { id: USER, username: "ada" } };
let seq = 0;
const nextId = () => String(300000000000000000n + BigInt(++seq) * 7n); // unique; ids ending in 0 would take the purge path
const slash = (name, options = []) => ({ type: 2, id: nextId(), application_id: "400000000000000004", token: "t", channel_id: CH, member: who, data: { name, options } });
const opt = (name, value) => ({ name, type: 3, value });
const realFetch = globalThis.fetch;
const realNow = Date.now;
globalThis.fetch = async () => new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
test.after(() => { globalThis.fetch = realFetch; Date.now = realNow; });

function mkEnv(extraKv = {}, dbPatch) {
  invalidateConfigCache();
  const DB = fakeD1({
    discord_members: [{ slug: "ada", name: "Ada", match: ["ada"], id: USER }],
    signups: { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [{ name: "Ada", rsvp: "in" }] },
    ...extraKv,
  }, { lenient: true });
  if (!DB.batch) DB.batch = async (s) => s.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  if (dbPatch) dbPatch(DB);
  return { DB, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: URL_ };
}
const call = (interaction, env, reqOpts) => handleDiscordInteraction(signer.signedRequest(interaction, reqOpts), env, { waitUntil() {} }, "https://worker.test");
async function send(interaction, extraKv) { return (await call(interaction, mkEnv(extraKv))).json(); }

// The structural rule for a reply's components (type 1 rows holding type 2 buttons).
function assertUrl(u, at) {
  let parsed;
  assert.doesNotThrow(() => { parsed = new URL(u); }, `${at}: url parses`);
  assert.ok(parsed.protocol === "http:" || parsed.protocol === "https:", `${at}: url is http(s)`);
}
function assertComponentsValid(components, where) {
  if (components === undefined) return;
  const ids = [];
  assert.ok(Array.isArray(components) && components.length <= 5, `${where}: up to 5 rows`);
  for (const [ri, row] of components.entries()) {
    const at = `${where} row ${ri}`;
    assert.equal(row.type, 1, `${at}: a top-level component is an action row (type 1)`);
    assert.ok(Array.isArray(row.components) && row.components.length >= 1 && row.components.length <= 5, `${at}: 1 to 5 children`);
    for (const [ci, c] of row.components.entries()) {
      const cat = `${at} child ${ci} (${c.label})`;
      assert.equal(c.type, 2, `${cat}: a button is type 2 (type 5 is a User Select)`);
      assert.ok(typeof c.label === "string" && c.label.length >= 1 && c.label.length <= 80, `${cat}: label 1 to 80 chars`);
      assert.equal((c.custom_id ? 1 : 0) + (c.url ? 1 : 0), 1, `${cat}: exactly one of custom_id or url`);
      assert.equal(c.style === 5, Boolean(c.url), `${cat}: style 5 iff url`);
      if (c.custom_id) { assert.ok(c.custom_id.length <= 100, `${cat}: custom_id <= 100`); ids.push(c.custom_id); }
      if (c.url) assertUrl(c.url, cat);
      assert.ok(Number.isInteger(c.style) && c.style >= 1 && c.style <= 5, `${cat}: style 1..5`);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${where}: custom_ids are unique within the message`);
}
// Also the embed urls of a reply (a /page embed links to the board).
function assertEmbedUrls(data, where) {
  for (const [i, e] of (data.embeds || []).entries()) if (e.url) assertUrl(e.url, `${where} embed ${i}`);
}
const PAGE_ROW = { id: "fixture-page", category: "fixture", title: "Fixture Page", blurb: "A fictional page.", facts_json: "[]" };
const withPage = (DB) => {
  const prepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    const o = prepare(sql);
    if (!/FROM lib_pages/.test(sql)) return o;
    return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => PAGE_ROW }; } };
  };
};

test("the structural checker rejects the old broken button", () => {
  assert.throws(() => assertComponentsValid([{ type: 1, components: [{ type: 5, style: 5, label: "Open Sign-ups", url: "https://x.test" }] }], "old"), /type 2/);
});

test("every drivable slash reply has valid components", async () => {
  const cases = [
    slash("signup"), slash("signup", [opt("rsvp", "maybe")]), slash("map", [opt("place", "Org")]), slash("start"), slash("dates"),
    slash("library"), slash("didyouknow"), slash("journey", [opt("choice", "guided")]), slash("quiz"), slash("vote"), slash("tonight"),
    slash("countdown"), slash("help"), slash("leeroy"), slash("page", [opt("title", "Nope")]), slash("tooltip", [opt("name", "Nope")]),
    slash("launch"), slash("build"), slash("sheet"), slash("page", [opt("title", "Fixture Page")]),
    slash("map", [opt("place", "x".repeat(60))]), slash("map", [opt("plan", "y".repeat(60))]),
  ];
  Date.now = () => LAUNCH_UTC - 86400000;
  try {
    let withComponents = 0;
    for (const i of cases) {
      const body = await (await call(i, mkEnv({}, withPage))).json();
      assert.equal(body.type, 4, `${i.data.name}: reply type`);
      assert.notEqual(body.data && body.data.content, SLASH_COPY.interactionFailed(), `/${i.data.name} fell into the catch path`);
      assertEmbedUrls(body.data || {}, `/${i.data.name}`);
      const comps = body.data && body.data.components;
      assertComponentsValid(comps, `/${i.data.name}`);
      if (comps) withComponents++;
    }
    assert.ok(withComponents >= 5, `expected several replies with components, saw ${withComponents}`);
  } finally { Date.now = realNow; }
});

test("/signup with no options: a link button (type 2, style 5, url) next to the three RSVP buttons", async () => {
  const body = await send(slash("signup"));
  const kids = body.data.components[0].components;
  assert.deepEqual(kids.map((c) => c.type), [2, 2, 2, 2]);
  assert.equal(kids[3].url, `${URL_}/#signups`);
  assert.equal(kids[3].style, 5);
  assert.equal(kids[3].custom_id, undefined);
  assertComponentsValid(body.data.components, "/signup");
});

test("/launch before launch is unchanged; after launch it is one honest line", async () => {
  try {
    Date.now = () => LAUNCH_UTC - 3600000;
    const before = await send(slash("launch"));
    assert.equal(before.data.content, `${SLASH_COPY.launchHeader()}
No launch states set yet.`);
    assert.equal(before.data.flags, 64);

    Date.now = () => LAUNCH_UTC + 3600000;
    const after = await send(slash("launch"));
    assert.equal(after.type, 4);
    assert.equal(after.data.flags, 64);
    assert.equal(after.data.content, SLASH_COPY.launchOver(URL_));
    assert.match(after.data.content, /\/ask/);
    assert.ok(after.data.content.includes(URL_));
    assert.doesNotMatch(after.data.content, /Nov|<t:|\d+ ?(hours|days|minutes)/);
    assertComponentsValid(after.data.components, "/launch after");

    // A state option after launch records nothing.
    const env = mkEnv();
    const res = await call(slash("launch", [opt("state", "in")]), env);
    assert.equal((await res.json()).data.content, SLASH_COPY.launchOver(URL_));
    assert.equal(env.DB.kv.has("launch"), false);
  } finally { Date.now = realNow; }
});

test("a throw after verification still answers: command 200 type 4 flags 64", async () => {
  const env = mkEnv({}, (DB) => {
    const prepare = DB.prepare.bind(DB);
    DB.prepare = (sql) => {
      const o = prepare(sql);
      return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => { throw new Error("db down"); } }; }, first: async () => { throw new Error("db down"); } };
    };
  });
  const seen = [];
  const realErr = console.error; console.error = (...a) => seen.push(a.join(" "));
  try {
    const res = await call(slash("tonight"), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
    assert.equal(body.data.content, "Something broke on my side. Check the board before you try again.");
    assert.doesNotMatch(body.data.content, /try again in a moment/i);
    assert.deepEqual(body.data.allowed_mentions, { parse: [] });
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((s) => !s.includes("db down")), "the log line carries no err.message");
    assert.ok(seen.some((s) => s.includes("Error") && s.includes("[interaction_catch]")), "the log line is err.name plus a fixed tag");
  } finally { console.error = realErr; }
});

test("a throw during autocomplete answers type 8 with no choices", async () => {
  const env = mkEnv();
  const realErr = console.error; console.error = () => {};
  try {
    const res = await call({ type: 4, id: nextId(), application_id: "400000000000000004", token: "t", channel_id: CH, member: who, data: { name: "page", options: 5 } }, env); // a signed but malformed options field makes the handler throw
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { type: 8, data: { choices: [] } });
  } finally { console.error = realErr; }
});

test("signature failures stay 401 and PING is unaffected", async () => {
  const env = mkEnv({}, (DB) => { DB.prepare = () => { throw new Error("db down"); }; });
  const bad = await call(slash("tonight"), env, { tamper: true });
  assert.equal(bad.status, 401);
  const stale = await call(slash("tonight"), env, { timestamp: 1000 });
  assert.equal(stale.status, 401);
  const ping = await call({ type: 1 }, env);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { type: 1 });
});

test("a signed-wrong non-JSON body is 401, not a crash", async () => {
  const env = mkEnv();
  const res = await call("not json {", env, { tamper: true });
  assert.equal(res.status, 401);
});

test("/launch at exactly LAUNCH_UTC is the post-launch line; one ms earlier is the old reply", async () => {
  try {
    Date.now = () => LAUNCH_UTC;
    assert.equal((await send(slash("launch"))).data.content, SLASH_COPY.launchOver(URL_));
    Date.now = () => LAUNCH_UTC - 1;
    assert.equal((await send(slash("launch"))).data.content, `${SLASH_COPY.launchHeader()}
No launch states set yet.`);
  } finally { Date.now = realNow; }
});

test("LAUNCH_UTC is LAUNCH_EPOCH in ms and matches data/timeline.json", () => {
  assert.equal(LAUNCH_UTC, LAUNCH_EPOCH * 1000);
  const timeline = JSON.parse(readFileSync(new URL("../../data/timeline.json", import.meta.url), "utf8"));
  const rows = Array.isArray(timeline) ? timeline : timeline.events || timeline.items || Object.values(timeline).find(Array.isArray) || [];
  const launch = rows.find((r) => r && r.key === "launch");
  assert.ok(launch, "timeline has a launch row");
  assert.equal(launch.epoch, LAUNCH_EPOCH);
});

test("/map caps a 60-character place: label <= 80 and a short slug (a long plan is refused, see below)", async () => {
  for (const [name, hashPrefix] of [["place", "#atlas."]]) {
    const body = await send(slash("map", [opt(name, "a".repeat(60))]));
    const btn = body.data.components[0].components[0];
    assert.ok(btn.label.length >= 1 && btn.label.length <= 80, `${name}: label ${btn.label.length}`);
    const slug = btn.url.split(hashPrefix)[1];
    assert.ok(slug && slug.length <= 40, `${name}: slug ${slug && slug.length}`);
  }
});

// ---- honest copy after launch, closed votes, and commands that promise only what they do (fictional data) ----
const button = (customId, extra = {}) => ({ type: 3, id: nextId(), application_id: "400000000000000004", token: "t", channel_id: CH, member: who, message: { id: "500000000000000001" }, data: { custom_id: customId, component_type: 2 }, ...extra });
const asAt = async (ms, fn) => { Date.now = () => ms; try { return await fn(); } finally { Date.now = realNow; } };
const allText = (b) => JSON.stringify(b);

test("/countdown after launch no longer offers name reservation; before launch it still does", async () => {
  const after = await asAt(LAUNCH_UTC + 3600000, () => send(slash("countdown")));
  assert.doesNotMatch(allText(after), /Names open|Name Reservation|until Nov 3/);
  const before = await asAt(LAUNCH_UTC - 86400000, () => send(slash("countdown")));
  assert.match(allText(before), /Names open for pack buyers/);
});

test("/tonight link button: 'Open Tonight on Board' only before launch; after launch it does not say tonight", async () => {
  const label = async (ms) => {
    const body = await asAt(ms, () => send(slash("tonight")));
    assertComponentsValid(body.data.components, "/tonight");
    return body.data.components[0].components[0].label;
  };
  assert.equal(await label(LAUNCH_UTC - 86400000), "Open Tonight on Board");
  assert.doesNotMatch(await label(LAUNCH_UTC + 86400000), /tonight/i);
});

test("/help: no 'plus your question', launch-night wording gated, staff commands only for admins", async () => {
  const text = async (ms, member) => asAt(ms, async () => (await (await call({ ...slash("help"), member }, mkEnv())).json()).data.content);
  const user = { user: who.user };
  const admin = { user: who.user, permissions: "8" };
  const plain = await text(LAUNCH_UTC - 86400000, user);
  assert.doesNotMatch(plain, /plus your question/);
  assert.match(plain, /`\/ask`/);
  assert.doesNotMatch(plain, /\/intents|\/ack|\/answer|Mailbox/, "a non-admin is not shown staff commands");
  assert.match(plain, /your launch night/);
  assert.match(await text(LAUNCH_UTC - 86400000, admin), /\/intents/);
  const post = await text(LAUNCH_UTC + 86400000, user);
  assert.doesNotMatch(post, /your launch night/, "after launch /tonight is not 'your launch night'");
  assert.doesNotMatch(post, /\/intents|\/ack|\/answer/);
  assert.match(await text(LAUNCH_UTC + 86400000, admin), /\/intents/);
});

test("an unrecognised command, button or modal says nothing was done", async () => {
  for (const i of [slash("nosuchcommand"), button("zzz:unknown"), { ...button("zzz:modal"), type: 5, data: { custom_id: "zzz:modal", components: [] } }]) {
    const body = await send(i);
    assert.equal(body.type, 4);
    assert.doesNotMatch(body.data.content, /received/i);
    assert.match(body.data.content, /nothing was done/i);
    assert.equal(body.data.flags, 64);
  }
});

const VOTE_ID = "abcdef01";
const mkVote = (closesAt) => ({ id: VOTE_ID, title: "Which snack", choices: ["Chicken", "Bread"], closes_at: new Date(closesAt).toISOString(), ballots: {} });
test("a click on a closed vote updates the message in place with disabled buttons", async () => {
  const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
  for (const id of [`vote:${VOTE_ID}:0`, `vote:${VOTE_ID}:1`]) {
    const body = await asAt(NOW, () => send(button(id), { [`vote:${VOTE_ID}`]: mkVote(NOW - 60000) }));
    assert.equal(body.type, 7, "update message, not an ephemeral reply");
    assert.equal(body.data.flags, undefined);
    assert.match(body.data.content, /Closed\./);
    assertComponentsValid(body.data.components, "closed vote");
    const choices = body.data.components.flatMap((r) => r.components).filter((c) => /^vote:abcdef01:\d$/.test(c.custom_id));
    assert.equal(choices.length, 2);
    assert.ok(choices.every((c) => c.disabled === true), "every choice button is disabled");
  }
  // Results stays a private read.
  const results = await asAt(NOW, () => send(button(`vote:${VOTE_ID}:results`), { [`vote:${VOTE_ID}`]: mkVote(NOW - 60000) }));
  assert.equal(results.type, 4);
  assert.equal(results.data.flags, 64);
});

test("/quiz offers no reaction reveal and always shows the answer behind a spoiler bar", async () => {
  const { DISCORD_SLASH_COMMANDS_MANIFEST } = await import("../../infrastructure/worker/discord.js");
  const quiz = DISCORD_SLASH_COMMANDS_MANIFEST.find((c) => c.name === "quiz");
  assert.doesNotMatch(JSON.stringify(quiz), /reaction|React with|eyes/i);
  for (const v of ["reaction", "spoiler", ""]) {
    const body = await send(slash("quiz", v ? [opt("reveal", v)] : []));
    assert.doesNotMatch(body.data.content, /React with/);
    assert.match(body.data.content, /\|\|[^|]+\|\|/, `reveal=${v || "none"}: the answer sits behind a spoiler bar`);
  }
});

test("/tooltip says Verified in only when the title or an alias matches; a facts-only match says Mentioned on", async () => {
  const embedFor = async (row) => {
    const env = mkEnv({}, (DB) => {
      const prepare = DB.prepare.bind(DB);
      DB.prepare = (sql) => {
        const o = prepare(sql);
        if (!/FROM lib_pages/.test(sql)) return o;
        return { ...o, bind: (...a) => { const b = o.bind(...a); return { ...b, first: async () => row }; } };
      };
    });
    return (await (await call(slash("tooltip", [opt("name", "Frostbolt")]), env)).json()).data.embeds[0].description;
  };
  const base = { id: "mage-spells", category: "spells", title: "Mage Spells", aliases_json: "[]", facts_json: "[]" };
  assert.match(await embedFor({ ...base, title: "Frostbolt" }), /Verified in \*\*Frostbolt\*\*/);
  assert.match(await embedFor({ ...base, aliases_json: JSON.stringify(["frostbolt rank 1"]) }), /Verified in/);
  const facts = await embedFor({ ...base, facts_json: JSON.stringify([{ t: "Frostbolt slows" }]) });
  assert.match(facts, /Mentioned on \*\*Mage Spells\*\*/);
  assert.doesNotMatch(facts, /Verified/);
});

const acMap = (focusedName, value) => ({ type: 4, id: nextId(), application_id: "400000000000000004", token: "t", channel_id: CH, member: who, data: { name: "map", options: [{ name: focusedName, type: 3, value, focused: true }] } });
const planUrl = async (value, extraKv) => { const b = await send(slash("map", [opt("plan", value)]), extraKv); return b.data.components ? b.data.components[0].components[0].url : null; };

test("MAP_PLAN_PLACES is exactly the set of places the Atlas can chart a plan to (recomputed from data/atlas)", async () => {
  const { buildGraph, makePlan } = await import("../../atlas/routes.js");
  const { MAP_PLAN_PLACES } = await import("../../infrastructure/worker/map-plan.js");
  const read = (n) => JSON.parse(readFileSync(new URL(`../../data/atlas/${n}.json`, import.meta.url), "utf8"));
  const places = read("places").places, graph = buildGraph(read("routes"));
  const routable = places.filter((p) => makePlan(graph, { meet: p.id }).who.length > 0);
  assert.deepEqual(MAP_PLAN_PLACES.map((p) => p.value).sort(), routable.map((p) => p.id).sort());
  for (const r of routable) assert.equal(MAP_PLAN_PLACES.find((p) => p.value === r.id).name, r.name);
});

test("/map plan: any routable place and the configured meeting points chart; the rest is refused with no link", async () => {
  for (const bad of ["no-such-place", "mulgore", "stormwind-keep", "x".repeat(60), "../../etc/passwd", "<script>alert(1)</script>", "@everyone", "a b; drop table"]) {
    const body = await send(slash("map", [opt("plan", bad)]));
    assert.equal(body.type, 4);
    assert.doesNotMatch(allText(body), /charted|atlas\.plan\./i, bad);
    assert.equal(body.data.components, undefined, bad);
    assert.equal(body.data.flags, 64, bad);
    assert.deepEqual(body.data.allowed_mentions, { parse: [] }, bad);
    assert.match(body.data.content, /No route plan/);
  }
  // Every place the board can chart, not just the two on the sign-up card (the old autocomplete offered these).
  for (const ok of ["valley-of-strength", "the-crossroads", "orgrimmar", "razor-hill", "brill", "bloodhoof-village", "undercity"]) {
    const body = await send(slash("map", [opt("plan", ok)]));
    const btn = body.data.components[0].components[0];
    assert.equal(btn.url, `${URL_}/#atlas.plan.${ok}`);
    assert.ok(btn.label.length <= 80);
    assertComponentsValid(body.data.components, `/map plan:${ok}`);
  }
  // A custom meeting point an admin added to the sign-up card (fictional), slugged the way the board does (MEM.slug).
  const custom = { signups: { options: { meet: ["Valley of Strength", "Fictional Fort #3", "The Crossroads"] }, entries: [] } };
  assert.equal(await planUrl("fictional-fort-3", custom), `${URL_}/#atlas.plan.fictional-fort-3`);
  assert.equal(await planUrl("fictional-fort-3"), null, "not offered when the admin has not configured it");
  assert.equal(await planUrl("orgrimmar", custom), `${URL_}/#atlas.plan.orgrimmar`);
  assert.equal(await planUrl("../fictional-fort-3", custom), null);
  const place = await send(slash("map", [opt("place", "orgrimmar")]));
  assert.equal(place.data.components[0].components[0].url, `${URL_}/#atlas.orgrimmar`);
});

test("/map plan aliases vos, crossroads and xroads resolve to the meeting point they always meant", async () => {
  for (const [alias, id] of [["vos", "valley-of-strength"], ["VoS", "valley-of-strength"], ["crossroads", "the-crossroads"], ["xroads", "the-crossroads"]]) {
    const btn = (await send(slash("map", [opt("plan", alias)]))).data.components[0].components[0];
    assert.equal(btn.url, `${URL_}/#atlas.plan.${id}`, alias);
    assert.match(btn.label, new RegExp(id));
  }
});

test("/map autocomplete for plan offers the routable set plus configured meeting points, not the place list", async () => {
  const values = (await send(acMap("plan", ""))).data.choices.map((c) => c.value);
  for (const v of ["orgrimmar", "razor-hill", "brill", "bloodhoof-village", "valley-of-strength", "the-crossroads"]) assert.ok(values.includes(v), v);
  assert.ok(!values.includes("mulgore") && !values.includes("tirisfal-glades"), "a zone does not route");
  assert.ok(values.length <= 25);
  assert.deepEqual((await send(acMap("plan", "razor"))).data.choices.map((c) => c.value), ["razor-hill"]);
  assert.deepEqual((await send(acMap("plan", "xroads"))).data.choices.map((c) => c.value), ["the-crossroads"]);
  const custom = { signups: { options: { meet: ["Fictional Fort"] }, entries: [] } };
  assert.deepEqual((await send(acMap("plan", "fictional"), custom)).data.choices.map((c) => c.value), ["fictional-fort"]);
  assert.deepEqual((await send(acMap("place", "mul"))).data.choices.map((c) => c.value), ["mulgore", "bloodhoof-village"]);
});

test("launch-instant boundary: LAUNCH_UTC - 1 is still pre-launch, LAUNCH_UTC is post-launch (/tonight, /countdown, /help)", async () => {
  const label = async (ms) => (await asAt(ms, () => send(slash("tonight")))).data.components[0].components[0].label;
  assert.equal(await label(LAUNCH_UTC - 1), "Open Tonight on Board");
  assert.equal(await label(LAUNCH_UTC), "Open the Board");
  const cd = async (ms) => allText(await asAt(ms, () => send(slash("countdown"))));
  assert.match(await cd(LAUNCH_UTC - 1), /Names open for pack buyers/);
  assert.doesNotMatch(await cd(LAUNCH_UTC), /Names open|Name Reservation/);
  const help = (ms) => asAt(ms, async () => (await (await call({ ...slash("help"), member: { user: who.user } }, mkEnv())).json()).data.content);
  assert.match(await help(LAUNCH_UTC - 1), /your launch night/);
  assert.doesNotMatch(await help(LAUNCH_UTC), /your launch night/);
});

test("/help: the staff line needs an admin of the roster server; a foreign-guild admin does not see it", async () => {
  const HOME = "200000000000000001", FOREIGN = "999999999999999999";
  const content = async (interaction) => (await (await call(interaction, mkEnv({ discord_roster: { guildId: HOME } }))).json()).data.content;
  const admin = { user: who.user, permissions: "8" };
  assert.match(await content({ ...slash("help"), guild_id: HOME, member: admin }), /\/intents/, "admin of the roster server sees it");
  for (const [label, i] of [["foreign guild", { ...slash("help"), guild_id: FOREIGN, member: admin }], ["no guild", { ...slash("help"), guild_id: undefined, member: admin }], ["roster-server non-admin", { ...slash("help"), guild_id: HOME, member: { user: who.user } }]]) {
    assert.doesNotMatch(await content(i), /\/intents|\/ack|\/answer|Mailbox/, label);
  }
});

test("a closed vote whose stored document cannot be rendered answers with the plain ephemeral 'closed' reply", async () => {
  const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
  const corrupt = { id: VOTE_ID, title: "Which snack", choices: "not-a-list", closes_at: new Date(NOW - 60000).toISOString(), ballots: {} };
  for (const id of [`vote:${VOTE_ID}:0`, `vote:${VOTE_ID}:1`]) {
    const body = await asAt(NOW, () => send(button(id), { [`vote:${VOTE_ID}`]: corrupt }));
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
    assert.match(body.data.content, /That vote is closed/);
    assert.doesNotMatch(body.data.content, /broke on my side/i);
  }
});
