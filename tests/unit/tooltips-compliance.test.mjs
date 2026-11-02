// Tooltip text guard. data/library/tooltips.json must not ship verbatim game tooltip prose (Wowhead is link-only).
// Numbers, names and our own composed `desc` line are fine. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize, DESC_MAX } from "../../tools/tooltips-compliance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tips = JSON.parse(fs.readFileSync(path.join(root, "data/library/tooltips.json"), "utf8"));
const client = JSON.parse(fs.readFileSync(path.join(root, "data/client.json"), "utf8"));

test("no shipped tooltip carries a desc longer than 160 characters", () => {
  assert.equal(DESC_MAX, 160);
  const bad = tips.tooltips.filter((t) => t.desc !== undefined && (typeof t.desc !== "string" || t.desc.length === 0 || t.desc.length > 160));
  assert.deepEqual(bad.map((t) => t.id), []);
});

test("no shipped tooltip keeps verbatim text under any field", () => {
  const allowed = new Set(["id", "kind", "name", "rank", "level", "quality", "url", "lines", "desc"]);
  const fails = [];
  for (const t of tips.tooltips) {
    for (const k of Object.keys(t)) if (!allowed.has(k)) fails.push(`${t.id}: unexpected field ${k}`);
    if (!/^https:\/\/www\.wowhead\.com\/forever\/(?:spell|item)=\d+$/.test(t.url)) fails.push(`${t.id}: url must be a Wowhead Forever link`);
    if (!Array.isArray(t.lines)) fails.push(`${t.id}: lines must be an array`);
    for (const l of t.lines || []) {
      if (l.length > 45) fails.push(`${t.id}: line over 45 chars (prose?): ${l.slice(0, 50)}`);
      if (/^(?:["“]|Equip:|Use:|Chance on hit:)/.test(l)) fails.push(`${t.id}: effect or flavour prose line: ${l}`);
      if (t.kind === "spell" && /[a-z]{3,} [a-z]{3,} [a-z]{3,}/.test(l)) fails.push(`${t.id}: sentence-like spell line: ${l}`);
    }
  }
  assert.deepEqual(fails, []);
});

test("the sanitizer is idempotent and drops description sentences", () => {
  const raw = { id: "spell-1", kind: "spell", name: "X", rank: null, level: 1, quality: null, url: "https://www.wowhead.com/forever/spell=1", lines: ["30 Mana", "35 yd range", "Requires Mage", "Requires level 1", "Hurls a fiery ball that causes 15 to 23 Fire damage."] };
  const once = sanitize(raw);
  assert.deepEqual(once.lines, ["30 Mana", "35 yd range", "Requires Mage", "Requires level 1"]);
  assert.equal(once.desc, "Mage spell, level 1. Deals 15 to 23 Fire damage.");
  assert.deepEqual(sanitize(once), once);
  assert.deepEqual(tips.tooltips.map(sanitize), tips.tooltips);
});

test("client flag tooltips.text exists and defaults to off", () => {
  assert.equal(client.flags["tooltips.text"], false);
});
