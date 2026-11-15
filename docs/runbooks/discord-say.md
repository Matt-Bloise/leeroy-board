# /say: post as the Leeroy bot

**Command:** `/say channel:<key> text:<message>`

- `channel`: a channel key from `discord_roster.channels` (the names, for example `general`, not ids). Autocomplete lists the keys; it never shows ids.
- `text`: required, at most 2000 characters. Longer text is refused with an ephemeral error (it is not cut).

**Who can run it:** server admins only, the same gate as `/intents`: the caller needs Manage Server or Administrator, and the interaction must come from the `guildId` in `discord_roster` (when the roster has no `guildId` the server check is off and the permission check still applies). Anyone else gets "That command is for server admins." and nothing is posted. The command is also registered with `default_member_permissions: "32"` and `dm_permission: false`, so Discord hides it from other members and from DMs. Autocomplete returns an empty list to non-admins.

**What it posts:** one message to the channel for that key, with `allowed_mentions: {parse: []}`. `@everyone`, `@here`, role and user mentions in the text are shown as text and ping nobody. No buttons, no role mention. Every reply to the admin is ephemeral: `Posted to <key>.`, `Unknown channel` (with the valid keys), `Discord refused the post`, or `Discord bot token not configured`. The reply never contains an id, the token or the text.

**No admin token is used or typed.** The post uses the Worker's existing `DISCORD_BOT_TOKEN` secret, the same one `POST /api/announce` uses. `BOARD_ADMIN_TOKEN` is not involved; authorisation is the signed Discord interaction plus the Manage Server check.

**Registration is automatic on deploy.** The production deploy (`.github/workflows/deploy-cloudflare.yml`) ends with the step "Sync Discord slash commands (idempotent, never deletes)", which runs `node tools/sync-discord-commands.mjs --apply` after the Worker is live and healthy. It reads the Worker manifest (`GET https://api.leeroy.party/api/discord/commands`, which includes `say`), reads Discord's global commands for the application, and POSTs only the commands that are missing or different, one at a time (Discord's POST creates or overwrites by name). It never uses the bulk PUT and never deletes, so commands that are not in the manifest (for example an Activity entry point) are left alone. It uses the `DISCORD_BOT_TOKEN` GitHub secret that the deploy already pushes to the Worker. The step is `continue-on-error`: a missing token, a Discord error or a rate limit prints a `::warning::` and the deploy stays green. The log lists command names and counts only (`created: say`, `unchanged: 22`).

By hand (names and counts only are printed; the default is a dry run that writes nothing):

```
DISCORD_BOT_TOKEN=<bot token> node tools/sync-discord-commands.mjs            # dry run
DISCORD_BOT_TOKEN=<bot token> node tools/sync-discord-commands.mjs --apply    # write
```

Optional `DISCORD_APP_ID` (default: the public application id in the code) and `WORKER_URL` (default `https://api.leeroy.party`). Global commands can take a while to show in clients after a write.

Superseded: the earlier manual step (fetch the manifest and `PUT` the whole array to `/applications/<id>/commands`) is no longer needed and should not be used, because a bulk PUT deletes every command that is not in the array.

**Unverified:** that the `DISCORD_BOT_TOKEN` GitHub secret is set and non-empty (the secret-sync step skips empty ones; with no token the sync step only warns), that the token belongs to the application whose id is in the code, that Discord returns `dm_permission` or `contexts` in the way the comparison assumes (a mismatch would only cause a harmless re-POST on each deploy, not a wrong write), and the whole path against the live Discord API: the tests use stubbed `fetch` only. After the first deploy, check the step log for `created: say` and that `/say` appears in Discord for an admin and not for a normal member. Until the command is registered, `/say` does not exist in Discord; the handler is inert for everyone without Manage Server regardless.
