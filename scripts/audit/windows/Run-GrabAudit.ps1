<#
.SYNOPSIS
  Guided Windows run of the Grab network-privacy audit (docs/audits/grab-network-privacy-audit.md).

.DESCRIPTION
  Runs one scenario at a time against the INSTALLED Grab and keeps every artifact in -OutDir on
  this PC. It changes no Windows setting, installs no certificate and needs no administrator
  rights. It starts the loopback audit endpoint (scripts/audit/diag-endpoint.cjs) and the
  connection capture, then tells you what to click. Requires Node.js and a checkout of this
  repository (for the scripts only).

  Chromium-wide proxy mode (-ChromiumProxy): Grab is started with --proxy-server pointing at the
  audit endpoint. Every Electron request (window, hidden probe, spellchecker, updater) is then
  logged by host name and REFUSED - nothing reaches the internet, so downloads that need the
  network will fail in that mode. Use it for T01/T07 host inventories; use normal mode for T02/T03.

.EXAMPLE
  .\Run-GrabAudit.ps1 -Scenario T01 -ChromiumProxy
  .\Run-GrabAudit.ps1 -Scenario T02
  .\Run-GrabAudit.ps1 -Scenario T06
#>
param(
  [ValidateSet('T00', 'T01', 'T02', 'T03', 'T06', 'T07')][string]$Scenario = 'T00',
  [string]$GrabExe = (Join-Path $env:LOCALAPPDATA 'Programs\Grab\Grab.exe'),
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,
  [string]$Media = '',
  [string]$OutDir = (Join-Path $env:USERPROFILE 'GrabAudit'),
  [int]$Port = 8765,
  [int]$IdleSeconds = 300,
  [switch]$ChromiumProxy,
  # T00: checkouts to compare the installed app.asar with (for example main and the security branch)
  [string[]]$Compare = @()
)
$ErrorActionPreference = 'Stop'
$run = Join-Path $OutDir ("{0}-{1}" -f $Scenario, (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $run | Out-Null
$audit = Join-Path $Repo 'scripts\audit'
$testUrl = 'https://mybook-gat0vxna1-or-meir-tsarfati-s-projects.vercel.app/HSSMT.mp4'
Write-Host "Artifacts: $run  (keep local; never attach to a PR or CI)"

function Start-Endpoint {
  $epArgs = @("$audit\diag-endpoint.cjs", '--port', $Port, '--log', (Join-Path $run 'requests.jsonl'))
  if ($Media) { $epArgs += @('--media', $Media) }
  return Start-Process node -ArgumentList $epArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $run 'endpoint.txt')
}
$stopFile = Join-Path $run 'capture.stop'
function Start-Capture([int]$Seconds, [switch]$Browsers) {
  $ps = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\Capture-GrabConnections.ps1", '-Seconds', $Seconds, '-OutDir', (Join-Path $run 'capture'), '-StopFile', $stopFile)
  if ($Browsers) { $ps += '-IncludeBrowsers' }
  return Start-Process powershell -ArgumentList $ps -PassThru -WindowStyle Minimized
}
# The capture writes its CSV and summary only when it ends: ask it to stop, then wait for it.
function Stop-Capture($cap) {
  New-Item -ItemType File -Force -Path $stopFile | Out-Null
  Wait-Process -Id $cap.Id -Timeout 120 -ErrorAction SilentlyContinue
}
function Start-Grab {
  if (Get-Process Grab -ErrorAction SilentlyContinue) { throw 'Close Grab first (tray included), then run again.' }
  $a = @(); if ($ChromiumProxy) { $a += "--proxy-server=http://127.0.0.1:$Port" }
  return Start-Process $GrabExe -ArgumentList $a -PassThru
}

switch ($Scenario) {
  'T00' {
    # Which build is installed? Compare with the two checkouts you want to test.
    $cmp = @(); foreach ($c in ($(if ($Compare.Count) { $Compare } else { @($Repo) }))) { $cmp += @('--compare', $c) }
    node "$audit\inspect-installed.cjs" --installed (Split-Path $GrabExe) @cmp | Tee-Object (Join-Path $run 'installed.txt')
    (Get-Item $GrabExe).VersionInfo | Format-List FileVersion, ProductVersion | Out-File -Append (Join-Path $run 'installed.txt')
    $r = Invoke-WebRequest -Method Head -Uri $testUrl -UseBasicParsing
    "test video: HTTP $($r.StatusCode) length=$($r.Headers['Content-Length']) type=$($r.Headers['Content-Type'])" | Tee-Object -Append (Join-Path $run 'installed.txt')
  }
  'T01' {
    $ep = Start-Endpoint; $cap = Start-Capture -Seconds ($IdleSeconds + 20)
    Start-Sleep 2; $g = Start-Grab
    Write-Host "Do NOTHING in Grab for $IdleSeconds s."
    Start-Sleep $IdleSeconds
    Stop-Capture $cap
    Write-Host 'Close Grab now (window and tray), then press Enter.'
    Read-Host | Out-Null
    Stop-Process -Id $ep.Id
  }
  'T02' {
    $cap = Start-Capture -Seconds 600; Start-Sleep 2; $g = Start-Grab
    Set-Clipboard -Value $testUrl
    Write-Host "Paste the link (already on the clipboard) into Grab, download it, then press Enter here."
    Read-Host | Out-Null
    $file = Get-ChildItem (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\Grab') -Filter 'HSSMT*.mp4' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    "downloaded: $($file.FullName) size=$($file.Length) expected=53961552 match=$($file.Length -eq 53961552)" | Tee-Object (Join-Path $run 'result.txt')
    Stop-Capture $cap
  }
  'T03' {
    $cap = Start-Capture -Seconds 900 -Browsers; Start-Sleep 2
    Write-Host "Open $testUrl in Chrome, send it to Grab from the extension, wait for the download. Repeat in Edge and Brave. Press Enter when done."
    Read-Host | Out-Null
    Stop-Capture $cap
  }
  'T06' {
    if (Get-Process Grab -ErrorAction SilentlyContinue) { throw 'Close Grab first so all files are flushed.' }
    node "$audit\scan-profile.cjs" --profile (Join-Path $env:APPDATA 'Grab') --temp $env:TEMP --json (Join-Path $run 'scan.json') | Tee-Object (Join-Path $run 'scan.txt')
  }
  'T07' {
    $ep = Start-Endpoint; Start-Sleep 1
    $ChromiumProxy = $true; $g = Start-Grab
    Write-Host "Wait 30 s (background check), then click 'Check for updates' in Settings once, close Grab (window and tray), then press Enter."
    Read-Host | Out-Null
    Stop-Process -Id $ep.Id
    "updater id file present: $(Test-Path (Join-Path $env:APPDATA 'Grab\.updaterId'))" | Tee-Object (Join-Path $run 'result.txt')
  }
}
Write-Host "Done: $run"
