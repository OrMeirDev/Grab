# Disposable CI account only. No installed app, personal account or browser profile is touched.
$ErrorActionPreference = 'Stop'
$testUser = 'GrabPriv' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$testPassword = 'G!' + [Guid]::NewGuid().ToString('N') + 'aA1'
$testRoot = Join-Path $env:PUBLIC ('grab-privacy-' + [Guid]::NewGuid().ToString('N'))
$nodeExe = (Get-Command node).Source
$created = $false
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'electron') | Out-Null
  Copy-Item -Recurse electron/infrastructure (Join-Path $testRoot 'electron/infrastructure')
  Copy-Item -Recurse electron/domain (Join-Path $testRoot 'electron/domain')
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'tests') | Out-Null
  foreach ($testFile in @('private-info-dir.test.cjs', 'cookie-vault-jar.test.cjs', 'privacy-settings.test.cjs')) {
    Copy-Item (Join-Path 'tests' $testFile) (Join-Path $testRoot ('tests/' + $testFile))
  }
  $canary = Join-Path $testRoot 'protected-peer'
  New-Item -ItemType Directory -Path $canary | Out-Null
  & $nodeExe -e "if (!require('./electron/infrastructure/private-info-dir.cjs').ensurePrivateDir(process.argv[1])) process.exit(1)" $canary
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect the synthetic peer directory' }
  Set-Content -LiteralPath (Join-Path $canary 'canary.txt') -Value 'synthetic-only'
  $entry = Join-Path $testRoot 'standard-user.ps1'
  @'
param([string]$NodeExe, [string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
$who = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($who)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This must be a real standard-user token' }
# A headless first logon need not initialize shell Known Folders. The test owns
# an explicit writable temp root while retaining the real standard-user token.
$env:TEMP = Join-Path $FixtureRoot 'standard-user-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Remove-Item Env:GRAB_TEST_YTDLP_DIR -ErrorAction SilentlyContinue
Set-Location $FixtureRoot
& $NodeExe -e "try { require('fs').readFileSync(process.argv[1]); process.exit(10); } catch(e) { if (!['EACCES','EPERM'].includes(e.code)) throw e; console.log('PASS: standard user cannot read synthetic peer data'); }" (Join-Path $FixtureRoot 'protected-peer/canary.txt')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $NodeExe --test --test-timeout=120000 tests/private-info-dir.test.cjs tests/cookie-vault-jar.test.cjs tests/privacy-settings.test.cjs
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $entry -Encoding utf8
  $securePassword = ConvertTo-SecureString $testPassword -AsPlainText -Force
  New-LocalUser -Name $testUser -Password $securePassword -Description 'Disposable Grab CI privacy test' | Out-Null
  $created = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $testUser
  $standardTemp = Join-Path $testRoot 'standard-user-temp'
  New-Item -ItemType Directory -Path $standardTemp | Out-Null
  $testSid = (Get-LocalUser -Name $testUser).SID
  $tempAcl = Get-Acl -LiteralPath $standardTemp
  $tempRule = [Security.AccessControl.FileSystemAccessRule]::new($testSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $tempAcl.AddAccessRule($tempRule)
  Set-Acl -LiteralPath $standardTemp -AclObject $tempAcl
  $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$testUser", $securePassword)
  Start-Service seclogon
  $shellExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $entry + '" -NodeExe "' + $nodeExe + '" -FixtureRoot "' + $testRoot + '"'
  $out = Join-Path $testRoot 'stdout.txt'
  $err = Join-Path $testRoot 'stderr.txt'
  $process = Start-Process -FilePath $shellExe -ArgumentList $arguments -Credential $credential -LoadUserProfile -WorkingDirectory $testRoot -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  if (!$process.WaitForExit(180000)) { $process.Kill(); throw 'Standard-user privacy test timed out' }
  if (Test-Path $out) { Get-Content $out }
  if (Test-Path $err) { Get-Content $err }
  if ($process.ExitCode -ne 0) { throw ('Standard-user privacy test failed: ' + $process.ExitCode) }
} finally {
  if ($created) { Remove-LocalUser -Name $testUser -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
