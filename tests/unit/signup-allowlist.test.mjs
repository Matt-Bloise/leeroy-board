// Issue #126: the /signup slash command and the `signup:<field>:<value>` buttons may only write rsvp, pack, meet and when,
// with validated values, and the typed `place` is capped and cleaned server-side. Real handler, stubbed D1, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { handleDiscordInteraction, validateSignupField, DISCORD_SLASH_COMMANDS_MANIFEST } from "../../infrastructure/worker/discord.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
test.after(() => {
  globalThis.fetch = realFetch;
});

const signer = createDiscordSigner();
const MEMBERS = [{ slug: "fixture-tester", name: "Fixture Tester", match: ["fixture tester"], id: "fixture-user-0001" }];

function makeEnv(seeds) {
  const writes = [];
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      first: async () => {
        if (/FROM kv_state/i.test(sql)) {
          const key = /key = '([a-z_]+)'/.exec(sql)?.[1] ?? args[0];
          return key in seeds ? { json: JSON.stringify(seeds[key]) } : null;
        }
        return /COUNT\(\*\)/i.test(sql) ? { count: 0 } : null;
      },
      all: async () => ({ results: [] }),
      run: async () => (writes.push({ sql, args }), { success: true, meta: { changes: 1, last_row_id: writes.length } }),
    };
    return stmt;
  };
  const room = { fetch: async () => new Response("ok") };
  const env = {
    DB: { prepare, batch: async (s) => s.map(() => ({ success: true, meta: { changes: 1 } })) },
    DISCORD_PUBLIC_KEY: signer.publicKeyHex,
    BOARD_PUBLIC_URL: "https://board.test",
    USER_SALT: "fixture-salt",
    BOARD_ROOM: { idFromName: () => "room", get: () => room },
  };
  return { env, writes };
}

const seedsWith = (extra = {}) => ({
  discord_members: MEMBERS,
  signups: { entries: [{ slug: "fixture-tester", name: "Fixture Tester", rsvp: "in" }] },
  party: { members: [] },
  launch: [],
  ...extra,
});

const base = {
  id: "fixture-interaction-0001", application_id: "fixture-app-0001", token: "fixture-token-not-real", version: 1,
  guild_id: "fixture-guild-0001", channel_id: "fixture-channel-0001", locale: "en-US",
  member: { user: { id: "fixture-user-0001", username: "fixture_tester", global_name: "Fixture Tester" }, roles: [] },
};
const slash = (options) => ({ ...base, type: 2, data: { id: "fixture-cmd", name: "signup", type: 1, options: options.map(([name, value]) => ({ name, type: 3, value })) } });
const button = (custom_id) => ({ ...base, type: 3, data: { custom_id, component_type: 2 } });

async function run(interaction, seeds = seedsWith()) {
  const { env, writes } = makeEnv(seeds);
  const res = await handleDiscordInteraction(signer.signedRequest(interaction), env, { waitUntil() {} }, "https://worker.test");
  const body = await res.json();
  const stored = writes.filter((w) => /UPDATE kv_state/i.test(w.sql)).map((w) => JSON.parse(w.args[0]));
  return { body, writes, entry: stored.at(-1)?.entries.find((e) => e.slug === "fixture-tester") };
}
const wrote = (r) => r.writes.length > 0;
const rejected = (r) => /not recorded/.test(r.body.data.content) && !wrote(r);

test("validateSignupField allows only the four fields and checks each value", () => {
  for (const f of ["name", "slug", "updated", "__proto__", "constructor", "", undefined, 5]) assert.equal(validateSignupField(f, "x").ok, false, String(f));
  assert.deepEqual(validateSignupField("rsvp", "late"), { ok: true, value: "late" });
  assert.equal(validateSignupField("rsvp", "yes").ok, false);
  assert.equal(validateSignupField("pack", "maybe").ok, false);
  assert.equal(validateSignupField("when", "midnight").ok, false);
  assert.equal(validateSignupField("when", "8pm").ok, true);
  assert.equal(validateSignupField("rsvp", 5).ok, false, "wrong type");
  assert.equal(validateSignupField("rsvp", { a: 1 }).ok, false, "wrong type");
  assert.equal(validateSignupField("meet", "Somewhere").ok, false, "free text not allowed for buttons");
  assert.equal(validateSignupField("meet", "vos").value, "Valley of Strength");
});

test("button: an arbitrary field is rejected and nothing is written", async () => {
  for (const id of ["signup:name:Someone", "signup:slug:x", "signup:updated:1", "signup:__proto__:x", "signup:constructor:x"]) {
    assert.ok(rejected(await run(button(id))), id);
  }
});

test("button: bad values, extra segments and non-string ids are rejected", async () => {
  for (const id of ["signup:rsvp:banana", "signup:pack:maybe", "signup:when:midnight", "signup:meet:<@everyone>", "signup:rsvp:in:extra", "signup:rsvp"]) {
    assert.ok(rejected(await run(button(id))), id);
  }
});

test("button: an allowed field and value is still written", async () => {
  const r = await run(button("signup:rsvp:maybe"));
  assert.equal(r.entry.rsvp, "maybe");
  assert.equal((await run(button("signup:meet:vos"))).entry.meet, "Valley of Strength");
});

test("button: a missing signups row is an error, not 'Recorded'", async () => {
  const seeds = seedsWith();
  delete seeds.signups;
  const r = await run(button("signup:rsvp:in"), seeds);
  assert.doesNotMatch(r.body.data.content, /^Recorded/);
  assert.ok(rejected(r));
});

test("slash: the quick field/value options cannot write an arbitrary field or value", async () => {
  assert.ok(rejected(await run(slash([["field", "name"], ["value", "Someone"]]))));
  assert.ok(rejected(await run(slash([["field", "__proto__"], ["value", "x"]]))));
  assert.ok(rejected(await run(slash([["field", "rsvp"], ["value", "banana"]]))));
  assert.ok(rejected(await run(slash([["field", "rsvp"]]))), "field without value");
  assert.equal((await run(slash([["field", "rsvp"], ["value", "out"]]))).entry.rsvp, "out");
});

test("slash: invalid choice values and wrong types are rejected", async () => {
  assert.ok(rejected(await run(slash([["rsvp", "banana"]]))));
  assert.ok(rejected(await run(slash([["pack", "maybe"]]))));
  const numeric = { ...slash([]), data: { name: "signup", type: 1, options: [{ name: "rsvp", type: 4, value: 5 }] } };
  assert.ok(rejected(await run(numeric)));
});

test("slash: an oversize place is capped at 40 characters, sanitised, and a junk-only place is rejected", async () => {
  const r = await run(slash([["place", "x".repeat(6000)]]));
  assert.equal(r.entry.meet.length, 40);
  const md = await run(slash([["place", "**hi** <@123456> [x](https://evil.example) @everyone `c`"]]));
  assert.doesNotMatch(md.entry.meet, /[*<>`@\[\]()]|https?:/);
  assert.ok(md.entry.meet.length <= 40);
  assert.ok(rejected(await run(slash([["place", "<@123456> https://evil.example"]]))));
});

test("manifest: place and value options declare max_length 40", () => {
  const signup = DISCORD_SLASH_COMMANDS_MANIFEST.find((c) => c.name === "signup");
  for (const n of ["place", "value"]) assert.equal(signup.options.find((o) => o.name === n).max_length, 40);
});
