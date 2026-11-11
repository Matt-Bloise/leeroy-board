# LeeroySpike: test plan for Matt (about 5 minutes)

Purpose: learn, on your real WoW Forever client, whether a tiny add-on loads, which character calls work, and what the SavedVariables file looks like. The add-on sends nothing anywhere and writes only your own character.

## Steps
1. Close the game. Copy the folder `LeeroySpike` (this folder, with the .toc and .lua files) into your Forever add-ons folder, for example `World of Warcraft\_forever_\Interface\AddOns\` (the folder name may differ; it is the one that already holds your other add-ons).
2. Start the game and log in to a character. In chat type: `/dump select(4, GetBuildInfo())` and note the number it prints (the interface number).
3. The .toc ships with `## Interface: 16001`, the expected Forever number. If step 2 printed a different number, or the add-on list shows it as out of date, edit `LeeroySpike.toc` and put that number on the first line. Log in again; you should see "LeeroySpike loaded" in chat.
4. Type `/leeroyspike save`. It prints your name, race, class, level, interface number and professions.
5. Log out (or `/reload`) so the file is written. Find `WTF\Account\<ACCOUNT>\SavedVariables\LeeroySpike.lua` and send that file to Claude (it holds only the snapshot; the account folder name is in the path, not in the file).

## What the answers tell us
- Loads or not, and with which interface number and TOC naming (see ops-wiki/pages/addon-bridge-design.md).
- Whether `GetProfessions` exists on Forever (the printed professions line says so).
- The exact shape of the file a site page would read.

## Safety
Read the two source files first: they are about 60 lines. Remove the add-on by deleting its folder. Nothing runs outside the game.
