-- LeeroyBuild_UI.lua: the export window and the options window. Display only; nothing here sends or reads anything.
local ADDON, ns = ...

local UI = {}

local function newFrame(name, width, height, title)
  local template = (BackdropTemplateMixin and "BackdropTemplate") or nil
  local f = CreateFrame("Frame", name, UIParent, template)
  f:SetSize(width, height)
  f:SetPoint("CENTER")
  f:SetFrameStrata("DIALOG")
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) self:StartMoving() end)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing() end)
  if f.SetBackdrop then
    f:SetBackdrop({
      bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
      edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
      tile = true, tileSize = 32, edgeSize = 32,
      insets = { left = 8, right = 8, top = 8, bottom = 8 },
    })
  end
  local t = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  t:SetPoint("TOP", 0, -16)
  t:SetText(title)
  f.title = t
  local close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  close:SetSize(80, 22)
  close:SetPoint("BOTTOM", 0, 14)
  close:SetText("Close")
  close:SetScript("OnClick", function() f:Hide() end)
  -- Esc closes (standard special-frame list).
  if type(UISpecialFrames) == "table" and name then
    table.insert(UISpecialFrames, name)
  end
  f:Hide()
  return f
end

-- Export window: movable, EditBox pre-filled with the string and highlighted. Edits are reverted, so it behaves read-only.
function UI.ShowExport(text, summaryLines)
  if not UI.exportFrame then
    local f = newFrame("LeeroyBuildExportFrame", 560, 210, "Leeroy Build export")
    local hint = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    hint:SetPoint("TOP", f.title, "BOTTOM", 0, -10)
    hint:SetWidth(500)
    hint:SetText("Press Ctrl+C to copy, then paste on leeroy.party (Import from game). Esc closes.")
    f.hint = hint

    local box = CreateFrame("EditBox", nil, f)
    box:SetMultiLine(true)
    box:SetFontObject(ChatFontNormal or GameFontHighlight)
    box:SetSize(500, 90)
    box:SetPoint("TOP", hint, "BOTTOM", 0, -12)
    box:SetAutoFocus(true)
    box:SetMaxLetters(0)
    box:SetScript("OnEscapePressed", function() f:Hide() end)
    box:SetScript("OnTextChanged", function(self, userInput)
      if userInput and f.exportText and self:GetText() ~= f.exportText then
        self:SetText(f.exportText)
        self:HighlightText()
      end
    end)
    box:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
    f.box = box
    UI.exportFrame = f
  end
  local f = UI.exportFrame
  f.exportText = text
  f.box:SetText(text)
  f:Show()
  f.box:SetFocus()
  f.box:HighlightText()
end

-- Options window: one checkbox per field. onChange(key, checked) is called on every click.
function UI.ShowOptions(fieldList, isEnabled, onChange)
  if not UI.optionsFrame then
    local rows = #fieldList
    local f = newFrame("LeeroyBuildOptionsFrame", 340, 120 + rows * 26, "Leeroy Build options")
    local note = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    note:SetPoint("TOP", f.title, "BOTTOM", 0, -8)
    note:SetWidth(300)
    note:SetText("Only ticked fields go into the export string.")
    f.checks = {}
    for i, field in ipairs(fieldList) do
      local cb = CreateFrame("CheckButton", nil, f, "UICheckButtonTemplate")
      cb:SetPoint("TOPLEFT", 28, -58 - (i - 1) * 26)
      local label = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
      label:SetPoint("LEFT", cb, "RIGHT", 4, 1)
      label:SetText(field.label .. (field.required and " (needed by the site)" or ""))
      cb:SetScript("OnClick", function(self) onChange(field.key, self:GetChecked() and true or false) end)
      f.checks[field.key] = cb
    end
    UI.optionsFrame = f
  end
  local f = UI.optionsFrame
  for key, cb in pairs(f.checks) do cb:SetChecked(isEnabled(key)) end
  f:Show()
end

ns.UI = UI
