// =============================================================================
// Discord Bot & Interactions Integration (`worker/discord.js`)
// Supports both:
//   1. Native Serverless Discord HTTP Interactions (`POST /api/discord`) with
//      WebCrypto Ed25519 signature verification (`DISCORD_PUBLIC_KEY`).
//   2. External Discord Bot REST sync (`POST /api/signups`) for updating the
//      #wow-forever Sign-ups card tallies in D1 and broadcasting over WebSockets.
// =============================================================================

import { answerWithClaude, resolveAiProvider } from "./claude.js";
import { broadcastToRoom, purgeWorkerCache } from "./index.js";

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
      if (tallies.meet[e.meet] && e.meet !== "other") {
        tallies.meet[e.meet].count++;
        tallies.meet[e.meet].names.push(name);
      } else {
        tallies.meet.other.count++;
        tallies.meet.other.names.push(name);
        if (e.meet_other || e.meet !== "other") {
          tallies.meet.other.places.push({ name, place: e.meet_other || e.meet });
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

export async function handleDiscordInteraction(req, env, ctx, origin) {
  const rawBody = await req.text();
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "DISCORD_PUBLIC_KEY not configured" }), { status: 500 });
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
  const byName =
    (interaction.member && interaction.member.nick) ||
    user.global_name ||
    user.username ||
    "party";

  // 2. Slash Command (Type 2): `/ask <question> [model:claude|gemini]`
  if (interaction.type === 2 && interaction.data && interaction.data.name === "ask") {
    const opts = interaction.data.options || [];
    const qOpt = opts.find((o) => o.name === "question" || o.name === "q") || opts[0];
    const mOpt = opts.find((o) => o.name === "model" || o.name === "provider");
    const question = String((qOpt && qOpt.value) || "").trim();
    const provider = resolveAiProvider(env, mOpt && mOpt.value);
    const intentId = `int_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    await env.DB.prepare(
      "INSERT INTO ask_turns (id, by_name, question, model, status, created_at) VALUES (?, ?, ?, ?, 'thinking', ?)"
    )
      .bind(intentId, byName, question, provider, now)
      .run();

    ctx.waitUntil(
      (async () => {
        await answerWithClaude({ env, origin, intentId, by: byName, question, provider, share: false });
        const row = await env.DB.prepare("SELECT answer FROM ask_turns WHERE id = ?").bind(intentId).first();
        if (interaction.application_id && interaction.token && row && row.answer) {
          await fetch(
            `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: row.answer }),
            }
          ).catch(() => {});
        }
      })()
    );

    // Return Type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) immediately (<5ms)
    return new Response(JSON.stringify({ type: 5 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Message Component Buttons (Type 3): Sign-ups card buttons (`signup:<field>:<value>`)
  if (interaction.type === 3 && interaction.data && interaction.data.custom_id) {
    const customId = String(interaction.data.custom_id);
    const [, field, val] = customId.split(":");
    if (field && val) {
      const row = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'signups'").first();
      if (row) {
        const doc = JSON.parse(row.json);
        doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
        let entry = doc.entries.find((e) => (e.name || "").toLowerCase() === byName.toLowerCase());
        if (!entry) {
          entry = { name: byName };
          doc.entries.push(entry);
        }
        entry[field] = val;
        await recomputeSignupTallies(doc);

        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
          .bind(JSON.stringify(doc), doc.updated)
          .run();
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/signups.json"]);
        await broadcastToRoom(env, { type: "data", key: "signups" });
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
