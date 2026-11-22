# /member: add and list roster members

**Commands:** `/member add user:<user> name:<display name> match:<optional words>` and `/member list`.

## Who can run it

Server admins only: Manage Server in the signed interaction, and the interaction must come from the roster guild (`discord_roster.guildId`). The same gate as `/say`. The command is also hidden from everyone else in Discord (`default_member_permissions: "32"`, guild only). Anyone else gets "That command is for server admins." and nothing is read or written. All replies are ephemeral with no mentions.

When no roster server is set (`discord_roster` absent or without `guildId`), both subcommands reply "Set the roster server first." and do nothing. There is no fallback to the server the command was typed in.

## What `add` does

1. Refuses an empty name, or a name with no letter or digit (the slug is derived from the name with the same `slugify` rule the rest of the Worker uses).
2. Guild check: `GET /guilds/{guild}/members/{user}` with the bot token. This endpoint does not need the privileged GUILD_MEMBERS intent (only List Guild Members and the gateway member events do). 404 replies "That user is not in this server." Anything else (no bot token, 5xx, 403, 429, network error, 2 second timeout) replies "Could not confirm membership with Discord; nothing was written." Both write nothing.
3. Match words: the words typed in `match` (split on spaces and commas, lowercased, deduplicated). With none typed, the lowercased words of the display name that are 3 or more characters long. An update with none typed keeps the existing list unless it is empty.
4. No rebinding: if the slug is already on the roster for a different Discord id, or for an entry with no id, the command replies "Nothing added: that name is already on the roster; use a different name." and writes nothing. Re-adding the same id updates the name and match words. Moving a slug to another person stays on `POST /api/admin/members` (token gated).
5. Writes through `saveMember` (`infrastructure/worker/member-write.js`), the same function `POST /api/admin/members` uses: same validation, id-uniqueness rule, `kv_state` write and cache invalidation. The write is a compare-and-set, so two admins adding at once cannot overwrite each other, and the no-rebind rule is judged on the row at write time. Validator messages are echoed; other members are never named.
6. Writes one `audit_log` row: action `member.add`, target the slug, `detail_json` `{"added": <added id>}`, `at` the ISO time. The actor column holds the admin's Discord id when the admin has a `users` row (it is a foreign key), otherwise it is empty; the admin id is not repeated in `detail_json`. No display name or match text.

## Verify

Run `/member list`: one line per member, `slug | name | id`. Ids are plain digits; markdown characters and line breaks in stored names are escaped. Or query the log:
`SELECT at, actor_discord_user_id, target, detail_json FROM audit_log WHERE action = 'member.add' ORDER BY id DESC LIMIT 5;`

## Rollback

Re-add the entry with `/member add` (same user), or `POST /api/admin/members` with the corrected entry (`{"slug":"aldous-thorne","name":"Aldous Thorne","match":["aldous"],"id":"<17 to 20 digits>"}`). Neither removes a member; to remove one, write the full `discord_members` row with `PUT /api/config/discord_members`.

## Privacy

Whoever an admin picks, and who is in the server, becomes a roster member: a Discord id and a display name stored in `discord_members`, an admin-only config row. The audit row holds the slug and the added id. The member data export lists `member.add` rows where the person is the added id, and an erase request scrubs them (`detail_json` set to `{}`, target cleared). The `discord_members` entry itself is not touched by the erase path; remove it by hand.
