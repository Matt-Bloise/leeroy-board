// /join: the same modal as /build, offered to anyone who is not on the board yet. Listed in the manifest only while BUILD_MODAL is on
// (like /setup), so with the flags off the served command list is unchanged. The first-contact hint is behind JOIN_PROMPT (default off).
import { isSnowflake } from "./build-modal.js";

export const JOIN_COMMAND_NAME = "join";
export const JOIN_BUTTON_ID = "join:open";
export const JOIN_COMMAND_DEFINITION = {
  name: JOIN_COMMAND_NAME,
  description: "Join the board: pick your class, race and role (only you see the form)",
};

const on = (v) => ["1", "true", "on", "yes"].includes(String(v || "").trim().toLowerCase());
export const joinPromptEnabled = (env) => on(env && env.JOIN_PROMPT);

export const joinHintBody = () => ({
  content: "You are not on the board yet. It takes a minute: pick a game handle, your class, race and role.",
  flags: 64,
  components: [{ type: 1, components: [{ type: 2, style: 1, label: "Join the board", custom_id: JOIN_BUTTON_ID }] }],
});

// One hint per person per isolate: no table, no write. A fresh isolate may show it once more, which is harmless.
const hinted = new Set();
export function shouldHint(env, { cmd, member, userId }) {
  if (!joinPromptEnabled(env) || member || !isSnowflake(userId)) return false;
  if (cmd !== "ask" && cmd !== "sheet") return false;
  if (hinted.has(String(userId))) return false;
  hinted.add(String(userId));
  if (hinted.size > 500) hinted.clear();
  return true;
}
export function resetJoinHints() {
  hinted.clear();
}
