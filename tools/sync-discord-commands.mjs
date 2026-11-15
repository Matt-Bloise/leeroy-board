#!/usr/bin/env node
// Idempotent Discord slash command sync. Makes Discord's global commands match the Worker's public manifest, one command at a time.
//
//   node tools/sync-discord-commands.mjs            dry run (default): reads both sides, writes nothing, prints what it would do
//   node tools/sync-discord-commands.mjs --apply    POSTs only the commands that are missing or different
//
// Inputs, from the environment only:
//   DISCORD_BOT_TOKEN  required to read or write Discord. Absent: a warning and exit 0, no network call at all.
//   DISCORD_APP_ID     default is the public application id the Worker and the site already use (infrastructure/worker/account.js DISCORD_APP_ID, vendor/discord-auth.js CLIENT_ID).
//   WORKER_URL         default https://api.leeroy.party; the manifest is GET <WORKER_URL>/api/discord/commands.
//
// Safety: the only write is POST /applications/<id>/commands with ONE command body, which creates or overwrites that command by name and never touches the others. There is no
// bulk PUT (it would delete every command that is not in the manifest, for example an Activity entry point) and no DELETE anywhere in this file; the unit test asserts every
// request method. Output is command NAMES and counts only: never ids, bodies or the token (the token is also scrubbed from any error text).
// Exit codes: 0 on success and on any Discord or network trouble (a deploy must not fail over this; a ::warning:: line is printed), 1 for a malformed manifest or an unknown flag.
import { pathToFileURL } from "node:url";

export const DEFAULT_APP_ID = "1561857940174938114";
export const DEFAULT_WORKER_URL = "https://api.leeroy.party";
const DISCORD_API = "https://discord.com/api/v10";
const MAX_RETRY_WAIT_MS = 30000;

// ---- comparison ------------------------------------------------------------------------------------------------------------------------
// Reduce a command (ours or Discord's copy) to the fields Discord stores, with the defaults Discord adds or drops made explicit, so equal commands compare equal.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function cleanOption(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if ((k === "required" || k === "autocomplete") && v === false) continue;
    if (k === "name_localizations" || k === "description_localizations") continue;
    if (k === "options" || k === "choices" || k === "channel_types") {
      if (!Array.isArray(v) || v.length === 0) continue;
      out[k] = v.map((x) => (isObj(x) ? cleanOption(x) : x));
      continue;
    }
    out[k] = isObj(v) ? cleanOption(v) : v;
  }
  return out;
}
export function normalize(cmd) {
  const hasDm = cmd.dm_permission !== null && cmd.dm_permission !== undefined;
  // Discord may report DM availability only through `contexts` (0 guild, 1 bot DM, 2 private channel).
  const dm = hasDm ? cmd.dm_permission !== false : Array.isArray(cmd.contexts) ? cmd.contexts.some((c) => c === 1 || c === 2) : true;
  const perms = cmd.default_member_permissions;
  return {
    name: cmd.name,
    type: cmd.type ?? 1,
    description: cmd.description ?? "",
    options: (Array.isArray(cmd.options) ? cmd.options : []).map(cleanOption),
    default_member_permissions: perms === null || perms === undefined ? null : String(perms),
    dm_permission: dm,
  };
}
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const canonical = (cmd) => JSON.stringify(sortKeys(normalize(cmd)));

// ---- manifest --------------------------------------------------------------------------------------------------------------------------
export function validateManifest(body) {
  if (!isObj(body) || !Array.isArray(body.commands)) throw new Error("manifest must be an object with a commands array");
  if (body.commands.length === 0) throw new Error("manifest has no commands");
  const seen = new Set();
  for (const c of body.commands) {
    if (!isObj(c) || typeof c.name !== "string" || !/^[\w-]{1,32}$/.test(c.name)) throw new Error("manifest command has no valid name");
    if (typeof c.description !== "string") throw new Error(`manifest command ${c.name} has no description`);
    if (c.options !== undefined && !Array.isArray(c.options)) throw new Error(`manifest command ${c.name} has malformed options`);
    const key = `${c.type ?? 1}:${c.name}`;
    if (seen.has(key)) throw new Error(`manifest lists ${c.name} twice`);
    seen.add(key);
  }
  return body.commands;
}

// ---- run -------------------------------------------------------------------------------------------------------------------------------
class Stop extends Error {}

export async function run({ argv = [], env = {}, fetchImpl = globalThis.fetch, out = (s) => console.log(s), err = (s) => console.error(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let apply = false;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else { err(`Unknown argument: ${String(a).slice(0, 40)}. Use --dry-run (default) or --apply.`); return 1; }
  }
  const token = env.DISCORD_BOT_TOKEN || "";
  const scrub = (s) => { let t = String(s); if (token) t = t.split(token).join("[redacted]"); return t.replace(/Bot\s+\S+/g, "Bot [redacted]"); };
  const warn = (msg) => out(`::warning::Discord command sync: ${scrub(msg)}`);
  if (!token) { warn("DISCORD_BOT_TOKEN is not set; nothing was read or changed."); return 0; }
  const appId = env.DISCORD_APP_ID || DEFAULT_APP_ID;
  const workerUrl = (env.WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, "");
  if (!/^\d{5,25}$/.test(appId)) { warn("DISCORD_APP_ID is not a numeric id; nothing was changed."); return 0; }

  let retried = false;
  const discord = async (method, path, body) => {
    for (;;) {
      const res = await fetchImpl(`${DISCORD_API}${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "leeroy-command-sync (https://leeroy.party, 1)" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 && !retried) {
        retried = true;
        let secs = 1;
        try { const j = await res.json(); if (typeof j?.retry_after === "number") secs = j.retry_after; } catch { /* default wait */ }
        await sleep(Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_WAIT_MS));
        continue;
      }
      return res;
    }
  };

  // 1. The manifest. A body that cannot be parsed or is malformed fails (exit 1); a Worker that cannot be reached is a warning only.
  let manifest;
  try {
    const res = await fetchImpl(`${workerUrl}/api/discord/commands`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { warn(`manifest request returned HTTP ${res.status}; nothing was changed.`); return 0; }
    let body;
    try { body = await res.json(); } catch { err("Malformed manifest: not JSON."); return 1; }
    try { manifest = validateManifest(body); } catch (e) { err(`Malformed manifest: ${scrub(e.message)}`); return 1; }
  } catch (e) { warn(`could not read the manifest (${scrub(e.message)}); nothing was changed.`); return 0; }

  try {
    // 2. Discord's current global commands.
    const listRes = await discord("GET", `/applications/${appId}/commands`);
    if (listRes.status === 429) throw new Stop("rate limited by Discord twice; stopped, nothing was changed.");
    if (!listRes.ok) throw new Stop(`Discord returned HTTP ${listRes.status} when listing commands; nothing was changed.`);
    const live = await listRes.json();
    if (!Array.isArray(live)) throw new Stop("Discord returned an unexpected command list; nothing was changed.");
    const liveByKey = new Map(live.filter((c) => c && typeof c.name === "string").map((c) => [`${c.type ?? 1}:${c.name}`, c]));

    // 3. Diff, then POST (upsert by name) only the missing or different ones.
    const created = [], updated = [], unchanged = [];
    for (const cmd of manifest) {
      const have = liveByKey.get(`${cmd.type ?? 1}:${cmd.name}`);
      if (!have) created.push(cmd);
      else if (canonical(have) !== canonical(cmd)) updated.push(cmd);
      else unchanged.push(cmd);
    }
    const names = (a) => a.map((c) => c.name).join(", ");
    if (!apply) {
      out("Dry run: no changes written.");
      out(`would create: ${names(created) || "none"}`);
      out(`would update: ${names(updated) || "none"}`);
      out(`unchanged: ${unchanged.length}`);
      return 0;
    }
    const done = { created: [], updated: [] };
    for (const [kind, list] of [["created", created], ["updated", updated]]) {
      for (const cmd of list) {
        const res = await discord("POST", `/applications/${appId}/commands`, cmd);
        if (res.status === 429) throw new Stop(`rate limited by Discord twice; stopped after ${done.created.length + done.updated.length} write(s).`);
        if (!res.ok) throw new Stop(`Discord returned HTTP ${res.status} when writing ${cmd.name}; stopped.`);
        done[kind].push(cmd.name);
      }
    }
    out(`created: ${done.created.join(", ") || "none"}`);
    out(`updated: ${done.updated.join(", ") || "none"}`);
    out(`unchanged: ${unchanged.length}`);
    return 0;
  } catch (e) {
    warn(e instanceof Stop ? e.message : `unexpected error (${e?.name || "Error"}: ${scrub(e?.message || e)}); nothing more was changed.`);
    return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ argv: process.argv.slice(2), env: process.env }).then((code) => { process.exitCode = code; });
}
