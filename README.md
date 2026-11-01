# Dungeons and Drinking: The Living Board (`leeroy-board`)

Self-contained, serverless web application and Discord companion for the five-player **World of Warcraft: Forever** Horde group (**Santa**, **Bible Boi**, **Street Rat**, **Bloise**, **Handsome Squidward**).

Previously a static export mirror of `Matt-Bloise/wow-mage`, `leeroy-board` now houses the entire runtime, database, multi-provider AI brain, source watcher, and Discord HTTP Interactions backend directly in this repository on the **Cloudflare Free Tier**.

---

## Architecture Overview

- **Frontend (`index.html`, `js/`, `scenes/`, `atlas/`, `room/`, `css/`)**:
  - Hosted on **Cloudflare Pages** with automatic PR preview environments (`.github/workflows/`).
  - Connects to the `leeroy-brain` Cloudflare Worker via [`js/brain.js`](js/brain.js) for single-roundtrip `/api/bootstrap` state, live WebSocket synchronization (`/api/live`), character sheet editing (`/api/sheet`), and Leeroy Chamber Q&A (`/api/intent`).
- **Serverless Edge Backend ([`infrastructure/`](infrastructure/README.md))**:
  - **[`infrastructure/worker/index.js`](infrastructure/worker/index.js)**: Edge-cached REST API (`/api/bootstrap`, `/api/state`, `/api/library/:name`, `/api/data/:name`, `/api/sheet`, `/api/vocab`, `/api/dispatch`, `/api/intent`, `/api/wiki/page`, `/api/wiki/snapshots`, `/api/wiki/proposals`).
  - **[`infrastructure/worker/room.js`](infrastructure/worker/room.js)**: Hibernatable WebSocket Durable Object (`BoardRoom`) for sub-second presence and live board updates.
  - **[`infrastructure/worker/ai-models.js`](infrastructure/worker/ai-models.js)**: Multi-provider AI RAG engine supporting **7 providers** (`claude`, `gemini`, `workers-ai`, `groq`, `cerebras`, `github`, `openrouter`), ranked by [`vendor/rank-core.js`](vendor/rank-core.js) with `wow-mage` house-voice guardrails (`repairHouseVoice`) and automated wiki fact extraction (`extractWikiFactsWithAi`).
  - **[`infrastructure/worker/scraper.js`](infrastructure/worker/scraper.js)**: 6-hour Cloudflare Cron Trigger (`0 */6 * * *`) that monitors canonical Blizzard/Wowhead/Warcraft Wiki sources (tracked in D1 lib_sources), archives stripped text snapshots in D1 (`lib_source_snapshots`), auto-learns updated facts (`wiki_proposals`), and rebuilds `search.json`, `open.json`, `index.json`, and category blobs in D1.
  - **[`infrastructure/worker/discord.js`](infrastructure/worker/discord.js)**: Ed25519-verified Discord HTTP Interactions endpoint (`/ask`, `/signup`, `/tonight`, `/sheet`, `/launch`, `/map`, `/status`, and interactive Sign-up card buttons).

---

## Common Workflows (No `wow-mage` Required)

All development, content authoring, and database management happen directly in this repository:

```bash
cd infrastructure
npm install

# 1. Initialize & migrate local D1 SQLite database, then seed from data/
npm run d1:schema:local
npm run d1:migrate:local
npm run d1:seed:local

# 2. Create a new numbered D1 SQL migration (auto-applied on every CI/CD deploy)
npm run d1:migrate:create -- add_new_column

# 3. Run the Cloudflare Worker + D1 locally on http://127.0.0.1:8787
npm run dev

# 4. Rebuild data/library/{search,open,index}.json stamps & TF-IDF indexes locally
npm run library:rebuild

# 5. Export live D1 state (remote or local) back to data/*.json
npm run d1:export:local
npm run d1:export:remote
```

See [`infrastructure/README.md`](infrastructure/README.md) for complete setup, API routes, and secret configuration.
