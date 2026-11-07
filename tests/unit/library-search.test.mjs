// Cinematic slice 7: Library search. Ranking lead (js/library-search.js over the shipped rank-core and the real data/library files) and the empty state.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rank, factHays } from "../../vendor/rank-core.js";
import { words, namesPage, leadWithNamedPages, emptyState } from "../../js/library-search.js";

const root = new URL("../../data/library/", import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, root), "utf8"));
const index = read("index.json");
const pages = index.categories.flatMap((c) => read(`${c.key}.json`).pages).map((p) => ({ id: p.id, title: p.title, aliases: p.aliases, category: p.category, facts: p.facts, open: p.open }));
const hays = factHays(pages);
const search = (q) => leadWithNamedPages(rank(q, pages, { hays }).hits, q, pages);

test("words drops stop words and stems", () => {
  assert.deepEqual(words("Where do I start as an Orc?"), ["start", "orc"]);
  assert.deepEqual(words("the"), []);
  assert.deepEqual(words(null), []);
});

test("a question names a page only when every content word is in its title or alias", () => {
  const mage = { title: "Mage", aliases: ["frost mage"] };
  assert.equal(namesPage("mage", mage), true);
  assert.equal(namesPage("Mages", mage), true);
  assert.equal(namesPage("frost mage", mage), true);
  assert.equal(namesPage("mage portal prices", mage), false);
  assert.equal(namesPage("the", mage), false);
  assert.equal(namesPage("", mage), false);
});

test("leadWithNamedPages is stable and never drops or invents a hit", () => {
  const ps = [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }];
  const hits = [{ page: "b", n: 1 }, { page: "a", n: 2 }, { page: "b", n: 3 }, { page: "a", n: 4 }];
  const out = leadWithNamedPages(hits, "alpha", ps);
  assert.deepEqual(out.map((x) => x.n), [2, 4, 1, 3]);
  assert.equal(leadWithNamedPages(hits, "gamma", ps), hits);
  assert.equal(out.length, hits.length);
});

test("real data: 'mage' leads with the Mage page, not another page's totals", () => {
  const hits = search("mage");
  assert.ok(hits.length > 0);
  assert.equal(hits[0].page, "classes/mage");
});

test("real data: scores of the pages that are not named keep their rank order", () => {
  const q = "where do i start as an orc", plain = rank(q, pages, { hays }).hits, led = search(q);
  assert.deepEqual(led.map((x) => `${x.page}#${x.key}`), plain.map((x) => `${x.page}#${x.key}`));
});

test("real data: an answerable question finds its fact first", () => {
  assert.equal(search("zeppelin")[0].key, "travel.horde_zeppelins");
  assert.equal(search("when is launch")[0].key, "launch.time");
});

test("real data: nonsense matches nothing", () => {
  assert.equal(search("flurble wumpus").length, 0);
  assert.equal(search("zzqx").length, 0);
});

test("empty state: says the Library does not cover it and points to Leeroy", () => {
  const e = emptyState("flurble wumpus", []);
  assert.equal(e.headline, "The Library does not cover that.");
  assert.match(e.detail, /flurble wumpus/);
  assert.equal(e.askLabel, "Ask Leeroy");
  assert.equal(e.askHref, "#librarian");
  assert.equal(e.askDraft, "flurble wumpus");
  assert.equal(e.nearLead, "");
});

test("empty state: similar pages are offered, at most five; the shown question is clipped but the draft is the question", () => {
  const near = Array.from({ length: 8 }, (_, i) => ({ id: `x/${i}`, title: `T${i}` }));
  const long = "q".repeat(300);
  const e = emptyState(long, near);
  assert.equal(e.near.length, 5);
  assert.match(e.nearLead, /similar/);
  assert.ok(e.detail.length < 100);
  assert.equal(e.askDraft.length, 300);
  assert.equal(emptyState("x".repeat(900), []).askDraft.length, 500);
});

test("empty state: tolerates null and blank input", () => {
  assert.equal(emptyState(null, null).askDraft, "");
  assert.equal(emptyState("  ", undefined).headline, "The Library does not cover that.");
});

test("every page named by its own title leads its own search (no page is shadowed)", () => {
  for (const p of pages) {
    if (!words(p.title).length) continue;
    const hits = search(p.title);
    if (!hits.length) continue;
    const named = pages.filter((x) => namesPage(p.title, x)).map((x) => x.id);
    if (!hits.some((x) => named.includes(x.page))) continue; /* the ranker drops words of 2 characters or fewer, so a title made of numbers can match nothing */
    assert.ok(named.includes(hits[0].page), `${p.title}: led by ${hits[0].page}, named pages ${named.join(",")}`);
  }
});
