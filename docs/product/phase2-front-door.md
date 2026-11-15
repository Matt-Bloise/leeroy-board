# Phase 2 design: know the asker, fix the front door

Design only, nothing built. 2026-11-14, base 7fb60170. Members are A to E, characters fictional. **[read]** = read in the file named; **[inferred]** = unverified.

## 1. What exists today

| Feature | Where | Flag (wrangler.toml) | State |
|---|---|---|---|
| Characters per person | `characters-api.js`, `js/characters.js`, `scenes/sheet.js`, migrations 0002 `characters`, 0005 `character_profiles` | `CHARS_V1` off | [read] Add, rename, select; max 12; list hides rows with realm `unset` (the `/build` row). No purpose (alt, PvP) or account label. |
| Which character on /ask | `ask-build.js` `findAsker` | none | [read] Picks the party-sheet by roster slug, one per person. The ask path never reads `characters`/`builds`. Nothing asks. |
| Join flow | `join.js`, `build-modal.js`, `project-build.js`, `discord.js:795-815` | `BUILD_MODAL`, `BUILD_PROJECT`, `JOIN_PROMPT` all off | [read] `/join` modal writes user, character (id `tenant:discordId`, realm `unset`), build, roster, party doc. Non-roster `/sheet` still answers "An admin can add you." No `memberships` row is written (only `setup-command.js` does). |
| Discord login | `web-auth.js` | `WEB_LOGIN` off | [read] Scope `identify`, PKCE, 30-day `__Host-sess`. **Any** Discord account gets a session: no roster or membership check. |
| Add-on import | `addon/LeeroyBuild`, `tests/browser/addon-import.mjs` | n/a | Add-on exports a pasted string [read, .toc]. Importer is on the site; its page was not read [inferred]. |
| Front page | `index.html` | n/a | [read] Twelve-tab launch board. Ask box hidden unless a board key exists; copy says guests get 2 an hour. |
| Ask box | `js/ask.js` | n/a | [read] 280 chars, seven-provider picker, "Also share in #wow-forever" box, six-per-hour limit text (copy and code disagree: 2 vs 6). |
| Answers page | none | n/a | [read] `GET /api/ask?id=`. A random-UUID **shared** turn is readable by id alone (`index.js` ~1090). With `WEB_LOGIN` on, any session reads the newest shared turn (~1111). |

The review-defect classes are in [docs/review-classes.md](../review-classes.md), but the Nov 14 exposure itself has no in-repo record (closest: audit finding 4, `tests/unit/ask-anonymous-privacy.test.mjs`). Adversarial tests below are mine.

## 2. Work items

### W1. Roster gate, then Discord login on (risk 6)
- **Files:** new `member-gate.js` (`isRosterMember(env, discordId)`: `discord_members` roster id match or active `memberships`); `web-auth.js`, `index.js` (`/me`, `/ask` session branch ~1089-1125, socket auth ~1007), `characters-api.js` `tenantFor`, `data-rights.js`.
- **Change:** `webSessionFrom` still proves identity; every member-only route now also needs the gate. `/me` returns `member: false` for outsiders. `tenantFor` stops falling back to "the only tenant" for non-members (today an outsider could add characters).
- **Flags:** `WEB_LOGIN` on after the gate merges. No migration.
- **The tank player:** Discord portal: add redirect `https://api.leeroy.party/api/auth/discord/callback` (from `redirectUri()`), confirm secret `DISCORD_CLIENT_SECRET`. Privacy page changes first ("Web sign-in is off today", line 46).
- **Tests:** (1) id is never a credential: a UUID shared turn, an old timestamp id and a guessed `?id=` return nothing without session plus gate. (2) Discord account with no roster entry: gets `member:false`, 401 from `/api/home`, empty socket payload (extend `live-socket-privacy.test.mjs`), cannot POST `/me/characters`. (3) Public-read allow-list unchanged (`public-read-contract.test.mjs`).

### W2. Join with no admin step (risk 4)
- **Files:** `join.js`, `build-modal.js`, `project-build.js`, `discord.js` (replace `notOnRoster`: reply with `joinHintBody()` instead of the admin line), new `POST /api/me/join` in `characters-api.js` for the web.
- **Change:** project-build also inserts `memberships` (role `member`, active) in its one atomic batch. Gate = being in the Discord server (slash command arrives with `guild_id`). Web join needs proof of guild membership: probe `guilds.members.read` scope versus a bot REST lookup [inferred; unverified which needs a privileged intent]. No approval queue.
- **Flags:** `BUILD_MODAL`, `BUILD_PROJECT`, `JOIN_PROMPT` on. No migration.
- **The tank player:** confirm the server is invite-only; if anyone with a link can enter, "in the server" is not a gate.
- **Tests:** new Discord account runs `/join` then `/ask` and gets a personal answer, zero admin calls (extend `join-flow.test.mjs`); a user from another guild is refused; a second `/join` is idempotent; hidden-field test: a new member's sheet fields default `visible:false`.

### W3. Characters per person (risk 4)
- **Migration 0011** (0008 is taken twice; check the number at merge). Side table, no `ALTER` (runbook rule):
  ```sql
  CREATE TABLE IF NOT EXISTS character_meta (
    character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL DEFAULT 'main' CHECK (purpose IN ('main','alt','pvp','other')),
    account_label TEXT,                 -- "account 2", typed by the member
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    group_visible INTEGER NOT NULL DEFAULT 0 CHECK (group_visible IN (0,1)),
    source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','modal','addon')),
    updated_at TEXT NOT NULL);
  ```
  Mirror in `schema.sql`; add to `DATA_MAP` (`data-rights.js`; `data-map.test.mjs` enforces). `/build` rows (realm `unset`) become the default main.
- **Files:** `characters-api.js` (list includes `unset`, accepts purpose and label), `scenes/sheet.js`, `js/characters.js` (kept in sync; drift test exists), the add-on importer (write `source='addon'`).
- **Rule:** alts and PvP characters are private to the owner unless `group_visible` is set; only the main appears in `PARTY_BUILDS`. This keeps today's hidden-field rule.
- **Tests:** 12 cap; second account via `human_members`; rename collision; B cannot select, rename or read A's character by id; hidden field of A never appears in B's `/api/me`; add-on string with out-of-range level rejected.

### W4. Which character on /ask (risk 7, waits for Phase 1)
- **Rule:** assume the default character. Ask only when: more than one character; `buildRelevant` says the build matters (existing `SELF_RE` logic); the question names no class or race that picks one; it is not a follow-up in a thread that already chose. Otherwise answer at once and add a footer "as Sinjin, Warlock (main)" with a Switch button. The question, when asked, is one ephemeral row of up to five buttons plus "none of these"; it never blocks.
- **Files:** `ask-build.js` (new `loadCharacterContext(env, discordId, characterId)` replacing the party-sheet lookup for members who have characters), `answer-ux.js` (buttons), `discord.js` (ask handler), `js/ask.js` chip. **Touches `ai-models.js` `buildAnswerInputs`: must wait for Phase 1 to land.**
- **Flags:** `CHARS_V1` plus new `ASK_CHAR_PICK` (default off).
- **Tests:** member with two characters, question "best talents for my build": asks once; "best Mage talents": no ask; ask 2 in a thread: no ask; alt hidden field never reaches a public ask prompt (`includeHidden` only on private); canary: character name appears only as an alias in outbound bodies (brief P12).

### W5. Front page and members-only split (risk 6)
- **Files:** new `home.html`, `js/home.js`, `css/home.css`; new `GET /api/home` (member-only: me, characters, last answers, you-said-we-did) and `GET /api/changes` (public); answer page `/a/<id>`; `index.js` routes; `js/ask.js` simplified (no model picker, 2000 chars, private by default, "share with group" opt-in; today it defaults shared).
- **Public:** "what changed" (new `kv_state` doc `changes`, link, title, date, own-words line, written by the Phase 2 watcher, hidden when empty) and "coming up" from `decide.dates`, already public. Both added to `public-read-allowlist.json` by hand with the diff read.
- **Members:** ask box, my characters, group answers (share=1 only), my private answers (by `ask_turn_askers.asker_hash`), you said we did (`kv_state` doc `you_said_we_did`, members-only).
- **Flags:** `HOME_V2` (Worker and client). Migration: none.
- **Tests:** anonymous crawl of every route, the socket and `/api/changes` finds no question, answer, name or trace (VAREN `product.exposure` plus a canary question); B's answer page contains none of A's hidden fields; guest flood: 300 guest asks from 50 IPs leave a member's ask unchanged (guest neuron share capped, separate key `ai_budget:<day>:guest`); **member at ask 41** answers, no wall string (grep `budget_user`, "Try again in a moment", "opens up again"; `budget.js:142`, `discord.js:596`, `js/ask.js:80`), this part touches `ai-models.js`, `budget.js`: waits for Phase 1; cold load, valid cookie: one `/api/home` request before first paint, box focused, one tap (Send) to an answer, Lighthouse run from `lighthouserc.json`, no WebGL on the path.

## 3. Order, dependencies, owner needs

| Order | Item | Parallel? | Files shared with others | Risk |
|---|---|---|---|---|
| 1 | W1 gate | with W3 migration and W2 | `index.js`, `characters-api.js` | 6 |
| 1 | W3 characters | with W1, W2 if `characters-api.js` is split by item first | `characters-api.js`, `data-rights.js` | 4 |
| 1 | W2 join | with W3 | `discord.js` (own handler file) | 4 |
| 2 | W5 front page (client, `/api/changes`) | after W1; the server half of ask-41 waits | `index.js`, `ask.js` | 6 |
| 3 | W4 which-character | **after Phase 1** (`ai-models.js`) and W3 | `ai-models.js`, `ask-build.js` | 7 |

**Needs the tank player:** Discord app redirect and secret; `WEB_LOGIN`, `CHARS_V1`, `BUILD_*`, `JOIN_PROMPT`, `HOME_V2`, `ASK_CHAR_PICK` in production; invite-only confirmation; the healer player if production flags or secrets sit on his account; the privacy page change before login goes on.

**Mock to the tank player before building (5):** the five wireframes below, as a clickable mock. The Activity board mock is separate (brief 4.4).

**Usage count before deleting anything:** per-command and per-tab production counts over 14 days or more, a repo tag, the tank player's yes. This design deletes nothing.

## 4. Wireframes (mobile, 36 columns)

```
1 FRONT PAGE, SIGNED OUT
+----------------------------------+
| LEEROY            [Sign in]      |
| What changed this week           |
|  Nov 10  Hotfix: auction deposit |
|          source: Blizzard, 11/10 |
|  Nov 9   Hotfix: class tuning    |
| Coming up                        |
|  Dec 9   Raids open (confirmed)  |
| Ask Leeroy? Sign in with Discord.|
| [ Sign in with Discord ]         |
+----------------------------------+
2 SIGNED-IN HOME
+----------------------------------+
| Leeroy      A (Sinjin, main) v   |
| +------------------------------+ |
| | Ask anything...              | |
| +------------------------------+ |
| [x] private   [ Send ]           |
| Group answers                    |
|  B: best bags?   Helpful 2       |
| My private answers (3)           |
| You said, we did                 |
|  "too wordy" -> shorter, Nov 12  |
| What changed | Coming up         |
+----------------------------------+
3 ANSWER PAGE (members only)
+----------------------------------+
| < Home                           |
| Q: best talents for my build?    |
| Answer line first. Pick: X.      |
| Why. Choose Y if Z.              |
| as Sinjin, Warlock [Switch]      |
| Sources: Blizzard 11/10 (conf.)  |
| [Helpful] [Off] [More]           |
+----------------------------------+
4 MY CHARACTERS
+----------------------------------+
| My characters (3 of 12)          |
| (*) Sinjin  Warlock  main        |
| ( ) Tuck    Rogue    alt         |
| ( ) Ruk     Orc PvP  acct 2      |
| Group sees: main only [change]   |
| [ Add ] [ Paste add-on string ]  |
| Hidden fields: only you see them |
+----------------------------------+
5 JOIN (signed in, no roster entry)
+----------------------------------+
| Hi C. You are not on the board.  |
| Handle (a game name) [_________] |
| Class [v]  Race [v]  Role [v]    |
| [ Join ]    no approval needed   |
| Not in the server? Join it first.|
+----------------------------------+
```

## 5. Unverified

- Guild membership proof for web join (scope versus bot lookup, privileged intent).
- Whether `POST /ask` accepts a web session.
- What the live socket sends to a `web`-authenticated upgrade.
- Add-on importer page and location.
- Production flags, usage counts, the server's invite setting.
- Cookie reach from the API host to the board host.
