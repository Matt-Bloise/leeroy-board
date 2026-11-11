# CSP enforcement readiness

Status: **measurement only**. `_headers` still sends `Content-Security-Policy-Report-Only`; nothing here changes what browsers enforce. This page exists so the owner of the back end (Uncle Jimmy) can decide to enforce from data. Measured 2026-11-06 on master at the commit that added `tests/csp/csp-audit.mjs`.

## How it was measured

`node tests/csp/csp-audit.mjs` (Playwright, from `tests/`) serves this checkout from disk as `https://leeroy.party/`, puts a **test copy** of the policy on every response in **enforce** mode, answers the Worker API from `tests/fixtures/api-snapshot` (no request reaches the Worker or production), and records every `securitypolicyviolation` event plus the browser console. It opens `/`, `/landing/`, `/privacy/`, `/terms/`, `/rate/`, `/404.html`, and `/?preview=1` with all 12 scenes opened through their hash, once as a first visit and once with a made-up member. Any other host a page asks for is refused and listed. A positive control (`--policy locked`: connect, font, image, worker and style sources set to `'none'`) blocks sockets/requests, images, workers and styles, which shows the audit can see them. Re-run it after any change that adds a script, style, font, image or host.

Totals seen in the Chromium run (current policy): 8 documents, 131 scripts, 90 stylesheets, 478 images, 15 fonts, 102 fetches; hosts only `https://leeroy.party` and `https://api.leeroy.party`.

## Result 1: the policy in `_headers` today, enforced

```
default-src 'self'; script-src 'self' 'sha256-FxN80pVgbTlbRq/Hn4p2zVWpiQ+tjIQ+PtbVBeJkZhk=' 'sha256-8S7wxnaCGT8ugLT4Wfj6nm96exEFITisKFDMIKJWkbo=' 'sha256-3Fpc/F1O6xKaU4gzvZYNmh5O/iE3Ffic4TY60K/QcDg=' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; connect-src 'self' https://api.leeroy.party wss://api.leeroy.party https://*.joshbblaine.workers.dev wss://*.joshbblaine.workers.dev https://*.jmattbloise.workers.dev wss://*.jmattbloise.workers.dev https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discordsays.com
```

**0 blocks** in Chromium, WebKit and Firefox: no inline script, style, font, image or connect host is refused on any page (`script`, `style`, `font`, `image`, `connect`, `worker` all 0). The three inline scripts in `index.html` are covered by hash (`tests/unit/csp-headers.test.mjs` keeps them in step).

## Result 2: the same policy without `style-src 'unsafe-inline'`

```
default-src 'self'; script-src 'self' 'sha256-FxN80pVgbTlbRq/Hn4p2zVWpiQ+tjIQ+PtbVBeJkZhk=' 'sha256-8S7wxnaCGT8ugLT4Wfj6nm96exEFITisKFDMIKJWkbo=' 'sha256-3Fpc/F1O6xKaU4gzvZYNmh5O/iE3Ffic4TY60K/QcDg=' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; connect-src 'self' https://api.leeroy.party wss://api.leeroy.party https://*.joshbblaine.workers.dev wss://*.joshbblaine.workers.dev https://*.jmattbloise.workers.dev wss://*.jmattbloise.workers.dev https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discordsays.com
```

10 distinct blocks, all inline styles (nothing else changes). Chromium:

| Directive | Where | Blocks | What it is |
| --- | --- | ---: | --- |
| `style-src-attr` | `js/board.js:26` | 1273 | `setAttribute("style", v)` in the DOM helper (most of the board) |
| `style-src-attr` | `img/vector/vector.js:10` | 449 | SVG `setAttribute` of a `style` attribute |
| `style-src-attr` | `js/seals.js:8` | 66 | same helper pattern in the seals |
| `style-src-attr` | `index.html:109` | 27 | `style="--i:0;--acc:..."` on the scene tiles |
| `style-src-elem` | `index.html:20` | 6 | the small first-paint `<style>` block |
| `style-src-attr` | `landing/index.html:28` | 3 | `style="width:75%"` bars |
| `style-src-elem` | `privacy/index.html:9`, `terms/index.html:9`, `404.html:9` | 1 each | page `<style>` blocks |
| `style-src-elem` | `img/vector/vector.js:30` | 1 | a `<style>` appended to `<head>` at run time |

So dropping `'unsafe-inline'` from `style-src` entirely is **not ready**: roughly 1,800 style-attribute writes would fail. A middle step is ready in principle: `style-src 'self' <hashes of the 4 static style blocks>; style-src-attr 'unsafe-inline'` blocks injected `<style>` elements (the part that matters for XSS) while leaving attributes, but `img/vector/vector.js:30` creates its `<style>` at run time and would need a nonce-free rewrite (a stylesheet file) first. That is a code change, not part of this PR.

## Proposed enforced policy (stage 1)

The current policy plus `frame-ancestors`, sent as `Content-Security-Policy` (enforcing) next to the existing Report-Only header while it soaks:

```
default-src 'self'; script-src 'self' 'sha256-FxN80pVgbTlbRq/Hn4p2zVWpiQ+tjIQ+PtbVBeJkZhk=' 'sha256-8S7wxnaCGT8ugLT4Wfj6nm96exEFITisKFDMIKJWkbo=' 'sha256-3Fpc/F1O6xKaU4gzvZYNmh5O/iE3Ffic4TY60K/QcDg=' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; connect-src 'self' https://api.leeroy.party wss://api.leeroy.party https://*.joshbblaine.workers.dev wss://*.joshbblaine.workers.dev https://*.jmattbloise.workers.dev wss://*.jmattbloise.workers.dev https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discordsays.com
```

- `frame-ancestors 'self' https://discord.com https://*.discordsays.com` lets the Discord Activity frame the board and nothing else. It only works in an enforcing header (browsers ignore it in Report-Only, which is why `_headers` leaves it out today).
- Nothing else changes; Result 1 shows 0 blocks.

## What this audit does not cover (decide with these in mind)

- **The Discord Activity itself.** The page was not loaded inside Discord. In the Activity the page host is `*.discordsays.com` and the code points the socket at `wss://<that host>/api/live`, which `'self'` covers, but this is not measured. `_headers` already says "Not yet proven against the Discord Activity".
- **The Cloudflare Web Analytics beacon** is injected by Cloudflare on the live site only; its hosts (`static.cloudflareinsights.com`, `cloudflareinsights.com`) are allowed by exact name and were not exercised here.
- **The live socket.** The audit's API stub accepts `wss://api.leeroy.party/api/live` without a server, so the socket's `connect-src` check is not independently proven; the fetch path to `https://api.leeroy.party` is (102 fetches, 0 blocks). The `wss://api.leeroy.party` entry is present in the policy.
- Pages behind a sign-in other than the made-up member state, and anything that needs a real Worker response, run from the recorded snapshot.
- Browsers: Chromium, WebKit and Firefox were run for Result 1; Result 2 only in Chromium.

## Suggested rollout

1. Add the enforcing header with the stage 1 policy (Report-Only stays); watch the Discord Activity and one PR preview by hand.
2. If anything is blocked, the console line names the directive and URL; fix the policy, not the page.
3. Decide separately on tightening `style-src` using the table above.
