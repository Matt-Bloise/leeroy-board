// ADR 0002 step 1: the member roster can come from D1 (kv_state 'party_roster') behind the flag ROSTER_FROM_D1, which defaults off everywhere.
// Every name in this file is fictional. The real roster is never written into a test: the built-in lists are read from the code under test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../../infrastructure/worker/index.js";
import { PARTY_MEMBERS, loadPartyMembers, loadRoster } from "../../infrastructure/worker/party-source.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";
import { validateRosterConfig, sheetMembersFromConfig, rosterDataFromConfig, privacyMembersFromConfig } from "../../infrastructure/worker/roster-shape.js";
import { activeRoster, primeRosterPrivacy, rosterScope, setStep2ReadyForTests, ROSTER_STEP2_READY } from "../../infrastructure/worker/roster-source.js";
import { buildAnswerInputs } from "../../infrastructure/worker/ai-models.js";
import { CONFIG_KEYS, invalidateConfigCache, isPrivateKvKey, validateConfigValue } from "../../infrastructure/worker/config.js";
import { researchMembers, researchRoster, setRosterOverride, setFirstNameSource } from "../../infrastructure/worker/privacy/roster-config.js";
import { prepareResearchPrivacy, resetResearchClaudeForTests } from "../../infrastructure/worker/research/claude.js";
import { guardBody } from "../../infrastructure/worker/privacy/outbound-guard.js";
import { invalidateMembersCache } from "../../infrastructure/worker/auth.js";
import { sha256Hex } from "../../infrastructure/worker/crypto.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN_TOKEN = "admin-token-for-tests-0123456789abcdef";
const KEY_SALT = "salt-for-tests-0123456789";
const MEMBER_KEY = "member-key-for-tests-0123456789ab";
const ctx = { waitUntil() {}, passThroughOnException() {} };

// Fictional roster. Slug 2 ("cask-wren") is the configured default admin, so it is NOT array position 3.
const FICTION = {
  version: 1,
  default_admin: "cask-wren",
  members: [
    { slug: "alderfox", name: "Alderfox", race: "human", class: "rogue", spec_path: "combat", professions: ["mining"], plan_zone: "elwynn-forest", aliases: ["alderfox", "fox"], first_names: ["Perrin"] },
    { slug: "brindle-moth", name: "Brindle Moth", race: "gnome", class: "mage", spec_path: "frost", professions: ["tailoring"], plan_zone: "dun-morogh", aliases: ["brindle moth", "brindle"] },
    { slug: "cask-wren", name: "Cask Wren", race: "dwarf", class: "priest", spec_path: "holy", professions: ["alchemy"], plan_zone: "dun-morogh", aliases: ["cask wren", "cask"], first_names: ["Odalys"] },
  ],
};

// In-memory D1 that records the SQL it sees. kv rows are { key: jsonString }.
function makeEnv({ flag, kv = {}, memberSlug = null, flags = null } = {}) {
  const seen = [];
  return {
    MEMBER_KEY,
    seen,
    async build() {
      const memberHash = await sha256Hex(`${KEY_SALT}:${MEMBER_KEY}`);
      const stmt = (sql) => {
        let args = [];
        const o = {
          bind: (...a) => { args = a; return o; },
          all: async () => { seen.push(sql); return { results: /FROM members/i.test(sql) && memberSlug ? [{ slug: memberSlug, key_hash: memberHash }] : [] }; },
          first: async () => {
            seen.push(sql + " " + JSON.stringify(args));
            const lit = /WHERE key = '([^']+)'/i.exec(sql);
            const k = lit ? lit[1] : args[0];
            return /FROM kv_state WHERE key/i.test(sql) && Object.prototype.hasOwnProperty.call(kv, k) ? { json: kv[k], updated_at: "1" } : null;
          },
          run: async () => ({ meta: { changes: 0, last_row_id: 1 } }),
        };
        return o;
      };
      const env = { DB: { prepare: stmt, batch: async () => [] }, BOARD_ADMIN_TOKEN: ADMIN_TOKEN, KEY_SALT, USER_SALT: "user-salt-for-tests-0123456789", ALLOWED_ORIGINS: "" };
      if (flag !== undefined) env.ROSTER_FROM_D1 = flag;
      if (flags) env.FLAGS = { getBooleanValue: async () => flags.value };
      return env;
    },
  };
}
async function envOf(opts) { const h = makeEnv(opts); const env = await h.build(); env.__seen = h.seen; env.__key = h.MEMBER_KEY; return env; }

async function me(env, who) {
  const headers = who === "admin" ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : who === "member" ? { Authorization: `Board ${env.__key}` } : {};
  const silence = console.error; console.error = () => {};
  try {
    const res = await worker.fetch(new Request("https://api.test/api/me", { headers: { ...headers, "CF-Connecting-IP": "203.0.113.9" } }), env, ctx);
    return { status: res.status, body: await res.text() };
  } finally { console.error = silence; }
}
// Every test opens the step 2 interlock unless it is about the interlock itself (roster-source.js ROSTER_STEP2_READY is false in the shipped code).
const reset = () => { setStep2ReadyForTests(true); invalidateMembersCache(); invalidateConfigCache(); setRosterOverride(null); setFirstNameSource(null); resetResearchClaudeForTests(); };
const ROW = JSON.stringify(FICTION);
globalThis.fetch = async () => new Response("blocked in tests", { status: 599 });

// ---- shape -----------------------------------------------------------------------------------------------------------------------------------------
test("party_roster is an admin-only private config key with a validated shape", () => {
  assert.ok(CONFIG_KEYS.includes("party_roster"));
  assert.equal(isPrivateKvKey("party_roster"), true);
  assert.equal(validateConfigValue("party_roster", FICTION), null);
  const bad = (v) => assert.equal(typeof validateConfigValue("party_roster", v), "string");
  bad(null); bad([]); bad({});
  bad({ ...FICTION, default_admin: "nobody" });
  bad({ ...FICTION, default_admin: undefined });
  bad({ ...FICTION, members: [] });
  // duplicate slug and nothing else wrong: a different name, different aliases
  assert.match(validateRosterConfig({ ...FICTION, members: [FICTION.members[0], { ...FICTION.members[1], slug: FICTION.members[0].slug }] }), /slugs must be unique/);
  bad({ ...FICTION, members: [{ ...FICTION.members[0], slug: "Bad Slug" }, FICTION.members[2]] });
  bad({ ...FICTION, members: [{ ...FICTION.members[0], aliases: ["Upper"] }, FICTION.members[2]] }); // aliases are lowercase like discord_members.match
  bad({ ...FICTION, members: [{ ...FICTION.members[0], name: "" }, FICTION.members[2]] });
  assert.equal(validateRosterConfig(FICTION), null);
});

test("shape converters: sheet members, roster entries and privacy members", () => {
  const sheets = sheetMembersFromConfig(FICTION);
  assert.deepEqual(sheets.map((m) => m.slug), ["alderfox", "brindle-moth", "cask-wren"]);
  assert.equal(sheets[0].class, "rogue");
  assert.equal("aliases" in sheets[0], false, "aliases and first names never reach the sheet shape");
  assert.equal("first_names" in sheets[0], false);
  assert.deepEqual(rosterDataFromConfig(FICTION).map((r) => r.display), ["Alderfox", "Brindle Moth", "Cask Wren"]);
  assert.deepEqual(rosterDataFromConfig(FICTION)[0].aliases, ["alderfox", "fox"]);
  assert.deepEqual(privacyMembersFromConfig(FICTION)[0].firstNames, ["Perrin"]);
  assert.deepEqual(privacyMembersFromConfig(FICTION)[1].firstNames, []);
});

// ---- flag OFF: byte-identical to today (differential) -----------------------------------------------------------------------------------------------------
const OFF_VARIANTS = [
  ["flag unset", { }],
  ['flag "off"', { flag: "off" }],
  ['flag "off" and a party_roster row present', { flag: "off", kv: { party_roster: ROW } }],
  ["unset and a party_roster row present", { kv: { party_roster: ROW } }],
  ["Flagship says false while the legacy var says on", { flag: "on", flags: { value: false }, kv: { party_roster: ROW } }],
  ["Flagship says a non-boolean", { flag: "on", flags: { value: "true" }, kv: { party_roster: ROW } }],
];

test("flag off: admin token, member key, anonymous, party members and roster are identical whatever D1 holds, and equal to the built-in lists", async () => {
  const baseline = {};
  for (const [label, opts] of OFF_VARIANTS) {
    reset();
    const slug = PARTY_MEMBERS[1].slug;
    const env = await envOf({ ...opts, memberSlug: slug });
    const got = {
      admin: await me(env, "admin"),
      member: await me(env, "member"),
      anon: await me(env, "anon"),
      party: await loadPartyMembers(env),
      roster: await loadRoster(env),
      active: await activeRoster(env),
    };
    if (!baseline.admin) Object.assign(baseline, got);
    assert.deepEqual(got, baseline, label);
    assert.equal(got.active, null, label);
    assert.deepEqual(JSON.parse(got.admin.body), { slug: PARTY_MEMBERS[3].slug, name: PARTY_MEMBERS[3].name, pending: [] }, `${label}: the default admin is still array position 3`);
    assert.equal(got.member.status, 200);
    assert.equal(JSON.parse(got.member.body).slug, slug);
    assert.equal(got.anon.status, 401);
    assert.deepEqual(got.party, PARTY_MEMBERS, label);
    assert.deepEqual(got.roster, ROSTER_DATA, label);
    assert.equal(env.__seen.filter((s) => s.includes("party_roster")).length, 0, `${label}: the flag is off, so D1 is never asked for the roster key`);
  }
});

test("flag off: the privacy roster is exactly the built-in one, and priming clears a leftover override", async () => {
  reset();
  const before = JSON.stringify(researchMembers());
  setRosterOverride(privacyMembersFromConfig(FICTION)); // a stale override from an earlier flag-on request in this isolate
  assert.notEqual(JSON.stringify(researchMembers()), before);
  await primeRosterPrivacy(await envOf({ flag: "off", kv: { party_roster: ROW } }));
  assert.equal(JSON.stringify(researchMembers()), before, "flag off means the built-in roster only");
  reset();
});

test("flag off: the new code paths do not change the redaction or admin source text paths (source guard)", () => {
  const idx = fs.readFileSync(path.join(ROOT, "infrastructure/worker/index.js"), "utf8");
  assert.match(idx, /PARTY_MEMBERS\[3\]/, "step 1 keeps the legacy default admin as the flag-off path");
});

// ---- flag ON -----------------------------------------------------------------------------------------------------------------------------------------------------
test("flag on: the admin token resolves to the CONFIGURED default admin, not array position 3", async () => {
  reset();
  const env = await envOf({ flag: "on", kv: { party_roster: ROW } });
  const r = await me(env, "admin");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { slug: "cask-wren", name: "Cask Wren", pending: [] });
  assert.notEqual(JSON.parse(r.body).slug, PARTY_MEMBERS[3].slug);
  reset();
});

test("flag on: a signed-in member matches the D1 roster; members and roster loaders use it as the base (built-ins are not mixed in)", async () => {
  reset();
  const env = await envOf({ flag: "on", kv: { party_roster: ROW }, memberSlug: "brindle-moth" });
  const m = await me(env, "member");
  assert.deepEqual(JSON.parse(m.body), { slug: "brindle-moth", name: "Brindle Moth", pending: [] });
  assert.deepEqual((await loadPartyMembers(env)).map((x) => x.slug), ["alderfox", "brindle-moth", "cask-wren"]);
  assert.deepEqual((await loadRoster(env)).map((x) => x.display), ["Alderfox", "Brindle Moth", "Cask Wren"]);
  assert.equal((await me(env, "anon")).status, 401);
  reset();
});

test("flag on, party document adds a person: merged after the D1 roster, as built-ins-first merging did before", async () => {
  reset();
  const doc = { members: [{ name: "Dovetail", race: "Night Elf", class: "Druid", class_key: "druid" }] };
  const env = await envOf({ flag: "on", kv: { party_roster: ROW, party: JSON.stringify(doc) } });
  assert.deepEqual((await loadPartyMembers(env)).map((x) => x.slug), ["alderfox", "brindle-moth", "cask-wren", "dovetail"]);
  reset();
});

test("flag on but the row is absent, unreadable or invalid: fall back to today's behaviour (built-in roster, array-position admin)", async () => {
  for (const kv of [{}, { party_roster: "{not json" }, { party_roster: JSON.stringify({ ...FICTION, default_admin: "nobody" }) }, { party_roster: JSON.stringify({ members: [] }) }]) {
    reset();
    const env = await envOf({ flag: "on", kv });
    assert.equal(await activeRoster(env), null);
    assert.deepEqual(JSON.parse((await me(env, "admin")).body).slug, PARTY_MEMBERS[3].slug);
    assert.deepEqual(await loadPartyMembers(env), PARTY_MEMBERS);
    await primeRosterPrivacy(env);
    assert.deepEqual(researchMembers().map((m) => m.display), ROSTER_DATA.map((r) => r.display), "redaction keeps covering the built-in names");
  }
  reset();
});

test("flag on: a DB error while reading the roster is not an outage; the built-ins answer", async () => {
  reset();
  const env = await envOf({ flag: "on" });
  env.DB = { prepare: () => { throw new Error("d1 down"); } };
  assert.equal(await activeRoster(env), null);
  assert.deepEqual(await loadPartyMembers(env), PARTY_MEMBERS);
  reset();
});

// ---- redaction follows the roster ---------------------------------------------------------------------------------------------------------------------------
const NEEDLES = ["Alderfox", "Brindle Moth", "Cask Wren", "Perrin", "Odalys", "fox", "brindle", "cask"]; // includes the aliases, so an override that loses aliases fails
const leaks = (text) => NEEDLES.filter((n) => text.toLowerCase().includes(n.toLowerCase()));

test("flag on: names, aliases and first names from the D1 roster are tokenised and guarded; built-in names stay covered", async () => {
  reset();
  await primeRosterPrivacy(await envOf({ flag: "on", kv: { party_roster: ROW } }));
  const names = researchMembers().map((m) => m.display);
  assert.deepEqual(names.slice(0, 3), ["Alderfox", "Brindle Moth", "Cask Wren"]);
  for (const r of ROSTER_DATA) assert.ok(names.includes(r.display), "a built-in member is still covered while the built-ins exist");
  const builtIn = ROSTER_DATA[0].display;
  const priv = prepareResearchPrivacy({
    systemPrompt: `You help Alderfox (really Perrin) and ${builtIn}.`,
    userPrompt: `Brindle Moth asked what Cask Wren, Odalys and fox should do.`,
    question: "what should we do", by: "Visitor", party: null,
  });
  assert.equal(priv.ok, true, priv.reason);
  assert.deepEqual(leaks(priv.system + "\n" + priv.user), [], "no D1-roster name, alias or first name reaches the prompt");
  assert.equal(priv.system.toLowerCase().includes(builtIn.toLowerCase()), false);
  // the outbound guard refuses a body that still carries one
  const raw = JSON.stringify({ messages: [{ role: "user", content: "tell Odalys hello" }] });
  assert.throws(() => guardBody(raw, priv.roster), "a first name from the roster in an outbound body is refused");
  reset();
});

test("flag off: the same fictional names are NOT covered (the roster really is the switch)", async () => {
  reset();
  await primeRosterPrivacy(await envOf({ flag: "off", kv: { party_roster: ROW } }));
  const priv = prepareResearchPrivacy({ systemPrompt: "Alderfox and Perrin", userPrompt: "Cask Wren", question: "q", by: "Visitor", party: null });
  assert.ok(leaks(priv.system + priv.user).length > 0);
  reset();
});

// ---- flag plumbing ---------------------------------------------------------------------------------------------------------------------------------------------
test("ROSTER_FROM_D1 follows the repo flag pattern and defaults off", () => {
  const toml = fs.readFileSync(path.join(ROOT, "infrastructure/wrangler.toml"), "utf8");
  assert.match(toml, /^ROSTER_FROM_D1 = "off"/m);
  const listed = fs.readFileSync(path.join(ROOT, "infrastructure/flagship-flags.txt"), "utf8").split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  assert.ok(listed.includes("ROSTER_FROM_D1"));
  assert.ok(fs.readFileSync(path.join(ROOT, "docs/runbooks/flags.md"), "utf8").includes("`ROSTER_FROM_D1`"));
  assert.ok(fs.existsSync(path.join(ROOT, "docs/adr/0002-member-roster-from-d1.md")));
});

// ---- flag on, then off, in one isolate --------------------------------------------------------------------------------------------------------------------------
test("a flag-on request followed by a flag-off request in the same isolate leaves no residue: the second answers exactly as the built-ins do", async () => {
  reset();
  const on = await envOf({ flag: "on", kv: { party_roster: ROW } });
  assert.equal(JSON.parse((await me(on, "admin")).body).slug, "cask-wren");
  await primeRosterPrivacy(on); // what the research path does just before it tokenises
  assert.equal(researchMembers()[0].display, "Alderfox", "the flag-on research path primed the privacy roster");
  const off = await envOf({ flag: "off", kv: { party_roster: ROW } });
  invalidateConfigCache(); // the config cache is per isolate and 60 s; a flag flip does not wait for it, but this test must not depend on timing
  const r = await me(off, "admin");
  assert.equal(JSON.parse(r.body).slug, PARTY_MEMBERS[3].slug);
  await buildAnswerInputs(off, { question: "what is a good spec", by: "Visitor", research: true }); // the next research call primes again, off, and clears the override
  assert.deepEqual(researchMembers().map((m) => m.display), ROSTER_DATA.map((x) => x.display), "no D1 name is left in the privacy roster");
  assert.deepEqual(await loadPartyMembers(off), PARTY_MEMBERS);
  assert.equal(off.__seen.filter((x) => x.includes("party_roster")).length, 0);
  reset();
});

// ---- F1: the redaction roster is a union PER KEY ------------------------------------------------------------------------------------------------------------------
const skel = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const GENERIC = ["mage", "rat", "tank"];
const builtInWithAliases = () => ROSTER_DATA.filter((r) => (r.aliases || []).some((a) => !GENERIC.includes(a)));

test("a D1 row that names a built-in member with no aliases, or different ones, keeps every built-in alias redacted", async () => {
  assert.ok(builtInWithAliases().length > 0);
  for (const variant of ["no aliases", "different alias"]) {
    reset();
    const names = ["one", "two", "three", "four", "five", "six", "seven"];
    const row = {
      version: 1, default_admin: "zz-one",
      members: ROSTER_DATA.map((r, i) => ({ slug: `zz-${names[i]}`, name: r.display, race: "human", class: "rogue", ...(variant === "different alias" ? { aliases: [`zq${i}extra`] } : {}) })),
    };
    // the row as the privacy layer gets it (validation is not under test here)
    setRosterOverride(privacyMembersFromConfig(row));
    const members = researchMembers();
    for (const r of ROSTER_DATA) {
      const m = members.find((x) => skel(x.display) === skel(r.display));
      assert.ok(m, "the member is present");
      for (const a of r.aliases || []) assert.ok(m.aliases.some((x) => skel(x) === skel(a)), `${variant}: a built-in alias is still a key`);
    }
    const aliases = builtInWithAliases().flatMap((r) => r.aliases).filter((a) => !GENERIC.includes(a));
    const priv = prepareResearchPrivacy({ systemPrompt: `Context ${aliases.join(" and ")}.`, userPrompt: `Ask about ${aliases.join(", ")}.`, question: "q", by: "Visitor", party: null });
    assert.equal(priv.ok, true, priv.reason);
    for (const a of aliases) assert.equal((priv.system + priv.user).toLowerCase().includes(a.toLowerCase()), false, `${variant}: alias still readable in the prompt`);
  }
  reset();
});

test("the union keeps D1 aliases too, and does not list one key twice", () => {
  reset();
  const b = builtInWithAliases()[0];
  setRosterOverride([{ display: b.display, aliases: ["zorbel", "zorbel", ...b.aliases], firstNames: ["Quillan", "quillan"] }]);
  const m = researchMembers().find((x) => skel(x.display) === skel(b.display));
  assert.equal(m.aliases.filter((a) => skel(a) === "zorbel").length, 1, "D1 alias listed once");
  for (const a of b.aliases) assert.equal(m.aliases.filter((x) => skel(x) === skel(a)).length, 1, "a built-in alias that D1 repeats is listed once");
  assert.equal(m.firstNames.length, 1, "first names deduped");
  assert.equal(researchMembers().filter((x) => skel(x.display) === skel(b.display)).length, 1, "the member is not duplicated as a separate built-in");
  reset();
});

test("a first name injected for a built-in position attaches to that built-in only, never to a D1 member at the same index", () => {
  reset();
  setFirstNameSource((_m, i) => (i === 0 ? ["Zephyrine"] : []));
  setRosterOverride(privacyMembersFromConfig(FICTION));
  const members = researchMembers();
  assert.equal(members.find((m) => m.display === "Alderfox").firstNames.includes("Zephyrine"), false);
  assert.equal(members.find((m) => m.display === ROSTER_DATA[0].display).firstNames.includes("Zephyrine"), true);
  setRosterOverride([{ display: ROSTER_DATA[0].display, aliases: [], firstNames: [] }]);
  assert.equal(researchMembers().find((m) => skel(m.display) === skel(ROSTER_DATA[0].display)).firstNames.includes("Zephyrine"), true, "merged through the built-in");
  reset();
});

test("a D1 member's slug is a redaction key", () => {
  reset();
  setRosterOverride(privacyMembersFromConfig(FICTION));
  assert.ok(researchMembers().find((m) => m.display === "Cask Wren").characterNames.includes("cask-wren"));
  reset();
});

// ---- F2: the interlock ---------------------------------------------------------------------------------------------------------------------------------------
test("interlock: ROSTER_STEP2_READY is false in the shipped code, and with it closed the flag on changes neither auth nor redaction", async () => {
  assert.equal(ROSTER_STEP2_READY, false);
  assert.match(fs.readFileSync(path.join(ROOT, "infrastructure/worker/roster-source.js"), "utf8"), /^export const ROSTER_STEP2_READY = false;$/m);
  reset();
  setStep2ReadyForTests(null); // the shipped state
  const env = await envOf({ flag: "on", kv: { party_roster: ROW }, memberSlug: "brindle-moth" });
  assert.equal(await activeRoster(env), null);
  assert.equal(JSON.parse((await me(env, "admin")).body).slug, PARTY_MEMBERS[3].slug, "admin is still the built-in default");
  assert.equal(JSON.parse((await me(env, "member")).body).name, "brindle-moth", "a D1-only member is not resolved to the D1 sheet (name falls back to the slug, as with the flag off)");
  assert.deepEqual(await loadPartyMembers(env), PARTY_MEMBERS);
  assert.deepEqual(await loadRoster(env), ROSTER_DATA);
  setRosterOverride(privacyMembersFromConfig(FICTION)); // a stale override
  await primeRosterPrivacy(env);
  assert.deepEqual(researchMembers().map((m) => m.display), ROSTER_DATA.map((r) => r.display), "redaction is the built-ins exactly");
  assert.equal(env.__seen.filter((x) => x.includes("party_roster")).length, 0, "D1 is never asked for the roster row");
  reset();
});

test("interlock open: flag on uses D1 for auth AND redaction together, and the privacy roster is a superset of the built-ins", async () => {
  reset();
  const env = await envOf({ flag: "on", kv: { party_roster: ROW } });
  assert.equal(JSON.parse((await me(env, "admin")).body).slug, "cask-wren");
  await primeRosterPrivacy(env);
  const keys = new Set(researchMembers().flatMap((m) => [m.display, ...m.aliases].map(skel)));
  for (const r of ROSTER_DATA) for (const n of [r.display, ...(r.aliases || [])]) assert.ok(keys.has(skel(n)), "built-in key still covered");
  for (const n of ["Alderfox", "fox", "Cask Wren", "cask"]) assert.ok(keys.has(skel(n)), "D1 key covered");
  reset();
});

// ---- F3: flag evaluations per request ------------------------------------------------------------------------------------------------------------------------
async function countingEnv(opts) {
  const env = await envOf(opts);
  const counter = { n: 0 };
  env.FLAGS = { getBooleanValue: async (key) => { if (key === "ROSTER_FROM_D1") counter.n++; return opts.value === true; } };
  return { env, counter };
}
async function req(env, method, p, headers = {}) {
  const silence = console.error; console.error = () => {};
  try { return await worker.fetch(new Request(`https://api.test${p}`, { method, headers: { ...headers, "CF-Connecting-IP": "203.0.113.9" } }), env, ctx); } finally { console.error = silence; }
}

test("flag evaluations per request: none on OPTIONS or on a route that never uses the roster, at most one on routes that do, flag on or off", async () => {
  for (const value of [true, false]) {
    reset();
    const probe = async (method, p, who) => {
      const { env, counter } = await countingEnv({ kv: { party_roster: ROW }, memberSlug: "brindle-moth", value });
      const headers = who === "admin" ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : who === "member" ? { Authorization: `Board ${env.__key}` } : {};
      await req(env, method, p, headers);
      return counter.n;
    };
    assert.equal(await probe("OPTIONS", "/api/me", "admin"), 0, `OPTIONS (flag ${value})`);
    assert.equal(await probe("OPTIONS", "/api/anything", "none"), 0);
    assert.equal(await probe("GET", "/health", "none"), 0, "a route that never uses the roster does not ask Flagship");
    assert.equal(await probe("GET", "/api/me", "admin"), 1, "admin auth: exactly one evaluation");
    assert.equal(await probe("GET", "/api/me", "member"), 1, "member auth evaluates once");
    assert.equal(await probe("GET", "/api/me", "none"), 1);
  }
  reset();
});

test("flag evaluations: the interlock refuses before asking Flagship, so a closed interlock costs nothing", async () => {
  reset();
  setStep2ReadyForTests(null);
  const { env, counter } = await countingEnv({ kv: { party_roster: ROW }, value: true });
  await req(env, "GET", "/api/me", { Authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(counter.n, 0);
  reset();
});

test("flag evaluations: a scheduled run asks at most once", async () => {
  reset();
  const { env, counter } = await countingEnv({ kv: { party_roster: ROW }, value: true });
  const silence = console.error; console.error = () => {};
  try { await worker.scheduled({ cron: "0 */6 * * *" }, env, ctx); } catch { /* the sweep has nothing to fetch in tests */ } finally { console.error = silence; }
  assert.ok(counter.n <= 1, `scheduled evaluated ${counter.n} times`);
  reset();
});

test("one request's memo is its own: a second request asks again, and an unscoped env is not memoised", async () => {
  reset();
  const { env, counter } = await countingEnv({ kv: { party_roster: ROW }, value: true });
  const a = rosterScope(env);
  await activeRoster(a); await activeRoster(a); await activeRoster(a);
  assert.equal(counter.n, 1);
  await activeRoster(rosterScope(env));
  assert.equal(counter.n, 2);
  await activeRoster(env); await activeRoster(env);
  assert.equal(counter.n, 4);
  reset();
});

test("research privacy is primed where it is used (the ask path); research off does not prime; fetch and scheduled do not prime", async () => {
  reset();
  const env = await envOf({ flag: "on", kv: { party_roster: ROW } });
  await buildAnswerInputs(env, { question: "what is a good spec", by: "Visitor", research: false });
  assert.deepEqual(researchMembers().map((m) => m.display), ROSTER_DATA.map((r) => r.display), "research off leaves the built-ins");
  await buildAnswerInputs(env, { question: "what is a good spec", by: "Visitor", research: true });
  assert.equal(researchMembers()[0].display, "Alderfox", "research on primes the D1 roster first");
  const idx = fs.readFileSync(path.join(ROOT, "infrastructure/worker/index.js"), "utf8");
  assert.equal(/primeRosterPrivacy/.test(idx), false, "priming is not done in fetch or scheduled");
  assert.match(fs.readFileSync(path.join(ROOT, "infrastructure/worker/ai-models.js"), "utf8"), /primeRosterPrivacy\(env\)[\s\S]{0,200}researchParty\(/);
  reset();
});

// ---- F5: validation --------------------------------------------------------------------------------------------------------------------------------------------
const withMembers = (...ms) => ({ version: 1, default_admin: ms[0].slug, members: ms });
const mem = (slug, name, extra = {}) => ({ slug, name, race: "human", class: "rogue", ...extra });
const A = mem("alderfox", "Alderfox", { aliases: ["alderfox", "fox"] });
const B = mem("brindle-moth", "Brindle Moth", { aliases: ["brindle moth", "brindle"] });

test("validation rejects the shapes that would corrupt the redaction roster", () => {
  const rejects = (label, cfg, re) => { const e = validateRosterConfig(cfg); assert.equal(typeof e, "string", label); if (re) assert.match(e, re, label); };
  rejects("missing version", { default_admin: "alderfox", members: [A] }, /version/);
  rejects("version 2", { version: 2, default_admin: "alderfox", members: [A] }, /version/);
  rejects("duplicate name", withMembers(A, mem("other", "Alderfox")), /collides/);
  rejects("case-duplicate name", withMembers(A, mem("other", "ALDERFOX")), /collides/);
  rejects("look-alike name (spacing)", withMembers(B, mem("other", "Brindlemoth")), /collides/);
  rejects("alias collides with another member's alias", withMembers(A, mem("other", "Other One", { aliases: ["fox"] })), /collides/);
  rejects("alias collides with another member's name", withMembers(A, mem("other", "Other One", { aliases: ["alderfox"] })), /collides/);
  rejects("first name collides with another member's alias", withMembers(A, mem("other", "Other One", { first_names: ["Fox"] })), /collides/);
  for (const w of ["all", "everyone", "id", "here", "All", "EVERYONE"]) {
    rejects(`reserved name ${w}`, withMembers(A, mem("other", w)), /reserved|at least 2/);
    rejects(`reserved alias ${w}`, withMembers(A, mem("other", "Other One", { aliases: [w.toLowerCase()] })), /reserved|at least 2/);
  }
  for (const w of ["all", "everyone", "here"]) rejects(`reserved name is rejected for the reserved reason: ${w}`, withMembers(A, mem("other", w)), /reserved/);
  rejects("reserved slug", withMembers(mem("everyone", "Other One")), /reserved/);
  rejects("reserved first name", withMembers(A, mem("other", "Other One", { first_names: ["Here"] })), /reserved/);
  for (const t of ["P1", "p23", "P007"]) { rejects(`token-like name ${t}`, withMembers(A, mem("other", t)), /token/); rejects(`token-like alias ${t}`, withMembers(A, mem("other", "Other One", { aliases: [t.toLowerCase()] })), /token/); }
  rejects("one-letter name", withMembers(A, mem("other", "Z")), /at least 2/);
  rejects("one-letter alias", withMembers(A, mem("other", "Other One", { aliases: ["z"] })), /at least 2/);
  rejects("one-letter first name", withMembers(A, mem("other", "Other One", { first_names: ["Z"] })), /at least 2/);
  for (const bad of ["Al.der", "Al*der", "Al+der", "Al?der", "Al(der", "Al)der", "Al[der", "Al]der", "Al{der", "Al}der", "Al|der", "Al^der", "Al$der", "Al\\der", "Al/der", "<Alder>"]) {
    rejects(`regex or markup character in a name: ${bad}`, withMembers(A, mem("other", bad)), /character/);
    rejects(`... in an alias: ${bad}`, withMembers(A, mem("other", "Other One", { aliases: [bad.toLowerCase()] })), /character/);
    rejects(`... in a first name: ${bad}`, withMembers(A, mem("other", "Other One", { first_names: [bad] })), /character/);
  }
  for (const w of ["constructor", "prototype", "tostring", "valueof", "hasownproperty", "__proto__", "toString", "to-string"]) {
    rejects(`prototype word as slug ${w}`, withMembers(A, mem(w, "Other One")), /./);
  }
  rejects("prototype word as a name", withMembers(A, mem("other", "Constructor")), /prototype/);
  rejects("prototype word as an alias", withMembers(A, mem("other", "Other One", { aliases: ["constructor"] })), /prototype/);
  rejects("empty aliases array", withMembers(mem("alderfox", "Alderfox", { aliases: [] })), /aliases/);
  rejects("empty first_names array", withMembers(mem("alderfox", "Alderfox", { first_names: [] })), /first_names/);
});

test("validation accepts the fictional roster, accents and apostrophes", () => {
  assert.equal(validateRosterConfig(FICTION), null);
  assert.equal(validateRosterConfig(withMembers(mem("tamsin", "Tamsin O'Hare", { aliases: ["tamsin o'hare", "tam"] }), mem("rene", "Renée Vail"))), null);
});

test("validation: the member cap is 50, and the first_names rules hold", () => {
  const pairs = [];
  for (const x of "bcdfghjklmnpqrstvwxz") for (const y of "aeiou") pairs.push(x + y);
  const many = (n) => Array.from({ length: n }, (_, i) => mem(`m-${pairs[i]}`, `Velm${pairs[i]}tor`));
  assert.equal(validateRosterConfig({ version: 1, default_admin: "m-ba", members: many(50) }), null);
  assert.match(validateRosterConfig({ version: 1, default_admin: "m-ba", members: many(51) }), /1 to 50/);
  assert.match(validateRosterConfig({ version: 1, default_admin: "m-ba", members: [] }), /1 to 50/);
  const fn = (v) => validateRosterConfig(withMembers(mem("alderfox", "Alderfox", { first_names: v })));
  assert.equal(fn(["Perrin"]), null);
  assert.equal(fn(["Perrin", "Odalys", "Quillan", "Rowan", "Sable", "Tarn", "Ulric", "Vesper"]), null, "8 is the limit");
  assert.match(fn(["Perrin", "Odalys", "Quillan", "Rowan", "Sable", "Tarn", "Ulric", "Vesper", "Wren"]), /first_names/);
  assert.match(fn("Perrin"), /first_names/);
  assert.match(fn([5]), /first_names/);
  assert.match(fn([""]), /first_names/);
  assert.match(fn(["x".repeat(61)]), /first_names/);
});

test("PUT-time validation is the same function (validateConfigValue)", () => {
  assert.equal(typeof validateConfigValue("party_roster", { ...FICTION, version: undefined }), "string");
  assert.equal(typeof validateConfigValue("party_roster", withMembers(A, mem("other", "Alderfox"))), "string");
});
