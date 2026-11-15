# /say: post as the Leeroy bot

**Command:** `/say channel:<key> text:<message>`

- `channel`: a channel key from `discord_roster.channels` (the names, for example `general`, not ids). Autocomplete lists the keys; it never shows ids.
- `text`: required, at most 2000 characters. Longer text is refused with an ephemeral error (it is not cut).

**Who can run it:** server admins only, the same gate as `/intents`: the caller needs Manage Server or Administrator, and the interaction must come from the `guildId` in `discord_roster` (when the roster has no `guildId` the server check is off and the permission check still applies). Anyone else gets "That command is for server admins." and nothing is posted. The command is also registered with `default_member_permissions: "32"` and `dm_permission: false`, so Discord hides it from other members and from DMs. Autocomplete returns an empty list to non-admins.

**What it posts:** one message to the channel for that key, with `allowed_mentions: {parse: []}`. `@everyone`, `@here`, role and user mentions in the text are shown as text and ping nobody. No buttons, no role mention. Every reply to the admin is ephemeral: `Posted to <key>.`, `Unknown channel` (with the valid keys), `Discord refused the post`, or `Discord bot token not configured`. The reply never contains an id, the token or the text.

**No admin token is used or typed.** The post uses the Worker's existing `DISCORD_BOT_TOKEN` secret, the same one `POST /api/announce` uses. `BOARD_ADMIN_TOKEN` is not involved; authorisation is the signed Discord interaction plus the Manage Server check.

**After deploy: re-register commands with Discord.** Deploying the Worker does not publish the new command to Discord. This repository has no registration script (registration is done by hand, see `infrastructure/README.md`). The step:

1. Fetch the manifest: `GET https://<worker-host>/api/discord/commands` returns `{ "commands": [...] }` including `say`.
2. Push that `commands` array to Discord as the application's commands: `PUT https://discord.com/api/v10/applications/<application_id>/commands` (global) or `.../guilds/<guild_id>/commands` (instant, one server), body = the array, header `Authorization: Bot <token>`. PUT replaces the whole set, so send the complete array.
3. In Discord, check that `/say` appears for an admin and not for a normal member.

Until step 2 is done, `/say` does not exist in Discord. The handler is inert for everyone without Manage Server regardless.

## Behaviours to know

- If Discord does not answer within 2 seconds the reply says it was slow and that the post may have gone through. Check the channel before posting again: a retry is a new interaction and can post twice.
- When the roster row has no `guildId` the server check is off: an admin of any server where the bot is installed can post into the roster channels, and the success reply says so. Set `guildId` in the `discord_roster` config row to close that.
- Nothing records who posted what. The post appears in the channel as the bot; the admin who ran it is visible in Discord's own audit log only for the interaction, not in this app.
