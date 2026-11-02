// =============================================================================
// Discord Bot & Serverless Interactions Integration (`worker/discord.js`)
// Full serverless parity with `wow-mage/bot/`:
//   1.  `/ask`        — Multi-Provider AI Q&A (Claude, Gemini, Workers AI, Groq, Cerebras, GitHub Models, OpenRouter)
//   2.  `/tonight`    — Launch countdown, next steps, party members, and RSVP tallies
//   3.  `/sheet`      — View or update character sheet fields in D1 (`sheet_events` + `party_sheets`)
//   4.  `/launch`     — View or update launch-night queue/in/done status in D1
//   5.  `/map`        — Deep-link to any Azeroth place, zone or route on the Living Board Atlas
//   6.  `/signup`     — Update pack, meet, place, rsvp, or when directly from Discord + button interactions
//   7.  `/countdown`  — Launch countdown with hype and stress test status
//   8.  `/dates`      — Every WoW: Forever date we know, with certainty ratings
//   9.  `/library`    — The reference threads: what's on the shelves and what's coming
//   10. `/quiz`       — Random Pop Quiz question (spoiler bar or reaction reveal)
//   11. `/didyouknow` — Random did-you-know fact from the verified library
//   12. `/build`      — Link to someone's build thread with party roster choices
//   13. `/leeroy`     — The yell with channel cooldown: "LEEROOOOOOOOY JENKINS!"
//   14. `/help`       — Ephemeral guide to Leeroy bot and board
//   15. `/page`       — Library page summary card with facts & direct board link
//   16. `/tooltip`    — Spell or item tooltip from the game
//   17. `/journey`    — Pick how deep Leeroy's answers go (guided, curious, everything)
//   18. `/intents`    — View pending intents in the mailbox waiting for bot/consumers
//   19. `/ack`        — Acknowledge and clear intents up to a sequence number
//   20. `/answer`     — Answer an ask turn / question on the Living Board
//   21. Context menus — "Ask Leeroy" & "Fix this fact" on any Discord message
// =============================================================================

import { answerWithAi, resolveAiProvider } from "./ai-models.js";
import { buildStartReply } from "./announce.js";
import { resolveMember } from "./members.js";
import { loadPersona, pickLine, helpIntro } from "./persona.js";
import { saltProblems } from "./salts.js";
import { BUILD_MODAL_ID, buildModalEnabled, buildModalResponse, parseBuildSubmit, saveConfirmedBuild, isSnowflake } from "./build-modal.js";
import { isOpen, voterHash, newVoteId, createVote, castVote, renderMessage, tallyLines, parseVoteCustomId, loadVote, saveVote, recordInIndex } from "./votes.js";
import { isFreshTimestamp, clampContent, hardenInteractionBody, ALLOWED_MENTIONS_NONE, DISCORD_MAX_AGE_SECONDS } from "./discord-safety.js";
import { loadConfigKey, libraryShelfLine, buildThreadMention } from "./config.js";
import {
  broadcastToRoom,
  purgeWorkerCache,
  buildPartySheetsFromD1,
  recordSheetEventInD1,
  insertIntent,
} from "./index.js";
import {
  DATES_DATA,
  FACTS_DATA,
  LIBRARY_DATA,
  QUIZ_DATA,
  ROSTER_DATA,
} from "./bot-data.js";

export const GOLD = 0xffd100; // WoW UI Gold
export const LAUNCH_UTC = Date.UTC(2026, 10, 4, 23, 0, 0); // Wed Nov 4 2026, 6:00 PM EST
export const STRESS_UTC = Date.UTC(2026, 9, 21, 21, 0, 0); // Wed Oct 21 2026, 5:00 PM EDT

// Channel cooldown tracking for /leeroy (in-memory per isolate)
const leeroyCooldownMap = new Map();

export const DISCORD_SLASH_COMMANDS_MANIFEST = [
  {
    name: "ask",
    description: "Ask Leeroy Jenkins a question from the verified WoW: Forever library",
    options: [
      { name: "question", description: "Your question for Leeroy", type: 3, required: true },
      {
        name: "model",
        description: "Optional AI provider override",
        type: 3,
        required: false,
        choices: [
          { name: "Cloudflare Workers AI (Llama 3.3 70B · Free)", value: "workers-ai" },
          { name: "Google Gemini Free Tier", value: "gemini" },
          { name: "Groq Free Tier (Llama 3.3 70B)", value: "groq" },
          { name: "Cerebras Free Tier (Llama 3.3 70B)", value: "cerebras" },
          { name: "GitHub Models (GPT-4o · Free)", value: "github" },
          { name: "OpenRouter Free (DeepSeek V3)", value: "openrouter" },
          { name: "Claude (Anthropic)", value: "claude" },
        ],
      },
      { name: "private", description: "Only you see the answer (ephemeral)", type: 5, required: false },
    ],
  },
  {
    name: "start",
    description: "What the Leeroy board is and where to find it",
  },
  {
    name: "tonight",
    description: "See the launch countdown, your next step, and who is signed up for launch night",
  },
  {
    name: "sheet",
    description: "View or update a field on your character sheet on the Living Board",
    options: [
      { name: "member", description: "Whose sheet to view (defaults to you)", type: 6, required: false },
      {
        name: "field",
        description: "Sheet field to update (omit to view your current sheet)",
        type: 3,
        required: false,
        choices: [
          { name: "Race", value: "race" },
          { name: "Class", value: "class" },
          { name: "Spec Path", value: "spec_path" },
          { name: "Spec at 40", value: "spec_at_40" },
          { name: "Meeting Zone (plan_zone)", value: "plan_zone" },
          { name: "Goals", value: "goals" },
        ],
      },
      { name: "value", description: "New value for the field", type: 3, required: false },
    ],
  },
  {
    name: "launch",
    description: "Set or check launch-night queue status (queue, in, done)",
    options: [
      {
        name: "state",
        description: "Your current launch status",
        type: 3,
        required: false,
        choices: [
          { name: "In Queue", value: "queue" },
          { name: "In the World", value: "in" },
          { name: "Done for Tonight", value: "done" },
        ],
      },
    ],
  },
  {
    name: "map",
    description: "Open a place, zone or route plan on the Living Board Azeroth Atlas",
    options: [
      { name: "place", description: "Place or zone slug (e.g. orgrimmar, crossroads, tirisfal-glades)", type: 3, required: false, autocomplete: true },
      { name: "plan", description: "Meeting route plan slug (e.g. vos, xroads)", type: 3, required: false, autocomplete: true },
    ],
  },
  {
    name: "signup",
    description: "Set your launch-night RSVP, pack, meeting point, or arrival time",
    options: [
      {
        name: "pack",
        description: "Do you hold a pre-order pack?",
        type: 3,
        required: false,
        choices: [
          { name: "I hold a pack", value: "yes" },
          { name: "No pack", value: "no" },
        ],
      },
      {
        name: "meet",
        description: "Launch-night meeting point",
        type: 3,
        required: false,
        choices: [
          { name: "Valley of Strength", value: "Valley of Strength" },
          { name: "The Crossroads", value: "The Crossroads" },
        ],
      },
      { name: "place", description: "Somewhere else: type your custom meeting point", type: 3, required: false },
      {
        name: "rsvp",
        description: "Launch night attendance",
        type: 3,
        required: false,
        choices: [
          { name: "I'm in", value: "in" },
          { name: "Tentative", value: "maybe" },
          { name: "Running late", value: "late" },
          { name: "Out", value: "out" },
        ],
      },
      {
        name: "when",
        description: "When you get on for launch night (Eastern)",
        type: 3,
        required: false,
        choices: [
          { name: "6:00 PM Eastern", value: "6pm" },
          { name: "8:00 PM Eastern", value: "8pm" },
          { name: "Later in the night", value: "later" },
        ],
      },
      {
        name: "field",
        description: "Quick update: specific sign-up field",
        type: 3,
        required: false,
        choices: [
          { name: "RSVP", value: "rsvp" },
          { name: "Pack", value: "pack" },
          { name: "Meeting Point", value: "meet" },
          { name: "Arrival Time", value: "when" },
        ],
      },
      { name: "value", description: "Value for quick update field", type: 3, required: false },
    ],
  },
  {
    name: "countdown",
    description: "Countdown to launch day, with hype and stress test status",
  },
  {
    name: "dates",
    description: "Every WoW: Forever date we know, with certainty ratings",
  },
  {
    name: "library",
    description: "The reference threads: what's on the shelves and what's coming",
  },
  {
    name: "quiz",
    description: "One random Pop Quiz question (answer hidden)",
    options: [
      {
        name: "reveal",
        description: "How the answer shows",
        type: 3,
        required: false,
        choices: [
          { name: "Spoiler bar (default)", value: "spoiler" },
          { name: "React with eyes to reveal", value: "reaction" },
        ],
      },
    ],
  },
  {
    name: "didyouknow",
    description: "One random did-you-know fact from the library",
  },
  {
    name: "build",
    description: "Link to someone's build thread in the party",
    options: [
      { name: "member", description: "Whose build thread (defaults to you)", type: 6, required: false },
    ],
  },
  {
    name: "leeroy",
    description: "The yell. Cooldown applies. He has chicken.",
  },
  {
    name: "help",
    description: "How to use Leeroy (only you see the answer)",
  },
  {
    name: "page",
    description: "A library page as a card: head, facts, and board link",
    options: [
      { name: "title", description: "Page title or slug", type: 3, required: true, autocomplete: true },
    ],
  },
  {
    name: "tooltip",
    description: "A spell or item tooltip from the game, as the board shows it",
    options: [
      { name: "name", description: "Spell or item name", type: 3, required: true, autocomplete: true },
    ],
  },
  {
    name: "journey",
    description: "Pick how deep Leeroy's answers go for you (guided, curious, everything)",
    options: [
      {
        name: "choice",
        description: "How you want to learn",
        type: 3,
        required: true,
        choices: [
          { name: "Guided: walk me through it", value: "guided" },
          { name: "Curious: I'll click around (default)", value: "curious" },
          { name: "Everything: show me every number", value: "everything" },
        ],
      },
    ],
  },
  {
    name: "vote",
    description: "Start a vote the party can answer with buttons",
    options: [
      {
        name: "start",
        description: "Start a vote in this channel",
        type: 1,
        options: [
          { name: "title", description: "What the vote is about", type: 3, required: true },
          { name: "options", description: "2 to 5 choices separated by |", type: 3, required: true },
          { name: "closes_in_hours", description: "Hours until it closes (default 72)", type: 4, required: false },
        ],
      },
    ],
  },
  {
    name: "intents",
    description: "View pending intents in the mailbox waiting for the bot or consumers",
    options: [
      { name: "after", description: "Sequence number to start after", type: 4, required: false },
      { name: "limit", description: "Maximum intents to return (default 10)", type: 4, required: false },
    ],
  },
  {
    name: "ack",
    description: "Acknowledge and clear intents up to a sequence number",
    options: [
      { name: "up_to", description: "Highest sequence number to clear", type: 4, required: true },
    ],
  },
  {
    name: "answer",
    description: "Answer an ask turn / question on the Living Board",
    options: [
      { name: "id", description: "Ask turn ID", type: 3, required: true },
      { name: "answer", description: "Answer text", type: 3, required: true },
      { name: "sources", description: "Optional sources (comma-separated or notes)", type: 3, required: false },
      { name: "failed", description: "Failure reason if unanswerable", type: 3, required: false },
    ],
  },
  // Context Menu Commands (Type 3 = MESSAGE)
  { name: "Ask Leeroy", type: 3 },
  { name: "Fix this fact", type: 3 },
];

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export async function verifyDiscordSignature(req, rawBody, publicKeyHex) {
  if (!publicKeyHex) return false;
  const sigHex = req.headers.get("X-Signature-Ed25519") || "";
  const timestamp = req.headers.get("X-Signature-Timestamp") || "";
  if (!sigHex || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519", namedCurve: "Ed25519" },
      false,
      ["verify"]
    );
    const msg = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(sigHex), msg);
  } catch {
    return false;
  }
}

export async function recomputeSignupTallies(signupsDoc) {
  const entries = Array.isArray(signupsDoc.entries) ? signupsDoc.entries : [];
  const meetOpts = (signupsDoc.options && signupsDoc.options.meet) || ["Valley of Strength", "The Crossroads"];
  const tallies = {
    pack: { yes: { count: 0, names: [] }, no: { count: 0, names: [] } },
    meet: {
      ...Object.fromEntries(meetOpts.map((m) => [m, { count: 0, names: [] }])),
      other: { count: 0, names: [], places: [] },
    },
    rsvp: {
      in: { count: 0, names: [] },
      maybe: { count: 0, names: [] },
      late: { count: 0, names: [] },
      out: { count: 0, names: [] },
    },
    when: {
      "6pm": { count: 0, names: [] },
      "8pm": { count: 0, names: [] },
      later: { count: 0, names: [] },
    },
  };

  for (const e of entries) {
    const name = e.name || "Someone";
    if (e.pack && tallies.pack[e.pack]) {
      tallies.pack[e.pack].count++;
      tallies.pack[e.pack].names.push(name);
    }
    if (e.meet) {
      const meetLabel =
        e.meet === "vos" ? "Valley of Strength" : e.meet === "xroads" ? "The Crossroads" : e.meet;
      if (tallies.meet[meetLabel] && meetLabel !== "other") {
        tallies.meet[meetLabel].count++;
        tallies.meet[meetLabel].names.push(name);
      } else {
        tallies.meet.other.count++;
        tallies.meet.other.names.push(name);
        if (e.meet_other || meetLabel !== "other") {
          tallies.meet.other.places.push({ name, place: e.meet_other || meetLabel });
        }
      }
    }
    if (e.rsvp && tallies.rsvp[e.rsvp]) {
      tallies.rsvp[e.rsvp].count++;
      tallies.rsvp[e.rsvp].names.push(name);
    }
    if (e.when && tallies.when[e.when]) {
      tallies.when[e.when].count++;
      tallies.when[e.when].names.push(name);
    }
  }

  signupsDoc.tallies = tallies;
  signupsDoc.updated = new Date().toISOString();
  return signupsDoc;
}

// members comes from the D1 config row 'discord_members' ([{ slug, name, match: [lowercase substrings] }]).
// Returns null when nothing matches or no config is loaded.
export function slugFromDisplayName(byName, members) {
  const low = String(byName || "").toLowerCase();
  for (const m of Array.isArray(members) ? members : []) {
    if (m && Array.isArray(m.match) && m.match.some((t) => t && low.includes(t))) return { slug: m.slug, name: m.name };
  }
  // Unrecognised users are not the owner. Mapping Discord user ids to slugs needs a schema change (follow-up).
  return null;
}

// Short friendly refusal for commands that write to a member's rows when no member is identified.
function unknownMemberResponse() {
  return new Response(
    JSON.stringify({
      type: 4,
      data: {
        content: "I can't tell which party member you are, so I can't change anyone's sheet or sign-ups from here. Ask, page, tooltip, library, help, dates, countdown, tonight and quiz still work for everyone.",
        flags: 64,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function splitDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return { days, hours, minutes, seconds };
}

function humanDuration(ms) {
  const { days, hours, minutes, seconds } = splitDuration(ms);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function launchHype(toLaunch) {
  if (toLaunch <= 0) return "Forever is live. The Dark Portal is open.";
  const days = Math.floor(toLaunch / 86400000);
  if (days === 0) return "Today is the day. Check your bags, fill your waters, get on voice.";
  if (days === 1) return "Tomorrow. One sleep left. Set your alarms.";
  if (days <= 3) return `${days} days. Clear your schedules and ready the group.`;
  return `${days} days. Time to study your talents and prep your route.`;
}

// Every interaction response goes through here: allowed_mentions off and content clamped.
export async function handleDiscordInteraction(req, env, ctx, origin) {
  const res = await handleDiscordInteractionInner(req, env, ctx, origin);
  if (res.status !== 200 || !(res.headers.get("Content-Type") || "").includes("application/json")) return res;
  try {
    const body = JSON.parse(await res.clone().text());
    const hardened = hardenInteractionBody(body);
    if (hardened === body) return res;
    return new Response(JSON.stringify(hardened), { status: res.status, headers: res.headers });
  } catch {
    return res;
  }
}

async function handleDiscordInteractionInner(req, env, ctx, origin) {
  const rawBody = await req.text();
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "DISCORD_PUBLIC_KEY not configured" }), { status: 500 });
  }

  // Reject stale, future-dated or malformed timestamps before any other work.
  const tsHeader = req.headers.get("X-Signature-Timestamp") || "";
  if (!isFreshTimestamp(tsHeader, Math.floor(Date.now() / 1000), DISCORD_MAX_AGE_SECONDS)) {
    return new Response("Stale or invalid request timestamp", { status: 401 });
  }

  const valid = await verifyDiscordSignature(req, rawBody, env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return new Response("Invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // 1. Discord PING (Type 1) -> PONG (Type 1)
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const user = (interaction.member && interaction.member.user) || interaction.user || {};
  const rawUser =
    (interaction.member && interaction.member.nick) ||
    user.global_name ||
    user.username ||
    "Guest";
  const membersConfig = await loadConfigKey(env, "discord_members");
  const member = resolveMember(user.id, rawUser, membersConfig); // null when the user is not a recognised party member
  const byName = member ? member.name : String(rawUser).slice(0, 80);
  const intentSlug = member ? member.slug : "guest"; // attribution only for read-style writes (ask, fix this fact)
  const boardUrl = env.BOARD_PUBLIC_URL || "https://leeroy.party";
  // Existing /build reply: link to the member's build thread.
  const legacyBuildContent = async (t) => {
    const person = ROSTER_DATA.find((r) => r.display.toLowerCase().replace(/ /g, "-") === t.slug) || { display: t.name };
    const mention = buildThreadMention(person, await loadConfigKey(env, "discord_roster"));
    return `**${t.name}'s Build**: ${mention || "(thread link not configured)"}\n-# Class & spec planning for launch night. Check party character sheets at ${boardUrl}/#five`;
  };

  // 4. Autocomplete (Type 4) -> Application Command Autocomplete Result (Type 8)
  if (interaction.type === 4 && interaction.data) {
    const cmd = interaction.data.name;
    const opts = interaction.data.options || [];
    const focused = opts.find((o) => o.focused);
    const query = focused ? String(focused.value).trim().toLowerCase() : "";

    if (cmd === "page") {
      let choices = [];
      try {
        const rows = await env.DB.prepare(
          "SELECT id, title FROM lib_pages WHERE title LIKE ? OR id LIKE ? LIMIT 25"
        )
          .bind(`%${query}%`, `%${query}%`)
          .all();
        choices = (rows.results || []).map((r) => ({
          name: (r.title || r.id).slice(0, 100),
          value: r.id.slice(0, 100),
        }));
      } catch {}
      return new Response(
        JSON.stringify({ type: 8, data: { choices } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (cmd === "tooltip") {
      let choices = [];
      try {
        const rows = await env.DB.prepare(
          "SELECT id, title FROM lib_pages WHERE title LIKE ? OR page_json LIKE ? LIMIT 25"
        )
          .bind(`%${query}%`, `%${query}%`)
          .all();
        choices = (rows.results || []).map((r) => ({
          name: (r.title || r.id).slice(0, 100),
          value: (r.title || r.id).slice(0, 100),
        }));
      } catch {}
      return new Response(
        JSON.stringify({ type: 8, data: { choices } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (cmd === "map") {
      const places = [
        { name: "Orgrimmar (Horde Capital)", value: "orgrimmar" },
        { name: "The Crossroads (Northern Barrens)", value: "crossroads" },
        { name: "Valley of Strength (Durotar)", value: "valley-of-strength" },
        { name: "Tirisfal Glades (Undead Start)", value: "tirisfal-glades" },
        { name: "Mulgore (Tauren Start)", value: "mulgore" },
        { name: "Durotar (Orc & Troll Start)", value: "durotar" },
        { name: "Brill (Tirisfal Glades)", value: "brill" },
        { name: "Bloodhoof Village (Mulgore)", value: "bloodhoof-village" },
        { name: "Razor Hill (Durotar)", value: "razor-hill" },
      ].filter((p) => p.name.toLowerCase().includes(query) || p.value.includes(query));

      return new Response(
        JSON.stringify({ type: 8, data: { choices: places.slice(0, 25) } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ type: 8, data: { choices: [] } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Slash Commands (Type 2, Command Type 1)
  if (interaction.type === 2 && interaction.data && (!interaction.data.type || interaction.data.type === 1)) {
    const cmd = interaction.data.name;
    const opts = interaction.data.options || [];
    const getOpt = (n) => {
      const o = opts.find((x) => x.name === n);
      return o ? String(o.value).trim() : "";
    };

    // Target of /build and /sheet: the optional USER option (type 6), else the invoker. Id match first, then display name.
    const memberOpt = opts.find((x) => x.name === "member" && x.type === 6);
    let target = member;
    let targetIsOther = false;
    if (memberOpt) {
      const tid = String(memberOpt.value);
      const resolved = interaction.data.resolved || {};
      const tu = (resolved.users && resolved.users[tid]) || {};
      const tm = (resolved.members && resolved.members[tid]) || {};
      target = resolveMember(tid, tm.nick || tu.global_name || tu.username || "", membersConfig);
      targetIsOther = tid !== String(user.id || "");
    }
    const notOnRoster = async () => {
      const line = pickLine(await loadPersona(env), "emptyLines", String(user.id || rawUser), "Not on the roster yet.");
      const who = targetIsOther ? "That person is not on the roster yet. An admin can add them." : "You are not on the roster yet. An admin can add you.";
      return new Response(
        JSON.stringify({ type: 4, data: { content: `${line} ${who}`, flags: 64 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    // 2a-vote. `/vote start`
    if (cmd === "vote") {
      const sub = opts.find((o) => o.type === 1 && o.name === "start");
      const subOpts = (sub && sub.options) || [];
      const subOpt = (n) => {
        const o = subOpts.find((x) => x.name === n);
        return o ? String(o.value).trim() : "";
      };
      const ephemeral = (content) =>
        new Response(JSON.stringify({ type: 4, data: { content, flags: 64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (!sub) return ephemeral("Use `/vote start` with a title and 2 to 5 choices separated by |.");
      if (!member) return ephemeral("I can't tell which party member you are, so only the party can start a vote. You can still press the buttons on one.");
      const nowMs = Date.now();
      const made = createVote({ id: newVoteId(), title: subOpt("title"), choices: subOpt("options"), hours: subOpt("closes_in_hours") || undefined, now: nowMs });
      if (!made.ok) return ephemeral(made.error);
      await saveVote(env.DB, made.vote, nowMs);
      await recordInIndex(env.DB, made.vote.id, nowMs);
      return new Response(JSON.stringify({ type: 4, data: renderMessage(made.vote, nowMs) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 2-start. `/start`: ephemeral, works for everyone (identified or not)
    if (cmd === "start") {
      return new Response(JSON.stringify({ type: 4, data: buildStartReply(`${boardUrl.replace(/\/+$/, "")}/`) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2a. `/ask`
    if (cmd === "ask") {
      const question = getOpt("question") || getOpt("q") || String((opts[0] && opts[0].value) || "").trim();
      const provider = resolveAiProvider(env, getOpt("model") || getOpt("provider"));
      const isPrivate = Boolean(getOpt("private"));
      const intentId = String(Date.now());
      const now = new Date().toISOString();

      await env.DB.prepare(
        "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, ?, 'thinking', ?, ?)"
      )
        .bind(intentId, byName, question, provider, isPrivate ? 0 : 1, now)
        .run();

      await insertIntent(env, {
        slug: intentSlug,
        kind: "ask",
        body: { id: intentId, question, by: byName, provider, private: isPrivate },
        ver: 1,
        at: now,
      });

      const persona = await loadPersona(env);
      ctx.waitUntil(
        (async () => {
          await answerWithAi({ env, origin, intentId, by: byName, question, provider, share: !isPrivate });
          const row = await env.DB.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").bind(intentId).first();
          const text = row && row.status === "error" && persona ? pickLine(persona, "errorLines", intentId) : row && row.answer;
          if (interaction.application_id && interaction.token && text) {
            await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: clampContent(text), allowed_mentions: ALLOWED_MENTIONS_NONE }),
              }
            ).catch(() => {});
          }
        })()
      );

      // With a persona pack: Type 4 with a thinking line, edited into the answer later. Otherwise Type 5 (Deferred Response)
      if (persona) {
        return new Response(
          JSON.stringify({ type: 4, data: { content: pickLine(persona, "ackLines", intentId), ...(isPrivate ? { flags: 64 } : {}) } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ type: 5, data: isPrivate ? { flags: 64 } : {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2b. `/tonight`
    if (cmd === "tonight") {
      const [signupsRow, partyRow] = await Promise.all([
        env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first(),
        env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first(),
      ]);
      const signups = signupsRow ? JSON.parse(signupsRow.json) : { entries: [] };
      const party = partyRow ? JSON.parse(partyRow.json) : { members: [] };
      const inList = (signups.entries || []).filter((e) => e.rsvp === "in").map((e) => e.name);
      const myEntry = (signups.entries || []).find(
        (e) => (e.name || "").toLowerCase() === byName.toLowerCase()
      );
      const nextStep = !myEntry || !myEntry.rsvp
        ? "Say whether you are **in** for launch night (`/signup rsvp:in`)."
        : !myEntry.meet
        ? "Pick where the party meets (`/signup meet:Valley of Strength` or `The Crossroads`)."
        : "Your launch-night answers are in — check your character sheet with `/sheet`.";

      const lines = [
        `**Launch Night: Wed Nov 4, 6:00 PM ET** (<t:1793833200:F>)`,
        `• **Party (${(party.members || []).length}):** ${(party.members || []).map((m) => `${m.name} (${m.race} ${m.class})`).join(" · ")}`,
        `• **RSVP In (${inList.length}):** ${inList.length ? inList.join(", ") : "None yet"}`,
        `• **Next for ${byName}:** ${nextStep}`,
        `• **Board:** ${boardUrl}/#tonight`,
      ];
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: lines.join("\n"),
            flags: 64,
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 5, label: "Open Tonight on Board", url: `${boardUrl}/#tonight` },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2c. `/sheet`
    if (cmd === "sheet") {
      if (!target) return notOnRoster();
      const field = getOpt("field");
      const value = getOpt("value");
      if (field && value && targetIsOther) {
        return new Response(
          JSON.stringify({ type: 4, data: { content: "You can only change your own sheet. Leave out the member to update yours.", flags: 64 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (field && value) {
        const now = new Date().toISOString();
        await recordSheetEventInD1(env, origin, {
          slug: target.slug,
          name: target.name,
          field,
          value,
          visible: true,
          source: "discord",
          at: now,
        });
        await insertIntent(env, {
          slug: target.slug,
          kind: "sheet",
          body: { field, value, source: "discord" },
          ver: 1,
          at: now,
        });
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `Updated **${target.name}**'s sheet (**${field}** → \`${value}\`). View on the board: ${boardUrl}/#five`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const { party } = await buildPartySheetsFromD1(env);
      const mine = party.find((p) => p.slug === target.slug);
      const fieldSummary = mine && mine.fields
        ? Object.entries(mine.fields)
            .map(([k, v]) => `• **${k}:** ${Array.isArray(v.value) ? v.value.join(", ") : v.value}`)
            .join("\n")
        : "No custom sheet fields recorded yet.";
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `**${target.name}'s Party Sheet**\n${fieldSummary}\nOpen your sheet: ${boardUrl}/#five`,
            flags: 64,
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 5, label: "Open Party Sheet", url: `${boardUrl}/#five` },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2d. `/launch`
    if (cmd === "launch") {
      if (!member) return unknownMemberResponse();
      const state = getOpt("state");
      const now = new Date().toISOString();
      const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'launch'").first();
      let rows = [];
      if (row) {
        try {
          const parsed = JSON.parse(row.json);
          rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
        } catch {}
      }
      if (state && ["queue", "in", "done"].includes(state)) {
        const idx = rows.findIndex((r) => r.slug === member.slug);
        const entry = { slug: member.slug, name: byName, state, at: now };
        if (idx >= 0) rows[idx] = entry;
        else rows.push(entry);
        await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('launch', ?, ?)")
          .bind(JSON.stringify(rows), now)
          .run();
        await recordSheetEventInD1(env, origin, {
          slug: member.slug,
          name: byName,
          field: "launch_state",
          value: state,
          visible: true,
          source: "discord",
          at: now,
        });
        await insertIntent(env, {
          slug: member.slug,
          kind: "launch",
          body: { state },
          ver: 1,
          at: now,
        });
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/launch.json"]);
        await broadcastToRoom(env, { type: "data", key: "launch", data: rows });
      }
      const summary = rows.length
        ? rows.map((r) => `• **${r.name}:** \`${r.state}\``).join("\n")
        : "No launch states set yet.";
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `**Launch Night Status**\n${summary}`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2e. `/map`
    if (cmd === "map") {
      const place = getOpt("place").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const plan = getOpt("plan").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const hash = plan ? `#atlas.plan.${plan}` : place ? `#atlas.${place}` : "#atlas";
      const label = plan ? `Meeting Route Plan (${plan})` : place ? `Atlas Place (${place})` : "Azeroth Atlas";
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `**${label} on the Living Board:** ${boardUrl}/${hash}`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: `${label} on the Atlas`,
                    url: `${boardUrl}/${hash}`,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2f. `/signup`
    if (cmd === "signup") {
      if (!member) return unknownMemberResponse();
      const pack = getOpt("pack");
      const meet = getOpt("meet");
      const place = getOpt("place");
      const rsvp = getOpt("rsvp");
      const when = getOpt("when");
      const quickField = getOpt("field");
      const quickVal = getOpt("value");

      const patch = {};
      if (pack) patch.pack = pack;
      if (meet) patch.meet = meet;
      if (place) patch.meet = place;
      if (rsvp) patch.rsvp = rsvp;
      if (when) patch.when = when;
      if (quickField && quickVal) {
        patch[quickField] = quickVal === "vos" ? "Valley of Strength" : quickVal === "xroads" ? "The Crossroads" : quickVal;
      }

      if (Object.keys(patch).length > 0) {
        const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
        const doc = row ? JSON.parse(row.json) : { entries: [] };
        doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
        let entry = doc.entries.find((e) => (e.name || "").toLowerCase() === byName.toLowerCase());
        if (!entry) {
          entry = { slug: member.slug, name: byName };
          doc.entries.push(entry);
        }
        for (const [k, v] of Object.entries(patch)) {
          entry[k] = v;
        }
        entry.updated = new Date().toISOString();
        await recomputeSignupTallies(doc);

        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
          .bind(JSON.stringify(doc), entry.updated)
          .run();

        await insertIntent(env, {
          slug: member.slug,
          kind: "signup",
          body: { patch, entry },
          ver: 1,
          at: entry.updated,
        });

        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/signups.json", "/api/signups"]);
        await broadcastToRoom(env, { type: "data", key: "signups", data: doc });

        const summary = Object.entries(patch).map(([k, v]) => `**${k}**: \`${v}\``).join(", ");
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `Recorded sign-up update for **${byName}**: ${summary}. View on the board: ${boardUrl}/#signups`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // No options provided: show current sign-up status with interactive buttons
      const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
      const doc = row ? JSON.parse(row.json) : { entries: [] };
      const myEntry = (doc.entries || []).find((e) => (e.name || "").toLowerCase() === byName.toLowerCase()) || {};

      const statusText = [
        `**${byName}'s Sign-up Status:**`,
        `• **RSVP:** \`${myEntry.rsvp || "not answered"}\``,
        `• **Meeting Point:** \`${myEntry.meet || "not answered"}\``,
        `• **Pre-order Pack:** \`${myEntry.pack || "not answered"}\``,
        `• **Arrival Time:** \`${myEntry.when || "not answered"}\``,
      ].join("\n");

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: statusText,
            flags: 64,
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 3, label: "I'm In!", custom_id: "signup:rsvp:in" },
                  { type: 2, style: 2, label: "Maybe", custom_id: "signup:rsvp:maybe" },
                  { type: 2, style: 4, label: "Can't Make It", custom_id: "signup:rsvp:out" },
                  { type: 5, style: 5, label: "Open Sign-ups", url: `${boardUrl}/#signups` },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2g. `/countdown`
    if (cmd === "countdown") {
      const now = Date.now();
      const toLaunch = LAUNCH_UTC - now;
      const toStress = STRESS_UTC - now;
      const launchSec = Math.floor(LAUNCH_UTC / 1000);
      const stressSec = Math.floor(STRESS_UTC / 1000);

      const fields = [];
      if (toStress > 0) {
        fields.push({
          name: "Free Server Stress Test",
          value: `<t:${stressSec}:F> (<t:${stressSec}:R>)\n**${humanDuration(toStress)}** to go. Battle.net > WoW > Game Version "World of Warcraft: Forever Stress Test".`,
        });
      } else {
        fields.push({
          name: "Character Name Reservation",
          value: "Names open for pack buyers: up to three characters per account until Nov 3.",
        });
      }

      fields.push({
        name: toLaunch > 0 ? "LAUNCH" : "LAUNCHED",
        value: toLaunch > 0
          ? `<t:${launchSec}:F> (<t:${launchSec}:R>)\n**${humanDuration(toLaunch)}** until the gates open worldwide.`
          : `<t:${launchSec}:F>. Forever has been live for ${humanDuration(-toLaunch)}.`,
      });

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            embeds: [
              {
                color: GOLD,
                title: toLaunch > 0 ? "World of Warcraft: Forever Launch Countdown" : "World of Warcraft: Forever is LIVE",
                description: launchHype(toLaunch),
                fields,
                footer: { text: "No early access for anyone. At least he has chicken." },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2h. `/dates`
    if (cmd === "dates") {
      const lines = DATES_DATA.events.map((e) => {
        const when = e.at
          ? `<t:${Math.floor(Date.parse(e.at) / 1000)}:f> (<t:${Math.floor(Date.parse(e.at) / 1000)}:R>)`
          : e.day;
        const sure = /confirmed|Blizzard date|calendar/.test(e.status) ? "" : " *(likely)*";
        return `• **${e.name}:** ${when}${sure}${e.note ? `\n  -# ${e.note}` : ""}`;
      });

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            embeds: [
              {
                color: GOLD,
                title: "Every WoW: Forever Date We Know",
                description: lines.join("\n").slice(0, 4000),
                footer: { text: "Blizzard's verified dates. Times render in your local time zone." },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2i. `/library`
    if (cmd === "library") {
      const roster = await loadConfigKey(env, "discord_roster");
      const posted = LIBRARY_DATA.posted.map((p) => libraryShelfLine(p, roster)).join("\n");
      const coming = LIBRARY_DATA.coming.map((c) => `• ${c}`).join("\n");

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            embeds: [
              {
                color: GOLD,
                title: "The WoW: Forever Library Shelves",
                description: `**On the Shelves (${LIBRARY_DATA.posted.length}):**\n${posted}\n\n**Coming Soon (${LIBRARY_DATA.coming.length}):**\n${coming}\n\nOpen full library on the Living Board: ${boardUrl}/#library`,
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2j. `/quiz`
    if (cmd === "quiz") {
      const reveal = getOpt("reveal") || "spoiler";
      const qList = QUIZ_DATA.questions || [];
      const q = qList[Math.floor(Math.random() * qList.length)] || qList[0];
      const head = `**${q.round}** #${q.n}`;
      const content = reveal === "reaction"
        ? `${head}\n${q.q}\n-# React with 👀 to reveal the answer. Full quiz on the Living Board.`
        : `${head}\n${q.q}\n||${q.a}||\n-# Tap the spoiler bar to reveal. No prizes, only bragging rights.`;

      return new Response(
        JSON.stringify({ type: 4, data: { content } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2k. `/didyouknow`
    if (cmd === "didyouknow") {
      const facts = FACTS_DATA.facts || [];
      const f = facts[Math.floor(Math.random() * facts.length)] || facts[0];
      const content = `**Did you know?** ${f.text}\n-# ${f.tag} (${f.thread} thread, as of ${FACTS_DATA.asOf || "verified"})`;

      return new Response(
        JSON.stringify({ type: 4, data: { content } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2l. `/build`
    if (cmd === "build") {
      // Modal path (env BUILD_MODAL, default off): the invoker's own build only.
      if (buildModalEnabled(env) && !targetIsOther && isSnowflake(user.id)) {
        return new Response(JSON.stringify(buildModalResponse()), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (!target) return notOnRoster();
      const content = await legacyBuildContent(target);
      return new Response(
        JSON.stringify({ type: 4, data: { content, flags: 64 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2m. `/leeroy`
    if (cmd === "leeroy") {
      const channelId = interaction.channel_id || "default";
      const now = Date.now();
      const last = leeroyCooldownMap.get(channelId) || 0;
      const cooldownSec = 300;
      const leftMs = last + cooldownSec * 1000 - now;

      if (leftMs > 0) {
        const s = Math.ceil(leftMs / 1000);
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `Leeroy is still running back from the graveyard. ${s}s left. At least he has chicken.`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      leeroyCooldownMap.set(channelId, now);
      const yell = "**ALRIGHT CHUMS, LET'S DO THIS.**\n\n# LEEEEEEEEEEEEEROOOOOOOOOOOOY\n# JEEEEEEEEEEEENKINS!\n\n-# ...at least I have chicken.";
      return new Response(
        JSON.stringify({ type: 4, data: { content: yell } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2n. `/help`
    if (cmd === "help") {
      const help = [
        helpIntro(await loadPersona(env), "**Leeroy Jenkins, party assistant.** Ask anything about WoW: Forever."),
        `**The Living Board:** [open it](<${boardUrl}>) in any browser, nothing to install.`,
        "**Ask:** `/ask <question>` plus your question, or set `private: True` to keep the answer to yourself.",
        "**Ask about a message:** computer, right-click it; phone, press and hold it. Then Apps -> **Ask Leeroy** (or **Fix this fact**).",
        "**Quick:** `/tonight` your launch night, `/countdown` the clock, `/dates` every date, `/signup` sign up, `/page` a library page, `/tooltip` a spell, `/map` the Atlas, `/library` the shelves.",
        "**Fun:** `/quiz` Pop Quiz, `/didyouknow` random facts, `/build` party builds, `/leeroy` the yell.",
        "**Votes:** `/vote start` with a title and 2 to 5 choices separated by |; everyone presses buttons to vote.",
        "**Worker Mailbox:** `/intents` view pending mailbox changes, `/ack` clear intents, `/answer` answer an ask turn.",
        "-# Leeroy never pings anyone. At least he has chicken.",
      ].join("\n");

      return new Response(
        JSON.stringify({ type: 4, data: { content: help, flags: 64 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2o. `/page`
    if (cmd === "page") {
      const title = getOpt("title");
      const row = await env.DB.prepare(
        "SELECT id, category, title, page_json FROM lib_pages WHERE id = ? OR title LIKE ? LIMIT 1"
      )
        .bind(title, `%${title}%`)
        .first();

      if (!row) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `${pickLine(await loadPersona(env), "emptyLines", title, `No library page found for "${title}".`)} Check \`/library\` for all available shelves.`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      let facts = [];
      try {
        const parsed = JSON.parse(row.page_json || "{}");
        facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 5) : [];
      } catch {}

      const factLines = facts.map((f) => `• **${f.key}:** ${f.value}`).join("\n");
      const pageUrl = `${boardUrl}/#lib.${row.id}`;

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            embeds: [
              {
                color: GOLD,
                title: row.title,
                description: `**Category:** \`${row.category}\`\n\n${factLines || "Open page to view all verified facts."}`,
                url: pageUrl,
                footer: { text: "WoW: Forever Verified Library" },
              },
            ],
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 5, label: "Open Page on Living Board", url: pageUrl },
                ],
              },
            ],
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2p. `/tooltip`
    if (cmd === "tooltip") {
      const name = getOpt("name");
      const row = await env.DB.prepare(
        "SELECT id, category, title, page_json FROM lib_pages WHERE title LIKE ? OR page_json LIKE ? LIMIT 1"
      )
        .bind(`%${name}%`, `%${name}%`)
        .first();

      if (!row) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `No tooltip found for "${name}". Check \`/page\` or ask with \`/ask\`.`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            embeds: [
              {
                color: GOLD,
                title: `Tooltip: ${name}`,
                description: `Verified in **${row.title}** (\`${row.category}\`).\nView the full tooltip and item stats on the Living Board.`,
                url: `${boardUrl}/#lib.${row.id}`,
              },
            ],
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2q. `/journey`
    if (cmd === "journey") {
      if (!member) return unknownMemberResponse();
      const choice = getOpt("choice") || "curious";
      const effects = {
        guided: "Leeroy answers in two or three plain sentences and gives you one next step.",
        curious: "Leeroy gives the answer, one thing worth a look next, and a link to the right spot on the board.",
        everything: "Leeroy gives the full answer: every number, where it came from, and where sources disagree.",
      };

      const now = new Date().toISOString();
      await insertIntent(env, {
        slug: member.slug,
        kind: "journey",
        body: { journey: choice },
        ver: 1,
        at: now,
      });

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `You're on **${choice.toUpperCase()}**. ${effects[choice] || ""}\n-# Switch any time with \`/journey\`.`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2r. `/intents`
    if (cmd === "intents") {
      if (!member) return unknownMemberResponse();
      const after = parseInt(getOpt("after") || "0", 10) || 0;
      const limit = Math.min(parseInt(getOpt("limit") || "10", 10) || 10, 50);

      const [rows, countRow] = await Promise.all([
        env.DB.prepare(
          "SELECT seq, at, slug, kind, body, ver FROM intents WHERE seq > ? ORDER BY seq ASC LIMIT ?"
        )
          .bind(after, limit)
          .all(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM intents").first(),
      ]);

      const intents = rows.results || [];
      if (!intents.length) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `📬 **Intents Mailbox:** No pending intents (total pending: ${countRow ? countRow.count : 0}).`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const list = intents
        .map((i) => {
          const bodyPreview = (i.body || "").slice(0, 60);
          return `• **#${i.seq}** [\`${i.kind}\`] by **${i.slug}** at <t:${Math.floor(Date.parse(i.at) / 1000)}:R>: \`${bodyPreview}\``;
        })
        .join("\n");

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `📬 **Intents Mailbox** (${intents.length} shown, ${countRow ? countRow.count : 0} total pending):\n${list}`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2s. `/ack`
    if (cmd === "ack") {
      if (!member) return unknownMemberResponse();
      const upTo = parseInt(getOpt("up_to") || getOpt("upTo") || "0", 10);
      if (!upTo || upTo <= 0) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: { content: "Please supply a valid `up_to` sequence number.", flags: 64 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const res = await env.DB.prepare("DELETE FROM intents WHERE seq <= ?").bind(upTo).run();
      const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM intents").first();
      const deleted = (res.meta && res.meta.changes) || 0;

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `✅ Acknowledged and cleared intents up to seq **${upTo}**. Deleted **${deleted}** intent(s) (${countRow ? countRow.count : 0} still pending).`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2t. `/answer`
    if (cmd === "answer") {
      if (!member) return unknownMemberResponse();
      const id = getOpt("id");
      const answer = getOpt("answer");
      const sources = getOpt("sources");
      const failed = getOpt("failed");
      const now = new Date().toISOString();
      const status = failed ? "failed" : "done";

      if (!id || !answer) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: { content: "Both `id` and `answer` are required.", flags: 64 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      await env.DB.prepare(
        "UPDATE ask_turns SET answer = ?, sources = ?, status = ?, answered_at = ? WHERE id = ?"
      )
        .bind(answer, sources ? JSON.stringify([sources]) : null, status, now, id)
        .run();

      const askItem = {
        id,
        status,
        answer,
        sources: sources ? [sources] : [],
        answered_at: now,
        failed: failed || null,
      };
      await broadcastToRoom(env, { type: "ask", ask: askItem });
      await purgeWorkerCache(origin, ["/api/bootstrap", `/api/ask?id=${id}`]);

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `✅ Answer recorded for question **#${id}** and broadcast to the Living Board.`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // 3. Message Context Menu Commands (Type 2, Command Type 3)
  if (interaction.type === 2 && interaction.data && interaction.data.type === 3) {
    const cmdName = interaction.data.name;
    const targetId = interaction.data.target_id;
    const messages = (interaction.data.resolved && interaction.data.resolved.messages) || {};
    const targetMsg = messages[targetId] || {};
    const text = String(targetMsg.content || "").trim();
    const now = new Date().toISOString();

    if (cmdName === "Ask Leeroy") {
      if (!text) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: { content: "That message has no text for Leeroy to read.", flags: 64 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const intentId = String(Date.now());
      const provider = resolveAiProvider(env);
      await env.DB.prepare(
        "INSERT INTO ask_turns (id, by_name, question, model, status, share, created_at) VALUES (?, ?, ?, ?, 'thinking', 1, ?)"
      )
        .bind(intentId, byName, text, provider, now)
        .run();

      await insertIntent(env, {
        slug: intentSlug,
        kind: "ask",
        body: { id: intentId, question: text, by: byName, provider, messageId: targetId },
        ver: 1,
        at: now,
      });

      const persona = await loadPersona(env);
      ctx.waitUntil(
        (async () => {
          await answerWithAi({ env, origin, intentId, by: byName, question: text, provider, share: true });
          const row = await env.DB.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").bind(intentId).first();
          if (row && row.status === "error" && persona) row.answer = pickLine(persona, "errorLines", intentId);
          if (interaction.application_id && interaction.token && row && row.answer) {
            await fetch(
              `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: clampContent(`> **${byName} asked Leeroy about message:**\n> ${text.slice(0, 200)}\n\n${row.answer}`),
                  allowed_mentions: ALLOWED_MENTIONS_NONE,
                }),
              }
            ).catch(() => {});
          }
        })()
      );

      return new Response(
        JSON.stringify(persona ? { type: 4, data: { content: pickLine(persona, "ackLines", intentId) } } : { type: 5, data: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (cmdName === "Fix this fact") {
      const fixId = String(Date.now());
      await env.DB.prepare(
        "INSERT INTO fact_fixes (id, page_id, fact_key, old_value, new_value, note, by_name, created_at) VALUES (?, 'discord-context', ?, ?, 'pending', ?, ?, ?)"
      )
        .bind(fixId, targetId, text.slice(0, 200), `Reported via Discord context menu on message ${targetId}`, byName, now)
        .run();

      await insertIntent(env, {
        slug: intentSlug,
        kind: "fix",
        body: { messageId: targetId, excerpt: text.slice(0, 200), reporter: byName },
        ver: 1,
        at: now,
      });

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `Thanks, **${byName}**. Filed for checking against the verified sources; nothing in the library changes until a source backs it.`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // 3-modal. `/build` modal submit (Type 5): defer, save, then edit the deferred reply.
  if (buildModalEnabled(env) && interaction.type === 5 && interaction.data && interaction.data.custom_id === BUILD_MODAL_ID) {
    const parsed = parseBuildSubmit(interaction.data.components);
    const edit = (body) =>
      interaction.application_id && interaction.token
        ? fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, content: clampContent(body.content), allowed_mentions: ALLOWED_MENTIONS_NONE }),
          }).catch(() => {})
        : Promise.resolve();
    ctx.waitUntil(
      (async () => {
        if (!parsed.ok) return edit({ content: parsed.error });
        const saved = await saveConfirmedBuild(env, { discordUserId: user.id, displayName: rawUser, guildId: interaction.guild_id, build: parsed.build });
        if (saved.saved) {
          return edit({
            content: "Saved. Open your sheet",
            components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open your sheet", url: `${boardUrl}/#five` }] }],
          });
        }
        return edit({ content: member ? await legacyBuildContent(member) : "Not saved: I can't tell which party member you are." });
      })()
    );
    return new Response(JSON.stringify({ type: 5, data: { flags: 64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 3a. Vote buttons (`vote:<id>:<index>` and `vote:<id>:results`). Handled before the generic sign-up buttons below.
  if (interaction.type === 3 && interaction.data && String(interaction.data.custom_id || "").startsWith("vote:")) {
    const ephemeral = (content) =>
      new Response(JSON.stringify({ type: 4, data: { content, flags: 64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const parsed = parseVoteCustomId(interaction.data.custom_id);
    if (!parsed) return ephemeral("That vote button is not valid.");
    const vote = await loadVote(env.DB, parsed.id);
    if (!vote) return ephemeral("That vote no longer exists.");
    const nowMs = Date.now();
    if (parsed.action === "results") return ephemeral(`**${vote.title}**\n${tallyLines(vote).join("\n")}`);
    if (!isOpen(vote, nowMs)) return ephemeral("That vote is closed. No new votes are counted.");
    const discordId = String(user.id || "");
    if (!discordId) return ephemeral("I can't tell who you are, so I can't count that vote.");
    if (saltProblems(env, ["USER_SALT"]).length) return ephemeral("Voting is unavailable: the Worker is missing its USER_SALT secret.");
    const result = castVote(vote, await voterHash(discordId, vote.id, env.USER_SALT), parsed.index, nowMs);
    if (!result.ok) return ephemeral(result.error === "closed" ? "That vote is closed. No new votes are counted." : "That choice does not exist.");
    await saveVote(env.DB, result.vote, nowMs);
    const picked = result.vote.choices[parsed.index];
    const note = result.changed ? `Changed your vote to **${picked}**.` : `Counted your vote for **${picked}**.`;
    if (interaction.application_id && interaction.token) {
      ctx.waitUntil(
        fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: clampContent(note), flags: 64, allowed_mentions: ALLOWED_MENTIONS_NONE }),
        }).catch(() => {})
      );
    }
    return new Response(JSON.stringify({ type: 7, data: renderMessage(result.vote, nowMs) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 3b. Message Component Buttons (Type 3): Sign-ups & Party card buttons (`signup:<field>:<value>`)
  if (interaction.type === 3 && interaction.data && interaction.data.custom_id) {
    const customId = String(interaction.data.custom_id);
    const [, field, val] = customId.split(":");
    if (field && val) {
      if (!member) return unknownMemberResponse();
      const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
      if (row) {
        const doc = JSON.parse(row.json);
        doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
        let entry = doc.entries.find((e) => (e.name || "").toLowerCase() === byName.toLowerCase());
        if (!entry) {
          entry = { slug: member.slug, name: byName };
          doc.entries.push(entry);
        }
        entry[field] = val === "vos" ? "Valley of Strength" : val === "xroads" ? "The Crossroads" : val;
        entry.updated = new Date().toISOString();
        await recomputeSignupTallies(doc);

        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
          .bind(JSON.stringify(doc), entry.updated)
          .run();

        await insertIntent(env, {
          slug: member.slug,
          kind: "signup",
          body: { patch: { [field]: entry[field] }, entry },
          ver: 1,
          at: entry.updated,
        });

        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/signups.json", "/api/signups"]);
        await broadcastToRoom(env, { type: "data", key: "signups", data: doc });
      }
      return new Response(
        JSON.stringify({
          type: 4,
          data: { content: `Recorded **${field}: ${val}** for **${byName}** on the Living Board.`, flags: 64 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(
    JSON.stringify({ type: 4, data: { content: "Command received by Leeroy.", flags: 64 } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
