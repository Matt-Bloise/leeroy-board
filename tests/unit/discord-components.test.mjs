// Discord rejects a whole reply when one component is invalid, and users then see "The application did not respond".
// Pins: every component in every reply we can drive is structurally valid; a throw after verification still answers;
// a bad signature stays 401; /launch stops after launch. Fictional data, no network.
// Run: node --test tests/unit/discord-components.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handleDiscordInteraction, LAUNCH_UTC } from "../../infrastructure/worker/discord.js";
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
function assertComponentsValid(components, where) {
  if (components === undefined) return;
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
      if (c.custom_id) assert.ok(c.custom_id.length <= 100, `${cat}: custom_id <= 100`);
      assert.ok(Number.isInteger(c.style) && c.style >= 1 && c.style <= 5, `${cat}: style 1..5`);
    }
  }
}

test("the structural checker rejects the old broken button", () => {
  assert.throws(() => assertComponentsValid([{ type: 1, components: [{ type: 5, style: 5, label: "Open Sign-ups", url: "https://x.test" }] }], "old"), /type 2/);
});

test("every drivable slash reply has valid components", async () => {
  const cases = [
    slash("signup"), slash("signup", [opt("rsvp", "maybe")]), slash("map", [opt("place", "Org")]), slash("start"), slash("dates"),
    slash("library"), slash("didyouknow"), slash("journey", [opt("choice", "guided")]), slash("quiz"), slash("vote"), slash("tonight"),
    slash("countdown"), slash("help"), slash("leeroy"), slash("page", [opt("title", "Nope")]), slash("tooltip", [opt("name", "Nope")]),
    slash("launch"), slash("build"),
  ];
  Date.now = () => LAUNCH_UTC - 86400000;
  try {
    let withComponents = 0;
    for (const i of cases) {
      const body = await send(i);
      assert.equal(body.type, 4, `${i.data.name}: reply type`);
      const comps = body.data && body.data.components;
      assertComponentsValid(comps, `/${i.data.name}`);
      if (comps) withComponents++;
    }
    assert.ok(withComponents >= 3, `expected several replies with components, saw ${withComponents}`);
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
    assert.equal(before.data.content, `${SLASH_COPY.launchHeader()}\nNo launch states set yet.`);
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
    assert.equal(body.data.content, "Something broke on my side. Try again in a moment.");
    assert.ok(seen.length >= 1);
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
