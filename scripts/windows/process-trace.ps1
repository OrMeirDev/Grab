# Test harness only: records when the processes that matter start and end (WMI process traces,
# the kernel's own timestamps), one JSON line each, so an order such as "the download's yt-dlp and
# FFmpeg ended before the update installer started" can be read afterwards. Needs administrator
# rights (GitHub's Windows runners have them). Writes {"ev":"ready"} once listening.
#   powershell -File process-trace.ps1 -Out <file.jsonl>
param([Parameter(Mandatory = $true)] [string]$Out)
$ErrorActionPreference = 'Stop'
$interesting = '^(yt-dlp|ffmpeg|ffprobe|deno|grab|un_a|uninstall|.*setup)'
function Write-Line($value) { [IO.File]::AppendAllText($Out, (ConvertTo-Json -InputObject $value -Compress) + "`n") }
try {
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier grabTraceStart | Out-Null
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier grabTraceStop | Out-Null
} catch {
  Write-Line ([ordered]@{ ev = 'error'; message = [string]$_ })
  exit 1
}
Write-Line ([ordered]@{ ev = 'ready'; t = [DateTime]::UtcNow.ToString('o') })
while ($true) {
  $e = Wait-Event -Timeout 1
  if (-not $e) { continue }
  $i = $e.SourceEventArgs.NewEvent
  if ([string]$i.ProcessName -match $interesting) {
    Write-Line ([ordered]@{
      ev = $(if ($e.SourceIdentifier -eq 'grabTraceStart') { 'start' } else { 'stop' })
      name = [string]$i.ProcessName
      pid = [int]$i.ProcessID
      ppid = [int]$i.ParentProcessID
      t = [DateTime]::FromFileTimeUtc([long]$i.TIME_CREATED).ToString('o')
    })
  }
  Remove-Event -EventIdentifier $e.EventIdentifier
}
