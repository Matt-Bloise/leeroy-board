// Property tests for the outbound-privacy modules: tokenise.js and outbound-guard.js.
// Pure and offline: no network, no provider calls. Fixtures are fictional only.
// Run: node --test tests/unit/privacy-tokenise.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildNameMap,
  tokenise,
  detokenise,
  carriesFirstName,
  normalise,
} from "../../infrastructure/worker/privacy/tokenise.js";
import {
  assertNoIdentifiers,
  findIdentifiers,
  scrubSearchQuery,
  CANARY,
} from "../../infrastructure/worker/privacy/outbound-guard.js";
import { ROSTER_DATA } from "../../infrastructure/worker/bot-data.js";

// ---------- seeded RNG ----------
function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    digits: (n) => {
      let s = String(1 + Math.floor(next() * 9));
      for (let i = 1; i < n; i++) s += Math.floor(next() * 10);
      return s;
    },
  };
}

// ---------- fictional fixtures ----------
const MEMBERS = [
  {
    display: "Testbard",
    aliases: ["testy", "the bard"],
    firstNames: ["Alderic"],
    discordIds: ["112233445566778899"],
    characterNames: ["Zorrin Quillfeather"],
    guild: "Examplehold Raiders",
  },
  {
    display: "Examplemage",
    aliases: ["exmage"],
    firstNames: ["Brenna"],
    discordIds: ["223344556677889900"],
    characterNames: ["Pyrelle"],
    guild: "Examplehold Raiders",
  },
  {
    display: "Hat",
    aliases: ["hatty"],
    firstNames: ["Corwin"],
    discordIds: ["334455667788990011"],
    characterNames: [],
  },
  {
    display: "Bell",
    aliases: ["bell ringer"],
    firstNames: ["Delphine"],
    discordIds: ["445566778899001122"],
    characterNames: ["Tollwen"],
  },
  {
    display: "Handsome Pumpkin",
    aliases: ["pumpkin"],
    firstNames: ["Evander"],
    discordIds: ["556677889900112233"],
    characterNames: ["Quillfeather Jr"],
  },
];
const MAP = buildNameMap(MEMBERS);

// ---------- variant generators ----------
const ZW = ["​", "‌", "‍", "⁠", "﻿"];
const LOOK = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у" };

function mutate(name, rng) {
  const mode = rng.int(10);
  let s = name;
  switch (mode) {
    case 0: return s;
    case 1: return s.toLowerCase();
    case 2: return s.toUpperCase();
    case 3: // mixed case
      return [...s].map((c) => (rng.next() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join("");
    case 4: { // zero-width split
      const i = 1 + rng.int(Math.max(1, s.length - 1));
      return s.slice(0, i) + rng.pick(ZW) + s.slice(i);
    }
    case 5: return s.replace(/ /g, " ");
    case 6: return s.replace(/ /g, rng.pick(["-", "‑", "–", "_"]));
    case 7: // fullwidth
      return [...s].map((c) => (/[A-Za-z]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
    case 8: // cyrillic lookalikes
      return [...s].map((c) => (LOOK[c.toLowerCase()] && rng.next() < 0.7 ? LOOK[c.toLowerCase()] : c)).join("");
    default: // mathematical bold
      return [...s]
        .map((c) => {
          if (/[a-z]/.test(c)) return String.fromCodePoint(0x1d41a + c.charCodeAt(0) - 97);
          if (/[A-Z]/.test(c)) return String.fromCodePoint(0x1d400 + c.charCodeAt(0) - 65);
          return c;
        })
        .join("");
  }
}

function suffix(rng) {
  return rng.pick(["", "", "'s", "’s", "s'", "s", "s's"]);
}

function anyName(rng) {
  const m = rng.pick(MEMBERS);
  const pool = [m.display, ...m.aliases, ...m.firstNames, ...m.characterNames];
  if (m.guild) pool.push(m.guild);
  return rng.pick(pool);
}

function ref(rng) {
  const roll = rng.int(8);
  const m = rng.pick(MEMBERS);
  if (roll === 0) return `<@${m.discordIds[0]}>`;
  if (roll === 1) return `<@!${m.discordIds[0]}>`;
  if (roll === 2) return `<@&${rng.digits(18)}>`;
  if (roll === 3) return rng.digits(17 + rng.int(4));
  if (roll === 4) return `<#${rng.digits(19)}>`;
  if (roll === 5) return rng.pick(["@everyone", "@here", "@EVERYONE"]);
  if (roll === 6) return rng.pick(["discord.gg/abc123", "https://discord.gg/Xy9-zQ", "discord.com/invite/fakecode1"]);
  return `<@${rng.digits(18)}>`;
}

const FILLER = [
  "Rather than guess, check the gear list and the biblical-length thread.",
  "That hatchet build matters more than the bellows nonsense.",
  "Can we clear the boss tonight and ask about loot rules afterwards?",
  "Tank cooldowns lined up with the third phase, honestly.",
];

function genPrompt(rng) {
  const lines = [];
  lines.push(`Asker: ${mutate(anyName(rng), rng)}${suffix(rng)}`);
  const n = 3 + rng.int(6);
  for (let i = 0; i < n; i++) {
    const t = rng.int(6);
    if (t === 0) lines.push(`${mutate(anyName(rng), rng)}${suffix(rng)} said the plan is fine, ask ${mutate(anyName(rng), rng)} too.`);
    else if (t === 1) lines.push(`Ping ${ref(rng)} and ${ref(rng)} about ${mutate(anyName(rng), rng)}${suffix(rng)} gear.`);
    else if (t === 2) lines.push(rng.pick(FILLER));
    else if (t === 3) lines.push(`${mutate(anyName(rng), rng)}${suffix(rng)}${rng.pick(["", "!", "?", ","])} ${rng.pick(FILLER)}`);
    else if (t === 4) {
      lines.push("--- channel history ---");
      for (let j = 0; j < 3; j++) lines.push(`[12:0${j}] ${mutate(anyName(rng), rng)}: ${rng.pick(FILLER)} ${ref(rng)}`);
      lines.push("--- end history ---");
    } else lines.push(`Is ${mutate(anyName(rng), rng)}${suffix(rng)} ready? (id ${rng.digits(17 + rng.int(4))})`);
  }
  return lines.join("\n");
}

function bodies(prompt, map) {
  const t = (s) => tokenise(s, map);
  const sys = t("You answer questions for a raid group. Use short replies.");
  return {
    anthropic: {
      model: "claude-test-model",
      max_tokens: 512,
      system: sys,
      messages: [
        { role: "user", content: t(prompt) },
        { role: "assistant", content: [{ type: "text", text: t(prompt.slice(0, 80)) }] },
      ],
    },
    workers: { messages: [{ role: "system", content: sys }, { role: "user", content: t(prompt) }] },
  };
}

// ---------- tests ----------
test("500 seeded prompts: tokenised bodies pass the outbound guard (3 provider shapes)", () => {
  const rng = rngFrom(20261114);
  let withNames = 0;
  for (let i = 0; i < 500; i++) {
    const prompt = genPrompt(rng);
    const b = bodies(prompt, MAP);
    assertNoIdentifiers(b.anthropic, MAP);
    assertNoIdentifiers(b.workers, MAP);
    const q = scrubSearchQuery(prompt, MAP);
    if (q !== null) {
      assert.deepEqual(findIdentifiers({ q }, MAP), []);
      assert.ok(!/\{P\d+\}/.test(q));
    } else withNames++;
  }
  assert.ok(withNames > 400, "most generated prompts carry identifiers and must yield a null search query");
});

test("guard is not vacuous: raw prompts leak, the canary leaks", () => {
  const rng = rngFrom(7);
  let flagged = 0;
  for (let i = 0; i < 100; i++) {
    const prompt = genPrompt(rng);
    if (findIdentifiers({ messages: [{ role: "user", content: prompt }] }, MAP).length) flagged++;
  }
  assert.ok(flagged >= 95, `raw prompts flagged: ${flagged}`);
  assert.throws(() => assertNoIdentifiers({ a: [{ b: `x ${CANARY} y` }] }, MAP), /leak/);
  assert.throws(() => assertNoIdentifiers({ a: "leeroy-canary-7f3a91c2" }, MAP, CANARY));
  assert.throws(() => assertNoIdentifiers({ a: "LEEROY CANARY 7f3a91c2" }, MAP));
});

test("guard catches each identifier class in nested bodies and in keys", () => {
  const m = MEMBERS[0];
  const cases = {
    display: `hi ${m.display}`,
    possessive: `${m.display}'s gear`,
    glued: `${m.display}sfoo bar`.replace("sfoo", "s"),
    alias: `ask ${m.aliases[0]}`,
    firstName: `${m.firstNames[0].toLowerCase()} said`,
    character: `${m.characterNames[0]}`,
    guild: `${m.guild}`,
    id: `id ${m.discordIds[0]}`,
    mention: `<@!${m.discordIds[0]}>`,
    zw: `Test​bard`,
    nbsp: "Zorrin Quillfeather",
    hyphen: "zorrin-quillfeather",
    everyone: "hey @everyone",
    invite: "join discord.gg/zzTop9",
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.throws(() => assertNoIdentifiers({ deep: { list: [1, { x: v }] } }, MAP), /leak/, k);
    assert.throws(() => assertNoIdentifiers({ [v]: 1 }, MAP), /leak/, `key:${k}`);
  }
  assert.throws(() => assertNoIdentifiers({ n: 112233445566778899n }, MAP), /leak/, "bigint id");
  const ok = assertNoIdentifiers({ messages: [{ content: "{P1} asked {P2} about rather biblical hatchets" }] }, MAP);
  assert.equal(ok.ok, true);
  try {
    assertNoIdentifiers({ x: `a ${m.display}` }, MAP);
  } catch (e) {
    assert.ok(!e.message.includes(m.display), "error text must not echo the leaked value");
    assert.ok(Array.isArray(e.leaks) && e.leaks.length > 0);
  }
});

test("reply round-trips tokens to display names only", () => {
  const reply = "Sure {P1}, {P3}'s plan beats {P5}s idea. Ask {P2}.";
  const out = detokenise(reply, MAP);
  assert.equal(out, "Sure Testbard, Hat's plan beats Handsome Pumpkins idea. Ask Examplemage.");
  const rng = rngFrom(99);
  for (let i = 0; i < 200; i++) {
    const prompt = genPrompt(rng);
    const back = detokenise(tokenise(prompt, MAP), MAP);
    assert.equal(carriesFirstName(back, MAP), false, "restoration must never reintroduce first names");
    assert.ok(!/\d{17,}/.test(back));
  }
  // tolerant of model-mangled brace spacing/case
  assert.equal(detokenise("ok { p1 } and {P2}", MAP), "ok Testbard and Examplemage");
});

test("carriesFirstName refuses replies containing a first name, accepts display-only replies", () => {
  const rng = rngFrom(5);
  for (const m of MEMBERS) {
    for (const fn of m.firstNames) {
      for (let i = 0; i < 20; i++) {
        const reply = `Looks good, ${mutate(fn, rng)}${suffix(rng)}. Carry on.`;
        assert.equal(carriesFirstName(reply, MAP), true, reply);
      }
    }
  }
  assert.equal(carriesFirstName("Testbard and Examplemage should split the loot.", MAP), false);
  assert.equal(carriesFirstName("{P1} and {P2} should split the loot.", MAP), false);
  assert.equal(carriesFirstName("", MAP), false);
});

test("unknown tokens get a neutral word", () => {
  assert.equal(detokenise("{P9} agrees with {P1}", MAP), "someone agrees with Testbard");
  assert.equal(detokenise("{ID} {ALL} {INVITE} {GUILD}", MAP), "someone everyone a link the server");
  assert.equal(detokenise("no tokens", MAP), "no tokens");
  assert.equal(detokenise("{P1}", buildNameMap([])), "someone");
});

test("tokenise is idempotent", () => {
  const rng = rngFrom(31337);
  for (let i = 0; i < 500; i++) {
    const once = tokenise(genPrompt(rng), MAP);
    assert.equal(tokenise(once, MAP), once);
  }
});

test("common-word display names: boundary respected, derived at runtime from the live roster", () => {
  // Synthetic common words
  assert.equal(tokenise("I would rather wear a hatchet than that hat", MAP), "I would rather wear a hatchet than that {P3}");
  assert.equal(tokenise("a bellow, a belly, Bell's turn", MAP), "a bellow, a belly, {P4}'s turn");
  // Real roster values built at runtime: embedded in longer words they must survive; alone they must go.
  const real = buildNameMap(ROSTER_DATA.map((r) => ({ display: r.display, aliases: r.aliases, firstNames: [], discordIds: [], characterNames: [] })));
  for (const r of ROSTER_DATA) {
    for (const a of [r.display, ...r.aliases]) {
      if (a.length >= 7 || /\s/.test(a)) continue; // long and multi-word names intentionally match as substrings
      assert.equal(tokenise(`${a}ical ${a}ther x${a}`, real), `${a}ical ${a}ther x${a}`, `must not mangle words containing "${a.length}-letter" alias`);
      assert.ok(/\{P\d+\}/.test(tokenise(`so ${a} said`, real)), "bare alias is replaced");
    }
  }
});

test("tokens are stable across calls and ordered by member position", () => {
  const a = buildNameMap(MEMBERS);
  const b = buildNameMap(JSON.parse(JSON.stringify(MEMBERS)));
  assert.deepEqual([...a.names], [...b.names]);
  assert.equal(tokenise("Testbard Examplemage Hat Bell Handsome Pumpkin", a), "{P1} {P2} {P3} {P4} {P5}");
  assert.equal(tokenise("Testbard Examplemage", b), tokenise("Testbard Examplemage", a));
  // asker already present: no extra token
  const withAsker = buildNameMap(MEMBERS, "exmage");
  assert.equal(withAsker.byToken.size, 5);
  assert.equal(tokenise("exmage asks", withAsker), "{P2} asks");
  // asker absent from roster: appended, original tokens unchanged
  const extra = buildNameMap(MEMBERS, "Zzyzx Guest");
  assert.equal(tokenise("Testbard / Zzyzx Guest", extra), "{P1} / {P6}");
  assert.equal(detokenise("{P6}", extra), "Zzyzx Guest");
});

test("mentions and ids: known ids resolve to the member token, unknown ids to {ID}, specials removed", () => {
  const out = tokenise(`<@112233445566778899> <@!223344556677889900> <@&998877665544332211> raw 99887766554433221100 @everyone @here discord.gg/abc123`, MAP);
  assert.equal(out, "{P1} {P2} {ID} raw {ID} {ALL} {ALL} {INVITE}");
  assert.equal(tokenise("ms 1700000000000 ok", MAP), "ms 1700000000000 ok");
});

test("normalise strips zero-width, folds width, lookalikes, nbsp", () => {
  assert.equal(normalise("T​e⁠s﻿t"), "Test");
  assert.equal(normalise("Ｔｅｓｔ"), "Test");
  assert.equal(normalise("Тest"), "Test");
  assert.equal(normalise("a b"), "a b");
});

test("no regex blowup on 200k-char inputs", () => {
  const hostile = [
    "a ".repeat(100000),
    "Testbard".repeat(25000),
    "Handsome-".repeat(22000) + "x",
    "Zorrin" + " ".repeat(199000) + "x",
    ("​".repeat(50) + "Hand some ").repeat(3000),
    "9".repeat(200000),
  ];
  for (const h of hostile) {
    const t0 = performance.now();
    const out = tokenise(h, MAP);
    assertNoIdentifiers({ x: out }, MAP);
    const dt = performance.now() - t0;
    assert.ok(dt < 1000, `took ${dt.toFixed(0)}ms`);
  }
});

test("scrubSearchQuery: null when a person or id would remain, text otherwise", () => {
  assert.equal(scrubSearchQuery("Testbard dps rotation", MAP), null);
  assert.equal(scrubSearchQuery("fire spell rotation for raid bosses", MAP), "fire spell rotation for raid bosses");
  assert.equal(scrubSearchQuery("{P9} gear", MAP), null);
  assert.equal(scrubSearchQuery("<@112233445566778899> gear", MAP), null);
  assert.equal(scrubSearchQuery("   ", MAP), null);
  assert.equal(scrubSearchQuery("", MAP), null);
});

test("scan: new files and tests contain no values from the live roster", () => {
  const allow = new Set(["mage", "tank"]);
  const values = new Set();
  for (const r of ROSTER_DATA) for (const v of [r.display, ...r.aliases]) if (!allow.has(v.toLowerCase())) values.add(v.toLowerCase());
  const files = [
    "../../infrastructure/worker/privacy/tokenise.js",
    "../../infrastructure/worker/privacy/outbound-guard.js",
    "./privacy-tokenise.test.mjs",
  ];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").toLowerCase();
    for (const v of values) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
      assert.ok(!re.test(src), `${f} contains a roster value (length ${v.length})`);
    }
  }
});
