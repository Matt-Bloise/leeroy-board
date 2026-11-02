# Privacy notice (draft)

**DRAFT. Every legal point here needs review by counsel before publication. Retention periods and some facts are marked (unverified) or (proposed) and need owner decisions.** This is not legal advice. Reviewers: the owner and the back-end architect. The table-level source for this notice is `docs/data-inventory.md`.

The Leeroy Living Board is an unofficial companion for guilds playing WoW Forever. It runs on Cloudflare. This notice says what we hold about you, why, who else sees it, and what you can do.

## What we collect

| Category | What | Where it comes from |
| :--- | :--- | :--- |
| Discord id | Your numeric Discord user id | Discord login or a Discord interaction |
| Display name | Your Discord name, and a handle or nickname used on the board | Discord, and the guild admin |
| Avatar | Your Discord avatar image reference | Discord (unverified whether stored or only displayed) |
| Guild and roles | Which Discord guild you belong to and your roles there | Discord, guild admin |
| Builds | Characters, talents, gear and sheet fields you or your guild enter | You |
| Sign-ups | Raid and event attendance you set | You |
| Saved settings | Preferences and journey state | You |
| Questions to Leeroy | What you type into Ask, and the answer | You |
| Device logs | Technical data from your browser and device: IP address, request time, device and browser type, and the settings your device keeps locally | Your device (unverified exactly what is stored server-side) |

Optional, only if you attach them: a Google account identifier; a Battle.net account identifier used to confirm a character is yours.

We do not read or store Discord message content for the board, except where the next section says so.

## Message content disclosure

The bot answers slash commands and other interactions sent to it over HTTP (`POST /discord`). It is not set up to read your channel messages (unverified; counsel and the owner should confirm no Message Content intent is enabled in the Discord developer portal). What you type into a command or into the Ask box is stored and sent to an AI vendor, so do not put anything private in it. If this changes the notice will change first.

## Why we use it (purposes)

| Purpose | Categories | Basis (counsel to confirm) |
| :--- | :--- | :--- |
| Sign you in and keep you signed in | Discord id, display name, avatar, sessions | Contract / legitimate interests |
| Show your guild's board, builds and sign-ups | Guild and roles, builds, sign-ups | Contract / legitimate interests |
| Answer your questions with AI | Questions, answers | Contract / consent (counsel) |
| Protect the service: rate limits, abuse, debugging | Device logs, hashed IP | Legitimate interests |
| Verify character ownership and give Blizzard attribution | Battle.net identifier (optional) | Consent |

We do not use your data for advertising or profiling.

## Who receives it (recipients)

| Recipient | Why | What |
| :--- | :--- | :--- |
| Cloudflare | Hosting, database, Workers, Durable Objects, logs | Everything stored in the service |
| Discord | Login and bot | Your Discord id and the interactions you make |
| Blizzard | Attribution and, if you attach it, character verification. We use Blizzard game data and names under their terms; we are not affiliated | Battle.net identifier, only if attached (proposed) |
| Google | Only if you attach a Google identity | Google account identifier |
| AI vendor | Answering Ask | Your question and context. The vendor is whichever provider is configured (`worker/ai-models.js` lists several, among them Anthropic, Google, Groq, Cerebras, Cloudflare Workers AI and OpenRouter); see `docs/subprocessors.md` |
| Your guild admins | Running your guild's board | Your name, roles, builds and sign-ups in that guild |

Other members of your guild can see what the board shows about you. Ask answers marked shared are visible to the group (`ask_turns.share` defaults to shared).

**We do not sell your data and we do not share it for advertising.** Counsel to confirm wording for US state laws that define "sale" and "sharing" broadly.

## Retention

All values are (proposed) unless stated and are not yet implemented in code. The owner decides; the architect confirms feasibility.

| Data | Proposed retention |
| :--- | :--- |
| Account (Discord id, display name, avatar) | Until you delete your account or your guild is removed; then purge within 30 days |
| Sessions | Until expiry; expired rows purged. Maximum lifetime to be set (unverified current value) |
| Builds, sign-ups, saved settings | Until you delete them or your account |
| Questions and answers (Ask) | 90 days, then deleted or anonymised |
| Hashed guest IP for rate limits | 24 hours |
| Cloudflare and Worker logs | As set in Cloudflare (unverified; counsel to note) |
| Audit log of admin actions | 12 months |
| Backups (D1 Time Travel) | Cloudflare's window (unverified; see `docs/runbooks/backup-restore.md`); deleted data can persist in backups until they expire |
| Guild data after the guild removes the bot | 30 days, then purge |

## Your rights

Depending on where you live (counsel to confirm which laws apply and the response time): access, correction, deletion, export, objection or restriction, withdrawal of consent, and complaint to your regulator. You can erase your account yourself with `DELETE /me`; what it removes was not checked against every table (see "Known gaps" in `docs/data-inventory.md`). Export and a fuller erase (`GET /api/me/export`, `POST /api/me/erase`) are built but stay switched off until counsel and the owner enable the `DATA_RIGHTS` flag. Until a contact is published, requests go to the owner at **(contact to be added)**.

## Children

The service is not for anyone under 13, or under the age of digital consent where you live if higher. Discord requires users to be 13 or older. We do not knowingly collect data from children; if we learn we have, we delete it. (Counsel to confirm the threshold and any parental-consent duty.)

## International transfers, security, changes

Cloudflare and the AI vendors may process data outside your country; counsel to confirm the transfer mechanism. Member keys and session tokens are stored only as salted hashes. No system is perfectly secure. We will update this notice with a date when it changes. Not yet decided: legal entity name, representative in the EU/UK (if required), and whether a data processing agreement is offered to guild admins.
