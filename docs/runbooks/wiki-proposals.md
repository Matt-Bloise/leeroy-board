# Runbook: approve or reject AI-proposed library facts

Last checked: 2026-11-03 against the unit tests only (`tests/unit/wiki-proposals.test.mjs`); not yet run against the live Worker. Code: `infrastructure/worker/wiki-proposals.js`, routes in `worker/index.js`.

## What this is
The cron source sweep reads monitored pages and asks a model whether a library fact changed. Since PR 150 the model never edits the library: each suggestion becomes a row in `wiki_proposals` with status `pending` (at most 5 per source per sweep, key up to 80 characters, value up to 300). Nothing reaches `lib_pages` until an admin approves it. There is no UI; use the three admin calls below. The learner and its 15 minute refresh cooldown are unchanged.

## Look
```bash
# pending and recent proposals (newest first, 50 rows)
curl -s -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" https://api.leeroy.party/api/wiki/proposals
```
```bash
# one proposal next to the value the page holds right now
curl -s -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" https://api.leeroy.party/api/wiki/proposals/<id>
```
In the second answer compare `proposal.proposed_value` with `current_value`. `changed_since_proposed: true` means someone edited the fact after the model looked, so check the source again. `problems` lists anything that blocks or needs `force`.

## Approve
```bash
curl -s -X POST -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "Content-Type: application/json" -d '{}' https://api.leeroy.party/api/wiki/proposals/<id>/approve
```
Set `BOARD_ADMIN_TOKEN` in your own shell (for example `read -rs BOARD_ADMIN_TOKEN; export BOARD_ADMIN_TOKEN`) so it is never typed into a file, a command line you save, or the repo. Never paste it into an issue, PR or chat.

What approve does, in one D1 batch: updates (or adds) the fact in `lib_pages.facts_json`, puts a line at the top of `history_json`, sets `checked` and `updated_at`, sets the proposal to `approved`, and writes an `audit_log` row (`wiki.proposal.approve`, target `wiki_proposals:<id>`, no actor because the admin token has no Discord user). If any part fails the whole batch rolls back and the proposal is still `pending`. After the batch it rebuilds the category blob, `search.json`, `open.json` and the stamps in `index.json`, clears the page cache, purges the edge cache and tells connected browsers, the same as `PUT /api/wiki/page`.

Answers: `200` done; `200` with `already:true` if it was already approved (safe to repeat); `404` unknown id; `409` it was rejected or is a legacy `applied` row, the page no longer exists (`page_missing`; nothing is created), the page's facts or history were edited at the same moment (`page_changed`; look again and retry), or the library value is no longer the one the proposal was made against (`stale_proposal`; see below); `422` see below; `500 apply_failed` nothing changed, try again.

If the answer carries `"refresh":"failed"` the approval stands but the blobs were not rebuilt: re-save the page with `PUT /api/wiki/page` (same content) to rebuild them, or wait for the next library change.

### Stale proposals
The proposal remembers the value it was made against (`old_value`). If the page says something else now, for example an admin corrected it after the model looked, approve answers `409 stale_proposal` and shows `old_value`, `current_value` and `proposed_value`. Decide which is right. To overwrite the later value anyway, approve again with `{"force":true}`; to keep it, reject the proposal. The same check shows as `changed_since_proposed` in the read call.

### Proposals that need `force`
A value that contains a link (`http://`, `www.`, a bare domain) or reads like a prompt-injection payload ("ignore previous instructions", "system:", markup, template braces) is refused with `422` and `needs_force:true`. Read it first. If it is a real fact (for example a patch number that looks like a domain), approve it again with `-d '{"force":true}'`; the audit row records `force:true`. Only the boolean `true` counts. Lengths cannot be forced: a key over 80 or a value over 300 characters, or an empty one, is always refused; reject it.

## Reject
```bash
curl -s -X POST -H "Authorization: Bearer $BOARD_ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"reason":"source is a forum post"}' https://api.leeroy.party/api/wiki/proposals/<id>/reject
```
`reason` is optional, text, at most 200 characters; it is kept in the audit row only. Rejecting is final: a rejected proposal can never be approved. If a rejection was a mistake, the next sweep proposes the fact again (once the source changes), or edit the page directly with `PUT /api/wiki/page`. An approved proposal cannot be rejected; to undo one, edit the fact back with `PUT /api/wiki/page`.

## Read the audit trail
```sql
SELECT at, action, target, detail_json FROM audit_log WHERE action LIKE 'wiki.proposal.%' ORDER BY id DESC LIMIT 20;
```
Run it in the Cloudflare D1 console (read only is enough).

## What this does not do
No UI, no bulk approve, no auto-approve, no change to what the learner proposes or how often. Old rows with status `applied` (written by the learner before PR 150) are history; they cannot be approved.

## Rollback
Revert the PR. The routes disappear and proposals stay `pending` as they were before; approved facts stay in `lib_pages` (edit them with `PUT /api/wiki/page`). No migration was added, so there is nothing to undo in D1.
