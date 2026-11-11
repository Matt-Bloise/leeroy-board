// Static SCAN of the add-on Lua (not a compile, not execution): block balance and Lua 5.2+/non-WoW syntax.
// Lua is not installed in CI or on the build PC, so this catches typos and forbidden syntax only.
// Run: node --test tests/unit/addon-lua-scan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dirs = ["LeeroyBuild", "LeeroySpike"].map((d) => new URL(`../../addon/${d}/`, import.meta.url));

// Remove comments and string literals so keywords inside them are not counted.
export function stripLua(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "--") {
      const m = /^--\[(=*)\[/.exec(src.slice(i));
      if (m) {
        const close = "]" + m[1] + "]";
        const end = src.indexOf(close, i + m[0].length);
        i = end < 0 ? src.length : end + close.length;
      } else {
        while (i < src.length && src[i] !== "\n") i++;
      }
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") break;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    const lm = /^\[(=*)\[/.exec(src.slice(i, i + 10));
    if (ch === "[" && lm) {
      const close = "]" + lm[1] + "]";
      const end = src.indexOf(close, i + lm[0].length);
      i = end < 0 ? src.length : end + close.length;
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function scanLua(src) {
  const code = stripLua(src);
  const problems = [];
  const words = code.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  // Openers: function, if, do (for/while consume their own do), repeat pairs with until.
  let open = 0, repeats = 0;
  for (const w of words) {
    if (w === "function" || w === "if" || w === "do") open++;
    else if (w === "end") open--;
    else if (w === "repeat") repeats++;
    else if (w === "until") repeats--;
    if (open < 0) { problems.push("end without opener"); break; }
  }
  if (open !== 0) problems.push(`unbalanced blocks: ${open > 0 ? open + " unclosed" : -open + " extra end"}`);
  if (repeats !== 0) problems.push("unbalanced repeat/until");
  // then/do pairing sanity: every if/elseif needs a then.
  const ifs = words.filter((w) => w === "if" || w === "elseif").length;
  const thens = words.filter((w) => w === "then").length;
  if (ifs !== thens) problems.push(`if/elseif (${ifs}) vs then (${thens})`);
  const loops = words.filter((w) => w === "for" || w === "while").length;
  const dos = words.filter((w) => w === "do").length;
  if (dos !== loops) problems.push(`for/while (${loops}) vs do (${dos})`);
  // Forbidden / non-5.1 constructs.
  if (words.includes("goto")) problems.push("goto");
  if (words.includes("utf8")) problems.push("utf8 library");
  if (/::/.test(code)) problems.push("label ::");
  if (/\/\//.test(code)) problems.push("// integer division");
  if (/<<|>>/.test(code)) problems.push("shift operator");
  if (/[^|]\|[^|]/.test(code) || /&/.test(code)) problems.push("bitwise operator");
  if (/~[^=]/.test(code)) problems.push("bitwise not");
  if (/\bbit\.|\bbit32\b/.test(code)) problems.push("bit library");
  if (/!=/.test(code)) problems.push("!= (use ~=)");
  if (/\+=|-=|\*=/.test(code)) problems.push("compound assignment");
  if (/\bcontinue\b/.test(words.join(" ")) && words.includes("continue")) problems.push("continue");
  return problems;
}

for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".lua"))) {
    test(`lua scan: ${dir.pathname.split("/").filter(Boolean).pop()}/${f}`, () => {
      assert.deepEqual(scanLua(readFileSync(new URL(f, dir), "utf8")), []);
    });
  }
}

test("lua scan catches planted problems", () => {
  assert.ok(scanLua("function f()\n if x then\n end\n").length > 0);
  assert.ok(scanLua("local x = 7 // 2").includes("// integer division"));
  assert.ok(scanLua("goto done").includes("goto"));
  assert.deepEqual(scanLua('local s = "end function if" -- end\nlocal t = [[ do ]]'), []);
  assert.ok(scanLua("for i = 1, 2 do x() end end").length > 0);
});

test("toc files list existing files and use a numeric interface", () => {
  const dir = dirs[0];
  for (const t of readdirSync(dir).filter((n) => n.endsWith(".toc"))) {
    const lines = readFileSync(new URL(t, dir), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    assert.match(lines[0], /^## Interface: [1-9]\d+$/);
    for (const l of lines.filter((x) => !x.startsWith("##"))) {
      assert.doesNotThrow(() => readFileSync(new URL(l, dir)), `${t} lists missing ${l}`);
    }
  }
  assert.match(readFileSync(new URL("LeeroySpike.toc", dirs[1]), "utf8").split("\n")[0], /^## Interface: 16001/);
});

test("consent: no character data is collected on login in either add-on", () => {
  const spike = stripLua(readFileSync(new URL("LeeroySpike.lua", dirs[1]), "utf8"));
  const onEvent = spike.slice(spike.indexOf('f:SetScript("OnEvent"'));
  assert.ok(!/snapshot\s*\(/.test(onEvent), "spike OnEvent must not call snapshot()");
  const core = stripLua(readFileSync(new URL("LeeroyBuild.lua", dirs[0]), "utf8"));
  // LeeroyBuildDB may only receive the option ticks.
  const writes = core.match(/LeeroyBuildDB\.\w+\s*=[^=]/g) || [];
  assert.ok(writes.every((w) => w.startsWith("LeeroyBuildDB.enabled")), writes.join("|"));
  assert.ok(!/Fields\.collect/.test(core.slice(core.indexOf("local loader"))), "no collection in the event loader");
});

test("professions: positions 1 and 2 are tested independently (no ipairs over a table with a nil hole)", () => {
  for (const [dir, f] of [[dirs[0], "LeeroyBuild_Fields.lua"], [dirs[1], "LeeroySpike.lua"]]) {
    const src = stripLua(readFileSync(new URL(f, dir), "utf8"));
    assert.ok(!/ipairs\s*\(\s*\{\s*p1\s*,\s*p2\s*\}\s*\)/.test(src), f);
    assert.ok(/for slot = 1, 2 do/.test(src), f);
  }
});

test("level above 60 is exported as-is (importer rejects it)", () => {
  const src = readFileSync(new URL("LeeroyBuild_Fields.lua", dirs[0]), "utf8");
  assert.ok(!/lvl <= 60/.test(src));
});
