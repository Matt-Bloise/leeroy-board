-- LeeroyBuild_Codec.lua: pure export-string codec (format v1).
-- No WoW globals. Lua 5.1 only: arithmetic checksum, no bit library, no // operator, no goto, no utf8.
-- A line-for-line JS twin lives in tests/unit/addon-codec.test.mjs and is cross-checked against zlib.
local ADDON, ns = ...
if type(ns) ~= "table" then ns = {} end

local Codec = {}

Codec.TAG = "LEEROY1"
Codec.MAX_LENGTH = 2048
Codec.KEY_ORDER = { "v", "iface", "t", "name", "class", "race", "level", "prof", "talents", "zone" }

-- Escape one value. Bytes are the UTF-8 bytes as the game returns them.
function Codec.escape(value)
  local s = tostring(value)
  local out = {}
  for i = 1, #s do
    local c = string.byte(s, i)
    local piece
    if c == 37 then piece = "%25"
    elseif c == 59 then piece = "%3B"
    elseif c == 61 then piece = "%3D"
    elseif c == 124 then piece = "%7C"
    elseif c == 10 then piece = "%0A"
    elseif c < 32 or c > 126 then piece = string.format("%%%02X", c)
    else piece = string.char(c) end
    out[#out + 1] = piece
  end
  return table.concat(out)
end

-- Adler-32 as two 16-bit halves, arithmetic only.
function Codec.adler32(s)
  local a, b = 1, 0
  for i = 1, #s do
    a = (a + string.byte(s, i)) % 65521
    b = (b + a) % 65521
  end
  return a, b
end

-- 8 lowercase hex digits. value = b * 65536 + a, so b's four digits then a's four digits.
function Codec.check(s)
  local a, b = Codec.adler32(s)
  return string.format("%04x%04x", b, a)
end

-- values: table key -> string or integer. Keys outside KEY_ORDER are ignored. nil or empty values are omitted.
function Codec.payload(values)
  local parts = {}
  for _, key in ipairs(Codec.KEY_ORDER) do
    local v = values[key]
    if v ~= nil then
      if type(v) == "number" then v = string.format("%d", v) end
      v = tostring(v)
      if v ~= "" then parts[#parts + 1] = key .. "=" .. Codec.escape(v) end
    end
  end
  return table.concat(parts, ";")
end

function Codec.wrap(payload)
  return Codec.TAG .. "|" .. payload .. "|" .. Codec.check(payload)
end

function Codec.encode(values)
  return Codec.wrap(Codec.payload(values))
end

ns.Codec = Codec
return Codec
