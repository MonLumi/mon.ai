# mon.ai launcher: runs the server in the background (no window) and opens it in the browser.
#   mon.ps1 start      start if not running, then open https://mon.ai   (default)
#   mon.ps1 restart    stop and start again (after updating mon.ai), then open it
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

switch ($Action) {
  'status' { $p = Get-MonProcess; if ($p) { Write-Host "running (pid $($p.Id)) on $url" } else { Write-Host 'not running' } }
  'stop' { Stop-Mon }
  'restart' { Stop-Mon; if ((Start-Mon) -and -not $NoBrowser) { Start-Process $url } }
  'open' { if ((Start-Mon) -and -not $NoBrowser) { Start-Process $url } }
  default { if ((Start-Mon) -and -not $NoBrowser) { Start-Process $url } }
}
