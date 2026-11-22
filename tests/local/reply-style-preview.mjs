// Preview Leeroy's Discord replies, today's look beside the REPLY_STYLE look (docs/discord-reply-style.md), from fictional data.
//   node tests/local/reply-style-preview.mjs                 an outline of every surface, today and styled
//   node tests/local/reply-style-preview.mjs --json          the message bodies as JSON
//   node tests/local/reply-style-preview.mjs --html out.html a page that draws them roughly the way Discord's dark theme does
// Not part of `node --test tests/unit/*`. Sends nothing anywhere and makes no AI call: fetch is stubbed, D1 is an in-memory fake, and today's /page,
// /tooltip and /map replies come from the real discord.js handler driven with a signed fake request (as tests/unit/discord-components.test.mjs does).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSignupCard, renderBoardCard } from "../../infrastructure/worker/cards.js";
import { buildAnswerComponents } from "../../infrastructure/worker/answer-ux.js";
import { handleDiscordInteraction } from "../../infrastructure/worker/discord.js";
import { invalidateConfigCache } from "../../infrastructure/worker/config.js";
import { pageCard, tooltipCard, mapCard } from "../../infrastructure/worker/reply-style.js";
import { createDiscordSigner } from "../helpers/discord-sign.mjs";
import { fakeD1 } from "../unit/fake-d1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const BASE = "https://leeroy.party";
const NOW = Date.now();

// ---- fictional data ----
const STATE = {
  updated: new Date(NOW - 42 * 60000).toISOString(),
  siteBase: BASE,
  boardUrl: `${BASE}/#signups`,
  options: { meet: ["Valley of Strength", "The Crossroads"], when: ["6pm", "8pm", "later"] },
  entries: [
    { name: "Quillfeather", slug: "quill", rsvp: "in", pack: "yes", meet: "Valley of Strength", when: "6pm" },
    { name: "Bramblewick", slug: "bram", rsvp: "in", meet: "Valley of Strength", when: "8pm" },
    { name: "Nimbus", slug: "nimbus", rsvp: "maybe", meet: "The Crossroads", when: "8pm" },
    { name: "Tallowmere", slug: "tallow", rsvp: "late", when: "later" },
  ],
  members: [
    { slug: "quill", name: "Quillfeather", classKey: "mage", classLabel: "Mage", race: "Undead", role: "damage" },
    { slug: "bram", name: "Bramblewick", classKey: "priest", classLabel: "Priest", race: "Troll", role: "healer" },
    { slug: "nimbus", name: "Nimbus", classKey: "shaman", classLabel: "Shaman", race: "Orc", role: "healer" },
    { slug: "tallow", name: "Tallowmere", classKey: "warrior", classLabel: "Warrior", race: "Tauren", role: "tank" },
    { slug: "rook", name: "Rookmantle", classKey: "rogue", classLabel: "Rogue", race: "Undead", role: "damage" },
  ],
};
const PAGE = { id: "dungeons/fixture-keep", category: "dungeons", title: "Fixture Keep", blurb: "A made-up dungeon used to preview the card.", aliases_json: '["Fixture Bolt"]' };
const FACTS = [{ key: "Levels", value: "13 to 18" }, { key: "Group", value: "5 players" }, { key: "Where", value: "A fictional canyon south of a fictional city" }];
PAGE.facts_json = JSON.stringify(FACTS);
const ANSWER = "> **Q:** how long is a run of fixture keep\n\n**A run takes about 40 minutes.**\n\n• **Levels** · 13 to 18\n• **Group** · 5 players\n\n-# Sources: [Fixture Keep](<https://leeroy.party/#library.dungeons.fixture-keep>)";
const SALT = "preview-salt-not-a-secret-0123456789abcdef";

// ---- today's /page, /tooltip and /map, from the real handler ----
async function todayReplies() {
  const signer = createDiscordSigner();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  let n = 0;
  const call = async (name, options) => {
    invalidateConfigCache();
    const DB = fakeD1({ discord_members: [], signups: { options: STATE.options, entries: [] } }, { lenient: true });
    DB.batch = async (s) => s.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    const prepare = DB.prepare.bind(DB);
    DB.prepare = (sql) => {
      const o = prepare(sql);
      return /FROM lib_pages/.test(sql) ? { ...o, bind: (...a) => ({ ...o.bind(...a), first: async () => PAGE }) } : o;
    };
    const interaction = { type: 2, id: String(300000000000000000n + BigInt(++n) * 7n), application_id: "400000000000000004", token: "t", channel_id: "100000000000000001", member: { user: { id: "1".repeat(18), username: "preview" } }, data: { name, options: options.map(([k, v]) => ({ name: k, type: 3, value: v })) } };
    const res = await handleDiscordInteraction(signer.signedRequest(interaction), { DB, DISCORD_PUBLIC_KEY: signer.publicKeyHex, BOARD_PUBLIC_URL: BASE }, { waitUntil() {} }, "https://worker.test");
    return (await res.json()).data;
  };
  try {
    return { page: await call("page", [["title", "Fixture Keep"]]), tooltip: await call("tooltip", [["name", "Fixture Bolt"]]), map: await call("map", [["plan", "vos"]]) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function surfaces() {
  const today = await todayReplies();
  const buttons = (flag) => buildAnswerComponents({ USER_SALT: SALT, ...(flag ? { REPLY_STYLE: "on" } : {}) }, { intentId: "preview1", messageId: "300000000000000003", hasMore: true, hasSources: true });
  return [
    { name: "Sign-up card", today: renderSignupCard(STATE), styled: renderSignupCard(STATE, { style: true }) },
    { name: "Party board", today: renderBoardCard(STATE), styled: renderBoardCard(STATE, { style: true }) },
    { name: "/ask answer", today: { content: ANSWER, components: await buttons(false) }, styled: { content: ANSWER, components: await buttons(true) } },
    { name: "/page", today: today.page, styled: pageCard({ row: PAGE, facts: FACTS, boardUrl: BASE }), wired: false },
    { name: "/tooltip", today: today.tooltip, styled: tooltipCard({ name: "Fixture Bolt", row: PAGE, verified: true, boardUrl: BASE }), wired: false },
    { name: "/map", today: today.map, styled: mapCard({ plan: { value: "valley-of-strength", name: "Valley of Strength" }, boardUrl: BASE }), wired: false },
  ];
}

// ---- outline ----
const hex = (c) => (Number.isInteger(c) ? `#${c.toString(16).toUpperCase().padStart(6, "0")}` : "none");
const STYLE_NAME = { 1: "blurple", 2: "grey", 3: "green", 4: "red", 5: "link" };
function outline(body) {
  const out = [];
  if (body.content) out.push(...body.content.split("\n").map((l) => `  ${l}`));
  for (const e of body.embeds || []) {
    out.push(`  | colour ${hex(e.color)}${e.thumbnail ? "   [thumbnail]" : ""}${e.image ? "   [image]" : ""}`);
    if (e.author) out.push(`  | ${e.author.icon_url ? "(icon) " : ""}${e.author.name}`);
    if (e.title) out.push(`  | ${e.title}${e.url ? `  -> ${e.url}` : ""}`);
    if (e.description) out.push(...e.description.split("\n").map((l) => `  | ${l}`));
    for (const f of e.fields || []) out.push(`  | ${f.inline ? "[inline] " : ""}${f.name}: ${f.value.replace(/\n/g, " / ")}`);
    if (e.footer || e.timestamp) out.push(`  | footer: ${e.footer ? e.footer.text : ""}${e.timestamp ? ` • ${new Date(e.timestamp).toLocaleString("en-US")}` : ""}`);
  }
  for (const r of body.components || []) out.push(`  ${r.components.map((c) => `[${c.label}](${STYLE_NAME[c.style] || c.style})`).join(" ")}`);
  return out.join("\n");
}

// ---- html ----
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function md(s) {
  return esc(s).split("\n").map((l) => {
    const small = /^-# /.test(l);
    let h = (small ? l.slice(3) : l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\(&lt;([^)]+)&gt;\)/g, '<a href="$2">$1</a>');
    if (/^&gt; /.test(h)) h = `<span class="quote">${h.slice(5)}</span>`;
    return small ? `<span class="small">${h}</span>` : h;
  }).join("<br>");
}
// The board's own images, read from the repo so the page draws offline.
function img(url) {
  const m = typeof url === "string" && url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : null;
  const file = m && path.join(ROOT, m);
  if (file && fs.existsSync(file)) return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  return esc(url || "");
}
function when(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return new Date(NOW).toDateString() === d.toDateString() ? `Today at ${t}` : d.toLocaleDateString("en-US");
}
function embedHtml(e) {
  const fields = (e.fields || []).map((f) => `<div class="field${f.inline ? " inline" : ""}"><div class="fname">${esc(f.name)}</div><div>${md(f.value)}</div></div>`).join("");
  return `<div class="embed" style="border-color:${hex(e.color) === "none" ? "#1e1f22" : hex(e.color)}"><div class="grid"><div class="main">
${e.author ? `<div class="author">${e.author.icon_url ? `<img src="${img(e.author.icon_url)}" alt="">` : ""}${esc(e.author.name)}</div>` : ""}
${e.title ? `<div class="title">${e.url ? `<a href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title)}</div>` : ""}
${e.description ? `<div class="desc">${md(e.description)}</div>` : ""}
${fields ? `<div class="fields">${fields}</div>` : ""}
${e.image ? `<img class="image" src="${img(e.image.url)}" alt="">` : ""}
${e.footer || e.timestamp ? `<div class="footer">${esc(e.footer ? e.footer.text : "")}${e.footer && e.timestamp ? " • " : ""}${e.timestamp ? esc(when(e.timestamp)) : ""}</div>` : ""}
</div>${e.thumbnail ? `<img class="thumb" src="${img(e.thumbnail.url)}" alt="">` : ""}</div></div>`;
}
const BTN = { 1: "primary", 2: "secondary", 3: "success", 4: "danger", 5: "secondary" };
function messageHtml(body) {
  const rows = (body.components || []).map((r) => `<div class="row">${r.components.map((c) => `<span class="btn ${BTN[c.style] || "secondary"}">${esc(c.label)}${c.style === 5 ? " ↗" : ""}</span>`).join("")}</div>`).join("");
  return `<div class="msg"><div class="who">Leeroy <span class="app">APP</span></div>${body.content ? `<div class="content">${md(body.content)}</div>` : ""}${(body.embeds || []).map(embedHtml).join("")}${rows}</div>`;
}
function page(list) {
  const css = `body{margin:0;background:#313338;color:#dbdee1;font:14px/1.375 "gg sans","Noto Sans","Helvetica Neue",Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:16px}h1{font-size:20px;color:#f2f3f5}h2{font-size:16px;color:#f2f3f5;margin:28px 0 8px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:820px){.pair{grid-template-columns:1fr}}
.label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#949ba4;margin-bottom:6px}.note{font-size:12px;color:#949ba4}
.msg{padding:4px 0}.who{font-weight:600;color:#f2f3f5;margin-bottom:2px}.app{background:#5865f2;color:#fff;font-size:10px;padding:0 4px;border-radius:3px;margin-left:4px}
.content{margin-bottom:4px}.quote{border-left:4px solid #4e5058;padding-left:8px;display:inline-block}.small{font-size:12px;color:#949ba4}a{color:#00a8fc;text-decoration:none}
.embed{max-width:520px;background:#2b2d31;border-left:4px solid;border-radius:4px;padding:8px 16px 16px 12px;margin:4px 0}
.grid{display:flex;gap:16px}.main{flex:1;min-width:0}.thumb{width:80px;height:80px;object-fit:contain;border-radius:3px;margin-top:8px}
.author{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;color:#f2f3f5;margin-top:8px}.author img{width:24px;height:24px;border-radius:50%}
.title{font-weight:600;font-size:16px;color:#f2f3f5;margin-top:8px}.desc{margin-top:8px;white-space:normal}
.fields{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}.field{grid-column:1/-1}.field.inline{grid-column:auto}.fname{font-weight:600;color:#f2f3f5}
.image{max-width:100%;border-radius:4px;margin-top:16px}.footer{font-size:12px;color:#b5bac1;margin-top:8px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.btn{display:inline-flex;align-items:center;height:32px;padding:0 16px;border-radius:3px;font-weight:500;color:#fff}
.primary{background:#5865f2}.secondary{background:#4e5058}.success{background:#248046}.danger{background:#da373c}`;
  const sections = list.map((s) => `<h2>${esc(s.name)}</h2>${s.wired === false ? '<p class="note">Built and tested, not wired yet: discord.js still sends today\'s reply with the flag on.</p>' : ""}<div class="pair"><div><div class="label">Today</div>${messageHtml(s.today)}</div><div><div class="label">REPLY_STYLE on</div>${messageHtml(s.styled)}</div></div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leeroy reply style preview</title><style>${css}</style></head><body><main><h1>Leeroy's Discord replies: today and REPLY_STYLE on</h1><p class="note">Fictional data. An approximation of Discord's dark theme; spacing in Discord differs a little.</p>${sections}</main></body></html>`;
}

const list = await surfaces();
if (argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
} else if (argv.includes("--html")) {
  const out = argv[argv.indexOf("--html") + 1];
  if (!out || out.startsWith("--")) { console.error("usage: --html <file>"); process.exit(2); }
  fs.writeFileSync(out, page(list));
  console.log(`wrote ${out}`);
} else {
  for (const s of list) {
    console.log(`\n== ${s.name}${s.wired === false ? "   (styled card built and tested, not wired yet)" : ""}\n-- today\n${outline(s.today)}\n-- REPLY_STYLE on\n${outline(s.styled)}`);
  }
}
