# Runbook: import sign-ups

`tools/import-signups.mjs` loads a sign-up export into the board's `signups` document. It is a dry run unless you pass `--apply`, and importing the same file twice changes nothing the second time.

## What it reads

Either shape the board already produces:

- the signups document: `GET /api/data/signups` or `data/signups.json` (`{ entries: [{ name, pack, meet, meet_other, rsvp, when, updated }] }`), or
- the intents mailbox: `GET /api/intents` (admin) or `{ intents: [...] }`; every intent of kind `signup` carries `{ patch, entry }`.

Allowed values: `pack` yes or no; `rsvp` in, maybe, late or out; `when` 6pm, 8pm or later; `meet` text (`vos` and `xroads` are expanded like the Worker does); `meet_other` text up to 80 characters; `updated` an ISO date. Other fields are dropped and reported. A wrong value refuses the whole file.

## Who is allowed

Names are checked against the party document (`--party-file`, default `data/party.json`; case and punctuation ignored, so `=Name=` matches `Name`). **A name that is not on the board is refused, and then nothing at all is written**, even for the names that are fine. Add the person first (`add-party-member.md`).

## Steps

1. Dry run, with a saved copy of the live document so the plan shows what really changes:
   ```bash
   curl -s https://api.leeroy.party/api/data/signups > current.json
   node tools/import-signups.mjs --in export.json --current-file current.json
   ```
2. Read the counts (add, update, already up to date) and the list. Nothing is sent.
3. Apply (admin token from the environment, never an argument):
   ```bash
   BOARD_ADMIN_TOKEN=... node tools/import-signups.mjs --in export.json --apply
   ```
   It reads the live document, saves it to a backup file (path printed, mode 600), sends one `PUT /api/data/signups` with the merged document and recomputed tallies, and sends nothing when there is nothing to change.
4. Run step 3 again: it reports "nothing to change".

## Merge rules

A newer dated entry wins over an older stored one and keeps its own date; an older or equal one changes nothing. An undated entry only fills empty fields. People who are not in the file are left alone and nothing is deleted. The existing entry keeps its name (so `=Name=` stays); a new entry takes the party name and slug.

## Rollback

`PUT /api/data/signups` with the backup file the tool printed: `curl -X PUT -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "Content-Type: application/json" --data @<backup> https://api.leeroy.party/api/data/signups`. The live read can be up to a minute old (edge cache), so wait a minute between an apply and a re-run if other people are signing up.

## Data-loss window (review fix)

`--apply` reads the public `signups` document, which is served from a cache that may be a few minutes old, and then replaces the whole document with a PUT that has no version check. A sign-up that lands between that read and the PUT is silently overwritten. Run `--apply` only when nobody is signing up (not around a raid-night poll), run the dry run immediately before, and re-check the board afterwards. A cache-bypass read or a conditional PUT is a tracked follow-up.
