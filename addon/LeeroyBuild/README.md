# Leeroy Build (WoW Forever add-on)

Turns your own character into one line of text you copy in the game and paste on leeroy.party. It sends nothing anywhere.

## Install
1. Close the game.
2. Unzip `LeeroyBuild-<version>.zip`, or copy the `LeeroyBuild` folder, into your Forever add-ons folder, for example `World of Warcraft\_forever_\Interface\AddOns\` (the one that already holds your other add-ons). The result must be `...\AddOns\LeeroyBuild\LeeroyBuild.toc`.
3. Start the game. At the character screen, open AddOns and make sure Leeroy Build is enabled. If it is marked out of date, tick "Load out of date AddOns". In game, `/dump select(4, GetBuildInfo())` prints the interface number; if it is not 16001, edit the first line of both .toc files to match.

## Use
- `/leeroy` or `/leeroy export`: opens a window with your export string already selected. Press Ctrl+C, then Esc.
- `/leeroy options`: tick which fields are included.
- On leeroy.party open "Import from game", paste the string, check the summary, and tap Send.

## What is exported
Always: format tag, client interface number, the time of export.
Ticked by default: class, race, level, primary professions (skill line ID and rank).
Unticked by default: character name, talent points per tree, current zone.
A field the game will not give the add-on is left out, never guessed. The window and the chat summary list exactly what went into the string.

## Wire format
`LEEROY1|<key=value;...>|<check>`. Values escape `%`, `;`, `=`, `|`, space (`%20`) and newline as `%XX`; every other control byte (below 32) and every byte above 126 is also written `%XX` (uppercase hex of the UTF-8 byte), so the string is ASCII only. Any standard percent-decoder reads it back. The check is Adler-32 of the payload, 8 lowercase hex digits. Level is exported as the real integer; the site rejects out-of-range values with a reason.

## Privacy
- The add-on has no network code (WoW add-ons cannot make network requests) and sends nothing.
- It reads only your own character. It never reads other players, chat, guild, friends, the account name, or file paths.
- It saves only your option ticks (`LeeroyBuildDB`). The export string is not stored.
- You decide where the string goes: nothing leaves the game unless you copy and paste it.
- Remove it by deleting the `LeeroyBuild` folder.

## Report a Lua error
1. In game: `/console scriptErrors 1`, then `/reload`.
2. Repeat what you did. The error popup shows the file and line; copy it.
3. Send the text to Matt or post it in the Leeroy channel, with your interface number (`/dump select(4, GetBuildInfo())`).
4. Turn the popup off again with `/console scriptErrors 0`.

## Files
`LeeroyBuild_Codec.lua` (pure string building and Adler-32 check), `LeeroyBuild_Fields.lua` (reads your character), `LeeroyBuild_UI.lua` (windows), `LeeroyBuild.lua` (options and commands). `LeeroyBuild.toc` and `LeeroyBuild_Forever.toc` are identical; the client picks the suffixed one on Forever.
