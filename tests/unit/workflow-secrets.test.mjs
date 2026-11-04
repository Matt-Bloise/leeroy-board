// Guard for docs/runbooks/ci-secrets.md: a workflow that a pull request can trigger must never reference a production secret,
// and the production deploy must run in the GitHub environment `production`. Needs the `yaml` package (tests/package.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const DIR = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const fromText = (f, text) => ({ f, text, doc: parse(text) });
// `§` stands for `$` so fixtures can be written without template interpolation.
const fx = (f, text) => fromText(f, text.replaceAll("§", "$"));
const load = (f) => fromText(f, readFileSync(DIR + f, "utf8"));
const workflows = files.map(load);

// Triggers that run code from a pull request (or its fork). `workflow_run` is included: it can be started by a PR workflow and read secrets with the PR's artifacts.
const PR_TRIGGERS = ["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment", "workflow_run"];
// The only secrets a PR-triggered workflow may name. GITHUB_TOKEN is per run; CLOUDFLARE_ACCOUNT_ID is an identifier, not a credential.
// CLOUDFLARE_API_TOKEN (the production Cloudflare token) is allowed ONLY in the jobs listed in TOKEN_JOBS, one occurrence each, by decision of the Cloudflare
// account owner (previews share the production Cloudflare token; there is no CLOUDFLARE_PREVIEW_API_TOKEN). BOARD_ADMIN_TOKEN and every other production secret stay forbidden.
const PR_ALLOWED = new Set(["GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN", "BOARD_PREVIEW_ADMIN_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
const TOKEN_JOBS = {
  "pr-preview-cloudflare.yml": { "preview-guard": 1, "deploy-pr-preview": 1, "teardown-pr-preview": 1 },
  "preview-tests.yml": { "preview-secrets": 1 },
};
const TOKEN_RE = /(?<![\w.\/-])secrets\.CLOUDFLARE_API_TOKEN\b/g;
// Production secrets: deploy-cloudflare.yml reads these from the environment `production` only.
const PRODUCTION = ["BOARD_ADMIN_TOKEN", "USER_SALT", "KEY_SALT", "AI_GATEWAY_TOKEN", "CLOUDFLARE_AIG_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "GROQ_API_KEY", "CEREBRAS_API_KEY", "GITHUB_MODELS_TOKEN", "OPENROUTER_API_KEY", "DISCORD_WEBHOOK_URL", "DISCORD_PUBLIC_KEY", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"];

const triggers = (doc) => { const on = doc.on ?? doc[true]; return typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on || {}); };
// B46: NOTHING is stripped. A `#` line inside a block scalar, a multiline quoted scalar or a heredoc is content that GitHub Actions still expands, and any inline-`#` rule can be
// tricked by quoting, so every reference anywhere in the file text counts, comments included. A comment that mentions a secret must be reworded.
// B46 (council on 6cd1991): a double-quoted YAML scalar is RESOLVED before Actions evaluates it, so a backslash-newline fold or a \u escape can hide `secrets.X` from a regex over the raw
// text. Forbidden references are therefore scanned in the UNION of the raw text (comments included) and every parsed string (keys and values). REQUIRED commands are checked against the
// parsed `run:` strings only, so a comment cannot satisfy a requirement.
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [String(k), ...strings(x)]) : []);
const parsedText = (w) => strings(w.doc).join("\n");
const scanText = (w) => w.text + "\n" + parsedText(w);
// B60: REQUIRED-command checks (and only those) strip shell comments from a run: script first, so `# npm ci --no-audit --no-fund` then `echo skipped` does not satisfy a requirement.
// Forbidden-secret scans never use this: they read the raw text and the unstripped parsed strings. A `#` starts a comment only outside quotes, at the start of a word (so `$#`, `${#a}`,
// `${a#b}` and `a#b` are kept), and a backslash escapes the next character. `$'...'` honours backslash escapes. A heredoc body (`<<EOF`, `<<-EOF`, `<<'EOF'`) is copied verbatim up to its
// delimiter line, with no quote or comment handling, so an apostrophe in it cannot unbalance the quote state; text in a heredoc body is data that counts as present (a known gap: it is not run).
const stripShellComments = (script) => {
  let out = "", q = "", brace = 0, arith = 0;
  const pending = [];
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === "\n" && !q && pending.length) {
      out += c; i++;
      for (const { tag, dash } of pending.splice(0)) {
        while (i < script.length) {
          let e = script.indexOf("\n", i); if (e < 0) e = script.length;
          const line = script.slice(i, e);
          out += line + (e < script.length ? "\n" : ""); i = e + 1;
          if ((dash ? line.replace(/^\t+/, "") : line).trimEnd() === tag) break;
        }
      }
      i--; continue;
    }
    if (!q && c === "\\") { out += c + (script[i + 1] ?? ""); i++; continue; }
    if (q === "'") { if (c === "'") q = ""; out += c; continue; }
    if (q === "$'") { if (c === "\\") { out += c + (script[i + 1] ?? ""); i++; continue; } if (c === "'") q = ""; out += c; continue; }
    if (q === '"' && c === "\\") { out += c + (script[i + 1] ?? ""); i++; continue; }
    if (c === "$" && script[i + 1] === "'" && !q) { q = "$'"; out += "$'"; i++; continue; }
    if (c === "'" && q !== '"') { q = "'"; out += c; continue; }
    if (c === '"') { q = q === '"' ? "" : '"'; out += c; continue; }
    if (!q && (script.startsWith("$((", i) || (script.startsWith("((", i) && (i === 0 || /[\s;&|(]/.test(script[i - 1]))))) { arith++; const n = script[i] === "$" ? 3 : 2; out += script.slice(i, i + n); i += n - 1; continue; }
    if (!q && arith && script.startsWith("))", i)) { arith--; out += "))"; i++; continue; }
    if (!q && !arith && c === "<" && script[i + 1] === "<" && script[i + 2] !== "<" && script[i - 1] !== "<") {
      // The delimiter word may be quoted or escaped in parts (<<'EOF', <<"EOF", <<\EOF, <<E'OF'); the tag is the word with the quoting removed.
      const m = /^<<(-?)[ \t]*((?:\\[^\n]|'[^']*'|"[^"]*"|[^\s;|&<>()'"\\])+)/.exec(script.slice(i));
      const tag = m && m[2].replace(/\\([^\n])/g, "$1").replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1");
      if (m && tag) { pending.push({ tag, dash: m[1] === "-" }); out += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "$" && script[i + 1] === "{") { brace++; out += "${"; i++; continue; }
    if (brace && c === "}") { brace--; out += c; continue; }
    if (c === "#" && !q && !brace && (i === 0 || /[\s;&|()]/.test(script[i - 1]))) { while (i + 1 < script.length && script[i + 1] !== "\n") i++; continue; }
    out += c;
  }
  return out;
};
const runCode = (t) => stripShellComments(t.run || "");
const runs = (w) => Object.values(w.doc.jobs || {}).flatMap((j) => (j.steps || []).map(runCode)).join("\n");
const secretNames = (text) => [...text.matchAll(/(?<![\w.\/-])secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);

test("the workflow directory is found and parsed", () => {
  assert.ok(workflows.length >= 5);
  assert.ok(workflows.some((w) => w.f === "preview-tests.yml") && workflows.some((w) => w.f === "pr-preview-cloudflare.yml"));
});

for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) {
  test(`${w.f} (PR-triggered) names no production secret`, () => {
    const bad = secretNames(scanText(w)).filter((n) => !PR_ALLOWED.has(n));
    assert.deepEqual([...new Set(bad)], [], `${w.f} references secrets a pull request must not read`);
    const c = scanText(w);
    for (const n of PRODUCTION) assert.equal(new RegExp(`(?<![\\w./-])secrets\\.${n}\\b`).test(c), false, `${w.f} reads production secret ${n}`);
    assert.equal(/CLOUDFLARE_PREVIEW_API_TOKEN/.test(c), false, `${w.f}: CLOUDFLARE_PREVIEW_API_TOKEN is not part of the design (previews use CLOUDFLARE_API_TOKEN)`);
    assert.equal(/\benvironment\s*:\s*production\b/.test(c), false, "a PR-triggered workflow must not use the production environment");
  });
}

// B60: the broad-exposure rules run on EVERY workflow file, PR-triggered or not (a production deploy has no reason to enumerate secrets either; it names each one).
// Expressions: every `${{ ... }}` in the raw text and in the parsed strings, plus every parsed `if:` value (which Actions evaluates as an expression without the wrapper). String literals are
// blanked first. Inside an expression the identifier `secrets` is fine only when it is followed by `.NAME` (a named secret); anything else (`toJSON((secrets))`, `true && secrets`,
// `secrets || github`, `format('{0}', secrets)`, `secrets[...]`, `secrets.*`) hands over the whole context or hides the name.
const expressions = (w) => {
  const found = [], seen = new Set();
  const add = (e) => { if (!seen.has(e)) { seen.add(e); found.push(e); } };
  for (const t of [w.text, parsedText(w)]) for (const m of t.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) add(m[1]);
  (function walk(v) { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "if" && typeof x === "string") add(x.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1")); walk(x); } })(w.doc);
  return found;
};
const bareSecrets = (w) => expressions(w).map((e) => e.replace(/'(?:[^']|'')*'/g, "''")).filter((e) => /(?<![\w.\-])secrets\b(?!\s*\.\s*[A-Za-z_])/i.test(e));
const BROAD = [
  ["indexed secrets access hides the name", (w) => /(?<![\w.\/-])secrets\s*\[/i.test(scanText(w))],
  ["toJSON(secrets) exposes every secret", (w) => /toJSON\(\s*secrets\s*\)/i.test(scanText(w))],
  ["the whole secrets context is passed on (a bare `secrets` in an expression)", (w) => bareSecrets(w).length > 0],
  ["secrets.* exposes every secret", (w) => /(?<![\w.\/-])secrets\s*\.\s*\*/i.test(scanText(w))],
  // Raw text first; then the PARSED document, which resolves quoting (`secrets: "inherit"`), quoted keys, tags (`!!str inherit`) and aliases (`secrets: *a`) that a raw-text regex cannot see.
  ["secrets: inherit passes every secret to a called workflow", (w) => /(?<![\w.\/-])secrets\s*:\s*inherit\b/i.test(w.text) || inheritsSecrets(w.doc)],
];
const inheritsSecrets = (v) => !!v && typeof v === "object" && Object.entries(v).some(([k, x]) => (k === "secrets" && typeof x === "string" && x.trim().toLowerCase() === "inherit") || inheritsSecrets(x));
const broadSecretUse = (w) => BROAD.filter(([, f]) => f(w)).map(([why]) => why);
const broadFindings = (ws) => ws.flatMap((w) => broadSecretUse(w).map((why) => `${w.f}: ${why}`));
const bw = (text) => { try { return fx("t.yml", text); } catch { return { f: "t.yml", text, doc: null }; } };
test("no workflow file has indexed secrets access, toJSON(secrets), secrets.* or secrets: inherit", () => {
  assert.deepEqual(broadFindings(workflows), []);
});

test("the broad-exposure rules each catch their pattern (revert-failing: dropping a rule fails here)", () => {
  // Each case names the rule that must fire; other rules may overlap (a bare `secrets` also fires on toJSON(secrets)), so the NAMED rule is asserted, not the count.
  const cases = {
    "indexed single quote": ["indexed secrets access", "run: echo ${{ secrets['BOARD_ADMIN_TOKEN'] }}"],
    "indexed with spaces": ["indexed secrets access", "run: echo ${{ secrets [ 'X' ] }}"],
    "toJSON": ["toJSON(secrets)", "env:\n  ALL: ${{ toJSON(secrets) }}"],
    "toJSON spaced and lower case": ["toJSON(secrets)", "env:\n  ALL: ${{ tojson( secrets ) }}"],
    "secrets.*": ["secrets.* exposes", "run: echo ${{ join(secrets.*, ' ') }}"],
    "secrets.* spaced": ["secrets.* exposes", "run: echo ${{ join(secrets . * , ' ') }}"],
    "secrets: inherit": ["secrets: inherit", "jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit"],
    "secrets : inherit spaced": ["secrets: inherit", "    secrets  :  inherit"],
  };
  for (const [name, [rule, text]] of Object.entries(cases)) assert.ok(broadSecretUse(bw(text)).some((x) => x.includes(rule)), name);
  for (const ok of ["run: echo ${{ secrets.GITHUB_TOKEN }}", "secrets:\n  X: ${{ secrets.X }}", "run: echo secrets_inherit", "run: echo mysecrets[0]"]) assert.deepEqual(broadSecretUse(bw(ok)), [], ok);
  const wholeContext = {
    "double parentheses": "run: echo ${{ toJSON((secrets)) }}",
    "and-expression": "run: echo ${{ toJSON(true && secrets) }}",
    "or-expression": "run: echo ${{ toJSON(secrets || github) }}",
    "format": "run: echo ${{ format('{0}', secrets) }}",
    "in an if: without the wrapper": "jobs:\n  a:\n    if: toJSON(secrets) != ''\n    steps:\n      - run: echo hi\n",
    "line continuation in a double-quoted scalar": String.raw`run: "echo §{{ toJSON((sec\
        rets)) }}"`,
  };
  for (const [name, text] of Object.entries(wholeContext)) {
    const found = broadSecretUse(bw(text));
    assert.ok(found.some((x) => /whole secrets context/.test(x)), name);
  }
  for (const ok of ["run: echo ${{ secrets.X }} ${{ github.token }}", "run: echo ${{ secrets . X }}", "run: echo ${{ format('{0}', 'secrets') }}", "run: echo ${{ inputs.secrets }}", "run: echo ${{ github.event.secrets }}", "run: echo secrets"]) assert.deepEqual(bareSecrets(bw(ok)), [], ok);
  // Forms a raw-text regex misses; only the parsed-document check sees them.
  const call = (v, pre = "") => `${pre}jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: ${v}\n`;
  const parsedOnly = {
    "double-quoted value": call('"inherit"'),
    "single-quoted value": call("'inherit'"),
    "!!str tag": call("!!str inherit"),
    "quoted key": 'jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    "secrets": inherit\n',
    "alias to an anchored value": "x: &a inherit\n" + call("*a"),
  };
  for (const [name, text] of Object.entries(parsedOnly)) {
    const w = bw(text);
    assert.ok(broadSecretUse(w).includes("secrets: inherit passes every secret to a called workflow"), name);
  }
  assert.deepEqual(broadSecretUse(bw(call("{ X: ${{ secrets.X }} }"))), [], "a mapping of named secrets is fine");
  // Not limited to PR-triggered workflows: a push-only workflow is flagged. broadFindings is what the real-workflow test runs.
  const pushOnly = fx("push.yml", "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets['X'] }}\n");
  assert.equal(triggers(pushOnly.doc).some((t) => PR_TRIGGERS.includes(t)), false);
  assert.ok(broadFindings([pushOnly]).includes("push.yml: indexed secrets access hides the name"));
  const folded = fx("f.yml", String.raw`jobs:
  a:
    steps:
      - run: "echo §{{ toJSON(\
          secrets) }}"
`);
  assert.equal(/toJSON\(\s*secrets\s*\)/i.test(folded.text), false, "the fixture hides toJSON(secrets) from the raw text");
  assert.ok(broadSecretUse(folded).includes("toJSON(secrets) exposes every secret"), "the parsed strings catch it");
});

test("no workflow uses pull_request_target", () => {
  for (const w of workflows) assert.equal(triggers(w.doc).includes("pull_request_target"), false, `${w.f} uses pull_request_target`);
});

test("the production deploy runs in the environment production and is not PR-triggered", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.ok(w);
  assert.equal(triggers(w.doc).some((t) => PR_TRIGGERS.includes(t)), false);
  const job = w.doc.jobs["deploy-production"];
  assert.equal(job.environment, "production");
  assert.equal(job.if, "github.ref == 'refs/heads/master'");
});

test("only the production deploy reads production secrets", () => {
  for (const w of workflows.filter((x) => x.f !== "deploy-cloudflare.yml")) {
    const bad = secretNames(scanText(w)).filter((n) => PRODUCTION.includes(n));
    assert.deepEqual([...new Set(bad)], [], `${w.f} reads production secrets outside the production environment`);
  }
});

test("the deploy installs wrangler from the lockfile, with an exact version", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.match(runs(w), /npm ci --no-audit --no-fund/, "the install step itself, not a comment");
  assert.equal(/npm install\b/.test(scanText(w)), false);
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package.json", import.meta.url)), "utf8"));
  assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/, "wrangler must be an exact version, no ^ or ~");
  const lock = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package-lock.json", import.meta.url)), "utf8"));
  assert.equal(lock.packages["node_modules/wrangler"].version, pkg.devDependencies.wrangler);
});

test("preview jobs skip, not fail, when the preview secrets are absent", () => {
  const prev = workflows.find((x) => x.f === "pr-preview-cloudflare.yml").doc;
  assert.match(prev.jobs["deploy-pr-preview"].if, /preview-guard\.outputs\.enabled == 'true'/);
  assert.ok([].concat(prev.jobs["deploy-pr-preview"].needs).includes("preview-guard"));
  const tests = workflows.find((x) => x.f === "preview-tests.yml").doc;
  assert.match(tests.jobs.preview.if, /preview-secrets\.outputs\.enabled == 'true'/);
});

// Returns the list of violations of the CLOUDFLARE_API_TOKEN budget: per job, and in total in the raw text (comments and anything outside jobs) and in the parsed strings.
const tokenViolations = (w, allowed) => {
  const bad = [];
  for (const [name, job] of Object.entries(w.doc.jobs || {})) {
    const n = (JSON.stringify(job).match(TOKEN_RE) || []).length;
    if (n !== (allowed[name] || 0)) bad.push(`${w.f} job ${name}: expected ${allowed[name] || 0} reference(s) to secrets.CLOUDFLARE_API_TOKEN, found ${n}`);
  }
  const total = Object.values(allowed).reduce((a, b) => a + b, 0);
  if ((w.text.match(TOKEN_RE) || []).length !== total) bad.push(`${w.f}: total references in the raw text`);
  if ((parsedText(w).match(TOKEN_RE) || []).length !== total) bad.push(`${w.f}: total references in the parsed strings`);
  return bad;
};

test("CLOUDFLARE_API_TOKEN is read only in the preview, teardown and preview-secrets jobs of the two preview workflows, once each", () => {
  const prFiles = workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)));
  for (const w of prFiles) assert.deepEqual(tokenViolations(w, TOKEN_JOBS[w.f] || {}), []);
  for (const f of Object.keys(TOKEN_JOBS)) assert.ok(prFiles.some((w) => w.f === f), `${f} must be PR-triggered and checked`);
});

// B60: revert-failing. Each fixture keeps every per-job count right, so ONLY the total check can see the extra reference; removing the raw-text or the parsed-string total fails here.
test("the CLOUDFLARE_API_TOKEN total check catches a reference outside the allowed jobs (comment, top-level env, folded string)", () => {
  const ALLOWED = { deploy: 1 };
  const job = "jobs:\n  deploy:\n    steps:\n      - run: echo §{{ secrets.CLOUDFLARE_API_TOKEN }}\n";
  assert.deepEqual(tokenViolations(fx("ok.yml", job), ALLOWED), [], "the budget itself passes");
  const comment = tokenViolations(fx("c.yml", "# uses §{{ secrets.CLOUDFLARE_API_TOKEN }}\n" + job), ALLOWED);
  assert.deepEqual(comment, ["c.yml: total references in the raw text"], "a comment outside any job");
  const topEnv = tokenViolations(fx("e.yml", "env:\n  T: §{{ secrets.CLOUDFLARE_API_TOKEN }}\n" + job), ALLOWED);
  assert.deepEqual(topEnv, ["e.yml: total references in the raw text", "e.yml: total references in the parsed strings"], "a workflow-level env");
  const folded = fx("f.yml", String.raw`name: "x §{{ secrets.CLOUDFLARE_API_\
  TOKEN }}"
` + job);
  assert.deepEqual(tokenViolations(folded, ALLOWED), ["f.yml: total references in the parsed strings"], "a folded reference outside the jobs is invisible to the raw text");
  const missing = tokenViolations(fx("m.yml", "jobs:\n  deploy:\n    steps:\n      - run: echo none\n"), ALLOWED);
  assert.equal(missing.length, 3, "a missing reference fails the per-job and both totals");
});

test("BOARD_ADMIN_TOKEN and the other production secrets are never available to a PR workflow", () => {
  for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) {
    for (const n of PRODUCTION) assert.equal(new RegExp(`(?<![\\w./-])secrets\\.${n}\\b`).test(scanText(w)), false, `${w.f}: ${n}`);
  }
});

// Flagship: production binds to the production Flagship app through [[flagship]] in wrangler.toml. A PR preview Worker is built from the same
// file and must NOT: the preview deploy strips the block (tools/strip-flagship-binding.mjs), so previews read the legacy [vars].
const STRIP = "strip-flagship-binding.mjs";
test("every non-production job that runs `wrangler deploy` strips the Flagship binding first, in the same job", () => {
  let seen = 0;
  for (const w of workflows.filter((x) => x.f !== "deploy-cloudflare.yml")) {
    for (const [name, job] of Object.entries(w.doc.jobs)) {
      const steps = job.steps || [];
      steps.forEach((s, i) => {
        if (!/\bwrangler deploy\b/.test((s.run || ""))) return;
        seen++;
        const strip = steps.findIndex((t) => runCode(t).includes(STRIP));
        assert.ok(strip >= 0 && strip <= i, `${w.f} job ${name}: step ${i} runs wrangler deploy without stripping the [[flagship]] binding first`);
      });
    }
  }
  assert.ok(seen >= 1, "the preview deploy step must be found");
});

test("the preview strips the binding AFTER it patches wrangler.toml, and no PR-triggered workflow can add a Flagship binding", () => {
  const prev = workflows.find((x) => x.f === "pr-preview-cloudflare.yml");
  const step = Object.values(prev.doc.jobs).flatMap((j) => j.steps || []).find((t) => runCode(t).includes(STRIP));
  assert.ok(step, "the preview patch step runs the strip tool");
  assert.ok(runCode(step).indexOf(STRIP) > runCode(step).indexOf('writeFileSync("wrangler.toml"'), "strip runs after the patched file is written");
  for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) {
    assert.equal(/flagship/i.test(scanText(w).split(STRIP).join("")), false, `${w.f} mentions Flagship in code other than the strip tool`);
  }
});

test("the production deploy keeps the binding: it does not strip it, and touches Flagship only through the one create-missing-flags step (B51)", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.equal(/strip-flagship-binding/.test(scanText(w)), false, "production never strips the binding");
  const mentions = scanText(w).split("\n").filter((l) => /flagship/i.test(l));
  for (const l of mentions) assert.match(l, /flagship-ensure-flags|Flagship flag|Flagship problem|Flagship app|flagship flags create|never changes an existing flag/i, `unexpected Flagship reference in the production deploy: ${l.trim()}`);
  assert.ok(/flagship-ensure-flags/.test(runs(w)), "the create-missing-flags step is there");
});

// wrangler 4 needs Node >= 22: every workflow that runs wrangler must set up Node 22 or newer.
test("every workflow that runs wrangler sets up Node 22 or newer", () => {
  for (const w of workflows.filter((x) => /\bwrangler\b/.test(scanText(x)))) {
    const versions = Object.values(w.doc.jobs).flatMap((j) => (j.steps || []).filter((s) => /actions\/setup-node/.test(s.uses || "")).map((s) => Number(String(s.with && s.with["node-version"]).split(".")[0])));
    assert.ok(versions.length > 0, `${w.f} runs wrangler without setup-node`);
    for (const v of versions) assert.ok(v >= 22, `${w.f}: setup-node ${v} is below wrangler 4's node >=22`);
  }
});

test("wrangler is pinned to the exact version 4.148.0 in package.json and the lockfile", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package.json", import.meta.url)), "utf8"));
  const lock = JSON.parse(readFileSync(fileURLToPath(new URL("../../infrastructure/package-lock.json", import.meta.url)), "utf8"));
  assert.equal(pkg.devDependencies.wrangler, "4.148.0");
  assert.equal(lock.packages["node_modules/wrangler"].version, "4.148.0");
  assert.equal(lock.packages[""].devDependencies.wrangler, "4.148.0");
});

// D1 seed decision: fail closed. An unparsed/unexpected wrangler output must never read as 0 rows (the seed does INSERT OR REPLACE over kv_state).
test("the production and preview seed steps read the row count with tools/d1-row-count.mjs, fail the step on error, and never default to 0", () => {
  for (const f of ["deploy-cloudflare.yml", "pr-preview-cloudflare.yml"]) {
    const w = workflows.find((x) => x.f === f);
    const c = runs(w);
    assert.match(c, /ROW_COUNT=\$\(node \.\.\/tools\/d1-row-count\.mjs "\$COUNT_JSON"\) \|\| \{[^}]*exit 1;?\s*\}/, `${f}: row count must come from the fail-closed tool and exit 1 on error`);
    assert.equal(/\?\?\s*0\b/.test(scanText(w)), false, `${f}: no "?? 0" default for the row count`);
  }
});

test("the preview workflow does not use `wrangler subdomain get` (gone in wrangler 4) and does not guess a workers.dev account subdomain", () => {
  const w = workflows.find((x) => x.f === "pr-preview-cloudflare.yml");
  assert.equal(/subdomain get/.test(scanText(w)), false);
  assert.equal(/jmattbloise\.workers\.dev/.test(scanText(w)), false);
  assert.match(runs(w), /Could not read the preview Worker URL/);
});

// B51: the production deploy creates missing Flagship flags with wrangler (tools/flagship-ensure-flags.mjs). It needs the production Cloudflare token, so it runs there only.
test("the Flagship flag creation is referenced by the production deploy only, once, after `wrangler deploy`, continue-on-error, and by no PR-triggered workflow", () => {
  const REF = /flagship-ensure-flags|flagship\s+flags\s+(create|enable|disable|update|delete|split|rules)\b/;
  for (const w of workflows.filter((x) => x.f !== "deploy-cloudflare.yml")) assert.equal(REF.test(scanText(w)), false, `${w.f} must not run or reference Flagship flag writes`);
  for (const w of workflows.filter((x) => triggers(x.doc).some((t) => PR_TRIGGERS.includes(t)))) assert.equal(/flagship/i.test(scanText(w).replace(/strip-flagship-binding/g, "")), false, `${w.f} (PR-triggered) mentions flagship beyond the preview strip`);
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  const steps = w.doc.jobs["deploy-production"].steps;
  const at = steps.findIndex((s) => /flagship-ensure-flags/.test(runCode(s)));
  assert.ok(at > 0, "the step exists in the production job");
  assert.equal(steps.filter((s) => /flagship-ensure-flags/.test(runCode(s))).length, 1);
  assert.ok(steps.findIndex((s) => /npx wrangler deploy\b/.test(runCode(s))) < at, "it runs after wrangler deploy");
  assert.equal(steps[at]["continue-on-error"], true, "a Flagship problem must never block a code deploy");
  assert.ok(steps[at]["timeout-minutes"] > 0 && steps[at]["timeout-minutes"] <= 5, "a hung wrangler must not hold up the secrets sync that follows (timeout-minutes 3)");
  assert.equal(workflows.find((x) => x.f === "deploy-cloudflare.yml").doc.jobs["deploy-production"].steps[at + 1].name.startsWith("Sync Worker Secrets"), true, "the secrets sync is the next step");
  assert.equal(/secrets\./.test(steps[at].run + JSON.stringify(steps[at].env || {})), false, "the step names no secret itself (the job env already holds the token)");
  assert.equal(/\b(enable|disable|update|delete|split)\b/.test(steps[at].run || ""), false, "it never changes an existing flag");
  for (const d of Object.values(w.doc.jobs)) assert.equal(d.environment === undefined || d.environment === "production", true);
});

// B51: the production workflow may contain NO `flagship flags <subcommand>` other than `create` (the script itself only runs list and create; see flagship-ensure.test.mjs).
const flagshipSubcommands = (text) => [...text.matchAll(/flagship\s*(?:\\\s*)?flags\s*(?:\\\s*)?([A-Za-z-]+)/g)].map((m) => m[1].toLowerCase());
const forbiddenFlagshipSubcommands = (text) => flagshipSubcommands(text).filter((c) => c !== "create");

test("the production deploy contains no `flagship flags` subcommand other than create", () => {
  const w = workflows.find((x) => x.f === "deploy-cloudflare.yml");
  assert.deepEqual(forbiddenFlagshipSubcommands(scanText(w)), []);
});

test("the subcommand check itself rejects enable, disable, update, delete, split, rules (and list/evaluate/pull), however spelled, and accepts create", () => {
  for (const sub of ["enable", "disable", "update", "delete", "split", "rules", "list", "evaluate", "pull", "ENABLE"]) {
    assert.deepEqual(forbiddenFlagshipSubcommands(`run: npx wrangler flagship flags ${sub} APP KEY`), [sub.toLowerCase()], sub);
    assert.deepEqual(forbiddenFlagshipSubcommands(`run: |\n  wrangler flagship   flags   ${sub} APP`), [sub.toLowerCase()], `${sub} with extra spaces`);
  }
  assert.deepEqual(forbiddenFlagshipSubcommands("run: wrangler flagship flags \\\n  enable APP KEY"), ["enable"], "line continuation");
  assert.deepEqual(forbiddenFlagshipSubcommands("run: wrangler flagship flags create APP KEY --disabled"), []);
  assert.deepEqual(forbiddenFlagshipSubcommands("# wrangler flagship flags enable is done by the owner\nrun: wrangler flagship flags create A K"), ["enable"], "comments are not stripped");
});


// B46: nothing is stripped. These strings each hide a secret reference from a comment-stripping rule; secretNames must still see it. They FAIL if stripping is reintroduced.
test("a secret reference is seen however a comment, quote or block scalar tries to hide it", () => {
  const caught = {
    "echo with a quoted #": 'run: echo "#" "${{ secrets.X }}"',
    "# inside single quotes": "run: echo '#' \"${{ secrets.X }}\"",
    "secret after a quoted #": 'env: { A: "x #y", B: ${{ secrets.X }} }',
    "escaped quote outside a quote": 'run: echo \\" # ${{ secrets.X }}',
    "}} inside a string literal in an expression": "run: echo ${{ '}}' }} # ${{ secrets.X }}",
    "multiline quoted scalar, secret after a # line": 'run: "echo\n  # a comment-looking line\n  ${{ secrets.X }}"',
    "multiline quoted scalar, secret ON a # line": 'run: "echo\n  # ${{ secrets.X }}"',
    "run: | block with a # line before the expression": "run: |\n  # setup\n  echo ${{ secrets.X }}",
    "run: | block, secret ON a # line (GitHub still expands it)": "run: |\n  # ${{ secrets.X }}",
    "heredoc": "run: |\n  cat <<'EOF'\n  # ${{ secrets.X }}\n  EOF",
    "whole-line comment": "# uses ${{ secrets.X }}",
    "trailing comment": "run: make build # uses ${{ secrets.X }}",
  };
  for (const [name, text] of Object.entries(caught)) assert.deepEqual(secretNames(text), ["X"], name);
});

// B46 (council on 6cd1991): a double-quoted scalar is resolved by YAML before Actions reads it. These fixtures are real bypasses of a raw-text regex (asserted below), so the test
// FAILS if the parsed-string scan is removed from scanText. `§` stands for `$` so the fixtures can be written without template interpolation.
test("a secret hidden by YAML folding or escaping in a double-quoted scalar is still seen (raw text AND parsed strings are scanned)", () => {
  const hidden = {
    "backslash-newline fold inside the reference": String.raw`jobs:
  a:
    steps:
      - run: "echo §{{ secrets.\
          BOARD_ADMIN_TOKEN }}"
`,
    "backslash-newline fold inside the secret name": String.raw`jobs:
  a:
    steps:
      - run: "echo §{{ secrets.BOARD_ADMIN_\
          TOKEN }}"
`,
    "unicode escape (\\u0073) for the s of secrets": String.raw`jobs:
  a:
    steps:
      - run: "echo §{{ \u0073ecrets.BOARD_ADMIN_TOKEN }}"
`,
    "hex escape (\\x73) in an env value": String.raw`jobs:
  a:
    steps:
      - run: echo hi
        env:
          T: "§{{ \x73ecrets.BOARD_ADMIN_TOKEN }}"
`,
    "escape in a with: value": String.raw`jobs:
  a:
    steps:
      - uses: some/action@v1
        with:
          token: "§{{ secrets.BOARD_ADMIN_\u0054OKEN }}"
`,
  };
  for (const [name, text] of Object.entries(hidden)) {
    const w = fx("hidden.yml", text);
    assert.equal(secretNames(w.text).includes("BOARD_ADMIN_TOKEN"), false, `${name}: the fixture really hides the name from a raw-text scan`);
    assert.ok(secretNames(scanText(w)).includes("BOARD_ADMIN_TOKEN"), `${name}: the parsed-string scan must see it`);
    assert.equal(new RegExp(`(?<![\\w./-])secrets\\.BOARD_ADMIN_TOKEN\\b`).test(scanText(w)), true, `${name}: the PRODUCTION check must see it`);
  }
  const token = fx("t.yml", String.raw`jobs:
  a:
    steps:
      - run: "echo §{{ secrets.CLOUDFLARE_API_\
          TOKEN }}"
`);
  assert.equal((token.text.match(TOKEN_RE) || []).length, 0);
  assert.equal((parsedText(token).match(TOKEN_RE) || []).length, 1, "the CLOUDFLARE_API_TOKEN count sees a folded reference in the parsed strings");
});

test("a comment never satisfies a REQUIRED command: only the parsed run: strings do", () => {
  const REQUIRED = /npm ci --no-audit --no-fund/;
  const commentOnly = fx("c.yml", "jobs:\n  a:\n    steps:\n      # npm ci --no-audit --no-fund\n      - run: npm install\n");
  assert.equal(REQUIRED.test(commentOnly.text), true, "the raw text contains the words (in a comment)");
  assert.equal(REQUIRED.test(runs(commentOnly)), false, "but no step runs them");
  const inName = fx("n.yml", "jobs:\n  a:\n    steps:\n      - name: npm ci --no-audit --no-fund\n        run: echo nothing\n");
  assert.equal(REQUIRED.test(runs(inName)), false, "a step name does not count either");
  const real = fx("r.yml", "jobs:\n  a:\n    steps:\n      - run: cd infrastructure && npm ci --no-audit --no-fund\n");
  assert.equal(REQUIRED.test(runs(real)), true, "a real step does");
});

// B60: a shell comment INSIDE a run: block must not satisfy a REQUIRED command. These go through runs()/runCode(), so they FAIL if stripping is removed from them.
test("a shell comment inside a run: block never satisfies a REQUIRED command", () => {
  const REQUIRED = /npm ci --no-audit --no-fund/;
  const bypass = {
    "comment line then echo": "#NPM\n      - run: |\n          # npm ci --no-audit --no-fund\n          echo skipped\n",
    "trailing comment": "#NPM\n      - run: echo skipped # npm ci --no-audit --no-fund\n",
    "comment after a semicolon": "#NPM\n      - run: echo a; # npm ci --no-audit --no-fund\n",
    "apostrophe in a heredoc body, then a comment": "#NPM\n      - run: |\n          cat <<EOF\n          it's data\n          EOF\n          # npm ci --no-audit --no-fund\n          echo skipped\n",
    "$'..\\'..' then a comment": "#NPM\n      - run: |\n          echo $'it\\'s'\n          # npm ci --no-audit --no-fund\n",
    "indented comment in a block": "#NPM\n      - run: |\n          if true; then\n            # npm ci --no-audit --no-fund\n            echo x\n          fi\n",
  };
  for (const [name, step] of Object.entries(bypass)) {
    const w = fx("b.yml", "jobs:\n  a:\n    steps:\n      " + step);
    assert.equal(REQUIRED.test(runs(w)), false, name);
    assert.equal(REQUIRED.test(w.text), true, `${name}: the words are in the file`);
  }
  const real = {
    "plain": "- run: cd infrastructure && npm ci --no-audit --no-fund",
    "after a comment line": "- run: |\n          # install\n          npm ci --no-audit --no-fund",
    "# inside quotes before it": "- run: |\n          echo '# not a comment' && npm ci --no-audit --no-fund",
    "$# before it": "- run: |\n          echo $# && npm ci --no-audit --no-fund",
    "${#x} before it": "- run: |\n          echo ${#x} && npm ci --no-audit --no-fund",
    "word#hash before it": "- run: |\n          echo a#b && npm ci --no-audit --no-fund",
  };
  for (const [name, step] of Object.entries(real)) assert.equal(REQUIRED.test(runs(fx("r.yml", "jobs:\n  a:\n    steps:\n      " + step + "\n"))), true, name);
});

test("stripShellComments keeps quoted #, $#, ${#x}, ${x#y} and escaped \\#, and drops real comments", () => {
  assert.equal(stripShellComments("a # b"), "a ");
  assert.equal(stripShellComments("# b\nc"), "\nc");
  assert.equal(stripShellComments("echo 'a # b' \"c # d\""), "echo 'a # b' \"c # d\"");
  assert.equal(stripShellComments("echo $# ${#a} ${a#b} a#b \\# c"), "echo $# ${#a} ${a#b} a#b \\# c");
  assert.equal(stripShellComments("echo \"it's\" # gone"), "echo \"it's\" ");
  assert.equal(stripShellComments("echo $'it\\'s' # gone"), "echo $'it\\'s' ", "ANSI-C quoting with an escaped quote");
  const heredoc = "cat <<EOF\nit's a heredoc\nEOF\n# real comment\nnpm ci";
  assert.equal(stripShellComments(heredoc), "cat <<EOF\nit's a heredoc\nEOF\n\nnpm ci", "an apostrophe in a heredoc body does not unbalance the quotes");
  assert.equal(stripShellComments("cat <<-'EOF'\n\tx\n\tEOF\n# c\nok"), "cat <<-'EOF'\n\tx\n\tEOF\n\nok");
  for (const [name, hd] of Object.entries({ "backslash": "cat <<\\EOF", "mid-word quote": "cat <<E'OF'", "double quotes": 'cat <<"EOF"', "dash and tab": "cat <<-EOF" })) {
    const script = `${hd}\nit's data\nEOF\n# comment\nnpm ci`;
    assert.equal(stripShellComments(script), `${hd}\nit's data\nEOF\n\nnpm ci`, name);
  }
  assert.equal(stripShellComments("cat <<EOF # why\n# kept: body\nEOF\n# gone\nok"), "cat <<EOF \n# kept: body\nEOF\n\nok", "a comment on the heredoc start line does not skip the body");
  assert.equal(stripShellComments("echo $((1<<n)) # a\n# npm ci\nok"), "echo $((1<<n)) \n\nok", "a shift in $(( )) is not a heredoc (the next comment line is still a comment)");
  assert.equal(stripShellComments("(( x = 1<<n )) # a\n# npm ci\nok"), "(( x = 1<<n )) \n\nok", "nor in a (( )) command");
  assert.equal(stripShellComments("echo <<< \"a # b\" # c"), "echo <<< \"a # b\" ");
});

// B60: stripping is for REQUIRED matching only. A forbidden reference inside a shell comment must still be seen by the secret scan.
test("a secret named only in a shell comment inside run: is still caught (forbidden scans are not comment-stripped)", () => {
  const w = fx("p.yml", "on: pull_request\njobs:\n  a:\n    steps:\n      - run: |\n          # §{{ secrets.BOARD_ADMIN_TOKEN }}\n          echo hi\n");
  assert.equal(runs(w).includes("BOARD_ADMIN_TOKEN"), false, "stripped for required matching");
  assert.ok(secretNames(scanText(w)).includes("BOARD_ADMIN_TOKEN"), "but the secret scan still sees it");
});
