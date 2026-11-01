// =============================================================================
// Discord Bot & Interactions Integration (`worker/discord.js`)
// Full serverless parity with `wow-mage/bot/`:
//   1. `/ask`     — Multi-Provider AI Q&A (Claude, Gemini, Workers AI, Groq, Cerebras, GitHub Models, OpenRouter)
//   2. `/tonight` — Launch countdown, next steps, and current RSVP tallies from D1
//   3. `/sheet`   — View or update character sheet fields in D1 (`sheet_events` + `party.json`)
//   4. `/launch`  — View or update launch-night queue/in/done status in D1
//   5. `/map`     — Deep-link to any Azeroth place or route on the Living Board Atlas (`#atlas.<place>`)
//   6. `/signup`  — Update pack, meet, rsvp, or when directly from Discord + button interactions
// =============================================================================

import { answerWithAi, resolveAiProvider } from "./ai-models.js";
import { broadcastToRoom, purgeWorkerCache, buildPartySheetsFromD1, recordSheetEventInD1 } from "./index.js";

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
    ],
  },
  {
    name: "tonight",
    description: "See the launch countdown, your next step, and who is signed up for launch night",
  },
  {
    name: "sheet",
    description: "View or update a field on your character sheet on the Living Board",
    options: [
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
    description: "Open a place or route on the Living Board Azeroth Atlas",
    options: [
      { name: "place", description: "Place or zone slug (e.g. orgrimmar, crossroads, tirisfal-glades)", type: 3, required: false },
      { name: "plan", description: "Meeting route plan slug (e.g. vos, xroads)", type: 3, required: false },
    ],
  },
  {
    name: "signup",
    description: "Set your launch-night RSVP, pack, meeting point, or arrival time",
    options: [
      {
        name: "field",
        description: "Which sign-up question to answer",
        type: 3,
        required: true,
        choices: [
          { name: "Launch Night RSVP (in, maybe, late, out)", value: "rsvp" },
          { name: "Pre-order Pack (yes, no)", value: "pack" },
          { name: "Meeting Point (vos, xroads, other)", value: "meet" },
          { name: "Arrival Time (6pm, 8pm, later)", value: "when" },
        ],
      },
      { name: "value", description: "Your answer", type: 3, required: true },
    ],
  },
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

function slugFromDisplayName(byName) {
  const low = String(byName || "").toLowerCase();
  if (low.includes("santa") || low.includes("nick")) return { slug: "santa", name: "Santa" };
  if (low.includes("bible") || low.includes("tony")) return { slug: "bible-boi", name: "Bible Boi" };
  if (low.includes("street") || low.includes("ethan")) return { slug: "street-rat", name: "Street Rat" };
  if (low.includes("squid") || low.includes("derek")) return { slug: "handsome-squidward", name: "Handsome Squidward" };
  return { slug: "bloise", name: "Bloise" };
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
  const rawUser =
    (interaction.member && interaction.member.nick) ||
    user.global_name ||
    user.username ||
    "Bloise";
  const member = slugFromDisplayName(rawUser);
  const byName = member.name;
  const boardUrl = env.BOARD_PUBLIC_URL || "https://leeroy-board.pages.dev";

  // 2. Slash Commands (Type 2)
  if (interaction.type === 2 && interaction.data) {
    const cmd = interaction.data.name;
    const opts = interaction.data.options || [];
    const getOpt = (n) => {
      const o = opts.find((x) => x.name === n);
      return o ? String(o.value).trim() : "";
    };

    // 2a. `/ask`
    if (cmd === "ask") {
      const question = getOpt("question") || getOpt("q") || String((opts[0] && opts[0].value) || "").trim();
      const provider = resolveAiProvider(env, getOpt("model") || getOpt("provider"));
      const intentId = String(Date.now());
      const now = new Date().toISOString();

      await env.DB.prepare(
        "INSERT INTO ask_turns (id, by_name, question, model, status, created_at) VALUES (?, ?, ?, ?, 'thinking', ?)"
      )
        .bind(intentId, byName, question, provider, now)
        .run();

      ctx.waitUntil(
        (async () => {
          await answerWithAi({ env, origin, intentId, by: byName, question, provider, share: false });
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

      return new Response(JSON.stringify({ type: 5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
        ? "Say whether you are **in** for launch night (`/signup field:rsvp value:in`)."
        : !myEntry.meet
        ? "Pick where the party meets (`/signup field:meet value:vos` or `xroads`)."
        : "Your launch-night answers are in — check your character sheet with `/sheet`.";

      const lines = [
        `**Launch Night: Wed Nov 4, 6:00 PM ET** (<t:1793833200:F>)`,
        `• **Party (${(party.members || []).length}):** ${(party.members || []).map((m) => `${m.name} (${m.race} ${m.class})`).join(" · ")}`,
        `• **RSVP In (${inList.length}):** ${inList.length ? inList.join(", ") : "None yet"}`,
        `• **Next for ${byName}:** ${nextStep}`,
        `• **Board:** ${boardUrl}/#tonight`,
      ];
      return new Response(
        JSON.stringify({ type: 4, data: { content: lines.join("\n"), flags: 64 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2c. `/sheet [field] [value]`
    if (cmd === "sheet") {
      const field = getOpt("field");
      const value = getOpt("value");
      if (field && value) {
        const now = new Date().toISOString();
        await recordSheetEventInD1(env, origin, {
          slug: member.slug,
          name: byName,
          field,
          value,
          visible: true,
          source: "discord",
          at: now,
        });
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `Updated **${byName}**'s sheet (**${field}** → \`${value}\`). View on the board: ${boardUrl}/#five`,
              flags: 64,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const { party } = await buildPartySheetsFromD1(env);
      const mine = party.find((p) => p.slug === member.slug);
      const fieldSummary = mine && mine.fields
        ? Object.entries(mine.fields)
            .map(([k, v]) => `• **${k}:** ${Array.isArray(v.value) ? v.value.join(", ") : v.value}`)
            .join("\n")
        : "No custom sheet fields recorded yet.";
      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `**${byName}'s Party Sheet**\n${fieldSummary}\nOpen your sheet: ${boardUrl}/#five`,
            flags: 64,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2d. `/launch [state]`
    if (cmd === "launch") {
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
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/launch.json"]);
        await broadcastToRoom(env, { type: "data", key: "launch", data: rows });
      }
      const summary = rows.length
        ? rows.map((r) => `• **${r.name}:** ${r.state}`).join("\n")
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

    // 2e. `/map [place] [plan]`
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

    // 2f. `/signup <field> <value>`
    if (cmd === "signup") {
      const field = getOpt("field");
      const val = getOpt("value");
      if (field && val) {
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
            .bind(JSON.stringify(doc), doc.updated)
            .run();
          await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/signups.json"]);
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
  }

  // 3. Message Component Buttons (Type 3): Sign-ups & Party card buttons (`signup:<field>:<value>`)
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
          entry = { slug: member.slug, name: byName };
          doc.entries.push(entry);
        }
        entry[field] = val === "vos" ? "Valley of Strength" : val === "xroads" ? "The Crossroads" : val;
        entry.updated = new Date().toISOString();
        await recomputeSignupTallies(doc);

        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'signups'")
          .bind(JSON.stringify(doc), doc.updated)
          .run();
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/signups.json"]);
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
