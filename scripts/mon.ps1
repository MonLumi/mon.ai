# mon.ai launcher: runs the server in the background (no window) and opens it in the browser.
#   mon.ps1 start      start if not running, then open https://mon.ai   (default)
#   mon.ps1 restart    stop and start again, then reload open mon.ai windows
#   mon.ps1 stop       stop the server
#   mon.ps1 status     is it running?
#   -NoBrowser         don't open the browser (e.g. when started at sign-in)
# Output goes to data\logs\mon.log (errors: mon.err.log).
param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'open')] [string] $Action = 'start',
  [switch] $NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$https = (Test-Path (Join-Path $root 'data\tls\mon.ai.pfx')) -and $env:MON_HTTPS -ne '0'
$port = if ($https) { [int]($env:HTTPS_PORT ?? 443) } else { [int]($env:PORT ?? 80) }
$url = if ($https) { 'https://mon.ai' + $(if ($port -ne 443) { ":$port" }) } else { 'http://mon.ai' + $(if ($port -ne 80) { ":$port" }) }

function Write-Note([string] $text) {
  # Shortcuts run hidden: also leave the message in the log
  Add-Content -Path (Join-Path $logDir 'launcher.log') -Value "$(Get-Date -Format s)  $text"
  Write-Host $text
}

# The mon.ai server = the node process listening on its port (however it was started: shortcut or npm start).
function Get-MonProcess {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { return $p }
  return $null
}

function Stop-Mon {
  $p = Get-MonProcess
  if (-not $p) { Write-Note 'mon.ai is not running.'; return }
  Stop-Process -Id $p.Id -Force
  for ($i = 0; $i -lt 20 -and (Get-MonProcess); $i++) { Start-Sleep -Milliseconds 250 }
  Write-Note "mon.ai stopped (pid $($p.Id))."
}

function Start-Mon {
  $p = Get-MonProcess
  if ($p) { Write-Note "mon.ai is already running (pid $($p.Id))."; return $true }
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($busy) { Write-Note "Port $port is used by another program (pid $($busy.OwningProcess)); mon.ai can't start."; return $false }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Note 'Node.js was not found on PATH.'; return $false }
  $log = Join-Path $logDir 'mon.log'
  $err = Join-Path $logDir 'mon.err.log'
  foreach ($f in $log, $err) { if ((Test-Path $f) -and (Get-Item $f).Length -gt 5MB) { Move-Item $f "$f.old" -Force } }
  $proc = Start-Process -FilePath $node -ArgumentList '--no-warnings=ExperimentalWarning', 'server.js' -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-MonProcess) { Write-Note "mon.ai started (pid $($proc.Id)) on $url"; return $true }
    if ($proc.HasExited) { break }
  }
  Write-Note "mon.ai did not start. See $err"
  return $false
}

# Open mon.ai in a dedicated Edge app window (no tab strip). Other sites opened from it, and links
# from outside apps (Teams, CLI logins, VPN), go to the normal Edge window instead of this one.
# Set MON_APP_WINDOW=0 to open it as a normal browser tab.
# The app window is pinned to an Edge profile (default: the work profile "Default"; override with
# MON_EDGE_PROFILE, e.g. "Profile 1"). Without it Edge uses the last-used profile, and links opened
# from mon.ai land in that profile's window.
function Open-Mon {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  $profile = $env:MON_EDGE_PROFILE ?? 'Default'
  if ($edge -and $env:MON_APP_WINDOW -ne '0') { Start-Process -FilePath $edge -ArgumentList "--profile-directory=`"$profile`"", "--app=$url" }
  else { Start-Process $url }
}

function Reload-Mon {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class MonWindows {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int maxLength);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    public static List<IntPtr> FindMonWindows() {
        var windows = new List<IntPtr>();
        EnumWindows((window, parameter) => {
            if (!IsWindowVisible(window)) return true;
            var title = new StringBuilder(512);
            if (GetWindowText(window, title, title.Capacity) == 0 ||
                title.ToString().IndexOf("mon.ai", StringComparison.OrdinalIgnoreCase) < 0)
                return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            try {
                using (var process = Process.GetProcessById((int)processId)) {
                    if (process.ProcessName.Equals("msedge", StringComparison.OrdinalIgnoreCase))
                        windows.Add(window);
                }
            } catch (ArgumentException) {
                // The window's process exited while windows were being enumerated.
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
'@
  $windows = [MonWindows]::FindMonWindows()
  if ($windows.Count -eq 0) { Write-Note 'No open mon.ai Edge window found; nothing to reload.'; return }

  $shell = New-Object -ComObject WScript.Shell
  $reloaded = 0
  foreach ($window in $windows) {
    [void][MonWindows]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds 100
    if ([MonWindows]::GetForegroundWindow() -ne $window) {
      Write-Note "Could not focus mon.ai window $window; it was not reloaded."
      continue
    }
    $shell.SendKeys('^r')
    $reloaded++
  }
  Write-Note "Reloaded $reloaded of $($windows.Count) open mon.ai Edge window(s)."
}

switch ($Action) {
  'status' { $p = Get-MonProcess; if ($p) { Write-Host "running (pid $($p.Id)) on $url" } else { Write-Host 'not running' } }
  'stop' { Stop-Mon }
  'restart' { Stop-Mon; if ((Start-Mon) -and -not $NoBrowser) { Reload-Mon } }
  'open' { if ((Start-Mon) -and -not $NoBrowser) { Open-Mon } }
  default { if ((Start-Mon) -and -not $NoBrowser) { Open-Mon } }
}
