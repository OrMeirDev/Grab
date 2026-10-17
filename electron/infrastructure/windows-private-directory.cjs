// Protect only Grab-owned directories, never the user's system/temp root.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const verified = new Map();
const script = `
$ErrorActionPreference = 'Stop'
$p = $env:GRAB_PRIVATE_DIR
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$old = [IO.Directory]::GetAccessControl($p)
$owner = $old.GetOwner([Security.Principal.SecurityIdentifier]).Value
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$adminOwnedByThisToken = $owner -eq 'S-1-5-32-544' -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($owner -ne $user.Value -and !$adminOwnedByThisToken) { throw 'Not owner' }
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
foreach ($sid in @($user, $system)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, $propagate, 'Allow')
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($p, $acl)
$check = [IO.Directory]::GetAccessControl($p)
if (!$check.AreAccessRulesProtected) { throw 'Inherited access remains' }
foreach ($rule in $check.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($user.Value, $system.Value)) { throw 'Unexpected access' }
}
`;

function protectWindowsDirectory(dir, { diagnostic } = {}) {
  try {
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const fingerprint = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    if (verified.get(dir) === fingerprint) return true;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, GRAB_PRIVATE_DIR: dir }, windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    verified.set(dir, fingerprint);
    return true;
  } catch (error) {
    // Used only by synthetic CI diagnostics. Production callers do not log these details.
    diagnostic?.({ code: error.code, status: error.status, detail: String(error.stderr || '').slice(-4000) });
    return false;
  }
}

module.exports = { protectWindowsDirectory };
