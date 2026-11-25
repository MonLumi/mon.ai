# Adds mon.ai shortcuts for the current user (no admin needed):
#   Start menu:  "mon.ai" (start + open) and "mon.ai - restart" (after updating) and "mon.ai - stop"
#   Desktop:     "mon.ai"
#   -AutoStart   also start mon.ai in the background when you sign in to Windows (Startup folder)
#   -Remove      remove everything this script added
# Shortcuts run scripts\mon.ps1 with no console window.
param([switch] $AutoStart, [switch] $Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $PSScriptRoot 'mon.ps1'
$icon = Join-Path $PSScriptRoot 'mon.ico'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'mon.ai'
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$links = @(
  @{ Path = Join-Path $startMenu 'mon.ai.lnk'; Args = 'start'; Tip = 'Start mon.ai (if needed) and open it' },
  @{ Path = Join-Path $startMenu 'mon.ai - restart.lnk'; Args = 'restart'; Tip = 'Restart mon.ai (after updating it) and open it' },
  @{ Path = Join-Path $startMenu 'mon.ai - stop.lnk'; Args = 'stop'; Tip = 'Stop mon.ai' },
  @{ Path = Join-Path $desktop 'mon.ai.lnk'; Args = 'start'; Tip = 'Start mon.ai (if needed) and open it' }
)
$autoLink = @{ Path = Join-Path $startup 'mon.ai.lnk'; Args = 'start -NoBrowser'; Tip = 'Start mon.ai in the background at sign-in' }

if ($Remove) {
  foreach ($l in $links + $autoLink) { if (Test-Path $l.Path) { Remove-Item $l.Path -Force; Write-Host "Removed $($l.Path)" } }
  if ((Test-Path $startMenu) -and -not (Get-ChildItem $startMenu)) { Remove-Item $startMenu }
  return
}

# Icon: the mon.ai "m" tile (same as the browser tab icon)
if (-not (Test-Path $icon)) {
  try {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 64, 64
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 16; $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc(63 - $r, 0, $r, $r, 270, 90); $path.AddArc(63 - $r, 63 - $r, $r, $r, 0, 90); $path.AddArc(0, 63 - $r, $r, $r, 90, 90); $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(79, 70, 229))), $path)
    $font = New-Object System.Drawing.Font 'Segoe UI', 34, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
    $g.DrawString('m', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, -2, 64, 64), $fmt)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = $ms.ToArray()
    # .ico = header + one entry pointing at the PNG
    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $out
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
    $w.Write([byte]64); $w.Write([byte]64); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$png.Length); $w.Write([uint32]22); $w.Write($png); $w.Flush()
    [IO.File]::WriteAllBytes($icon, $out.ToArray())
  } catch { Write-Host "Icon not created ($($_.Exception.Message)); using a standard one."; $icon = "$env:SystemRoot\System32\shell32.dll,13" }
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }
$shell = New-Object -ComObject WScript.Shell
function New-MonLink($l) {
  New-Item -ItemType Directory -Force (Split-Path $l.Path) | Out-Null
  $s = $shell.CreateShortcut($l.Path)
  # conhost --headless: no console window flashes up (Windows Terminal ignores -WindowStyle Hidden)
  $s.TargetPath = "$env:SystemRoot\System32\conhost.exe"
  $s.Arguments = "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" $($l.Args)"
  $s.WorkingDirectory = $root
  $s.IconLocation = if ($icon -like '*,*') { $icon } else { "$icon,0" }
  $s.Description = $l.Tip
  $s.WindowStyle = 7 # minimized
  $s.Save()
  Write-Host "Created $($l.Path)"
}
$links | ForEach-Object { New-MonLink $_ }
if ($AutoStart) { New-MonLink $autoLink } elseif (Test-Path $autoLink.Path) { Write-Host "Auto-start at sign-in is on ($($autoLink.Path))." }
Write-Host ''
Write-Host 'Done. Open mon.ai from the Start menu or the desktop; pin it to the taskbar from the Start menu if you like.'
