// Votes for the Discord handler. Pure logic plus thin kv_state helpers that take the D1 binding as an argument.
// Storage (no schema change): kv_state key `vote:<id>` holds one vote as JSON, `votes:index` holds { ids: [newest first] }.
// A voter is stored only as a salted hash, never as the raw Discord user id, and the hash never leaves the Worker.
import { sha256Hex } from "./crypto.js";

export const VOTE_MIN_CHOICES = 2;
export const VOTE_MAX_CHOICES = 5;
export const VOTE_MAX_TITLE = 200;
export const VOTE_MAX_CHOICE = 80; // Discord button labels stop at 80 characters
export const VOTE_DEFAULT_HOURS = 72;
export const VOTE_MIN_HOURS = 1;
export const VOTE_MAX_HOURS = 720;
export const VOTE_INDEX_MAX = 50;
export const VOTE_ID_RE = /^[a-f0-9]{8}$/;

// Per-vote, per-salt hash of a Discord user id. Without a salt it falls back to an unsalted form (like guestIpKey)
// so a missing secret never breaks voting.
export function voterHash(discordId, voteId, salt) {
  const hasSalt = salt !== undefined && salt !== null && String(salt) !== "";
  return sha256Hex(hasSalt ? `${salt}:vote:${voteId}:${discordId}` : `vote:${voteId}:${discordId}`);
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
export async function loadVote(db, id) {
  if (!VOTE_ID_RE.test(String(id))) return null;
  const row = await db.prepare("SELECT json FROM kv_state WHERE key = ?").bind(`vote:${id}`).first();
  if (!row) return null;
  try { return JSON.parse(row.json); } catch { return null; }
}

export async function saveVote(db, vote, now) {
  const at = new Date(now).toISOString();
  await db.prepare("INSERT OR REPLACE INTO kv_state (key, json, updated_at) VALUES (?, ?, ?)").bind(`vote:${vote.id}`, JSON.stringify(vote), at).run();
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
  const votes = [];
  for (const id of ids) {
    const v = await loadVote(db, id);
    if (v && Array.isArray(v.choices)) votes.push(publicView(v, now));
  }
  return votes;
}
