# Cloudflare 100% Serverless Infrastructure & GitHub Actions CI/CD Proposal

This directory (`infrastructure/`) contains the complete Infrastructure-as-Code (IaC), Cloudflare Worker runtime, D1 SQLite schema, automated seed tooling, and GitHub Actions CI/CD workflow to run the **Dungeons & Drinking Living Board** (`leeroy-brain`) at **$0/month** on Cloudflare's Free Tier + the site's existing Anthropic Claude API key.

---

## 1. Architecture Overview (Zero VMs, Zero Git Data Commits)

```mermaid
flowchart LR
  subgraph Client["Browser / Discord Activity"]
    UI["Living Board UI\n(board.js, brain.js, scenes/*)"]
  end

  subgraph Edge["Cloudflare Global Edge ($0 Free Tier)"]
    Cache["Cloudflare Edge Cache\n(caches.default — ∞ free hits)"]
    Worker["Cloudflare Worker\n(leeroy-brain)"]
    DO["Hibernatable Durable Object\n(BoardRoom SQLite + WebSockets)"]
    D1[("Cloudflare D1 SQLite\n(kv_state, lib_pages, lib_blobs,\nlib_sources, ask_turns, fact_fixes)")]
    Cron["Cloudflare Cron Trigger\n(*/15 * * * *)"]
  end

  subgraph External["External APIs"]
    Claude["Anthropic Messages API\n(Claude Haiku 4.5 / Sonnet 4.5)"]
    Sources["Blizzard / Wowhead / Wiki\n(186 tracked URLs)"]
    Discord["Discord Webhook\n(#wow-forever)"]
  end

  UI -- "GET /api/bootstrap\nGET /api/library/*" --> Cache
  Cache -- "Cache Miss" --> Worker
  Worker <--> D1
  UI <-->|"WSS /api/live (0ms cold start)"| DO
  UI -- "POST /api/intent (ask / fix / refresh)\nPOST /api/sheet" --> Worker
  Worker -- "Broadcast live diff (<5ms)" --> DO
  Worker -- "ctx.waitUntil() + ANTHROPIC_API_KEY" --> Claude
  Worker -- "Optional Q&A mirror" --> Discord
  Cron -- "Every 15m" --> Worker
  Worker -- "ETag / SHA-256 check" --> Sources
```

### Cloudflare Free-Tier Quotas Used
| Resource | Cloudflare Free Quota | Board Usage |
| :--- | :--- | :--- |
| **Workers Requests** | **100,000 req / day** | ~500–3,000 req/day (Edge Cache absorbs >95% of reads) |
| **Edge Cache (`caches.default`)** | **Unlimited (Unmetered)** | Serves `/api/bootstrap` and `/api/library/*.json` in 10–25 ms globally |
| **D1 Serverless SQLite** | **5 GB storage, 5M row reads/day, 100k writes/day** | ~3.5 MB total storage; 1-row reads per cache miss |
| **Durable Objects (`BoardRoom`)** | **100,000 req/day, 13,000 GB-s/day, 5 GB SQLite** | Hibernates at 0 GB-s when idle; instant `<5ms` WebSocket fan-out |
| **Cron Triggers** | **5 schedules / account** | 1 schedule (`*/15 * * * *` = 96 runs/day) |

---

## 2. Directory Contents

| File | Purpose |
| :--- | :--- |
| [`wrangler.toml`](./wrangler.toml) | Cloudflare Worker configuration (`leeroy-brain`), D1 binding (`DB`), SQLite Durable Object (`BoardRoom`), and `*/15 * * * *` Cron Trigger. |
| [`schema.sql`](./schema.sql) | Idempotent D1 SQLite schema (`kv_state`, `lib_pages`, `lib_blobs`, `lib_sources`, `ask_turns`, `fact_fixes`). |
| [`scripts/seed-d1.mjs`](./scripts/seed-d1.mjs) | Compiles existing `../data/*.json`, `../data/library/*.json`, and `../data/atlas/{links,marks}.json` into SQL batches and seeds D1 via `wrangler d1 execute`. |
| [`worker/index.js`](./worker/index.js) | Main Cloudflare Worker entry point (`/api/bootstrap`, `/api/library/:name`, `/api/data/:name`, `/api/atlas/:name`, `/api/intent`, `/api/sheet`, `/api/state`, `/api/live`). |
| [`worker/room.js`](./worker/room.js) | `BoardRoom` Hibernatable WebSocket Durable Object class (SQLite-backed live state & sub-5ms WebSocket broadcast). |
| [`worker/claude.js`](./worker/claude.js) | Direct Anthropic Messages API integration (`https://api.anthropic.com/v1/messages`) with D1 RAG context retrieval and live WebSocket + Discord webhook push. |
| [`worker/scraper.js`](./worker/scraper.js) | 15-minute Cron Trigger source sweep (`ETag` / `If-Modified-Since` / `SHA-256`) and D1 library blob rebuilder + Edge Cache invalidator. |
| [`workflows/deploy-cloudflare.yml`](./workflows/deploy-cloudflare.yml) | Reference copy of `.github/workflows/deploy-cloudflare.yml` for zero-touch GitHub Actions provisioning and deployment. |

---

## 3. Spinning Up the Environment via GitHub Actions CI/CD

The workflow at [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) is designed to be **100% self-provisioning and idempotent**—you do **not** need to run any manual CLI commands on your machine to create the D1 database, run migrations, or seed the initial data.

### Step 1: Create a Cloudflare API Token
1. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **My Profile** -> **API Tokens** -> **Create Token**.
2. Start from the **Edit Cloudflare Workers** template and ensure the following permissions are included:
   - **Account** -> **Workers Scripts**: `Edit`
   - **Account** -> **D1**: `Edit`
   - **Account** -> **Workers KV Storage** (optional): `Edit`
3. Copy your **API Token** and your **Account ID** (visible on the right sidebar of the Workers & Pages overview page).

### Step 2: Configure GitHub Repository Secrets
In your GitHub repository (`Matt-Bloise/leeroy-board`), navigate to **Settings -> Secrets and variables -> Actions -> New repository secret** and add:

| GitHub Secret Name | Required? | Description |
| :--- | :---: | :--- |
| `CLOUDFLARE_API_TOKEN` | **Yes** | Cloudflare API token with `Workers Scripts: Edit` and `D1: Edit` permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | **Yes** | Your 32-character Cloudflare Account ID. |
| `ANTHROPIC_API_KEY` | **Yes** | Site's Claude API key (`sk-ant-...`) used by `worker/claude.js` to answer `/ask` queries. |
| `BOARD_ADMIN_TOKEN` | Optional | Shared secret key matched against `#k=<token>` in the browser URL for write intents (`/api/intent`, `/api/sheet`). If omitted, writes are open to all party members. |
| `DISCORD_WEBHOOK_URL` | Optional | Discord channel webhook URL for `#wow-forever` to mirror Leeroy's Claude answers into Discord chat. |

### Step 3: Trigger the GitHub Actions Pipeline
The pipeline runs automatically whenever changes in `infrastructure/**` are pushed, or you can trigger it manually at any time:
1. Go to **Actions -> Deploy Cloudflare Serverless Stack (Workers + D1 + Durable Objects)** in GitHub.
2. Click **Run workflow** (leave `seed_d1` as `false` for normal deploys; the workflow automatically seeds D1 on first creation when `kv_state` has `0` rows, or set `seed_d1` to `true` if you want to force-reset D1 from the repo's `data/*.json` files).

### What the CI Pipeline Does Automatically on Every Run
1. **D1 Provisioning (`Ensure D1 Database Exists`)**:
   - Runs `npx wrangler d1 list --json` to check if `leeroy-board-db` exists in your Cloudflare account.
   - On the very first run, it automatically creates `leeroy-board-db` (`npx wrangler d1 create leeroy-board-db`), extracts its UUID, and patches `database_id` in `infrastructure/wrangler.toml`.
2. **Schema Migration (`Apply Idempotent D1 Schema`)**:
   - Executes [`infrastructure/schema.sql`](./schema.sql) (`CREATE TABLE IF NOT EXISTS ...`) against the remote D1 database.
3. **Smart Initial Seeding (`Seed Initial Board & Library Data into D1`)**:
   - Checks `SELECT COUNT(*) FROM kv_state` in D1.
   - If the database is brand new (`0` rows) or `seed_d1 == 'true'` was requested via `workflow_dispatch`, runs [`scripts/seed-d1.mjs --remote`](./scripts/seed-d1.mjs) to populate all 9 board JSON documents (`party`, `timeline`, `stats`, `signups`, `tonight`, `launch`, `decide`, `marks`, `links`), all 19 library blobs (`index.json`, `classes.json`, etc.), all 59 library pages (`lib_pages`), and all 186 external source URLs (`lib_sources`).
   - On subsequent code deployments, it **skips seeding** so live edits, signups, and Claude Q&A turns stored in D1 are never overwritten by static repo files.
4. **Worker + Durable Object + Cron Deployment (`npx wrangler deploy`)**:
   - Deploys `leeroy-brain`, provisions the SQLite-backed `BoardRoom` Durable Object migration (`v1`), and activates the `*/15 * * * *` Cron Trigger.
5. **Secret Synchronization (`Sync Worker Secrets`)**:
   - Pushes `ANTHROPIC_API_KEY`, `BOARD_ADMIN_TOKEN`, and `DISCORD_WEBHOOK_URL` into encrypted Cloudflare Worker Secrets via `npx wrangler secret put`.

---

## 4. Local Development & Verification

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

To test the frontend against your local Worker, open the board with `?brain=http://localhost:8787/api` (or set `localStorage.setItem("board-brain-url", "http://localhost:8787/api")`).
