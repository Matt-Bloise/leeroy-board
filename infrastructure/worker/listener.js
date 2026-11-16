// The listener route (step f of the /ask rebuild): POST /api/listen takes a signed Discord message event from the forwarder on Matt's PC and decides what Leeroy does with it.
// Flag LISTENER = off | dry | live (listener-config.js); docs/runbooks/listener.md. Owner decisions (Matt, 2026-11-15): answer when tagged or replied to; untagged chat is read in
// (a later PR classifies it); a short dry run, then live; a mute command is the friends' remote control.
//
// What it does with one event:
//   - checks the HMAC signature and the timestamp window, the body size, the guild (the roster's guildId; fail closed when none is set) and the author (a roster member by Discord id;
//     anyone else is ignored and nothing about them is stored), then claims the message id in listen_events (a repeated delivery does nothing);
//   - kind 'mention' or 'reply': runs the same research answer as /ask (answerWithAi: paid Claude only, real names, group memory) and, in live mode, posts it as a reply with every ping off.
//     The answer is a PRIVATE turn in a dry run (share false: filed 'ask-private', shown to no one else) and nothing is posted; a live answer is a public turn like a public /ask;
//   - kind 'chatter': files the text as the author's 'message' row in the group memory log when GROUP_MEMORY is on and the channel is not quiet (mentions and replies are filed by answerWithAi).
// Part B (flag LISTENER_UNTAGGED, off by default; listener-untagged.js): the signing key is derived from the bot token (listener-config.js listenerKey; no separate secret), and untagged text
// (kind 'chatter') goes through rules, a Haiku-class classifier for candidates and a soft daily cap: answered only when a direct checkable answer exists, otherwise fed to the group wiki
// (personal-life topics never). With the flag off, 'chatter' behaves exactly as above.
// Never throws to the caller after the signature passes; every failure is a short code in a log line and a decision in listen_events, never message text.
import { answerWithAi, resolveAiProvider, isPrPreviewEnv, callAnthropicClaude } from "./ai-models.js";
import { insertAskTurn } from "./answer-ux.js";
import { SaltMissingError } from "./salts.js";
import { askWallPlan, memberLine } from "./research/no-wall.js";
import { researchModeOn, DEGRADED_SUFFIX } from "./research/provider.js";
import { groupMemoryOn, appendGroupLog } from "./research/group-memory.js";
import { hashId } from "./budget.js";
import { loadConfigKey } from "./config.js";
import { resolveMember } from "./members.js";
import { loadPersona } from "./persona.js";
import { postChannelMessage } from "./announce.js";
import { clampContent } from "./discord-safety.js";
import { MAX_QUESTION_CHARS } from "./limits.js";
import { listenerMode, verifyListen, parseListenEvent, LISTEN_MAX_BODY, isSnow, listenerKeyFor } from "./listener-config.js";
import { untaggedOn, untaggedRules, classifyUntagged, untaggedCapReached, personalLife, UNTAGGED_MIN_CONFIDENCE } from "./listener-untagged.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// The listener may run only when its flag is on, a bot token is set (the signing key is derived from it), ASK_RESEARCH is on (friend text must only reach the paid Claude hop) and this is not a PR preview.
export async function listenerActive(env) {
  const mode = listenerMode(env);
  if (mode === "off") return null;
  if (isPrPreviewEnv(env)) return null;
  if (!(await listenerKeyFor(env))) return null; // no usable bot token: no signing key, the route does not exist (fails closed exactly like the flag off)
  let research = false;
  try { research = Boolean(await researchModeOn(env, { preview: false })); } catch { research = false; }
  return research ? mode : null;
}

export async function isQuiet(env, channel) {
  try {
    return Boolean(await env.DB.prepare("SELECT 1 AS q FROM listen_quiet WHERE channel = ?").bind(String(channel)).first());
  } catch (e) {
    // Table missing (migration not applied): nobody could have run /quiet, so no channel is quiet. Any other failure fails CLOSED: a muted channel is never read on a bad day.
    return !/no such table/i.test(String((e && e.message) || e));
  }
}

export async function setQuiet(env, channel, on) {
  if (!isSnow(String(channel || "")) ) return false;
  try {
    if (on) await env.DB.prepare("INSERT INTO listen_quiet (channel, at) VALUES (?, ?) ON CONFLICT(channel) DO UPDATE SET at = excluded.at").bind(String(channel), new Date().toISOString()).run();
    else await env.DB.prepare("DELETE FROM listen_quiet WHERE channel = ?").bind(String(channel)).run();
    return true;
  } catch {
    return false;
  }
}

// Claim the message id. true: first delivery. false: seen before (or the table is missing: do nothing rather than answer twice).
// The stored key is a salted hash of the Discord message id, so a row cannot be looked up in Discord (which would give its author and time) and survives an erase harmlessly.
async function msgKey(env, id) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`listen:${String((env && env.USER_SALT) || "")}:${id}`));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function claim(env, ev) {
  try {
    if (!env.USER_SALT) return false; // no salt: the key would be guessable, so do nothing
    const r = await env.DB.prepare("INSERT OR IGNORE INTO listen_events (msg_id, at, channel, kind, decision, posted) VALUES (?, ?, ?, ?, 'claimed', 0)")
      .bind(await msgKey(env, ev.id), new Date().toISOString(), ev.channel_id, ev.kind).run();
    return Boolean(r && r.meta && r.meta.changes > 0);
  } catch {
    return false;
  }
}

async function decide(env, id, decision, { askId = null, posted = false } = {}) {
  try {
    await env.DB.prepare("UPDATE listen_events SET decision = ?, ask_id = ?, posted = ? WHERE msg_id = ?").bind(String(decision).slice(0, 40), askId, posted ? 1 : 0, await msgKey(env, id)).run();
  } catch {}
}

// Exposed for tests and for the route. Returns the decision string.
export async function processListenEvent(env, origin, ev, mode, { fetchImpl } = {}) {
  const roster = await loadConfigKey(env, "discord_roster");
  if (!roster || !isSnow(String(roster.guildId || "")) || roster.guildId !== ev.guild_id) return "ignored:guild";
  const membersConfig = await loadConfigKey(env, "discord_members");
  const member = resolveMember(ev.author_id, "", membersConfig);
  if (!member) return "ignored:non-member";
  if (!(await claim(env, ev))) return "duplicate";

  if (ev.kind === "chatter") {
    if (!ev.content) { await decide(env, ev.id, "empty"); return "empty"; }
    if ((await isQuiet(env, ev.channel_id)) || (ev.parent_id && (await isQuiet(env, ev.parent_id)))) { await decide(env, ev.id, "quiet"); return "quiet"; }
    if (untaggedOn(env)) return untaggedText(env, origin, ev, member, mode, { fetchImpl });
    if (personalLife(ev.content)) { await decide(env, ev.id, "personal"); return "personal"; } // personal-life text is not filed, with or without LISTENER_UNTAGGED
    if (!(await groupMemoryOn(env))) { await decide(env, ev.id, "memory-off"); return "memory-off"; }
    const n = await appendGroupLog(env, [{ at: new Date().toISOString(), channel: ev.channel_id, author_slug: member.slug, kind: "message", text: ev.content, reply_to: ev.id, source: "listener" }]);
    const d = n ? "logged" : "not-stored";
    await decide(env, ev.id, d);
    return d;
  }

  return answerEvent(env, origin, ev, member, mode, { fetchImpl });
}

// The answer path shared by a mention or reply and by an untagged text the classifier chose to answer (part B): answer it the way /ask would, and in live mode post it as a reply with every ping off.
// tag: prefixed to every decision this path records ("" for mention and reply, as in part A; "u:" for an untagged text, which the daily cap counts). allowFallback false: no in-voice filler line.
async function answerEvent(env, origin, ev, member, mode, { fetchImpl, tag = "", allowFallback = true } = {}) {
  if (!ev.content) { await decide(env, ev.id, tag + "empty"); return "empty"; }
  const question = (ev.kind === "reply" && ev.ref_text ? `(replying to Leeroy's earlier line: "${ev.ref_text}") ${ev.content}` : ev.content).slice(0, MAX_QUESTION_CHARS);
  const live = mode === "live";
  const share = live; // a dry-run answer is private: filed 'ask-private', shown to no one else
  const intentId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await insertAskTurn(env, { id: intentId, byName: member.name, question, provider: resolveAiProvider(env), share, createdAt: now }, { discordId: ev.author_id, slug: member.slug });
  } catch (e) {
    await decide(env, ev.id, tag + (e instanceof SaltMissingError ? "no-salt" : "store-failed"));
    return "store-failed";
  }
  let budget = null;
  try { ({ budget } = await askWallPlan(env, { isMember: true, userPart: await hashId(ev.author_id), preview: false })); } catch {}
  try {
    await answerWithAi({ env, origin, intentId, by: member.name, memberSlug: member.slug, question, provider: resolveAiProvider(env), share, budget, isMember: true, channel: ev.channel_id, noFanout: true });
  } catch {
    console.warn(JSON.stringify({ evt: "listen_answer_failed" }));
  }
  let text = "";
  try {
    const row = await env.DB.prepare("SELECT answer, status, model FROM ask_turns WHERE id = ?").bind(intentId).first();
    if (row && row.status !== "error" && row.answer && (allowFallback || !String(row.model || "").endsWith(DEGRADED_SUFFIX))) text = String(row.answer); // an unprompted reply is never the degraded "my brain is out" line
  } catch {}
  let fallback = false;
  if (!text && allowFallback) { // an unprompted answer has no in-voice filler line: when Claude cannot answer, nothing is posted
    try { text = memberLine(await loadPersona(env), intentId) || ""; fallback = Boolean(text); } catch {}
  }
  if (!text) { await decide(env, ev.id, tag + "no-answer", { askId: intentId }); return "no-answer"; }
  if (!live) { await decide(env, ev.id, tag + (fallback ? "dry:fallback" : "dry:answered"), { askId: intentId }); return "dry"; }
  if (!env.DISCORD_BOT_TOKEN) { await decide(env, ev.id, tag + "no-token", { askId: intentId }); return "no-token"; }
  const res = await postChannelMessage(env, ev.channel_id, {
    content: clampContent(text),
    allowed_mentions: { parse: [], replied_user: false },
    message_reference: { message_id: ev.id, channel_id: ev.channel_id, fail_if_not_exists: false },
  }, { timeoutMs: 8000, fetchImpl });
  console.log(JSON.stringify({ evt: "listen_post", ok: res.ok, status: res.status, fallback }));
  await decide(env, ev.id, tag + (res.ok ? (fallback ? "posted:fallback" : "posted") : `post-failed:${res.status}`), { askId: intentId, posted: res.ok });
  return res.ok ? "posted" : "post-failed";
}

// Untagged channel text (kind 'chatter') with LISTENER_UNTAGGED on. The author is already a roster member in the roster guild and the channel is not quiet (processListenEvent checked both).
// Decisions recorded in listen_events (never text, never an author), all prefixed "u:": ignore:<reason>, wiki:<reason> (filed in the group memory log), memory-off, not-stored, answer-dry:<reason> (dry: nothing is run or
// posted), posted / post-failed:<status> / no-answer / no-token (live: the part A answer path).
async function untaggedText(env, origin, ev, member, mode, { fetchImpl } = {}) {
  const done = async (d, ret) => { await decide(env, ev.id, d); return ret || d; };
  const rules = untaggedRules(ev.content);
  if (rules.verdict === "ignore") return done(`u:ignore:${rules.reason}`);
  let decision = "wiki_only", reason = rules.reason;
  if (rules.verdict === "candidate") {
    const v = await classifyUntagged(env, { text: ev.content, isMember: Boolean(member), call: callAnthropicClaude });
    decision = v.decision; reason = v.reason;
    if (decision === "answer") {
      if (!(v.confidence >= UNTAGGED_MIN_CONFIDENCE)) { decision = "wiki_only"; reason = "lowconf"; }
      else if (await untaggedCapReached(env, ev.channel_id)) { decision = "wiki_only"; reason = "cap"; }
    }
  }
  if (decision === "ignore") return done(`u:ignore:${reason}`);
  if (decision === "answer") {
    if (mode !== "live") return done(`u:answer-dry:${reason}`, "dry");
    return answerEvent(env, origin, ev, member, mode, { fetchImpl, tag: "u:", allowFallback: false });
  }
  // wiki_only: the group wiki's own appender, as part A does for chatter (private storage, secret screen, roster slug); nothing when memory is off
  if (!(await groupMemoryOn(env))) return done("u:memory-off");
  const n = await appendGroupLog(env, [{ at: new Date().toISOString(), channel: ev.channel_id, author_slug: member.slug, kind: "message", text: ev.content, reply_to: ev.id, source: "listener" }]);
  return n ? done(`u:wiki:${reason}`, "logged") : done("u:not-stored");
}

// The latest ask turn matching `where` (a SQL condition over ask_turns with its binds), never one the listener created: a turn the listener answered (a mention, a reply or an unprompted answer) is
// "shared in the reply channel only", so GET /ask must not hand it to every member. Before migration 0012 there is no listen_events table and nothing to exclude.
export async function latestTurn(env, where, binds) {
  const run = (extra) => env.DB.prepare(`SELECT * FROM ask_turns WHERE (${where})${extra} ORDER BY created_at DESC LIMIT 1`).bind(...binds).first();
  try {
    return await run(" AND id NOT IN (SELECT ask_id FROM listen_events WHERE ask_id IS NOT NULL)");
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) return run("");
    throw e;
  }
}

// The body as text, or null when it is over `max` BYTES. The declared length is checked first and the stream is cancelled the moment the running count passes the limit,
// so an unsigned caller cannot make the Worker buffer a large body.
export async function readBounded(req, max) {
  const declared = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

export async function handleListen(req, env, ctx, origin) {
  const mode = await listenerActive(env);
  if (!mode) return json({ error: "not found" }, 404); // off: the route does not exist
  const raw = await readBounded(req, LISTEN_MAX_BODY);
  if (raw === null) return json({ error: "too large" }, 413);
  const ok = await verifyListen(await listenerKeyFor(env), req.headers.get("X-Listen-Timestamp"), raw, req.headers.get("X-Listen-Signature"), Math.floor(Date.now() / 1000));
  if (!ok) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const parsed = parseListenEvent(body);
  if (!parsed.ok) return json({ error: "bad event", why: parsed.why }, 400);
  const run = processListenEvent(env, origin, parsed.ev, mode).then(
    (d) => console.log(JSON.stringify({ evt: "listen", kind: parsed.ev.kind, decision: d, mode })),
    () => console.warn(JSON.stringify({ evt: "listen_failed", kind: parsed.ev.kind })),
  );
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run); else await run;
  return json({ ok: true, mode }, 202);
}
