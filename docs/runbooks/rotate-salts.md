# Runbook: rotate USER_SALT and KEY_SALT

Prepared 2026-11-02. Nothing in this file has been run. The tool `tools/rotate-salts.mjs` only prints a plan; it cannot apply anything. Rotating the Worker secrets stays with the person who owns the Cloudflare account and the GitHub repository secrets. No salt or key value appears in this file, in the tool's output, or in its tests (they use made-up values).

## Why

Both salts were fixed constants committed to a repository that was once public (`secrets.md`, weakness 1). Every hash made with them can be attacked offline by anyone who has the old values. Rotating does not undo what was already copied; it makes new hashes safe.

## What each salt protects, and what can be rebuilt

`tools/rotate-salts.mjs` holds the same list (`INVENTORY`), and a test fails if the Worker or the schema gains a salted site that is not on it.

| Salt | Where | Rebuilt from known Discord ids? | Plan |
| :--- | :--- | :--- | :--- |
| `USER_SALT` | `user_state.user_key` (saved board preferences) | Yes, for every id we know | Rename old key to new key |
| `USER_SALT` | `sessions.user_key` (Discord Activity sign-ins) | Yes | Rename; `token_hash` is not salted and does not change |
| `USER_SALT` | `answer_details.asker_hash`, `answer_feedback.user_hash` | Yes | Rename (rows expire after 30 and 90 days anyway) |
| `USER_SALT` | `kv_state` `vote:<id>`, keys of `ballots` | Yes, for known ids and listed vote ids | Re-key each ballot, keep the choice |
| `USER_SALT` | `guest_rate_limits.ip_hash` | **No**: visitor addresses are not stored | Delete all rows (short-lived counters) |
| `USER_SALT` | `audit_log.target` of erase events | **No**: those people were erased | Leave; never looked up by hash |
| `USER_SALT` | Discord button ids on answers already posted (HMAC) | **No**: signed into the messages | Nothing to do; those buttons stop working |
| `KEY_SALT` | `members.key_hash` | **No**: keys are never stored | **Re-issue a key for every member** |
| `KEY_SALT` | `kv_state` `moments_ledger`, `channelHash` and `contentHash` | **No**, and not needed | Leave. Diagnostic rows only (`moments.md`); rows written after the flip use the new salt, so compare before and after separately |
| `KEY_SALT` | `account_keys.key_hash` | **No** (and no Worker code reads this table) | Re-issue or empty it; check it is unused first |

"Known ids" are the Discord ids in the `discord_members` roster row, the `users` table, and anything you add by hand. An id that is not known keeps its old hash and is unreachable after the flip: that person signs in again and starts with empty preferences. `--export` reports how many rows are in that state before you commit.

## Before the window (anyone, nothing is changed)

1. Pull a backup and keep it private, outside the repository: `BOARD_ADMIN_TOKEN=... node tools/pull-export.mjs --api https://api.leeroy.party --out <private path>/export.ndjson`. Run the restore drill on it once (`backup-restore.md`).
2. Make two new salts: 48 random bytes each, for example `openssl rand -base64 48`. They must be different from each other and from the old values. Keep them only in the password manager and the shell session that needs them. Never paste them into a chat, an issue, a file in this repository or a command line that is logged.
3. Make a plan with the real roster. In a private shell:
   ```bash
   OLD_USER_SALT=... NEW_USER_SALT=... OLD_KEY_SALT=... NEW_KEY_SALT=... \
     node tools/rotate-salts.mjs --export <private path>/export.ndjson --ids-file <private path>/extra-ids.txt --sql-out <private path>/rotate.sql
   ```
   Read the "Rows in the export" lines. A large "unmapped" count means ids are missing: add them to `--ids-file` and run again. `--only user` or `--only key` plans one salt on its own.
4. Take the D1 Time Travel bookmark and write it down: `cd infrastructure && npx wrangler d1 time-travel info leeroy-board-db`.
5. Prepare a new key for each member, and the hash statements. Keys are made and handed over privately (`add-party-member.md`, step 4). For each member: `printf '%s' "$NEW_KEY" | KEY_SALT="$NEW_KEY_SALT" node infrastructure/scripts/hash-key.mjs <slug> > <private path>/key-<slug>.sql`. Run nothing yet.
6. Run the BEFORE query from `rotate.sql` against production and keep the numbers: `npx wrangler d1 execute leeroy-board-db --remote --command "<the BEFORE select>"`.

## What the account owner runs

The Worker secret and the GitHub repository secret are two copies of one value. **The production deploy sets every Worker secret from the repository secret on each run** (`deploy-cloudflare.yml`, the `wrangler secret put` loop), so a bare `wrangler secret put` is overwritten by the old value at the next deploy. Do both, in this order:

1. Update the two GitHub repository secrets `USER_SALT` and `KEY_SALT` to the new values (repository settings, Secrets, Actions). Preview Workers derive their own salts from these on their next push, so previews rotate by themselves.
2. In one sitting, with the member-key SQL ready, set both Worker secrets (each prompts for the value, so it never appears in a command line or the shell history):
   ```bash
   cd infrastructure
   npx wrangler secret put USER_SALT --name leeroy-brain
   npx wrangler secret put KEY_SALT --name leeroy-brain
   ```
   Order: `USER_SALT` first, then `KEY_SALT`. A secret change creates a new Worker version, so the 15 minute in-memory cache of member hashes (`auth.js`) should start empty (Cloudflare behaviour, not verified here; if a member is refused after step 3, wait 15 minutes or redeploy).
3. Straight away, apply the data changes:
   ```bash
   npx wrangler d1 execute leeroy-board-db --remote --file <private path>/rotate.sql
   for f in <private path>/key-*.sql; do npx wrangler d1 execute leeroy-board-db --remote --file "$f"; done
   ```
   `rotate.sql` is safe to run again: it keeps a newer row that people wrote under the new key in the meantime and removes the old duplicate.
4. Check (below), then hand each member their new key.

The next normal deploy is then harmless: it sets the same new values.

## Order and the length of the window

`KEY_SALT` takes effect when step 2 finishes; members can use their new key as soon as step 3 has stored its hash. Members are locked out for the minutes between those two steps. `USER_SALT`: people see empty preferences between step 2 and the first statement of step 3, then their saved preferences are back. Choose a quiet hour. Do not start a deploy in the middle (it would set the secrets again from the repository secrets, which is correct only after step 1).

## Verify

1. Run the AFTER queries from `rotate.sql`. The first must return all zeros: nothing known is left under an old hash and the rate-limit table is empty. The second must be at least the BEFORE numbers.
2. `SELECT slug, substr(key_hash, 1, 8) AS hash_start FROM members ORDER BY slug;` run before and after: every `hash_start` must have changed.
3. With one new key: `curl -s -H "Authorization: Board <new key>" https://api.leeroy.party/api/me` returns that member. The old key returns 401.
4. `GET /api/health` with the admin token is 200. Sign in to the board once and confirm saved preferences are still there.
5. Record the date (not the values) in the owner's private notes.

## Rollback

Choose by how far it got.

- **Before step 2:** nothing has changed. Stop.
- **After step 2, member keys only:** put the old `KEY_SALT` back (repository secret first, then `wrangler secret put KEY_SALT`), and re-run the old hash statements. The old values are the ones in git history (public), so keep them in the password manager until the rotation is accepted.
- **Whole rotation:** put both old salts back (repository secrets first, then `wrangler secret put`), then either restore D1 to the bookmark (`npx wrangler d1 time-travel restore leeroy-board-db --bookmark=<bookmark>`; this also drops anything written since) or run the reverse plan: the same tool command with `--reverse` and the same four variables writes the SQL that renames new hashes back to old ones. Old member keys work again only if the old `members` hashes are back, which the Time Travel restore does.

## What breaks for users

- Every member key stops working until the new key is handed over and its hash is stored (`KEY_SALT`). This is the visible one.
- Saved board preferences and Discord Activity sign-ins are kept for known ids; for an unknown id the person signs in again and starts empty.
- A person who voted keeps their ballot only if their id is known and the vote id is listed (`--export` lists them); otherwise they could vote again in an open vote.
- The More, Sources, Helpful and Off buttons on answers already posted stop working. New answers are fine.
- Visitor ask limits restart from zero.
- Nothing changes for web-login cookie sessions (`sessions_v2`) or for anything that is not on the table above.

## What this does not fix

The old hashes still exist in git history, in older exports and in any backup taken before the rotation. Delete or re-protect old exports. Rotation protects hashes made from now on.
