// Chrome and Brave share the Windows native-host registry location. Identify the actual
// launching browser from this host's process ancestry, never from its UA or the registry label.
const path = require('node:path');
const { execFile } = require('node:child_process');
const KINDS = ['edge', 'chrome', 'brave'];

async function browserKind({ declared = process.env.GRAB_BROWSER, platform = process.platform,
  parentPid = process.ppid, windowsDir = process.env.SystemRoot || 'C:\\Windows', exec = execFile, signal } = {}) {
  if (declared !== 'chromium') return KINDS.includes(declared) ? declared : 'unknown';
  if (platform !== 'win32' || !Number.isInteger(parentPid) || parentPid < 1) return 'unknown';
  const script = `& {
    $ErrorActionPreference = 'Stop'
    $ancestorId = ${parentPid}
    for ($depth = 0; $depth -lt 8 -and $ancestorId -gt 0; $depth++) {
      $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $ancestorId" -Property Name,ParentProcessId
      if (!$ancestor) { break }
      switch ($ancestor.Name.ToLowerInvariant()) {
        'brave.exe' { [Console]::Out.Write('brave'); return }
        'chrome.exe' { [Console]::Out.Write('chrome'); return }
        'msedge.exe' { [Console]::Out.Write('edge'); return }
      }
      $ancestorId = [int]$ancestor.ParentProcessId
    }
  }`;
  const powershell = path.win32.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return 'unknown';
    const result = await new Promise((resolve) => {
      exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: attempt ? 8000 : 4000, maxBuffer: 1024, windowsHide: true, ...(signal ? { signal } : {}) }, (error, stdout) => {
          const value = error ? '' : String(stdout || '').trim();
          resolve({ value: KINDS.includes(value) ? value : 'unknown', retry: !!error?.killed || error?.code === 'ETIMEDOUT' });
        });
    });
    if (result.value !== 'unknown' || !result.retry) return result.value;
  }
  return 'unknown';
}
module.exports = { browserKind };
