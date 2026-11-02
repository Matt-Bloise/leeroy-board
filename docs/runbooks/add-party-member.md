# Runbook: add a person to the party

Use this when someone new joins the friends' Discord and should appear on the board. It works for the sixth person and for the tenth. Nothing here needs a code change.

## The normal way: the person fills /join

With the flags `BUILD_MODAL` and `BUILD_PROJECT` on (set in `infrastructure/wrangler.toml` `[vars]`, shipped `off`), nobody runs a script:

1. The person joins the Discord and types `/join` (or presses **Join the board** on the hint that `JOIN_PROMPT` shows to an unknown person who tries `/ask` or `/sheet`).
2. They fill the form: game handle, class, race, role, optional notes. The handle is the name the board shows; it must not hold `@`, a link, a slash or a publisher's mark, and it must not be anyone else's.
3. In one atomic write the Worker saves their rows, their roster entry (Discord id to slug and name; the slug is always the handle in lowercase with dashes), and their card in the party document, then refreshes the cache and tells open boards. They get a private "Saved" message with a link.

Nothing is written if any part fails, and the person is told so. A handle that is already taken is refused (never renamed or suffixed). A person who already has a card cannot rename themselves; an admin does that.

What is still by hand: the **member key** (step 4 below; no route exists, and keys are not touched by this flow) and turning on the real-count copy (step 8). The Worker's built-in five names stay as a fallback only; everyone else is read from D1, so the old step 6 is no longer needed.

The scripted steps below are the **admin fallback**: use them when the flags are off, when the person cannot use Discord forms, or to repair a card.

## What a new member needs

| Need | What it is | Where it lives |
| :--- | :--- | :--- |
| Discord user id | 17 to 20 digits (Discord, Developer Mode, Copy User ID). Maps the Discord user to the board name. | `discord_members` row in D1 `kv_state` (private, write-only) |
| Game handle | The name shown on the board. A character or table nickname, 1 to 40 characters. Never a real name, never contact details, no publisher marks. | party document, `discord_members` |
| Class and race | One class and one race from the lists in `tools/add-member.mjs`. | party document |
| Their agreement | They have said yes to being on the board. Ask before you add anyone. | outside the repo |
| A member key | Lets them edit their own sheet and sign-ups from the board. Stored only as a salted hash. | `members` table |

The script fills in a spec of "Not chosen yet", no professions and a role from the class. The person sets the rest on their own sheet.

## Steps

| # | Step | Who | How |
| :-- | :--- | :--- | :--- |
| 1 | Collect the four facts above | Matt | Ask in the Discord. Do not write them down anywhere that is not private. |
| 2 | Dry run | Matt, or anyone with the repo | `node tools/add-member.mjs --id <id> --name "<handle>" --class <class> --race <race>` prints the requests and sends nothing. Add `--party-file <saved copy of GET /api/data/party>` to see the member count and catch a duplicate. |
| 3 | Apply | Matt (admin token) | `BOARD_ADMIN_TOKEN=... node tools/add-member.mjs ... --apply`. It saves the old party document to a backup file (path printed), writes the roster entry (`POST /api/admin/members`), then the party document (`PUT /api/data/party`). The token is read from the environment only. Keep the backup file until step 8. |
| 4 | Make the member key | Matt, with the new member | See below. No route exists for this, so it is SQL. |
| 5 | Check the live board | Matt | Open leeroy.party. The new name is in the name chips, on the front tile and in The five. Copy still says "five" while the flag is off; that is expected. |
| 6 | Built-in lists | Nobody | No longer needed: `/sheet` and the build thread names read the party document and roster from D1 (`infrastructure/worker/party-source.js`); `PARTY_MEMBERS` and `ROSTER_DATA` are only the fallback for the first five. The AI's own party summary fallback in `ai-models.js` is unchanged and still lists only the first five. |
| 7 | Refresh the repository copy | Josh | `data/party.json` is generated and is the static fallback and the preview seed. The generator picks the member up from the live document. Do not hand-edit it. |
| 8 | Turn on the real count | Matt | Set `"party.n": true` in the `flags` of `data/client.json`, the way the other flags are set (who edits that file is Josh's call; the flag is read by `js/board.js`). Copy that said "five" then says the real count and the scene tab reads "The party". Scene ids and links (`#five`) do not change. |
| 9 | Prove it | Anyone | Run `node browser/six-members.mjs --url <preview or live origin>` from `tests/` (the same suite runs in Preview Tests). |

### Step 4: the member key

Never put a key in a chat, a command line argument, an issue or a file in the repo. `infrastructure/scripts/hash-key.mjs` reads the key from stdin and the salt from `KEY_SALT`.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > key.txt   # on the member's own device if possible
```

```bash
# on Matt's machine, with KEY_SALT set from the secret store (see docs/runbooks/secrets.md), key piped in:
KEY_SALT="$KEY_SALT" node infrastructure/scripts/hash-key.mjs <slug> < key.txt
```

The second command prints one `INSERT INTO members ...` statement. Run it with `cd infrastructure && npx wrangler d1 execute <database> --remote --command="<that statement>"`, then delete `key.txt` after the member has the key by a private route. The Worker caches the member list for up to 15 minutes, so the key works within a quarter of an hour. The slug is the one the dry run printed.

## Rollback

Pick the smallest one that undoes what went wrong.

| What to undo | How |
| :--- | :--- |
| The person is on the board and should not be | Put the backup back: `curl -X PUT "$API/api/data/party" -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "content-type: application/json" --data @<backup file>`. The Worker purges its cache on PUT; the board updates for open tabs by itself. |
| The roster entry | There is no delete route and the roster has no read route. An unused entry is harmless. To remove it, send the whole roster without the entry with `PUT /api/config/discord_members` (you need your own copy of the roster), or use D1 Time Travel to the minute before step 3. |
| The member key | `DELETE FROM members WHERE slug = '<slug>';` with `wrangler d1 execute --remote`. Gone within 15 minutes. |
| Sheet edits the person made | `DELETE FROM sheet_events WHERE slug = '<slug>';` then `DELETE FROM kv_state WHERE key = 'party_sheets';` (the Worker rebuilds that cache row). |
| The /join flow wrote someone it should not have | Set `BUILD_PROJECT` back to `"off"` (and `BUILD_MODAL` to turn the form off), then undo the person as in the first two rows. The `characters` and `builds` rows are removed with the person's `users` row (`POST /api/me/erase` or an admin `DELETE FROM users`). |
| The count copy | Set `"party.n"` back to `false`. The old wording returns on the next load. |
| Everything | D1 Time Travel to just before step 3 (see `docs/runbooks/rollback.md` and `docs/runbooks/backup-restore.md`). |

## Privacy

The board shows game handles only. Do not store a real name, an email address, a phone number or anything about a person's life outside the game, in the party document, the roster, a test or a commit message. The script refuses a name that contains `@`, a link or a publisher's mark, and takes no real name. The one place real first names may exist, `name_map`, is private, write-only, and is replaced as a whole object: Matt edits it by hand, and only if answers need it.

## Known limits

- The class and race lists in `tools/add-member.mjs` are for World of Warcraft Classic. A different game needs different tables; the steps stay the same.
- Some classes share a colour or a medallion with another member. Two people of one class are allowed by the data, but the buff wheel and Decide scene are written per class, so check them (step 5) after adding a second of any class.
- `PUT /api/data/party` replaces the whole document. If someone else edits it between the script's read and write, the later write wins. Run the script when nobody else is changing party data.
