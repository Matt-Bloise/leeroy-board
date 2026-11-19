# Roster upsert: edit the production roster through CI

Workflow: `.github/workflows/roster-upsert.yml` (manual only). Script: `tools/roster-upsert.mjs`. Tests: `tests/unit/roster-upsert.test.mjs`.

## When to use it

This is the **stopgap for when `/member` is unreachable and the repository is private** (it is public now, see below) (docs/runbooks/member.md, PR 379) and the Cloudflare D1 console is read-only for the person who needs the edit. It writes the same row the Worker does, `kv_state` key `discord_members`, with the Worker's own functions (`upsertMember` from `infrastructure/worker/members.js` and `validateConfigValue('discord_members', ...)` from `infrastructure/worker/config.js`), so the rules are the same as `POST /api/admin/members`: slug rules, name 1 to 40 characters, match tokens lowercase, id 17 to 20 digits, an id may belong to one slug only. An update of an existing slug keeps its id and match list when the entry does not carry them.

Real data is never stored in the repository. The entries are typed into the dispatch form, and they are visible on that run's page and in its log.

## What it needs

The same secrets as the production deploy: repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (docs/runbooks/ci-secrets.md). Nothing new. The token needs D1 edit permission, as the deploy does. The job runs only from `master`, in the environment `production`.

**This workflow cannot run while the repository is public.** The log prints the roster (slug, name, Discord id, match count) before and after, and the runs of a public repository publish their logs to everyone. The first step of the job fails the run when `github.event.repository.private` is not `true`, before anything is read or written. The repository has been public since 2026-11-19, so the workflow is disabled in effect: a dispatch fails at that first step with nothing read or written.

What to do instead (no new mechanism is introduced here): use `/member add` and `/member list` (docs/runbooks/member.md) when the command is reachable; otherwise the roster edit needs the repository private again, or a manual edit of the `kv_state` row `discord_members` in the Cloudflare D1 console by the account owner (the SQL under "Rollback" shows the statement shape).

## How to run it

1. GitHub, Actions, "Roster upsert (guarded discord_members edit, production D1)", Run workflow, branch `master`.
2. **Dry run first.** Leave `dry_run` ticked. Fill `entries_json` with a JSON array, at most 10 entries and 4000 bytes. Quote ids: a Discord id written as a bare number loses digits in JSON.

   ```json
   [
     {"slug":"aldous-thorne","name":"Aldous Thorne","match":["aldous","thorne"],"id":"99999999990000000001"},
     {"slug":"mirelle-voss","name":"Mirelle Voss","match":["mirelle"],"id":"99999999990000000002"}
   ]
   ```

   (Fictional members and synthetic ids.) The entry fields are exactly `slug`, `name`, `match`, `id`; any other field is refused, and so is the same slug twice.
3. Read the log. It prints the roster BEFORE (`slug | name | id | match-count`), the planned AFTER, and a diff summary (added slugs; changed slugs with the names of the fields that changed). A rejected entry (bad id, an id held by another slug, an uppercase match token) stops the run with nothing written.
4. **Real run.** Dispatch again with the same `entries_json` and `dry_run` unticked. Leave `audit_adds` ticked unless there is a reason.
5. Check the end of the log: the roster read back from the database, and one line per entry, `proof <slug>: present=true id-match=true match-count=<n>`. Any `false` fails the run.

The Worker caches the roster for up to 60 seconds per isolate (`infrastructure/worker/config.js`, `TTL_MS`). The change is in the database at once, but Discord and the board can keep the old roster for up to a minute. There is no cache invalidation from CI.

## What it writes

- `kv_state` row `discord_members`: ONE statement, a compare-and-set, `UPDATE kv_state SET json = '<new>', updated_at = '<iso now>' WHERE key = 'discord_members' AND json = '<the exact text that was read>'`. It is sent through a temporary `.sql` file with `wrangler d1 execute --remote --file`. If the stored text moved in the meantime, zero rows change, the run says "the roster changed while we ran, nothing written" and exits 1. Run it again (dry run first) against the current roster.
- `audit_log`: for each entry whose slug was **not** on the roster before and that carries an id, one row, the same as the Worker's `auditMemberAdd`: `action` `member.add`, `target` the slug, `detail_json` `{"added":"<id>"}`, `at` the ISO time, `actor_discord_user_id` empty. Updates write no audit row. `audit_adds` unticked writes none.
- Nothing else. It never creates the roster: a missing row, text that is not JSON, a value that is not an array, or a stored roster that fails the Worker's validator stops the run with exit 1 and nothing written. It never creates a database.

## Rollback

The BEFORE print in the run log is the record of the roster as it was. To undo an update, dispatch again with the previous values of the changed entries (the diff summary lists which fields changed; the BEFORE lines give slug, name, id and match count). To undo an add there is no removal entry: remove the member by writing the full roster through `PUT /api/config/discord_members`, or with a manual statement from a session that can write D1:

```sql
UPDATE kv_state SET json = '<the full roster JSON>', updated_at = '<iso now>' WHERE key = 'discord_members';
```

The audit row of an add stays as the history of that add. The D1 Time Travel bookmark of the deploy workflow (docs/runbooks/rollback.md) can restore the whole database.

## Checks

- Log lines never contain the token or the account id: the script redacts both from anything it prints.
- `tests/unit/roster-upsert.test.mjs` runs the script against a fake wrangler: dry run makes no write call, the real run issues one guarded UPDATE, a lost race writes nothing and exits 1, audit rows only for adds, an id held by another slug is rejected.
- Not yet verified against Cloudflare: the shape of `wrangler d1 execute --json` output (read as a list of `{ results, success, meta }`, the same assumption as `tools/d1-row-count.mjs`), and that wrangler's `--file` handling splits the statement correctly when a value holds a semicolon.
