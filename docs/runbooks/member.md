# /member: add and list roster members

**Commands:** `/member add user:<user> name:<display name> match:<optional words>` and `/member list`.

## Who can run it

Server admins only: Manage Server in the signed interaction, and the interaction must come from the roster guild (`discord_roster.guildId`). The same gate as `/say`. The command is also hidden from everyone else in Discord (`default_member_permissions: "32"`, guild only). Anyone else gets "That command is for server admins." and nothing is read or written. All replies are ephemeral with no mentions.

## What `add` does

1. Refuses an empty name, or a name with no letter or digit (the slug is derived from the name with the same `slugify` rule the rest of the Worker uses).
2. Guild check: `GET /guilds/{guild}/members/{user}` with the bot token. This endpoint does not need the privileged GUILD_MEMBERS intent (only List Guild Members and the gateway member events do). 404 replies "That user is not in this server." Anything else (no bot token, 5xx, 403, 429, network error, 2 second timeout) replies "Could not confirm membership with Discord; nothing was written." Both write nothing.
3. Match words: the words typed in `match` (split on spaces and commas, lowercased, deduplicated). With none typed, the lowercased words of the display name. An update with none typed keeps the existing list unless it is empty.
4. Writes through `saveMember` (`infrastructure/worker/member-write.js`), the same function `POST /api/admin/members` uses: same validation, id-uniqueness rule, `kv_state` write and cache invalidation. Validator messages are echoed; other members are never named.
5. Writes one `audit_log` row: action `member.add`, target the slug, `detail_json` `{"by": <admin id>, "added": <added id>}`, `at` the ISO time. No display name or match text. The `actor_discord_user_id` column is filled only if the admin has a `users` row (it is a foreign key), so the admin id is always in `detail_json` too.

## Verify

Run `/member list`: one line per member, `slug | name | id`. Ids are plain digits. Or query the log:
`SELECT at, target, detail_json FROM audit_log WHERE action = 'member.add' ORDER BY id DESC LIMIT 5;`

## Rollback

Re-add the entry with `/member add`, or `POST /api/admin/members` with the corrected entry (`{"slug":"aldous-thorne","name":"Aldous Thorne","match":["aldous"],"id":"<17 to 20 digits>"}`). Neither removes a member; to remove one, write the full `discord_members` row with `PUT /api/config/discord_members`.

## Privacy

Whoever an admin picks becomes a roster member: a Discord id and a display name stored in `discord_members`, which is an admin-only config row. The audit row holds two ids and a slug. Both ids sit in `detail_json`, which the member data export and erase paths (keyed on the actor column) do not reach for an added member; handle an erase request for such a person by hand.
