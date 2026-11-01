// test-endpoints-parity.mjs: verify Discord commands manifest and handlers parity
import assert from "node:assert/strict";
import {
  DISCORD_SLASH_COMMANDS_MANIFEST,
  GOLD,
  LAUNCH_UTC,
  STRESS_UTC,
} from "../worker/discord.js";
import {
  DATES_DATA,
  FACTS_DATA,
  LIBRARY_DATA,
  QUIZ_DATA,
  ROSTER_DATA,
} from "../worker/bot-data.js";

console.log("=== Testing Discord Slash Commands Manifest ===");
const expectedCommands = [
  "ask",
  "tonight",
  "sheet",
  "launch",
  "map",
  "signup",
  "countdown",
  "dates",
  "library",
  "quiz",
  "didyouknow",
  "build",
  "leeroy",
  "help",
  "page",
  "tooltip",
  "journey",
  "intents",
  "ack",
  "answer",
];

const slashCmdNames = DISCORD_SLASH_COMMANDS_MANIFEST.filter((c) => !c.type || c.type === 1).map((c) => c.name);
const messageCmdNames = DISCORD_SLASH_COMMANDS_MANIFEST.filter((c) => c.type === 3).map((c) => c.name);

for (const cmd of expectedCommands) {
  assert(slashCmdNames.includes(cmd), `Missing slash command: ${cmd}`);
}
console.log(`✓ All ${expectedCommands.length} expected slash commands present in manifest.`);

assert(messageCmdNames.includes("Ask Leeroy"), "Missing context command: Ask Leeroy");
assert(messageCmdNames.includes("Fix this fact"), "Missing context command: Fix this fact");
console.log(`✓ Both Discord message context commands ("Ask Leeroy", "Fix this fact") present.`);

console.log("=== Testing Bot Reference Data Integrity ===");
assert(DATES_DATA.events.length >= 10, "DATES_DATA has at least 10 verified events");
assert(FACTS_DATA.facts.length >= 30, "FACTS_DATA has at least 30 facts");
assert(LIBRARY_DATA.posted.length >= 7, "LIBRARY_DATA has at least 7 posted shelves");
assert(QUIZ_DATA.questions.length >= 30, "QUIZ_DATA has at least 30 questions");
assert(ROSTER_DATA.length === 5, "ROSTER_DATA has all 5 party members");
console.log("✓ Bot data integrity verified.");

console.log("=== All Discord & Bot Parity Assertions Passed! ===");
