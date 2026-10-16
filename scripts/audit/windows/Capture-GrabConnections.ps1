<#
.SYNOPSIS
  Process-attributed TCP connection log for the Grab network-privacy audit (docs/audits/).

.DESCRIPTION
  Polls Get-NetTCPConnection (no administrator rights, no driver, no settings change) and records
  every new connection owned by Grab and the processes it starts (yt-dlp, ffmpeg, ffprobe, deno,
  the native host) and, with -IncludeBrowsers, by Chrome, Edge and Brave. At the end, remote
  addresses are matched with names from the DNS client cache. Output stays in -OutDir; do not
  upload it (it shows which sites were contacted).

  Limits: very short connections can fall between two polls; UDP/QUIC (HTTP/3) and DNS lookups
  are not attributed to a process. Use the Chromium-wide proxy mode of Run-GrabAudit.ps1 for
  host names of Electron traffic, and the loopback audit endpoint for HTTP header contents.

.EXAMPLE
  .\Capture-GrabConnections.ps1 -Seconds 300 -OutDir $env:USERPROFILE\GrabAudit\T01
#>
param(
  [int]$Seconds = 300,
  [int]$IntervalMs = 250,
  [string]$OutDir = (Join-Path $env:USERPROFILE 'GrabAudit\capture'),
  [switch]$IncludeBrowsers,
  # Ends the capture early (results are still written) as soon as this file exists.
  [string]$StopFile = ''
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$csv = Join-Path $OutDir 'connections.csv'
$names = @('Grab', 'yt-dlp', 'ffmpeg', 'ffprobe', 'deno', 'node')
if ($IncludeBrowsers) { $names += @('chrome', 'msedge', 'brave') }

function Get-Watched {
  $procs = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath
  $byPid = @{}
  foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }
  $watched = @{}
  foreach ($p in $procs) {
    $base = [IO.Path]::GetFileNameWithoutExtension($p.Name)
    if ($names -contains $base) { $watched[[int]$p.ProcessId] = $p; continue }
    # anything started (directly or indirectly) by Grab.exe
    $cur = $p; $depth = 0
    while ($cur -and $depth -lt 8) {
      $parent = $byPid[[int]$cur.ParentProcessId]
      if ($parent -and [IO.Path]::GetFileNameWithoutExtension($parent.Name) -eq 'Grab') { $watched[[int]$p.ProcessId] = $p; break }
      $cur = $parent; $depth++
    }
  }
  return $watched
}

$seen = @{}
$rows = New-Object System.Collections.Generic.List[object]
$end = (Get-Date).AddSeconds($Seconds)
$watched = Get-Watched
$lastRefresh = Get-Date
Write-Host "Capturing for $Seconds s -> $csv"
while ((Get-Date) -lt $end -and -not ($StopFile -and (Test-Path $StopFile))) {
  if (((Get-Date) - $lastRefresh).TotalSeconds -ge 2) { $watched = Get-Watched; $lastRefresh = Get-Date }
  foreach ($c in Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    if (-not $watched.ContainsKey([int]$c.OwningProcess)) { continue }
    if ($c.RemoteAddress -in @('0.0.0.0', '::')) { continue }
    $key = "$($c.OwningProcess)|$($c.LocalPort)|$($c.RemoteAddress)|$($c.RemotePort)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $p = $watched[[int]$c.OwningProcess]
    $rows.Add([pscustomobject]@{
      Time = (Get-Date).ToString('HH:mm:ss.fff'); Process = $p.Name; Pid = $c.OwningProcess; ParentPid = $p.ParentProcessId
      RemoteAddress = $c.RemoteAddress; RemotePort = $c.RemotePort; State = "$($c.State)"
      Loopback = ($c.RemoteAddress -like '127.*' -or $c.RemoteAddress -eq '::1')
    })
  }
  Start-Sleep -Milliseconds $IntervalMs
}

# Reverse names from the DNS client cache (best effort; CDN addresses may not resolve uniquely)
$dns = @{}
foreach ($r in Get-DnsClientCache -ErrorAction SilentlyContinue) { if ($r.Data) { $dns[$r.Data] += @($r.Entry) } }
foreach ($row in $rows) { $row | Add-Member -NotePropertyName Names -NotePropertyValue (($dns[$row.RemoteAddress] | Select-Object -Unique) -join ';') }
$rows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $csv
$rows | Group-Object Process, RemoteAddress, RemotePort | ForEach-Object {
  [pscustomobject]@{ Process = $_.Group[0].Process; Remote = "$($_.Group[0].RemoteAddress):$($_.Group[0].RemotePort)"; Names = $_.Group[0].Names; Connections = $_.Count; First = $_.Group[0].Time }
} | Sort-Object First | Format-Table -AutoSize | Out-String -Width 220 | Tee-Object -FilePath (Join-Path $OutDir 'summary.txt')
