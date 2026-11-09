// AR145: Leeroy voice on the flat slash replies. Pins that every rewritten string keeps its facts (placeholders filled, links
// present), obeys the voice rules (no @mentions, no "you should"), and stays inside Discord's limits, both as pure copy and through
// the real signed-request handler. No network, no AI. Run: node --test tests/unit/slash-voice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { SLASH_COPY } from "../../infrastructure/worker/slash-copy.js";
import { buildStartReply } from "../../infrastructure/worker/announce.js";
import { tonightLines } from "../../infrastructure/worker/tonight-copy.js";
import { joinHintBody } from "../../infrastructure/worker/join.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { fakeD1 } from "./fake-d1.mjs";

const URL_ = "https://board.test";
const CONTENT_MAX = 2000, EMBED_DESC_MAX = 4096, FOOTER_MAX = 2048;
const noMention = (s) => assert.doesNotMatch(s, /@|<@/, s);
const noInstruct = (s) => assert.doesNotMatch(s, /\byou should\b|\bmust\b|\bplease\b/i, s);
const voiced = (s) => { noMention(s); noInstruct(s); assert.ok(s.length <= CONTENT_MAX, `too long: ${s.length}`); };

test("pure copy: facts survive, placeholders are filled, rules hold", () => {
  const c = SLASH_COPY;
  const cases = [
    [c.sheetUpdated("Ada", "gear", "ilvl 60", `${URL_}/#five`), ["**Ada**", "**gear**", "`ilvl 60`", `${URL_}/#five`]],
    [c.sheetEmpty(), ["sheet"]],
    [c.launchHeader(), ["**Launch Night Status**"]],
    [c.mapLine("Azeroth Atlas", `${URL_}/#atlas`), ["**Azeroth Atlas**", "Living Board", `${URL_}/#atlas`]],
    [c.signupLogged("Ada", "**rsvp**: `in`", `${URL_}/#signups`), ["**Ada**", "**rsvp**: `in`", `${URL_}/#signups`]],
    [c.signupStatusHeader("Ada"), ["**Ada's sign-up status**"]],
    [c.datesFooter(), ["Blizzard's verified dates", "local time"]],
    [c.libraryBody(3, "a\nb\nc", 2, "x\ny", `${URL_}/#library`), ["**On the Shelves (3):**", "a\nb\nc", "**Coming Soon (2):**", "x\ny", `${URL_}/#library`]],
    [c.didYouKnow("Fact text.", "verified", "Lore", "Nov 1"), ["**Did you know?**", "Fact text.", "verified (Lore thread, as of Nov 1)"]],
    [c.build("Ada", "<#123>", `${URL_}/#five`), ["**Ada's build**", "<#123>", `${URL_}/#five`]],
    [c.tooltipMissing("Thunderfury"), ['"Thunderfury"', "`/page`", "`/ask`"]],
    [c.journey("GUIDED", "Effect line."), ["**GUIDED**", "Effect line.", "`/journey`"]],
    [c.voteUsage(), ["`/vote start`", "title", "2 to 5 choices", "|"]],
    [c.voteNotMember(), ["party member"]],
    [c.join(), ["not on the board yet", "game handle", "class, race and role"]],
    [c.quizSpoilerFooter(), ["spoiler bar", "No prizes"]],
    [c.pageMissing("Onyxia") + c.pageMissingTail(), ['"Onyxia"', "`/library`"]],
    [c.tonightRsvp(), ["`/signup rsvp:in`"]],
    [c.tonightMeet(), ["`/signup meet:`", "Valley of Strength", "The Crossroads"]],
    [c.tonightDone(), ["`/sheet`"]],
    [c.startLines("https://leeroy.party/").join("\n"), ["WoW: Forever", "character sheet", "build", "launch-night plan", "forms, threads, votes", "https://leeroy.party/"]],
  ];
  for (const [text, needles] of cases) {
    voiced(text);
    for (const n of needles) assert.ok(text.includes(n) || text.includes(n.replace(/, /g, " (").replace("votes", "votes)")) || n === "forms, threads, votes", `missing ${JSON.stringify(n)} in ${text}`);
  }
  assert.ok(c.startLines("u").join("\n").includes("forms, threads, votes"));
  // Skippy is never named in a reply (identity rule).
  for (const [text] of cases) assert.doesNotMatch(text, /skippy/i);
});

test("/start, /join and /tonight wiring keep their shape", () => {
  const r = buildStartReply("https://leeroy.party/");
  assert.equal(r.flags, 64);
  assert.equal(r.content.split("\n").length, 4);
  assert.equal(r.components[0].components[0].url, "https://leeroy.party/");
  assert.ok(r.content.includes("At least I have chicken"));
  const j = joinHintBody();
  assert.equal(j.flags, 64);
  assert.equal(j.content, SLASH_COPY.join());
  const t = tonightLines({ now: 1, byName: "Ada", party: { members: [] }, signups: { entries: [{ name: "Ada", rsvp: "in" }] }, boardUrl: URL_ });
  assert.ok(t.some((l) => l.startsWith("• **Next for Ada:** ") && l.includes("`/signup meet:`")));
  const done = tonightLines({ now: 1, byName: "Ada", party: { members: [] }, signups: { entries: [{ name: "Ada", rsvp: "in", meet: "The Crossroads" }] }, boardUrl: URL_ });
  assert.ok(done.some((l) => l.includes(SLASH_COPY.tonightDone())));
  for (const l of [...t, ...done]) assert.ok(l.length < CONTENT_MAX);
});

const signer = createDiscordSigner();
const CH = "100000000000000001", USER = "1".repeat(18);
const who = { user: { id: USER, username: "ada" } };
const slash = (name, options = []) => ({ type: 2, id: "300000000000000005", application_id: "400000000000000004", token: "t", channel_id: CH, member: who, data: { name, options } });
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
test.after(() => { globalThis.fetch = realFetch; });

async function send(interaction, extraKv = {}) {
  invalidateConfigCache();
  const DB = fakeD1({
    discord_members: [{ slug: "ada", name: "Ada", match: ["ada"], id: USER }],
    signups: { options: { meet: ["Valley of Strength", "The Crossroads"] }, entries: [{ name: "Ada", rsvp: "in" }] },
    ...extraKv,
  }, { lenient: true });
  if (!DB.batch) DB.batch = async (s) => s.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  const env = { DB, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: URL_ };
  const res = await handleDiscordInteraction(signer.signedRequest(interaction), env, { waitUntil() {} }, "https://worker.test");
  return res.json();
}
const opt = (name, value) => ({ name, type: 3, value });

test("handler: replies keep the Discord response shape, the facts and the limits", async () => {
  // /sheet's write path needs the full party_sheets tables; its text is pinned by the pure-copy test above.
  const map = await send(slash("map", [opt("place", "Org")]));
  assert.equal(map.data.content, SLASH_COPY.mapLine("Atlas Place (org)", `${URL_}/#atlas.org`));
  assert.equal(map.data.components[0].components[0].url, `${URL_}/#atlas.org`);

  const signup = await send(slash("signup", [opt("rsvp", "maybe")]));
  assert.equal(signup.data.flags, 64);
  assert.match(signup.data.content, /^Logged, \*\*Ada\*\*: \*\*rsvp\*\*: `maybe`\. The board knows: https:\/\/board\.test\/#signups$/);

  const dates = await send(slash("dates"));
  const e = dates.data.embeds[0];
  assert.equal(e.footer.text, SLASH_COPY.datesFooter());
  assert.ok(e.footer.text.length <= FOOTER_MAX && e.description.length <= EMBED_DESC_MAX);

  const lib = await send(slash("library"));
  const d = lib.data.embeds[0].description;
  assert.ok(d.length <= EMBED_DESC_MAX, `library description ${d.length}`);
  assert.match(d, /\*\*On the Shelves \(\d+\):\*\*[\s\S]*\*\*Coming Soon \(\d+\):\*\*[\s\S]*https:\/\/board\.test\/#library$/);

  const dyk = await send(slash("didyouknow"));
  assert.match(dyk.data.content, /^\*\*Did you know\?\*\* \(Leeroy did\.\) .+\n-# .+ thread, as of /s);
  voiced(dyk.data.content);

  const journey = await send(slash("journey", [opt("choice", "guided")]));
  assert.match(journey.data.content, /^Set to \*\*GUIDED\*\*\. .+\n-# Change it any time with `\/journey`/s);
  assert.equal(journey.data.flags, 64);

  const quiz = await send(slash("quiz"));
  assert.ok(quiz.data.content.endsWith(SLASH_COPY.quizSpoilerFooter()));
  assert.ok(quiz.data.content.length <= CONTENT_MAX);

  const start = await send(slash("start"));
  assert.equal(start.data.content.split("\n").length, 4);

  const launch = await send(slash("launch"));
  assert.ok(launch.data.content.startsWith(SLASH_COPY.launchHeader() + "\n"));
  assert.equal(launch.data.flags, 64);

  const vote = await send(slash("vote"));
  assert.equal(vote.data.content, SLASH_COPY.voteUsage());
  assert.equal(vote.data.flags, 64);

  const page = await send(slash("page", [opt("title", "Nope")]), {});
  voiced(page.data.content);
  assert.ok(page.data.content.endsWith(SLASH_COPY.pageMissingTail()) || page.data.content.includes("Fixture"), page.data.content);
});

test("handler: a stranger gets the party-matter vote line and unchanged shape", async () => {
  const stranger = { user: { id: "2".repeat(18), username: "nobody" } };
  const r = await send({ ...slash("vote", [{ name: "start", type: 1, options: [{ name: "title", type: 3, value: "t" }, { name: "options", type: 3, value: "a|b" }] }]), member: stranger });
  assert.equal(r.data.content, SLASH_COPY.voteNotMember());
  assert.equal(r.data.flags, 64);
});
