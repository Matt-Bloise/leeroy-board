// Council round 3 on PR 210 (Codex): spelled-out numbers in the ANSWER must be validated like digits, and a clock equivalent must come only from a clock
// expression, never from a bare number. Pure functions, fictional text. Run: node --test tests/unit/self-rag-numbers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { supportCheck } from "../../infrastructure/worker/self-rag.js";

const ok = (answer, grounding) => { const r = supportCheck(answer, grounding); assert.equal(r.ok, true, `${answer} | grounding ${grounding} | unsupported ${r.unsupported}`); };
const bad = (answer, grounding) => { const r = supportCheck(answer, grounding); assert.equal(r.ok, false, `${answer} | grounding ${grounding}`); return r; };

test("a spelled-out number in the answer is checked like digits", () => {
  bad("**Entry requires level seventy.**\n- Bring friends.", "Entry requires level sixty.");
  bad("**Entry requires level seventy.**\n- Bring friends.", "Entry requires level 60.");
  bad("**It needs twenty-six players.**\n- Bring friends.", "The raid group is 25.");
  bad("**A wipe costs two hundred gold.**\n- Bring friends.", "A wipe costs 20 gold.");
  bad("**It takes ten minutes.**\n- Bring friends.", "It takes a while.");
  const r = bad("**Entry requires level seventy.**\n- Bring friends and a healer.", "Entry requires level sixty.");
  assert.ok(!/seventy/.test(r.answer) && /Bring friends/.test(r.answer), r.answer);
});

test("a spelled-out number the grounding supports passes, in digits or words, compounds included", () => {
  ok("**You need level sixty.**", "Entry requires level 60.");
  ok("**You need level 60.**", "Entry requires level sixty.");
  ok("**The group is twenty-five players.**", "The raid group is 25.");
  ok("**The group is 25 players.**", "The raid group is twenty-five.");
  ok("**A wipe costs two hundred gold.**", "A wipe costs 200 gold.");
  ok("**It opens in the one boss room with two doors.**", "The keep is hard."); // 1 and 2 are counting words
  ok("**Two bosses, three doors, five keys.**", "The keep is hard.");
});

test("a clock equivalent comes only from a clock expression, never from a bare number", () => {
  bad("**It costs 20 gold.**\n- Bring friends.", "It costs 8 gold.");
  bad("**It costs 8 gold.**\n- Bring friends.", "It costs 20 gold.");
  bad("**You need level 8.**\n- Bring friends.", "You need level 20.");
  bad("**You need level 20.**\n- Bring friends.", "You need level 8.");
  bad("**It costs 14 gold.**\n- Bring friends.", "It costs 2 gold and 14:00 is late.".replace("14:00", "evening"));
  // recognised clock expressions authorise both readings
  ok("**It starts at 8 PM.**", "Doors open at 20:00.");
  ok("**It starts at 20:00.**", "Doors open at 8pm.");
  ok("**It starts at 8 o'clock.**", "Doors open at 20:00.");
  ok("**It starts at 20:30.**", "Doors open at 8:30 PM.");
  ok("**It starts at 6 PM.**", "Doors open at 18:00 ET (3 PM PT).");
  // and only the hour: another hour is still wrong
  bad("**It starts at 9 PM.**\n- Bring friends.", "Doors open at 8pm.");
  // the clock's own hour does not authorise the same number as a quantity elsewhere unless it is that hour
  bad("**It costs 21 gold.**\n- Bring friends.", "Doors open at 8pm.");
});

test("previous behaviours stay: dates, thousands, ranges, wrong numbers, counting words", () => {
  const fact = "The keep opens on 2026-12-09 and a wipe costs 10,000 gold; it takes 5 to 7 hours.";
  ok("**It opens on December 9.**", fact);
  ok("**A wipe costs 10k gold.**", fact);
  ok("**Plan on about 6 hours.**", fact);
  bad("**It opens on December 10.**\n- Bring friends.", fact);
  bad("**Plan on about 11 hours.**\n- Bring friends.", fact);
});
