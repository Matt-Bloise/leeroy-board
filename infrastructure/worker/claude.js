// =============================================================================
// Direct Anthropic Claude API Integration for Leeroy (`worker/claude.js`)
// Retrieves matching facts from D1 (`lib_pages` + `kv_state`), calls Claude
// (`https://api.anthropic.com/v1/messages`) using `env.ANTHROPIC_API_KEY`,
// persists the answer + latency metrics to D1, purges `/api/bootstrap`, and
// broadcasts the live answer over WebSockets + optional Discord webhook.
// =============================================================================

import { broadcastToRoom, purgeWorkerCache } from "./index.js";

function scorePageForQuestion(page, words) {
  const hay = `${page.title} ${page.id} ${page.blurb || ""} ${page.facts_json || ""}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (hay.includes(w)) score += page.title.toLowerCase().includes(w) ? 4 : 1;
  }
  return score;
}

export async function answerWithClaude({ env, origin, intentId, by, question, deep = false }) {
  const t0 = Date.now();
  const nowIso = () => new Date().toISOString();

  try {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY secret is not configured on the Cloudflare Worker");
    }

    // 1. Pull relevant library pages & party state from D1 for grounded RAG context
    const [{ results: pages }, partyRow] = await Promise.all([
      env.DB.prepare("SELECT id, category, title, as_of, blurb, facts_json, open_json FROM lib_pages").all(),
      env.DB.prepare("SELECT json FROM kv_state WHERE key = 'party'").first(),
    ]);

    const words = question
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const ranked = (pages || [])
      .map((p) => ({ p, s: scorePageForQuestion(p, words) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.p);

    const contextBlocks = ranked.map((p) => {
      let facts = [];
      try {
        facts = JSON.parse(p.facts_json || "[]");
      } catch {}
      const lines = facts.slice(0, 25).map((f) => `  - [${p.id}~${f.key}]: ${f.value}`);
      return `Page: ${p.title} (${p.id}, as of ${p.as_of || "current"})\n${lines.join("\n")}`;
    });

    const partySummary = partyRow ? partyRow.json : "{}";
    const model = deep
      ? env.CLAUDE_MODEL_DEEP || "claude-sonnet-4-5-20250929"
      : env.CLAUDE_MODEL_FAST || "claude-haiku-4-5-20251001";

    const systemPrompt = [
      "You are Leeroy, the party librarian for the 'Dungeons and Drinking' WoW Classic Forever five-player group (Mend, Tank, Moira, Shazz, Faux).",
      "Answer strictly using the verified library facts and party state below. Where the library does not know something yet, state plainly that it is not published yet.",
      "Keep answers concise (2 to 4 sentences), warm, plain-spoken, and cite specific library page IDs in brackets like [classes/paladin-holy] or [dungeons/overview] whenever you use a fact.",
    ].join(" ");

    // 2. Call Anthropic Messages API directly from Cloudflare Worker
    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 450,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Party Context:\n${partySummary}\n\nLibrary Facts:\n${contextBlocks.join("\n\n")}\n\nQuestion from ${by}: ${question}`,
          },
        ],
      }),
    });

    if (!claudeResp.ok) {
      const errTxt = await claudeResp.text();
      throw new Error(`Claude API HTTP ${claudeResp.status}: ${errTxt.slice(0, 200)}`);
    }

    const data = await claudeResp.json();
    const answer = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // Extract cited page IDs like [classes/paladin-holy]
    const cites = [...new Set([...answer.matchAll(/\[([a-z0-9_-]+\/[a-z0-9_-]+)(?:~[^\]]+)?\]/gi)].map((m) => m[1]))];
    const latencyMs = Date.now() - t0;
    const answeredAt = nowIso();

    // 3. Save completed Q&A turn in D1 `ask_turns` and update `kv_state['stats']`
    await env.DB.prepare(
      "UPDATE ask_turns SET answer = ?, cites_json = ?, model = ?, status = 'answered', latency_ms = ?, answered_at = ? WHERE id = ?"
    )
      .bind(answer, JSON.stringify(cites), model, latencyMs, answeredAt, intentId)
      .run();

    const statsRow = await env.DB.prepare("SELECT json FROM kv_state WHERE key = 'stats'").first();
    if (statsRow) {
      try {
        const stats = JSON.parse(statsRow.json);
        stats.answers = (Number(stats.answers) || 0) + 1;
        stats.updated = answeredAt.slice(0, 10);
        stats.recent = [
          {
            id: intentId,
            by,
            q: question,
            a: answer,
            cites,
            at: answeredAt,
            ms: latencyMs,
          },
          ...(Array.isArray(stats.recent) ? stats.recent : []),
        ].slice(0, 15);
        await env.DB.prepare("UPDATE kv_state SET json = ?, updated_at = ? WHERE key = 'stats'")
          .bind(JSON.stringify(stats), answeredAt)
          .run();
        await purgeWorkerCache(origin, ["/api/bootstrap", "/api/data/stats.json"]);
      } catch (e) {
        console.error("Failed updating stats row:", e);
      }
    }

    // 4. Broadcast live completion over WebSockets to all connected browsers
    const completedItem = {
      id: intentId,
      kind: "ask",
      by,
      q: question,
      answer,
      cites,
      model,
      ms: latencyMs,
      status: "answered",
      at: answeredAt,
    };
    await broadcastToRoom(env, {
      type: "data",
      key: "stats",
      intent: completedItem,
    });

    // 5. Optional Discord Webhook post to #wow-forever
    if (env.DISCORD_WEBHOOK_URL) {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Leeroy",
          content: `**${by} asked:** ${question}\n${answer}`,
        }),
      }).catch(() => {});
    }
  } catch (err) {
    const failedAt = nowIso();
    const msg = String((err && err.message) || err);
    await env.DB.prepare("UPDATE ask_turns SET status = 'error', answer = ?, answered_at = ? WHERE id = ?")
      .bind(msg, failedAt, intentId)
      .run()
      .catch(() => {});
    await broadcastToRoom(env, {
      type: "intent",
      item: { id: intentId, kind: "ask", by, q: question, status: "error", error: msg, at: failedAt },
    });
  }
}
