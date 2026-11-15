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
// Never throws to the caller after the signature passes; every failure is a short code in a log line and a decision in listen_events, never message text.
import { answerWithAi, resolveAiProvider, isPrPreviewEnv } from "./ai-models.js";
import { insertAskTurn } from "./answer-ux.js";
import { SaltMissingError } from "./salts.js";
import { askWallPlan, memberLine } from "./research/no-wall.js";
import { researchModeOn } from "./research/provider.js";
import { groupMemoryOn, appendGroupLog } from "./research/group-memory.js";
import { hashId } from "./budget.js";
import { loadConfigKey } from "./config.js";
import { resolveMember } from "./members.js";
import { loadPersona } from "./persona.js";
import { postChannelMessage } from "./announce.js";
import { clampContent } from "./discord-safety.js";
import { MAX_QUESTION_CHARS } from "./limits.js";
import { listenerMode, verifyListen, parseListenEvent, LISTEN_MAX_BODY, isSnow } from "./listener-config.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// The listener may run only when its flag is on, ASK_RESEARCH is on (friend text must only reach the paid Claude hop) and this is not a PR preview.
export async function listenerActive(env) {
  const mode = listenerMode(env);
  if (mode === "off") return null;
  if (isPrPreviewEnv(env)) return null;
  let research = false;
  try { research = Boolean(await researchModeOn(env, { preview: false })); } catch { research = false; }
  return research ? mode : null;
}

export async function isQuiet(env, channel) {
  try {
    return Boolean(await env.DB.prepare("SELECT 1 AS q FROM listen_quiet WHERE channel = ?").bind(String(channel)).first());
  } catch {
    return false; // table missing (migration not applied): no channel is quiet
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
async function claim(env, ev) {
  try {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO listen_events (msg_id, at, channel, kind, decision, posted) VALUES (?, ?, ?, ?, 'claimed', 0)")
      .bind(ev.id, new Date().toISOString(), ev.channel_id, ev.kind).run();
    return Boolean(r && r.meta && r.meta.changes > 0);
  } catch {
    return false;
  }
}

async function decide(env, id, decision, { askId = null, posted = false } = {}) {
  try {
    await env.DB.prepare("UPDATE listen_events SET decision = ?, ask_id = ?, posted = ? WHERE msg_id = ?").bind(String(decision).slice(0, 40), askId, posted ? 1 : 0, id).run();
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
    if (await isQuiet(env, ev.channel_id)) { await decide(env, ev.id, "quiet"); return "quiet"; }
    if (!(await groupMemoryOn(env))) { await decide(env, ev.id, "memory-off"); return "memory-off"; }
    const n = await appendGroupLog(env, [{ at: new Date().toISOString(), channel: ev.channel_id, author_slug: member.slug, kind: "message", text: ev.content, reply_to: ev.id, source: "listener" }]);
    const d = n ? "logged" : "not-stored";
    await decide(env, ev.id, d);
    return d;
  }

  // mention or reply: answer it the way /ask would
  if (!ev.content) { await decide(env, ev.id, "empty"); return "empty"; }
  const question = (ev.kind === "reply" && ev.ref_text ? `(replying to Leeroy's earlier line: "${ev.ref_text}") ${ev.content}` : ev.content).slice(0, MAX_QUESTION_CHARS);
  const live = mode === "live";
  const share = live; // a dry-run answer is private: filed 'ask-private', shown to no one else
  const intentId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await insertAskTurn(env, { id: intentId, byName: member.name, question, provider: resolveAiProvider(env), share, createdAt: now }, { discordId: ev.author_id, slug: member.slug });
  } catch (e) {
    await decide(env, ev.id, e instanceof SaltMissingError ? "no-salt" : "store-failed");
    return "store-failed";
  }
  let budget = null;
  try { ({ budget } = await askWallPlan(env, { isMember: true, userPart: await hashId(ev.author_id), preview: false })); } catch {}
  try {
    await answerWithAi({ env, origin, intentId, by: member.name, memberSlug: member.slug, question, provider: resolveAiProvider(env), share, budget, isMember: true, channel: ev.channel_id });
  } catch {
    console.warn(JSON.stringify({ evt: "listen_answer_failed" }));
  }
  let text = "";
  try {
    const row = await env.DB.prepare("SELECT answer, status FROM ask_turns WHERE id = ?").bind(intentId).first();
    if (row && row.status !== "error" && row.answer) text = String(row.answer);
  } catch {}
  let fallback = false;
  if (!text) {
    try { text = memberLine(await loadPersona(env), intentId) || ""; fallback = Boolean(text); } catch {}
  }
  if (!text) { await decide(env, ev.id, "no-answer", { askId: intentId }); return "no-answer"; }
  if (!live) { await decide(env, ev.id, fallback ? "dry:fallback" : "dry:answered", { askId: intentId }); return "dry"; }
  if (!env.DISCORD_BOT_TOKEN) { await decide(env, ev.id, "no-token", { askId: intentId }); return "no-token"; }
  const res = await postChannelMessage(env, ev.channel_id, {
    content: clampContent(text),
    allowed_mentions: { parse: [], replied_user: false },
    message_reference: { message_id: ev.id, channel_id: ev.channel_id, fail_if_not_exists: false },
  }, { timeoutMs: 8000, fetchImpl });
  console.log(JSON.stringify({ evt: "listen_post", ok: res.ok, status: res.status, fallback }));
  await decide(env, ev.id, res.ok ? (fallback ? "posted:fallback" : "posted") : `post-failed:${res.status}`, { askId: intentId, posted: res.ok });
  return res.ok ? "posted" : "post-failed";
}

export async function handleListen(req, env, ctx, origin) {
  const mode = await listenerActive(env);
  if (!mode) return json({ error: "not found" }, 404); // off: the route does not exist
  const raw = await req.text();
  if (raw.length > LISTEN_MAX_BODY) return json({ error: "too large" }, 413);
  const ok = await verifyListen(env.LISTENER_SECRET, req.headers.get("X-Listen-Timestamp"), raw, req.headers.get("X-Listen-Signature"), Math.floor(Date.now() / 1000));
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
