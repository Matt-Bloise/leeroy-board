// tools/render-legal.mjs: the markdown subset, escaping, and that the committed pages are current. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, inline, build } from "../../tools/render-legal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("headings, paragraphs, lists, bold, code, links and tables render", () => {
  const { html, title } = render("# T\n\nA **b** and `c<d>` [x](https://e.com/?a=1&b=2).\nSecond line.\n\n- one\n- two\n\n| H1 | H2 |\n| :-- | --- |\n| a | b |\n");
  assert.equal(title, "T");
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<p>A <strong>b<\/strong> and <code>c&lt;d&gt;<\/code> <a href="https:\/\/e\.com\/\?a=1&amp;b=2">x<\/a>\. Second line\.<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<th scope="col">H1<\/th>.*<td>a<\/td><td>b<\/td>/s);
});

test("raw HTML and script URLs never survive", () => {
  assert.equal(inline("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.ok(!/<a /.test(inline("[x](javascript:alert(1))")));
  assert.ok(!/<a /.test(inline("[x](data:text/html,hi)")));
  assert.ok(!/<img/.test(render("<img src=x onerror=alert(1)>").html));
});

test("both pages build with one h1, a back link, and the committed files are current", () => {
  for (const { out, html } of build(root)) {
    assert.equal((html.match(/<h1>/g) || []).length, 1, out);
    assert.match(html, /<a class="back" href="\/">Back to the board<\/a>/);
    assert.ok(!/noindex/.test(html), out);
    assert.equal(fs.readFileSync(path.join(root, out), "utf8"), html, `${out} is stale: run node tools/render-legal.mjs`);
  }
});
