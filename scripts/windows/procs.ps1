# Test harness only (scripts/windows/installed-app.cjs): process queries that need the command
# line, and freezing/unfreezing a process, without starting PowerShell for every question.
# Reads one command per line on stdin and answers each with one JSON line on stdout:
#   list <image.exe>    -> [{ pid, ppid, cmd }]
#   tree <pid>          -> [{ pid, name, cmd }] the process and its ancestors
#   suspend <pid>       -> { status }   (NtSuspendProcess; 0 = done)
#   resume <pid>        -> { status }
#   alive <pid>         -> { alive }
#   installers          -> [{ pid, ppid, name, created, path }] app installers running now (an
#                          update's from the updater cache, or any Grab-Setup*.exe), with their
#                          creation time (kernel timestamp, UTC)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GrabTestProc {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr handle);
  public static int Freeze(int pid, bool freeze) {
    IntPtr h = OpenProcess(0x0800, false, pid); // PROCESS_SUSPEND_RESUME
    if (h == IntPtr.Zero) return -1;
    try { return freeze ? NtSuspendProcess(h) : NtResumeProcess(h); } finally { CloseHandle(h); }
  }
}
"@

function Write-Answer($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 4))
  [Console]::Out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $line = $line.Trim()
  if (-not $line) { continue }
  $cmd, $arg = $line -split '\s+', 2
  try {
    switch ($cmd) {
      'list' {
        $items = @(Get-CimInstance Win32_Process -Filter "Name='$arg'" | ForEach-Object {
          [ordered]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cmd = [string]$_.CommandLine } })
        Write-Answer $items
      }
      'tree' {
        $chain = @()
        $id = [int]$arg
        for ($i = 0; $i -lt 8 -and $id -gt 0; $i++) {
          $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
          if (-not $p) { break }
          $chain += [ordered]@{ pid = [int]$p.ProcessId; name = [string]$p.Name; cmd = ([string]$p.CommandLine).Substring(0, [Math]::Min(300, ([string]$p.CommandLine).Length)) }
          $id = [int]$p.ParentProcessId
        }
        Write-Answer $chain
      }
      'suspend' { Write-Answer ([ordered]@{ status = [GrabTestProc]::Freeze([int]$arg, $true) }) }
      'resume' { Write-Answer ([ordered]@{ status = [GrabTestProc]::Freeze([int]$arg, $false) }) }
      'alive' { Write-Answer ([ordered]@{ alive = [bool](Get-Process -Id ([int]$arg) -ErrorAction SilentlyContinue) }) }
      'installers' {
        $items = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'Grab-Setup%' OR ExecutablePath LIKE '%grab-updater%'" | ForEach-Object {
          [ordered]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; created = $_.CreationDate.ToUniversalTime().ToString('o'); path = [string]$_.ExecutablePath } })
        Write-Answer $items
      }
      default { Write-Answer ([ordered]@{ error = "unknown command $cmd" }) }
    }
  } catch {
    Write-Answer ([ordered]@{ error = [string]$_ })
  }
}
