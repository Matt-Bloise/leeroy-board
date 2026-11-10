-- LeeroyBuild_Fields.lua: reads the player's OWN character, nothing else (no other players, no chat, no account path).
-- Every API call is wrapped in pcall. A field whose API errors, is missing, or returns something unusable
-- yields nil and is OMITTED from the export (never guessed, never placeholder text).
local ADDON, ns = ...

local Fields = {}

-- Order shown in options and in the summary. required = the site importer rejects a string without it.
Fields.LIST = {
  { key = "class",   label = "Class",                  required = true,  default = true },
  { key = "race",    label = "Race",                   required = true,  default = true },
  { key = "level",   label = "Level",                  required = true,  default = true },
  { key = "prof",    label = "Professions",            required = false, default = true },
  { key = "name",    label = "Character name",         required = false, default = false },
  { key = "talents", label = "Talent points per tree", required = false, default = false },
  { key = "zone",    label = "Current zone",           required = false, default = false },
}

local function call(fn, ...)
  if type(fn) ~= "function" then return false end
  return pcall(fn, ...)
end

-- A value the client marks secret cannot be read by add-ons; treat it as unavailable.
local function usable(v)
  if v == nil then return false end
  if type(issecretvalue) == "function" then
    local ok, secret = pcall(issecretvalue, v)
    if not ok or secret then return false end
  end
  return true
end

local function cleanString(v)
  if not usable(v) or type(v) ~= "string" or v == "" then return nil end
  return v
end

local function cleanInt(v)
  if not usable(v) or type(v) ~= "number" then return nil end
  if v ~= v or v < 0 or v > 4000000000 then return nil end
  if v ~= math.floor(v) then return nil end
  return v
end

local collectors = {}

function collectors.class()
  local ok, _, token = call(UnitClass, "player")
  token = ok and cleanString(token) or nil
  if token and token:match("^%u+$") then return token end
  return nil
end

function collectors.race()
  local ok, _, token = call(UnitRace, "player")
  token = ok and cleanString(token) or nil
  if token and token:match("^%a+$") then return token end
  return nil
end

function collectors.level()
  local ok, lvl = call(UnitLevel, "player")
  lvl = ok and cleanInt(lvl) or nil
  if lvl and lvl >= 1 and lvl <= 60 then return lvl end
  return nil
end

function collectors.name()
  local ok, name = call(UnitName, "player")
  return ok and cleanString(name) or nil
end

function collectors.zone()
  local ok, zone = call(GetRealZoneText)
  return ok and cleanString(zone) or nil
end

-- Primary professions: first two indexes from GetProfessions; then rank (3rd return) and skillLine (7th return)
-- of GetProfessionInfo. Omitted entirely if either API is missing or nothing reads cleanly.
function collectors.prof()
  if type(GetProfessions) ~= "function" or type(GetProfessionInfo) ~= "function" then return nil end
  local ok, p1, p2 = call(GetProfessions)
  if not ok then return nil end
  local found = {}
  for _, idx in ipairs({ p1, p2 }) do
    if cleanInt(idx) then
      local okInfo, _, _, rank, _, _, _, skillLine = call(GetProfessionInfo, idx)
      rank, skillLine = cleanInt(rank), cleanInt(skillLine)
      if okInfo and rank and skillLine then
        found[#found + 1] = string.format("%d:%d", skillLine, rank)
      end
    end
  end
  if #found == 0 then return nil end
  return table.concat(found, ",")
end

-- Points spent per talent tree (3rd return of GetTalentTabInfo in the classic API).
-- Omitted unless the APIs exist and every tree reads cleanly.
function collectors.talents()
  if type(GetNumTalentTabs) ~= "function" or type(GetTalentTabInfo) ~= "function" then return nil end
  local ok, n = call(GetNumTalentTabs)
  n = ok and cleanInt(n) or nil
  if not n or n < 1 or n > 4 then return nil end
  local points = {}
  for i = 1, n do
    local okTab, _, _, spent = call(GetTalentTabInfo, i)
    spent = okTab and cleanInt(spent) or nil
    if not spent then return nil end
    points[#points + 1] = string.format("%d", spent)
  end
  return table.concat(points, ",")
end

-- enabled: key -> boolean (the player's ticks). Returns values (key -> value, only fields read cleanly)
-- and the list of required technical keys or ticked fields that were unavailable.
function Fields.collect(enabled)
  local values, unavailable = {}, {}
  local okB, _, _, _, iface = call(GetBuildInfo)
  iface = okB and cleanInt(iface) or nil
  local okT, now = call(time)
  now = okT and cleanInt(now) or nil
  values.v = 1
  values.iface = iface
  values.t = now
  if not iface then unavailable[#unavailable + 1] = "iface" end
  if not now then unavailable[#unavailable + 1] = "t" end
  for _, f in ipairs(Fields.LIST) do
    if enabled[f.key] then
      local v = collectors[f.key]()
      if v == nil then unavailable[#unavailable + 1] = f.key else values[f.key] = v end
    end
  end
  return values, unavailable
end

ns.Fields = Fields
