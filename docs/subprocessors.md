# Sub-processors (draft)

**DRAFT; needs counsel and the owner before publication.** Lists the third parties that may receive personal data to run the service. Built from `infrastructure/README.md`, `infrastructure/wrangler.toml` and `infrastructure/worker/ai-models.js` read on 2026-11-02. Whether each is a processor, a controller or a recipient in law is a question for counsel. "Active" means in production use: unverified for every row unless stated, because secrets and production settings were not inspected. Locations and certifications were not checked; fill from each vendor's own documentation.

| Vendor | Role | Data | Where used | Status | Location / safeguards |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Cloudflare | Hosting (Pages), Worker, D1, Durable Objects, logs, cron | All stored data; request metadata including IP | Whole service | Active | (to confirm) |
| Discord | Login (OAuth) and bot interactions | Discord id, name, avatar, guild and roles | `POST /discord`, `POST /auth/discord` | Active | (to confirm) |
| Blizzard Entertainment | Game data and attribution; character verification if built | Battle.net identifier (optional, proposed) | Planned in ADR 0001 | Not built (unverified) | (to confirm) |
| Google | Optional attached sign-in identity | Google account id | Planned in ADR 0001 | Not built (unverified) | (to confirm) |
| Google (Gemini) | AI answers | Question and context | `worker/ai-models.js` provider `gemini` | Configured if `GEMINI_API_KEY` is set (unverified) | (to confirm) |
| Anthropic | AI answers | Question and context | provider `claude` | Configured if `ANTHROPIC_API_KEY` is set (unverified) | (to confirm) |
| Groq | AI answers | Question and context | provider `groq` | Same | (to confirm) |
| Cerebras | AI answers | Question and context | provider `cerebras` | Same | (to confirm) |
| OpenRouter (and the model hosts behind it) | AI answers | Question and context | provider `openrouter` | Same | (to confirm); onward hosts are a gap |
| Cloudflare Workers AI | AI answers | Question and context | provider `workers-ai` | Default and used in previews | Same as Cloudflare |
| GitHub | Source code and CI; GitHub Models provider | Code, CI logs; question text if the GitHub Models provider is enabled | Repo, workflows, provider `github` | Repo active; provider unverified | (to confirm) |

## Open items
1. The AI provider list is a code fact, not a decision: pick which vendors are actually allowed for production and drop the rest from the code and this table.
2. Check each vendor's retention and training-on-inputs terms for free tiers, which are often weaker than paid ones. Free-tier use with member questions is a legal risk for counsel.
3. Decide how guild admins are told of changes (notice period, objection route).
4. Decide whether a vendor receives names and Discord ids in prompts or only the question text; read the prompt builders before claiming either.
