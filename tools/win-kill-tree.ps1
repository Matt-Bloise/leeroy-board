# Stops a process and all its children by Windows PID (used by tools/local-browser.sh on Windows, where setsid and process groups do not exist).
# Usage: powershell -NoProfile -File tools/win-kill-tree.ps1 <windows pid>
param([int]$WinPid)
function Stop-Tree([int]$Id) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id" | ForEach-Object { Stop-Tree $_.ProcessId }
  Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}
Stop-Tree $WinPid
