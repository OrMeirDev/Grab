# A pinned portable browser for disposable CI profiles; never installed into Windows or shipped.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This test download runs only on a disposable Actions runner.' }
$braveTestRoot = Join-Path $env:RUNNER_TEMP 'grab-brave-test-1.97.57'
$braveTestZip = "$braveTestRoot.zip"
Invoke-WebRequest 'https://github.com/brave/brave-browser/releases/download/v1.97.57/brave-v1.97.57-win32-x64.zip' -OutFile $braveTestZip
$expected = 'c986dc568bbabf7dc5dcce0bb354597eaafeab6dc47412d37ff7458d8b5d0550'
if ((Get-FileHash $braveTestZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Brave test browser hash mismatch.' }
Expand-Archive $braveTestZip -DestinationPath $braveTestRoot -Force
$braveTestFiles = @(Get-ChildItem $braveTestRoot -Filter brave.exe -Recurse -File)
if ($braveTestFiles.Count -ne 1) { throw 'Expected one portable Brave executable.' }
"GRAB_TEST_BRAVE=$($braveTestFiles[0].FullName)" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output 'Verified portable Brave 1.97.57 for isolated browser integration tests.'
