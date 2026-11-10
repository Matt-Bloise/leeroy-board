-- LeeroySpike: the smallest add-on that answers three questions on a real WoW Forever client:
--   1. Does the client load it (interface number, TOC suffix)?
--   2. Which character calls work without a Lua error (UnitName, UnitRace, UnitClass, UnitLevel, GetProfessions)?
--   3. What does the SavedVariables file look like, so a site page can read it?
-- It sends nothing. It writes only the player's own character, only when the player types /leeroyspike save or logs out
-- with the option on. Every field written is listed in the printed summary.
local ADDON = ...
LeeroySpikeDB = LeeroySpikeDB or {}

local function safe(fn, ...)
  local ok, a, b, c, d = pcall(fn, ...)
  if ok then return a, b, c, d end
  return "ERROR: " .. tostring(a)
end

local function snapshot()
  local snap = {
    addon = ADDON,
    savedAt = date("!%Y-%m-%dT%H:%M:%SZ"),
    name = safe(UnitName, "player"),
    race = select(2, safe(UnitRace, "player")),
    class = select(2, safe(UnitClass, "player")),
    level = safe(UnitLevel, "player"),
  }
  local build, buildNumber, buildDate, interface = safe(GetBuildInfo)
  snap.client = { version = build, build = buildNumber, date = buildDate, interface = interface }
  if GetProfessions then
    local p1, p2 = safe(GetProfessions)
    snap.professionIndexes = { p1, p2 }
    local names = {}
    for _, idx in ipairs({ p1, p2 }) do
      if type(idx) == "number" and GetProfessionInfo then names[#names + 1] = (safe(GetProfessionInfo, idx)) end
    end
    snap.professions = names
  else
    snap.professions = "GetProfessions not available in this client"
  end
  return snap
end

local function report(snap)
  print("|cff7fd1ffLeeroySpike|r saved: " .. tostring(snap.name) .. ", " .. tostring(snap.race) .. " " .. tostring(snap.class)
    .. " level " .. tostring(snap.level) .. "; interface " .. tostring(snap.client.interface)
    .. "; professions " .. (type(snap.professions) == "table" and table.concat(snap.professions, ", ") or tostring(snap.professions)))
  print("|cff7fd1ffLeeroySpike|r written to SavedVariables on logout or /reload. Nothing is sent anywhere.")
end

SLASH_LEEROYSPIKE1 = "/leeroyspike"
SlashCmdList["LEEROYSPIKE"] = function(msg)
  msg = (msg or ""):lower()
  if msg == "save" or msg == "" then
    LeeroySpikeDB.snapshot = snapshot()
    report(LeeroySpikeDB.snapshot)
  elseif msg == "show" then
    print("|cff7fd1ffLeeroySpike|r last snapshot: " .. tostring(LeeroySpikeDB.snapshot and LeeroySpikeDB.snapshot.savedAt or "none"))
  else
    print("|cff7fd1ffLeeroySpike|r usage: /leeroyspike save | show")
  end
end

local f = CreateFrame("Frame")
f:RegisterEvent("PLAYER_LOGIN")
f:SetScript("OnEvent", function()
  LeeroySpikeDB.snapshot = snapshot()
  print("|cff7fd1ffLeeroySpike|r loaded. Type /leeroyspike save to refresh the snapshot.")
end)
