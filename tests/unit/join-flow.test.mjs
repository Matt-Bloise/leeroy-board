// Batch A: /join, the /build modal with a handle, BUILD_PROJECT (atomic write of tenant + model-B rows + roster + party document),
// the party and roster read from D1 (A5), and the first-contact hint. Drives infrastructure/worker/discord.js with signed interactions
// and an in-memory D1 stub that applies a batch all-or-nothing, like D1. No network, no AI, no Blizzard. Ids are built at run time.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { SQL as BUILD_SQL } from "../../infrastructure/worker/build-modal.js";
import { SQL as SETUP_SQL, manifestFor } from "../../infrastructure/worker/setup-command.js";
import { SQL as PROJECT_SQL } from "../../infrastructure/worker/project-build.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { resetJoinHints } from "../../infrastructure/worker/join.js";
import { mergePartyMembers, mergeRoster, PARTY_MEMBERS } from "../../infrastructure/worker/party-source.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { buildPartySheetsFromD1 } from "../../infrastructure/worker/index.js";
import { DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fx = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "discord", f), "utf8")).interaction;
const PARTY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "party.json"), "utf8"));
const USER = "1".repeat(18);
const OTHER = "3".repeat(18);
const GUILD = "2".repeat(18);
const STRANGER_GUILD = "4".repeat(18);
const flags = { BUILD_MODAL: "on", BUILD_PROJECT: "on" };

const ROSTER_SEED = PARTY.members.map((m) => {
  const slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { slug, name: m.name, match: [m.name.toLowerCase()] };
});

// In-memory D1. Statements are recognised by their exact SQL, so a changed statement fails here.
function stubDb({ failOn = null, party = PARTY, members = ROSTER_SEED } = {}) {
  const state = {
    kv: { discord_roster: JSON.stringify({ guildId: GUILD }), ...(party ? { party: JSON.stringify(party) } : {}), ...(members ? { discord_members: JSON.stringify(members) } : {}) },
    tenants: [], users: {}, characters: {}, builds: [],
  };
  const apply = (s, sql, a) => {
    if (sql === SETUP_SQL.tenant) {
      const t = s.tenants.find((x) => x.guild === a[1]);
      if (t) { if (t.status !== "suspended") t.status = "active"; } else s.tenants.push({ id: a[0], guild: a[1], name: a[2], status: "active" });
    } else if (sql === BUILD_SQL.user) s.users[a[0]] = a[1];
    else if (sql === BUILD_SQL.character) {
      const clash = Object.values(s.characters).find((c) => c.id !== a[0] && c.tenant === a[1] && c.name.toLowerCase() === String(a[3]).toLowerCase());
      if (clash) throw new Error("UNIQUE constraint failed: characters.tenant_id, characters.region, characters.realm, characters.name");
      s.characters[a[0]] = { id: a[0], tenant: a[1], user: a[2], name: a[3], class: a[6] };
    } else if (sql === BUILD_SQL.build) s.builds.push({ id: a[0], character: a[1], title: a[2], data: a[3] });
    else if (sql === PROJECT_SQL.kvWrite) s.kv[a[0]] = a[1];
    else throw new Error(`stub D1: unexpected write: ${sql}`);
  };
  let n = 0;
  const prepare = (sql) => {
    let args = [];
    const st = {
      bind: (...a) => ((args = a), st),
      first: async () => {
        if (sql === PROJECT_SQL.tenantRow) { const t = state.tenants.find((x) => x.guild === args[0]); return t ? { id: t.id, status: t.status } : null; }
        if (sql === PROJECT_SQL.kvRead) return state.kv[args[0]] !== undefined ? { json: state.kv[args[0]] } : null;
        if (sql === BUILD_SQL.tenant) { const t = state.tenants.find((x) => x.guild === args[0] && x.status === "active"); return t ? { id: t.id } : null; }
        if (/FROM kv_state WHERE key = 'party'/.test(sql)) return state.kv.party !== undefined ? { json: state.kv.party } : null;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
      _sql: sql,
      _args: () => args,
    };
    return st;
  };
  const batch = async (stmts) => {
    const draft = structuredClone(state);
    stmts.forEach((st, i) => {
      if (failOn && failOn(st._sql, i, n)) throw new Error("D1_ERROR: injected failure");
      apply(draft, st._sql, st._args());
    });
    Object.assign(state, draft); // all or nothing
    n++;
    return stmts.map(() => ({ success: true }));
  };
  return { prepare, batch, state };
}

const signer = createDiscordSigner();
const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};
test.after(() => { globalThis.fetch = realFetch; });

function room() {
  const sent = [];
  return { sent, idFromName: () => "id", get: () => ({ fetch: async (_u, init) => (sent.push(JSON.parse(init.body)), new Response("ok")) }) };
}

async function run(interaction, { db = stubDb(), env: extra = flags, boardRoom = room() } = {}) {
  calls = [];
  invalidateConfigCache();
  const env = { DB: db, BOARD_ROOM: boardRoom, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: "https://board.test", ...extra };
  const pending = [];
  const res = await handleDiscordInteraction(signer.signedRequest(interaction), env, { waitUntil: (p) => pending.push(p) }, "https://worker.test");
  await Promise.allSettled(pending);
  return { res, body: await res.json(), db, boardRoom, edits: calls.filter((c) => /@original$/.test(c.url)).map((c) => JSON.parse(c.init.body)) };
}

const ids = (i, user = USER, guild = GUILD) => {
  const c = structuredClone(i);
  c.guild_id = guild;
  c.member.user.id = user;
  return c;
};
const submit = ({ handle = "Fizzwick", cls = "Mage", race = "Gnome", role = "DPS", user = USER, guild = GUILD } = {}) => {
  const i = ids(fx("modal-submit.json"), user, guild);
  i.data.custom_id = "build:modal";
  i.data.components = [
    { type: 18, component: { type: 4, custom_id: "handle", value: handle } },
    { type: 18, component: { type: 3, custom_id: "class", values: [cls] } },
    { type: 18, component: { type: 3, custom_id: "race", values: [race] } },
    { type: 18, component: { type: 3, custom_id: "role", values: [role] } },
    { type: 18, component: { type: 4, custom_id: "notes", value: "" } },
  ];
  return i;
};
const kv = (db, k) => JSON.parse(db.state.kv[k]);
const quiet = async (fn) => {
  const errs = [];
  const real = console.error;
  console.error = (...a) => errs.push(a);
  try { return { out: await fn(), errs }; } finally { console.error = real; }
};

test("A7: a signed modal submit creates the tenant, the roster entry with id and slug, the party card, and broadcasts", async () => {
  const { body, db, boardRoom, edits } = await run(submit());
  assert.equal(body.type, 5, "the 3 s ack is the unchanged deferred reply");
  assert.deepEqual(db.state.tenants.map((t) => [t.guild, t.status]), [[GUILD, "active"]]);
  const roster = kv(db, "discord_members");
  assert.equal(roster.length, 6);
  assert.deepEqual(roster.at(-1), { slug: "fizzwick", name: "Fizzwick", match: ["fizzwick"], id: USER });
  const party = kv(db, "party");
  assert.equal(party.members.length, 6);
  assert.deepEqual(party.members.slice(0, 5), PARTY.members, "the five existing cards are untouched");
  const card = party.members[5];
  assert.deepEqual([card.name, card.class_key, card.race, card.role], ["Fizzwick", "mage", "Gnome", "damage"]);
  assert.equal(party.faction, PARTY.faction, "the rest of the document is kept");
  const tenant = db.state.tenants[0];
  assert.deepEqual(Object.values(db.state.characters).map((c) => [c.id, c.name, c.class]), [[`${tenant.id}:${USER}`, "Fizzwick", "Mage"]], "characters.name is the handle, not the Discord id");
  assert.equal(db.state.builds.length, 1);
  assert.deepEqual(boardRoom.sent.map((m) => [m.type, m.key, m.data.members.length]), [["data", "party", 6]]);
  assert.match(edits[0].content, /^Saved/);
  assert.equal(edits[0].components[0].components[0].url, "https://board.test/#five");
});

test("A7: the slug is slugify(handle) and a spaced handle keeps its name for the board to find", async () => {
  const { db } = await run(submit({ handle: "Moon  Walker" }));
  assert.equal(kv(db, "discord_members").at(-1).slug, "moon-walker");
  assert.equal(kv(db, "party").members.at(-1).name, "Moon Walker");
});

test("A7: a resubmit by the same person is idempotent (one tenant, one roster entry, one card, one character)", async () => {
  const db = stubDb();
  await run(submit(), { db });
  const after1 = { roster: db.state.kv.discord_members, party: db.state.kv.party };
  const { boardRoom, edits } = await run(submit({ cls: "Mage", role: "DPS" }), { db });
  assert.equal(db.state.tenants.length, 1);
  assert.equal(db.state.kv.discord_members, after1.roster);
  assert.equal(db.state.kv.party, after1.party);
  assert.equal(Object.keys(db.state.characters).length, 1);
  assert.equal(db.state.builds.length, 2, "builds are an append-only history, one row per confirmed submit");
  assert.equal(boardRoom.sent.length, 1, "and the board hears about it again");
  assert.match(edits[0].content, /^Saved/);
});

test("A7: a changed class on a resubmit updates the same card in place", async () => {
  const db = stubDb();
  await run(submit(), { db });
  await run(submit({ cls: "Warlock", race: "Gnome", role: "DPS" }), { db });
  const members = kv(db, "party").members;
  assert.equal(members.length, 6);
  assert.equal(members[5].class_key, "warlock");
  assert.equal(kv(db, "discord_members").length, 6);
});

test("A7: a name that is already taken is refused (case, spacing, dashes), and nothing is written", async () => {
  for (const handle of ["Santa", "santa", "Street-Rat", "street  rat"]) {
    const db = stubDb();
    const before = structuredClone(db.state);
    const { edits, boardRoom } = await run(submit({ handle, user: OTHER }), { db });
    assert.deepEqual(db.state, before, handle);
    assert.match(edits[0].content, /^Not saved: that handle is taken by another member/, handle);
    assert.equal(boardRoom.sent.length, 0);
  }
});

test("A7: a rename is refused and sends the person to an admin", async () => {
  const db = stubDb();
  await run(submit(), { db });
  const before = structuredClone(db.state);
  const { edits } = await run(submit({ handle: "Fizzwick Two" }), { db });
  assert.deepEqual(db.state, before);
  assert.match(edits[0].content, /Ask an admin to rename you/);
});

test("A7: a failure in the middle of the batch leaves nothing written, logs once, and says so", async () => {
  const db = stubDb({ failOn: (sql) => sql === PROJECT_SQL.kvWrite });
  const before = structuredClone(db.state);
  const { out, errs } = await quiet(() => run(submit(), { db }));
  assert.deepEqual(db.state, before, "no tenant, no user, no character, no build, same roster, same party");
  assert.equal(errs.length, 1, "console.error once");
  assert.match(out.edits[0].content, /^Not saved\. Nothing was changed/);
  assert.equal(out.boardRoom.sent.length, 0, "no broadcast for a save that did not happen");
});

test("A7: the wrong server, a missing party document and a suspended server write nothing", async () => {
  for (const [label, db, interaction] of [
    ["other guild", stubDb(), submit({ guild: STRANGER_GUILD })],
    ["no party doc", stubDb({ party: null }), submit()],
    ["suspended", (() => { const d = stubDb(); d.state.tenants.push({ id: "t1", guild: GUILD, name: "x", status: "suspended" }); return d; })(), submit()],
  ]) {
    const before = structuredClone(db.state);
    const { edits } = await run(interaction, { db });
    assert.deepEqual(db.state, before, label);
    assert.match(edits[0].content, /^Not saved/, label);
  }
});

test("A7: an existing tenant row is reused, not duplicated", async () => {
  const db = stubDb();
  db.state.tenants.push({ id: "tenant-existing", guild: GUILD, name: "x", status: "active" });
  await run(submit(), { db });
  assert.equal(db.state.tenants.length, 1);
  assert.deepEqual(Object.keys(db.state.characters), [`tenant-existing:${USER}`]);
});

test("A4: BUILD_PROJECT off keeps the earlier behaviour: no roster, no party, no broadcast, no tenant created", async () => {
  const db = stubDb();
  const before = structuredClone(db.state);
  const { edits, boardRoom } = await run(submit(), { db, env: { BUILD_MODAL: "on" } });
  assert.deepEqual(db.state, before);
  assert.equal(boardRoom.sent.length, 0);
  assert.doesNotMatch(edits[0].content, /^Saved/, "no tenant row: the legacy reply, as before");
});

test("A4: BUILD_PROJECT on without BUILD_MODAL does nothing at all", async () => {
  const db = stubDb();
  const before = structuredClone(db.state);
  const { edits } = await run(submit(), { db, env: { BUILD_PROJECT: "on" } });
  assert.deepEqual(db.state, before);
  assert.equal(edits.length, 0);
});

// ---- A5

test("A5: with the party document the built-ins are returned unchanged for the current five", () => {
  assert.deepEqual(mergePartyMembers(PARTY), PARTY_MEMBERS);
  assert.deepEqual(mergePartyMembers(null), PARTY_MEMBERS);
  assert.deepEqual(mergeRoster(ROSTER_SEED), ROSTER_DATA);
  assert.deepEqual(mergeRoster(null), ROSTER_DATA);
});

test("A5: a person added only in D1 appears in the sheet members and the roster, with no invented spec", () => {
  const doc = { ...PARTY, members: [...PARTY.members, { name: "Fizzwick", class_key: "mage", race: "Night Elf", start_zone: "Teldrassil" }] };
  const merged = mergePartyMembers(doc);
  assert.equal(merged.length, 6);
  assert.deepEqual(merged[5], { slug: "fizzwick", name: "Fizzwick", race: "night-elf", class: "mage", plan_zone: "teldrassil" });
  const roster = mergeRoster([...ROSTER_SEED, { slug: "fizzwick", name: "Fizzwick", match: ["fizzwick"], id: USER }]);
  assert.deepEqual(roster.at(-1), { display: "Fizzwick", aliases: ["fizzwick"] });
});

test("A5: buildPartySheetsFromD1 gives the same five sheets as before, plus the new person from the party document", async () => {
  const dbFor = (party) => ({
    prepare: (sql) => ({
      first: async () => (/key = 'party'$/.test(sql) && party ? { json: JSON.stringify(party) } : null),
      all: async () => ({ results: [] }),
      bind: () => ({ run: async () => ({}) }),
    }),
  });
  const base = (await buildPartySheetsFromD1({ DB: dbFor(null) })).party;
  const same = (await buildPartySheetsFromD1({ DB: dbFor(PARTY) })).party;
  assert.deepEqual(same, base);
  assert.equal(base.length, 5);
  const grown = (await buildPartySheetsFromD1({ DB: dbFor({ ...PARTY, members: [...PARTY.members, { name: "Fizzwick", class_key: "mage", race: "Gnome", start_zone: "Coldridge Valley" }] }) })).party;
  assert.equal(grown.length, 6);
  assert.deepEqual(grown.slice(0, 5), base);
  assert.equal(grown[5].slug, "fizzwick");
  assert.equal(grown[5].fields.class.value, "mage");
});

// ---- A6

test("A6: /join is listed in the manifest only while BUILD_MODAL is on; with it off the list is unchanged", () => {
  assert.equal(manifestFor({}, DISCORD_SLASH_COMMANDS_MANIFEST), DISCORD_SLASH_COMMANDS_MANIFEST);
  assert.ok(!manifestFor({ BUILD_PROJECT: "on" }, DISCORD_SLASH_COMMANDS_MANIFEST).some((c) => c.name === "join"));
  const on = manifestFor({ BUILD_MODAL: "on" }, DISCORD_SLASH_COMMANDS_MANIFEST);
  assert.equal(on.length, DISCORD_SLASH_COMMANDS_MANIFEST.length + 1);
  assert.equal(on.at(-1).name, "join");
  assert.equal(on.at(-1).options, undefined);
});

const cmd = (name, user = USER) => {
  const i = ids(fx("cmd-build.json"), user);
  i.data = { id: "fixture-cmd", name, type: 1 };
  return i;
};

test("A6: /join opens the same modal for someone not on the roster, and tells a member they are already on it", async () => {
  const { body } = await run(cmd("join"));
  assert.equal(body.type, 9);
  assert.deepEqual(body.data.components.map((c) => c.component.custom_id), ["handle", "class", "race", "role", "notes"]);
  const db = stubDb({ members: [{ slug: "fizzwick", name: "Fizzwick", match: ["fizzwick"], id: USER }] });
  const again = await run(cmd("join"), { db });
  assert.equal(again.body.type, 4);
  assert.match(again.body.data.content, /already on the board as \*\*Fizzwick\*\*/);
});

test("A6: /join with BUILD_MODAL off is not offered", async () => {
  const { body } = await run(cmd("join"), { env: {} });
  assert.notEqual(body.type, 9);
});

test("A6: the Join button opens the modal", async () => {
  const i = ids(fx("component-signup-button.json"));
  i.data = { custom_id: "join:open", component_type: 2 };
  assert.equal((await run(i)).body.type, 9);
  assert.notEqual((await run(i, { env: {} })).body.type, 9, "flag off: the button does nothing new");
});

test("A6: JOIN_PROMPT sends one ephemeral hint with a Join button to an unknown user of /sheet, once, and never when off", async () => {
  resetJoinHints();
  const on = { BUILD_MODAL: "on", JOIN_PROMPT: "on" };
  const first = await run(cmd("sheet"), { env: on });
  const hint = calls.filter((c) => !/@original$/.test(c.url) && c.init && c.init.method === "POST").map((c) => JSON.parse(c.init.body));
  assert.equal(first.body.type, 4, "the normal /sheet reply is untouched");
  assert.equal(hint.length, 1);
  assert.equal(hint[0].flags, 64);
  assert.equal(hint[0].components[0].components[0].custom_id, "join:open");
  await run(cmd("sheet"), { env: on });
  assert.equal(calls.filter((c) => c.init && c.init.method === "POST").length, 0, "not twice for the same person");
  resetJoinHints();
  await run(cmd("sheet"), { env: { BUILD_MODAL: "on" } });
  assert.equal(calls.length, 0, "JOIN_PROMPT off: no follow-up");
  const known = stubDb({ members: [{ slug: "fizzwick", name: "Fizzwick", match: ["fizzwick"], id: USER }] });
  await run(cmd("sheet"), { env: on, db: known });
  assert.equal(calls.length, 0, "a person on the roster never sees it");
});
