-- LeeroyBuild: exports your OWN character as a text string you copy and paste on leeroy.party.
-- It sends nothing, makes no network requests (add-ons cannot), and never reads other players, chat, or the account path.
-- The only thing it saves is your option ticks (LeeroyBuildDB.enabled); the export string itself is never stored.
local ADDON, ns = ...
local Codec, Fields, UI = ns.Codec, ns.Fields, ns.UI

local PREFIX = "|cff7fd1ffLeeroyBuild|r "
local function say(msg) print(PREFIX .. msg) end

local function applyDefaults()
  if type(LeeroyBuildDB) ~= "table" then LeeroyBuildDB = {} end
  if type(LeeroyBuildDB.enabled) ~= "table" then LeeroyBuildDB.enabled = {} end
  for _, f in ipairs(Fields.LIST) do
    if type(LeeroyBuildDB.enabled[f.key]) ~= "boolean" then LeeroyBuildDB.enabled[f.key] = f.default end
  end
end

local function isEnabled(key)
  return LeeroyBuildDB and LeeroyBuildDB.enabled and LeeroyBuildDB.enabled[key] == true
end

local function setEnabled(key, value)
  applyDefaults()
  LeeroyBuildDB.enabled[key] = value and true or false
end

local function doExport()
  applyDefaults()
  local values, unavailable = Fields.collect(LeeroyBuildDB.enabled)
  if not values.iface or not values.t then
    say("Export stopped: the game did not return its build number or time.")
    return
  end
  local text = Codec.encode(values)
  if #text > Codec.MAX_LENGTH then
    say("Export stopped: the string is longer than " .. Codec.MAX_LENGTH .. " characters.")
    return
  end
  local included, omitted, skipped = {}, {}, {}
  for _, f in ipairs(Fields.LIST) do
    if values[f.key] ~= nil then
      included[#included + 1] = f.key .. "=" .. tostring(values[f.key])
    elseif LeeroyBuildDB.enabled[f.key] then
      omitted[#omitted + 1] = f.key
    else
      skipped[#skipped + 1] = f.key
    end
  end
  say("Export contains: client build, time, " .. (#included > 0 and table.concat(included, ", ") or "no character fields") .. ".")
  if #omitted > 0 then say("Ticked but unavailable on this client, left out: " .. table.concat(omitted, ", ") .. ".") end
  if #skipped > 0 then say("Not ticked, not included: " .. table.concat(skipped, ", ") .. ".") end
  for _, f in ipairs(Fields.LIST) do
    if f.required and values[f.key] == nil then
      say("Warning: the site needs " .. f.key .. "; it will reject this string without it.")
    end
  end
  UI.ShowExport(text)
end

local function help()
  say("/leeroy export  - show your export string to copy (also just /leeroy)")
  say("/leeroy options - choose which fields are included")
end

SLASH_LEEROYBUILD1 = "/leeroy"
SlashCmdList["LEEROYBUILD"] = function(msg)
  msg = string.lower((string.gsub(msg or "", "^%s*(.-)%s*$", "%1")))
  if msg == "" or msg == "export" then
    doExport()
  elseif msg == "options" or msg == "config" then
    applyDefaults()
    UI.ShowOptions(Fields.LIST, isEnabled, setEnabled)
  else
    help()
  end
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:RegisterEvent("PLAYER_LOGIN")
loader:SetScript("OnEvent", function(self, event, name)
  if event == "ADDON_LOADED" and name == ADDON then
    applyDefaults()
  elseif event == "PLAYER_LOGIN" then
    applyDefaults()
    say("loaded. Type /leeroy to export your character. Nothing is sent anywhere.")
  end
end)
