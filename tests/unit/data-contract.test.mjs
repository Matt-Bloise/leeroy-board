import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Contract between the board's code and the REAL data files. On Nov 8 2026 PRs 226 and 227 read `.when` from timeline events; data/tonight.json events have it, data/timeline.json
// events do not, the unit test loaded tonight.json, and production said "Launch night was undefined" for about 20 hours. This test runs the board's own event functions (js/board.js,
// extracted as source, not copied) over each real data file with every event wrapped in a Proxy, and fails when the code reads a property the data does not have and the property is
// not in the list of reads that are guarded on purpose below. A new unguarded read of a missing field fails here before it can render as "undefined".

const src = fs.readFileSync("js/board.js", "utf8").replace(/\r\n/g, "\n"); // LF so the function-end search below cannot miss on a CRLF checkout
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, `function ${name} not found in js/board.js`);
  const eol = src.indexOf("\n", i), first = src.slice(i, eol);
  if (first.trimEnd().endsWith("{")) { const end = src.indexOf("\n}\n", i); return src.slice(i, end + 2); }
  return first;
};
const FNS = ["withWhen", "launchEvent", "launchPast", "nextDated", "settleLaunch", "tonightNext"].filter((n) => src.includes(`function ${n}(`)); // withWhen exists from PR 234 on; older code is run without it so this test can be shown to fail on the buggy version
// Properties the code reads on purpose when they may be absent (each is a guard in the source, e.g. `!e.when` in withWhen, or an optional field).
const GUARDED = new Set(["when", "open_when", "until_epoch", "date", "detail", "format"]);
const IGNORE = new Set(["then", "toJSON", "constructor", "inspect", "nodeType", "length", "asymmetricMatch", "$$typeof"]);

function run(file, nowSec) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")), missed = new Set();
  const wrap = (o) => new Proxy(o, { get(t, k, r) { if (typeof k === "string" && !(k in t) && !IGNORE.has(k)) missed.add(k); return Reflect.get(t, k, r); } });
  const events = raw.events.map(wrap);
  const party = JSON.parse(fs.readFileSync("data/party.json", "utf8"));
  const D = { party, timeline: { events } };
  const ctx = { D, Date: { now: () => nowSec * 1000 }, fmtWhen: (epoch) => `WHEN(${epoch})` };
  vm.runInNewContext(FNS.map(grab).join("\n") + "\nthis.out={launchPast,nextDated,settleLaunch,tonightNext,launchEvent};", ctx);
  const o = ctx.out, texts = [];
  o.launchPast(); const nx = o.nextDated(); if (nx) texts.push(String(nx.when), String(nx.label));
  const le = o.launchEvent(); if (le) texts.push(String(le.when));
  o.settleLaunch(); texts.push(JSON.stringify(D.party.settled_extra || []));
  if (file.endsWith("tonight.json")) { const tn = o.tonightNext({ events }); if (tn) texts.push(String(tn.when), String(tn.label)); } // the tonight scene picks from tonight.json only; its pick is rendered, not discarded
  return { missed, texts };
}

const LAUNCH = JSON.parse(fs.readFileSync("data/timeline.json", "utf8")).events.find((e) => e.key === "launch").epoch;
for (const file of ["data/timeline.json", "data/tonight.json"]) {
  for (const [label, now] of [["before launch", LAUNCH - 3600], ["after launch", LAUNCH + 86400], ["after every dated event", LAUNCH + 90 * 86400]]) {
    test(`board code reads only fields ${file} has, and renders no undefined (${label})`, () => {
      const { missed, texts } = run(file, now);
      const unguarded = [...missed].filter((k) => !GUARDED.has(k));
      assert.deepEqual(unguarded, [], `js/board.js read ${unguarded.join(", ")} from ${file} events but the data has no such field. Guard the read or add the field.`);
      for (const t of texts) assert.doesNotMatch(t, /undefined|null|NaN/, `rendered text contains a junk word: ${t.slice(0, 120)}`);
    });
  }
}
test("every real timeline and tonight event has a key and a numeric epoch or a date", () => {
  for (const file of ["data/timeline.json", "data/tonight.json"]) for (const e of JSON.parse(fs.readFileSync(file, "utf8")).events) assert.ok(typeof e.key === "string" && (Number.isFinite(e.epoch) || typeof e.date === "string"), `${file}: event ${JSON.stringify(e).slice(0, 80)} lacks key and epoch or date`);
});
