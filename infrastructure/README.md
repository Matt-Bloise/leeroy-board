# Cloudflare 100% Serverless Infrastructure & GitHub Actions CI/CD Proposal

This directory (`infrastructure/`) contains the complete Infrastructure-as-Code (IaC), Cloudflare Worker runtime, D1 SQLite schema, automated seed tooling, and GitHub Actions CI/CD workflows to run the **Dungeons & Drinking Living Board** (`leeroy-board` + `leeroy-brain`) at **$0/month** on Cloudflare's Free Tier + the site's existing Anthropic Claude API key.

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
| **Cloudflare Pages (`leeroy-board`)** | **Unlimited requests & bandwidth** | Hosts `index.html`, `js/`, `css/`, `scenes/`, `atlas/`, `img/`, `fonts/` |
| **Workers Requests (`leeroy-brain`)** | **100,000 req / day** | ~500–3,000 req/day (Edge Cache absorbs >95% of reads) |
| **Edge Cache (`caches.default`)** | **Unlimited (Unmetered)** | Serves `/api/bootstrap` and `/api/library/*.json` in 10–25 ms globally |
| **D1 Serverless SQLite** | **5 GB storage, 5M row reads/day, 100k writes/day, 10 DBs** | ~3.5 MB total storage; 1 production DB + up to 9 concurrent PR preview DBs |
| **Durable Objects (`BoardRoom`)** | **100,000 req/day, 13,000 GB-s/day, 5 GB SQLite** | Hibernates at 0 GB-s when idle; instant `<5ms` WebSocket fan-out |
| **Cron Triggers** | **5 schedules / account** | 1 schedule (`*/15 * * * *` on production only) |

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
| [`workflows/deploy-cloudflare.yml`](./workflows/deploy-cloudflare.yml) | Reference copy of [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) — deploys to **Production ONLY on new commits to `master`**. |
| [`workflows/pr-preview-cloudflare.yml`](./workflows/pr-preview-cloudflare.yml) | Reference copy of [`.github/workflows/pr-preview-cloudflare.yml`](../.github/workflows/pr-preview-cloudflare.yml) — spins up isolated **Ephemeral PR Environments** (`Pages + Worker + DO + D1`) on PR open/sync and tears them down on PR merge/close. |

---

## 3. Spinning Up & Deploying to Production via GitHub Actions (`master` Only)

The production workflow at [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) runs **exclusively on new commits pushed to `master`**:

```yaml
on:
  push:
    branches:
      - master
```

### Step 1: Create a Cloudflare API Token
1. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **My Profile** -> **API Tokens** -> **Create Token**.
2. Start from the **Edit Cloudflare Workers** template and ensure the following permissions are included:
   - **Account** -> **Workers Scripts**: `Edit`
   - **Account** -> **D1**: `Edit`
   - **Account** -> **Cloudflare Pages**: `Edit`
3. Copy your **API Token** and your **Account ID** (visible on the right sidebar of the Workers & Pages overview page).

### Step 2: Configure GitHub Repository Secrets
In your GitHub repository (`Matt-Bloise/leeroy-board`), navigate to **Settings -> Secrets and variables -> Actions -> New repository secret** and add:

| GitHub Secret Name | Required? | Description |
| :--- | :---: | :--- |
| `CLOUDFLARE_API_TOKEN` | **Yes** | Cloudflare API token with `Workers Scripts: Edit`, `D1: Edit`, and `Cloudflare Pages: Edit` permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | **Yes** | Your 32-character Cloudflare Account ID. |
| `ANTHROPIC_API_KEY` | **Yes** | Site's Claude API key (`sk-ant-...`) used by `worker/claude.js` to answer `/ask` queries. |
| `BOARD_ADMIN_TOKEN` | Optional | Shared secret key matched against `#k=<token>` in the browser URL for write intents (`/api/intent`, `/api/sheet`). If omitted, writes are open to all party members. |
| `DISCORD_WEBHOOK_URL` | Optional | Discord channel webhook URL for `#wow-forever` to mirror Leeroy's Claude answers into Discord chat. |

### Step 3: Merge to `master`
When any commit lands on `master`, GitHub Actions automatically executes the full production pipeline:
1. **D1 Provisioning (`leeroy-board-db`)**: Creates the production D1 database on first run and patches `wrangler.toml`.
2. **Schema Migration**: Executes [`infrastructure/schema.sql`](./schema.sql).
3. **Smart Initial Seeding**: Seeds `leeroy-board-db` from `data/*.json` and `data/library/*.json` only if `kv_state` is empty (`0` rows), preserving live party state on all future `master` deploys.
4. **Worker + Durable Object + Cron Deployment**: Deploys `leeroy-brain` and syncs secrets.
5. **Production Static Site Deployment**: Stages the static frontend bundle and deploys it to **Cloudflare Pages production** (`leeroy-board`, `--branch=master`).

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

### How It Works
- **On PR Open / New Commit (`opened`, `synchronize`, `reopened`)**:
  1. Creates isolated D1 database `leeroy-board-db-pr-<N>`, applies `schema.sql`, and seeds it from the PR branch's `data/*.json`.
  2. Deploys isolated Worker `leeroy-brain-pr-<N>` (with its own `BoardRoom` Durable Object) and syncs `ANTHROPIC_API_KEY` + `BOARD_ADMIN_TOKEN`.
  3. Stamps the PR Worker URL into `.cloudflare-dist/js/brain.js` (and `js/brain.js` also auto-detects `pr-<N>.leeroy-board.pages.dev`), then deploys the static site to `https://pr-<N>.leeroy-board.pages.dev`.
  4. Posts/updates a sticky comment on the PR with clickable links to the live preview site and preview Worker API.
- **On PR Merge or Close (`closed`)**:
  1. Deletes the ephemeral Worker & Durable Object (`npx wrangler delete --name leeroy-brain-pr-<N> --force`).
  2. Deletes the ephemeral D1 database (`npx wrangler d1 delete leeroy-board-db-pr-<N> --skip-confirmation`).
  3. Deletes the Cloudflare Pages preview deployments for branch `pr-<N>` via the Cloudflare API.
  4. Updates the sticky PR comment to confirm all preview resources were torn down.

---

## 5. Local Development & Verification

You can also run the entire Cloudflare Worker + D1 + Durable Objects stack locally on your machine using Wrangler's built-in Miniflare simulator:

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
