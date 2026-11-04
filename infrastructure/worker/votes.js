// Votes for the Discord handler. Pure logic plus thin kv_state helpers that take the D1 binding as an argument.
// Storage: kv_state key `vote:<id>` holds the vote (title, choices, times) as JSON, ballots are one row each in vote_ballots (migration 0010), `votes:index` holds { ids: [newest first] }.
// A voter is stored only as a salted hash, never as the raw Discord user id, and the hash never leaves the Worker.
import { sha256Hex } from "./crypto.js";
import { requireSalt } from "./salts.js";

export const VOTE_MIN_CHOICES = 2;
export const VOTE_MAX_CHOICES = 5;
export const VOTE_MAX_TITLE = 200;
export const VOTE_MAX_CHOICE = 80; // Discord button labels stop at 80 characters
export const VOTE_DEFAULT_HOURS = 72;
export const VOTE_MIN_HOURS = 1;
export const VOTE_MAX_HOURS = 720;
export const VOTE_INDEX_MAX = 50;
export const VOTE_ID_RE = /^[a-f0-9]{8}$/;

// Per-vote, per-salt hash of a Discord user id. A missing salt throws SaltMissingError (no unsalted fallback).
export function voterHash(discordId, voteId, salt) {
  const s = requireSalt({ USER_SALT: salt }, "USER_SALT");
  return sha256Hex(`${s}:vote:${voteId}:${discordId}`);
}

export function newVoteId(randomBytes) {
  const bytes = randomBytes || crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Split on `|`, trim, drop empties. Returns { ok, choices } or { ok: false, error }.
export function parseChoices(raw) {
  const choices = String(raw === undefined || raw === null ? "" : raw)
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  if (choices.length < VOTE_MIN_CHOICES) return { ok: false, error: `Give at least ${VOTE_MIN_CHOICES} choices separated by |.` };
  if (choices.length > VOTE_MAX_CHOICES) return { ok: false, error: `Give at most ${VOTE_MAX_CHOICES} choices.` };
  if (choices.some((c) => c.length > VOTE_MAX_CHOICE)) return { ok: false, error: `Each choice must be ${VOTE_MAX_CHOICE} characters or fewer.` };
  const seen = new Set(choices.map((c) => c.toLowerCase()));
  if (seen.size !== choices.length) return { ok: false, error: "Choices must be different from each other." };
  return { ok: true, choices };
}

// Returns { ok: true, vote } or { ok: false, error }. `now` is a ms timestamp.
export function createVote({ id, title, choices: rawChoices, hours, now }) {
  if (!VOTE_ID_RE.test(String(id))) return { ok: false, error: "Bad vote id." };
  const t = String(title === undefined || title === null ? "" : title).trim();
  if (!t) return { ok: false, error: "A vote needs a title." };
  if (t.length > VOTE_MAX_TITLE) return { ok: false, error: `The title must be ${VOTE_MAX_TITLE} characters or fewer.` };
  const parsed = parseChoices(rawChoices);
  if (!parsed.ok) return parsed;
  const h = hours === undefined || hours === null || hours === "" ? VOTE_DEFAULT_HOURS : Number(hours);
  if (!Number.isInteger(h) || h < VOTE_MIN_HOURS || h > VOTE_MAX_HOURS) {
    return { ok: false, error: `closes_in_hours must be a whole number from ${VOTE_MIN_HOURS} to ${VOTE_MAX_HOURS}.` };
  }
  return {
    ok: true,
    vote: {
      id,
      title: t,
      choices: parsed.choices,
      created_at: new Date(now).toISOString(),
      closes_at: new Date(now + h * 3600000).toISOString(),
      ballots: {}, // voterHash -> choice index
    },
  };
}

export function isOpen(vote, now) {
  const closes = Date.parse(vote && vote.closes_at);
  return Number.isFinite(closes) && now < closes;
}

// Records or changes a ballot. Never mutates `vote`. Returns { ok, vote, changed, previous } or { ok: false, error }.
// error is one of: closed, bad_choice, no_voter.
export function castVote(vote, voter, index, now) {
  if (!voter || typeof voter !== "string") return { ok: false, error: "no_voter" };
  if (!isOpen(vote, now)) return { ok: false, error: "closed" };
  if (!Number.isInteger(index) || index < 0 || index >= vote.choices.length) return { ok: false, error: "bad_choice" };
  const ballots = vote.ballots || {};
  const had = Object.prototype.hasOwnProperty.call(ballots, voter);
  const previous = had ? ballots[voter] : null;
  return { ok: true, vote: { ...vote, ballots: { ...ballots, [voter]: index } }, changed: had && previous !== index, previous };
}

export function tally(vote) {
  const counts = vote.choices.map(() => 0);
  for (const idx of Object.values(vote.ballots || {})) {
    if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
  }
  return counts;
}

// The only shape that leaves the Worker over HTTP. No ballots, no hashes.
export function publicView(vote, now) {
  const counts = tally(vote);
  return {
    id: vote.id,
    title: vote.title,
    choices: vote.choices.map((label, i) => ({ label, count: counts[i] })),
    closes_at: vote.closes_at,
    open: isOpen(vote, now),
  };
}

// custom_id forms: `vote:<id>:<index>` and `vote:<id>:results`. Returns null for anything else.
export function parseVoteCustomId(customId) {
  const parts = String(customId).split(":");
  if (parts.length !== 3 || parts[0] !== "vote" || !VOTE_ID_RE.test(parts[1])) return null;
  if (parts[2] === "results") return { id: parts[1], action: "results" };
  if (/^[0-4]$/.test(parts[2])) return { id: parts[1], action: "choice", index: Number(parts[2]) };
  return null;
}

export function tallyLines(vote) {
  const counts = tally(vote);
  return vote.choices.map((c, i) => `${i + 1}. ${c}: **${counts[i]}**`);
}

// Public channel message body (content + button rows) for a vote.
export function renderMessage(vote, now) {
  const open = isOpen(vote, now);
  const closesUnix = Math.floor(Date.parse(vote.closes_at) / 1000);
  const total = tally(vote).reduce((a, b) => a + b, 0);
  const content = [
    `**Vote: ${vote.title}**`,
    ...tallyLines(vote),
    `-# ${total} ${total === 1 ? "vote" : "votes"}. ${open ? `Closes <t:${closesUnix}:R>. Pick again to change your vote.` : "Closed."}`,
  ].join("\n");
  const buttons = vote.choices.map((c, i) => ({ type: 2, style: 1, label: `${i + 1}. ${c}`.slice(0, 80), custom_id: `vote:${vote.id}:${i}`, disabled: !open }));
  buttons.push({ type: 2, style: 2, label: "Results", custom_id: `vote:${vote.id}:results` });
  const components = [];
  for (let i = 0; i < buttons.length; i += 5) components.push({ type: 1, components: buttons.slice(i, i + 5) });
  return { content, components };
}

export function addToIndex(index, id, max = VOTE_INDEX_MAX) {
  const ids = Array.isArray(index && index.ids) ? index.ids.filter((x) => x !== id) : [];
  return { ids: [id, ...ids].slice(0, max) };
}

// kv_state helpers. `db` is the D1 binding.
// The vote document (title, choices, closes_at) lives in kv_state `vote:<id>`; ballots live one per row in vote_ballots (migration 0010).
// Ballots still inside an old document's `ballots` map are read too; a vote_ballots row for the same voter wins.
async function tableBallots(db, ids) {
  if (!ids.length) return [];
  try {
    const r = await db.prepare(`SELECT vote_id, voter_hash, choice FROM vote_ballots WHERE vote_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    return (r && r.results) || [];
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) throw e; // any other D1 error must not silently drop ballots from the totals
    return []; // table not migrated yet: fall back to the document's own ballots
  }
}

function withBallots(vote, rows) {
  const ballots = { ...(vote.ballots && typeof vote.ballots === "object" ? vote.ballots : {}) };
  for (const b of rows) ballots[b.voter_hash] = Number(b.choice);
  return { ...vote, ballots };
}

async function loadDoc(db, id) {
  if (!VOTE_ID_RE.test(String(id))) return null;
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(`vote:${id}`).first();
  if (!row) return null;
  try {
    const v = JSON.parse(row.json);
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

export async function loadVote(db, id) {
  const doc = await loadDoc(db, id);
  return doc ? withBallots(doc, await tableBallots(db, [String(id)])) : null;
}

// Creates the vote document once. Never replaces an existing document and never carries ballots (they are rows).
export async function saveVote(db, vote, now) {
  const at = new Date(now).toISOString();
  const { ballots: _ballots, ...doc } = vote;
  await db.prepare("INSERT INTO kv_state (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(`vote:${vote.id}`, JSON.stringify({ ...doc, ballots: {} }), at).run();
}

// One atomic upsert of one ballot. Two different voters touch two different rows, so neither can overwrite the other.
export async function recordBallot(db, voteId, voter, index, now) {
  await db.prepare(
    "INSERT INTO vote_ballots (vote_id, voter_hash, choice, cast_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(vote_id, voter_hash) DO UPDATE SET choice = excluded.choice, cast_at = excluded.cast_at"
  ).bind(String(voteId), voter, index, new Date(now).toISOString()).run();
}

export async function recordInIndex(db, id, now) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = 'votes:index'").first();
  let current = { ids: [] };
  try { if (row) current = JSON.parse(row.json); } catch {}
  const next = addToIndex(current, id);
  await db.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES ('votes:index', ?, ?)").bind(JSON.stringify(next), new Date(now).toISOString()).run();
}

// Public listing: newest first, public view only.
export async function loadPublicVotes(db, now) {
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = 'votes:index'").first();
  let ids = [];
  try { if (row) ids = JSON.parse(row.json).ids; } catch {}
  ids = (Array.isArray(ids) ? ids : []).filter((id) => VOTE_ID_RE.test(String(id))).slice(0, VOTE_INDEX_MAX);
  const docs = [];
  for (const id of ids) {
    const v = await loadDoc(db, id);
    if (v && Array.isArray(v.choices)) docs.push([id, v]); // one extra read below covers every vote's ballots
  }
  const rows = await tableBallots(db, docs.map(([id]) => id));
  return docs.map(([id, v]) => publicView(withBallots(v, rows.filter((r) => r.vote_id === id)), now));
}
