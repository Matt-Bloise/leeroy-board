# Cloudflare 100% Serverless Infrastructure & GitHub Actions CI/CD Proposal

This directory (`infrastructure/`) contains the complete Infrastructure-as-Code (IaC), Cloudflare Worker runtime, D1 SQLite schema, and automated seed tooling to run the **Dungeons & Drinking Living Board** (`leeroy-board` + `leeroy-brain`) at **$0/month** on Cloudflare's Free Tier, with dual-provider AI support for both **Anthropic Claude** (`ANTHROPIC_API_KEY`) and **Google Gemini's Free Tier** (`GEMINI_API_KEY`), paired with the live GitHub Actions workflows in [`.github/workflows/`](../.github/workflows/).

---

## 1. Architecture Overview (Zero VMs, Zero Git Data Commits)

```mermaid
flowchart LR
  subgraph Client["Browser / Discord Activity"]
    UI["Living Board UI\n(Cloudflare Pages: leeroy-board)"]
  end

  subgraph Edge["Cloudflare Global Edge ($0 Free Tier)"]
    Cache["Cloudflare Edge Cache\n(caches.default — ∞ free hits)"]
    Worker["Cloudflare Worker\n(leeroy-brain)"]
    DO["Hibernatable Durable Object\n(BoardRoom SQLite + WebSockets)"]
    D1[("Cloudflare D1 SQLite\n(kv_state, lib_pages, lib_blobs,\nlib_sources, ask_turns, fact_fixes)")]
    Cron["Cloudflare Cron Trigger\n(*/15 * * * *)"]
  end

  subgraph External["External APIs & Discord"]
    Claude["Anthropic Messages API\n(Claude Haiku 4.5 / Sonnet 4.5)"]
    Gemini["Google Gemini Free Tier\n(Gemini 2.5 Flash / Pro)"]
    Sources["Blizzard / Wowhead / Wiki\n(186 tracked URLs)"]
    Discord["Discord (#wow-forever)\nWebhook + /api/discord Interactions"]
  end

  UI -- "GET /api/bootstrap\nGET /api/library/*" --> Cache
  Cache -- "Cache Miss" --> Worker
  Worker <--> D1
  UI <-->|"WSS /api/live (0ms cold start)"| DO
  UI -- "POST /api/intent (ask / fix / refresh)\nPOST /api/sheet" --> Worker
  Worker -- "Broadcast live diff (<5ms)" --> DO
  Worker -- "provider = 'claude'" --> Claude
  Worker -- "provider = 'gemini' ($0 Free Tier)" --> Gemini
  Worker <-->|"Slash commands, Sign-ups & Q&A"| Discord
  Cron -- "Every 15m" --> Worker
  Worker -- "ETag / SHA-256 check" --> Sources
```

### Cloudflare & AI Free-Tier Quotas Used
| Resource | Free Quota | Board Usage |
| :--- | :--- | :--- |
| **Cloudflare Pages (`leeroy-board`)** | **Unlimited requests & bandwidth** | Hosts `index.html`, `js/`, `css/`, `scenes/`, `atlas/`, `img/`, `fonts/` |
| **Workers Requests (`leeroy-brain`)** | **100,000 req / day** | ~500–3,000 req/day (Edge Cache absorbs >95% of reads) |
| **Edge Cache (`caches.default`)** | **Unlimited (Unmetered)** | Serves `/api/bootstrap` and `/api/library/*.json` in 10–25 ms globally |
| **D1 Serverless SQLite** | **5 GB storage, 5M row reads/day, 100k writes/day, 10 DBs** | ~3.5 MB total storage; 1 production DB + up to 9 concurrent PR preview DBs |
| **Durable Objects (`BoardRoom`)** | **100,000 req/day, 13,000 GB-s/day, 5 GB SQLite** | Hibernates at 0 GB-s when idle; instant `<5ms` WebSocket fan-out |
| **Cron Triggers** | **5 schedules / account** | 1 schedule (`*/15 * * * *` on production only) |
| **Google Gemini Free Tier (`gemini-2.5-flash`)** | **15 RPM, 1,000,000 TPM, 1,500 req/day ($0)** | Selectable in UI, Discord `/ask`, or as default via `AI_PROVIDER = "gemini"` |

---

## 2. Directory & Workflow Contents

| File | Purpose |
| :--- | :--- |
| [`wrangler.toml`](./wrangler.toml) | Cloudflare Worker configuration (`leeroy-brain`), D1 binding (`DB`), SQLite Durable Object (`BoardRoom`), `AI_PROVIDER` config, and `*/15 * * * *` Cron Trigger. |
| [`schema.sql`](./schema.sql) | Idempotent D1 SQLite schema (`kv_state`, `lib_pages`, `lib_blobs`, `lib_sources`, `ask_turns`, `fact_fixes`). |
| [`scripts/seed-d1.mjs`](./scripts/seed-d1.mjs) | Compiles existing `../data/*.json`, `../data/library/*.json`, and `../data/atlas/{links,marks}.json` into SQL batches and seeds D1 via `wrangler d1 execute`. |
| [`worker/index.js`](./worker/index.js) | Main Cloudflare Worker entry point (`/api/bootstrap`, `/api/library/:name`, `/api/data/:name`, `/api/atlas/:name`, `/api/intent`, `/api/ask`, `/api/signups`, `/api/discord`, `/api/sheet`, `/api/state`, `/api/live`). |
| [`worker/room.js`](./worker/room.js) | `BoardRoom` Hibernatable WebSocket Durable Object class (SQLite-backed live state & sub-5ms WebSocket broadcast). |
| [`worker/claude.js`](./worker/claude.js) | Dual-provider AI integration supporting both **Anthropic Claude** (`ANTHROPIC_API_KEY`) and **Google Gemini Free Tier** (`GEMINI_API_KEY`) with D1 RAG context retrieval and live WebSocket + Discord webhook push. |
| [`worker/discord.js`](./worker/discord.js) | Native Discord HTTP Interactions endpoint (`POST /api/discord` with Ed25519 signature verification) and external bot signup sync (`POST /api/signups`). |
| [`worker/scraper.js`](./worker/scraper.js) | 15-minute Cron Trigger source sweep (`ETag` / `If-Modified-Since` / `SHA-256`) and D1 library blob rebuilder + Edge Cache invalidator. |
| [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) | Live GitHub Actions workflow — deploys to **Production ONLY on new commits to `master`**. |
| [`.github/workflows/pr-preview-cloudflare.yml`](../.github/workflows/pr-preview-cloudflare.yml) | Live GitHub Actions workflow — spins up isolated **Ephemeral PR Environments** (`Pages + Worker + DO + D1`) on PR open/sync and tears them down on PR merge/close. |

---

## 3. Spinning Up & Deploying to Production via GitHub Actions (`master` Only)

The production workflow at [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) runs **exclusively on new commits pushed to `master`**:

```yaml
on:
  push:
    branches:
      - master
```

### Step 1a: Create a Cloudflare API Token
1. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **My Profile** -> **API Tokens** -> **Create Token**.
2. Start from the **Edit Cloudflare Workers** template and ensure the following permissions are included:
   - **Account** -> **Workers Scripts**: `Edit`
   - **Account** -> **D1**: `Edit`
   - **Account** -> **Cloudflare Pages**: `Edit`
3. Copy your **API Token** and your **Account ID** (visible on the right sidebar of the Workers & Pages overview page).

### Step 1b: Create a Free-Tier Google Gemini API Key (`GEMINI_API_KEY`)
Google AI Studio provides a **100% Free Tier** for `gemini-2.5-flash` (15 requests/minute, 1,000,000 tokens/minute, 1,500 requests/day) and `gemini-2.5-pro` with **no credit card or billing account required**:
1. Sign into [Google AI Studio — API Keys (`https://aistudio.google.com/apikey`)](https://aistudio.google.com/apikey) with your Google account.
2. Click **Create API key** in the top-right corner.
3. Choose **Create API key in new project** (or select an existing Google Cloud project that does **not** have Cloud Billing enabled so the key remains strictly locked to the **$0 Free Tier** and can never incur charges).
4. Confirm that the **Plan** column next to your new key says **Free of charge**.
5. Copy the generated key (starts with `AIzaSy...`) and save it as the `GEMINI_API_KEY` secret in your GitHub repository (Step 2 below).
6. *(Optional smoke test from your terminal)*:
   ```bash
   curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=YOUR_GEMINI_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"contents":[{"parts":[{"text":"Say Leeroy Jenkins in one sentence."}]}]}'
   ```

### Step 2: Configure GitHub Repository Secrets
In your GitHub repository (`Matt-Bloise/leeroy-board`), navigate to **Settings -> Secrets and variables -> Actions -> New repository secret** and add:

| GitHub Secret Name | Required? | Description |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | **Yes** | Cloudflare API token with `Workers Scripts: Edit`, `D1: Edit`, and `Cloudflare Pages: Edit` permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | **Yes** | Your 32-character Cloudflare Account ID. |
| `ANTHROPIC_API_KEY` | One or Both | Site's Claude API key (`sk-ant-...`) used when `provider = "claude"`. |
| `GEMINI_API_KEY` | One or Both | Google AI Studio Free-Tier API key (`AIzaSy...` created in Step 1b) used when `provider = "gemini"`. |
| `BOARD_ADMIN_TOKEN` | Optional | Shared secret key matched against `#k=<token>` in the browser URL or `Authorization: Bearer <token>` from the Discord bot for write intents (`/api/intent`, `/api/sheet`, `/api/signups`). |
| `DISCORD_WEBHOOK_URL` | Optional | Discord channel webhook URL for `#wow-forever` to mirror Leeroy's answers into Discord chat. |
| `DISCORD_PUBLIC_KEY` | Optional | Public key (`General Information -> Public Key`) from the Discord Developer Portal if using `POST /api/discord` as a serverless Discord Interactions Endpoint. |

### Step 3: Switching Between Claude and Gemini's Free Tier
You can switch Leeroy's AI model between **Claude** and **Gemini Free Tier (`gemini-2.5-flash` / `gemini-2.5-pro`)** in three ways:
1. **Per-Question in the Web Board UI ([`js/ask.js`](../js/ask.js))**:
   - In the **Leeroy** tab (`#ask-form`), use the model dropdown (`Model: Claude (Anthropic)` vs `Model: Gemini Free Tier`). Your selection is saved in `localStorage["board-ai-provider"]` and sent with each question (`patch.provider`).
2. **Per-Command in Discord (`/ask`)**:
   - Pass `model: gemini` or `model: claude` on `/ask`, or in JSON API calls: `POST /api/intent {"kind":"ask","q":"...","provider":"gemini"}`.
3. **Global Default (`AI_PROVIDER` in [`wrangler.toml`](./wrangler.toml#L27))**:
   - Set `AI_PROVIDER = "gemini"` or `AI_PROVIDER = "claude"` in `infrastructure/wrangler.toml`.
   - Furthermore, [`resolveAiProvider()`](./worker/claude.js#L23-L30) automatically falls back to whichever provider has a configured API key secret if only `GEMINI_API_KEY` or only `ANTHROPIC_API_KEY` is present.

---

## 4. Ephemeral PR Preview Environments & Automatic Teardown

The workflow at [`.github/workflows/pr-preview-cloudflare.yml`](../.github/workflows/pr-preview-cloudflare.yml) gives every Pull Request targeting `master` its own **100% isolated full-stack environment** on Cloudflare's Free Tier:

| Layer | Production (`master`) | Ephemeral PR Preview (`PR #<N>`) |
| :--- | :--- | :--- |
| **Static Site (Pages)** | `https://leeroy-board.pages.dev` | `https://pr-<N>.leeroy-board.pages.dev` |
| **Worker + Durable Object** | `leeroy-brain` | `leeroy-brain-pr-<N>` |
| **D1 SQLite Database** | `leeroy-board-db` | `leeroy-board-db-pr-<N>` |
| **Cron Trigger** | Enabled (`*/15 * * * *`) | Stripped (preserves 5-cron Free-Tier account quota) |
| **Discord Webhook** | Enabled (`#wow-forever`) | Omitted (prevents PR test queries from spamming Discord) |

---

## 5. Hooking Up the Discord Bot & Discord Activity (`1561857940174938114`)

There are **three** touchpoints between Discord (`#wow-forever`) and the new Cloudflare deployment:

### A. Discord Embedded App / Activity URL Mappings
In [`index.html`](../index.html#L306), the board uses Discord Application ID `1561857940174938114`. When opened inside a Discord Voice channel Activity (`1561857940174938114.discordsays.com`), [`js/brain.js`](../js/brain.js#L55) routes API requests to `/api` and WebSockets to `wss://1561857940174938114.discordsays.com/api/live`.

To point the Discord Activity at your new Cloudflare deployment:
1. Open the [Discord Developer Portal](https://discord.com/developers/applications/1561857940174938114) -> select your application (`1561857940174938114`).
2. In the left sidebar under **Activities**, click **URL Mappings** and configure:

| Prefix | Target | Purpose |
| :--- | :--- | :--- |
| `/` | `leeroy-board.pages.dev` | Serves the static board UI from Cloudflare Pages inside the Discord Activity iframe |
| `/api` | `leeroy-brain.jmattbloise.workers.dev/api` | Proxies all `/api/*` REST calls and `wss://.../api/live` WebSockets directly to the Cloudflare Worker |

### B. Outbound Answers to `#wow-forever` (`DISCORD_WEBHOOK_URL`)
Whenever someone asks Leeroy a question from the web board (`POST /api/intent { kind: "ask" }`), [`worker/claude.js`](./worker/claude.js#L243-L253) automatically posts the question and Claude/Gemini's cited answer to `#wow-forever` if `DISCORD_WEBHOOK_URL` is set:
1. In Discord, open **Channel Settings (⚙️) for `#wow-forever` -> Integrations -> Webhooks -> New Webhook**.
2. Name it `Leeroy`, copy the **Webhook URL**, and save it as the `DISCORD_WEBHOOK_URL` secret in GitHub Actions.

### C. Connecting the Discord Bot (`Leeroy` Slash Commands & Sign-up Card Buttons)
You can connect the Discord bot in **either** of two ways:

#### Option 1: 100% Serverless Discord Bot (Zero Bot VM Needed)
The Cloudflare Worker includes a native Discord HTTP Interactions endpoint in [`worker/discord.js`](./worker/discord.js) (`POST /api/discord`):
1. In the [Discord Developer Portal](https://discord.com/developers/applications/1561857940174938114) -> **General Information**, copy the **Public Key** and add it as the `DISCORD_PUBLIC_KEY` secret in GitHub Actions.
2. On the same **General Information** page, set **Interactions Endpoint URL** to:
   ```text
   https://leeroy-brain.jmattbloise.workers.dev/api/discord
   ```
   *(Discord will immediately send a signed `PING` request; the Worker verifies the `X-Signature-Ed25519` header using WebCrypto and responds with `PONG`.)*
3. What `POST /api/discord` handles automatically:
   - **`/ask <question> [model:claude|gemini]` slash command**: Returns a deferred thinking state (`type: 5`) in `<5ms`, runs [`answerWithClaude()`](./worker/claude.js) (using Claude or Gemini Free Tier) via `ctx.waitUntil()`, PATCHes the Discord message with Leeroy's cited answer, saves the turn in D1, and broadcasts it live to all open boards.
   - **Sign-ups Card Buttons (`signup:<field>:<value>`, e.g. `signup:rsvp:in`, `signup:pack:yes`, `signup:meet:Valley of Strength`, `signup:when:6pm`)**: Updates the caller's entry in D1 `kv_state['signups']`, recomputes all tallies, purges the Edge Cache, and broadcasts `{ type: "data", key: "signups" }` over WebSockets so the tavern table on the web board updates in `<5ms`.

#### Option 2: Keeping an Existing Gateway Discord Bot Process
If you already run a gateway bot script that listens to message events or reactions in `#wow-forever`, point its HTTP calls at the Worker instead of writing/committing JSON files to Git:
- **Board Link in Bot Replies**: `https://leeroy-board.pages.dev`
- **Forwarding `/ask` from Bot to Worker (using Claude or Gemini Free Tier)**:
  ```bash
  curl -X POST https://leeroy-brain.jmattbloise.workers.dev/api/intent \
    -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"kind":"ask","by":"Mend","q":"When do dungeons unlock?","provider":"gemini"}'
  ```
- **Syncing `#wow-forever` Sign-up Card Tallies to Worker**:
  ```bash
  curl -X POST https://leeroy-brain.jmattbloise.workers.dev/api/signups \
    -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"Mend","rsvp":"in","pack":"yes","meet":"Valley of Strength","when":"6pm"}'
  ```
- **Syncing Character Sheet Changes to Worker**:
  ```bash
  curl -X POST https://leeroy-brain.jmattbloise.workers.dev/api/sheet \
    -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"member":"mend","patch":{"race":"undead","spec":"holy"}}'
  ```

---

## 6. Local Development & Verification

You can run the entire Cloudflare Worker + D1 + Durable Objects stack locally on your machine using Wrangler's built-in Miniflare simulator:

```bash
cd infrastructure

# 1. Install Wrangler
npm install

# 2. Create local D1 SQLite tables
npm run d1:schema:local

# 3. Seed local D1 from ../data/*.json and ../data/library/*.json
npm run d1:seed:local

# 4. Start local Worker + Durable Object + Cron emulator on http://localhost:8787
npm run dev
```

To test the frontend against your local Worker, open the board with `?brain=http://localhost:8787` (or `?brain=local`).
