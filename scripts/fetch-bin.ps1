# Downloads the third-party tools Grab bundles (yt-dlp, ffmpeg, ffprobe, deno) into bin/, exactly
# as pinned in native-tools.lock.json (GRB-06): fixed release URLs, and every download and every
# extracted file must match its SHA-256 or the script stops. License texts go to bin/licenses/.
# Not in git because each binary is far larger than GitHub's 100 MB file limit.
# -LockFile / -BinDir: another lock and target folder (tests/fetch-bin.windows.test.cjs).
param([string]$LockFile, [string]$BinDir)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $LockFile) { $LockFile = Join-Path $root 'native-tools.lock.json' }
$bin = if ($BinDir) { $BinDir } else { Join-Path $root 'bin' }
$lock = Get-Content $LockFile -Raw | ConvertFrom-Json
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('grab-bin-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $bin, (Join-Path $bin 'licenses'), $tmp | Out-Null

function Get-File($url, $out) {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}

# Hashing and unzipping go through .NET, not Get-FileHash/Expand-Archive: Windows PowerShell 5.1
# started from a PowerShell 7 window (npm in Windows Terminal, CI) inherits 7's module path and
# cannot load those cmdlets.
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256($file) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($file)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Assert-Hash($file, $expected, $what) {
    $actual = Get-Sha256 $file
    if ($actual -ne $expected.ToLowerInvariant()) {
        throw "SHA-256 mismatch for ${what}: expected $expected, got $actual. Nothing was installed from it."
    }
}

# Upstream FFmpeg autobuilds are ephemeral. Recover only this exact locked build from our
# already-published installer when its original archive was removed. Both the carrier and every
# recovered binary/license are checked; no installer code is executed and no tool is upgraded.
function Restore-PublishedFfmpeg($tool, $staging) {
    if ($tool.name -ne 'ffmpeg' -or $tool.sha256 -ne 'cc4c8f3e15b317be771bce75e4f7cba40ab89991cf1a6bfc4c9385e3ae50baec') {
        throw 'No verified recovery source for this tool.'
    }
    $seven = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
    if (-not (Test-Path $seven)) {
        $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
        if (-not $command) { throw 'Recovering the removed pinned FFmpeg archive requires 7-Zip.' }
        $seven = $command.Source
    }
    $installer = Join-Path $tmp 'Grab-Setup-1.8.0.exe'
    Get-File 'https://github.com/OrMeirDev/Grab/releases/download/v1.8.0/Grab-Setup-1.8.0.exe' $installer
    Assert-Hash $installer '10203e2ce1b41ffb7d636808af4c829b271eb76e8da235a7c65c385f313d67eb' 'published recovery installer'
    $outer = Join-Path $tmp 'recovery-installer'
    & $seven x $installer "-o$outer" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract recovery installer.' }
    $payload = @(Get-ChildItem $outer -Recurse -File -Filter 'app-64.7z')
    if ($payload.Count -ne 1) { throw 'Recovery installer has no unique x64 payload.' }
    $unpacked = Join-Path $tmp 'recovery-app'
    & $seven x $payload[0].FullName "-o$unpacked" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract recovery application.' }
    $sourceBin = Join-Path $unpacked 'resources/bin'
    foreach ($entry in $tool.files.PSObject.Properties) {
        $source = Join-Path $sourceBin $entry.Name
        Assert-Hash $source $entry.Value $entry.Name
    }
    foreach ($license in $tool.licenseFiles) {
        Assert-Hash (Join-Path $sourceBin "licenses/$($license.name)") $license.sha256 $license.name
    }
    # Verify the complete recovered tool before staging any of it for installation.
    foreach ($entry in $tool.files.PSObject.Properties) {
        Copy-Item (Join-Path $sourceBin $entry.Name) (Join-Path $staging $entry.Name)
    }
    foreach ($license in $tool.licenseFiles) {
        $target = Join-Path $staging $license.archivePath
        New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
        Copy-Item (Join-Path $sourceBin "licenses/$($license.name)") $target
    }
}

try {
    foreach ($tool in $lock.tools) {
        $name = Split-Path $tool.url -Leaf
        $download = Join-Path $tmp $name
        $staging = Join-Path $tmp $tool.name
        New-Item -ItemType Directory -Force $staging | Out-Null
        $recovered = $false
        try { Get-File $tool.url $download }
        catch {
            $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
            if ($status -ne 404 -or $tool.name -ne 'ffmpeg' -or $tool.sha256 -ne 'cc4c8f3e15b317be771bce75e4f7cba40ab89991cf1a6bfc4c9385e3ae50baec') { throw }
            Write-Host 'Pinned FFmpeg archive removed upstream; recovering identical verified files from Grab 1.8.0.'
            Restore-PublishedFfmpeg $tool $staging
            $recovered = $true
        }
        if (-not $recovered) {
            Assert-Hash $download $tool.sha256 $name
            if ($name -like '*.zip') { [IO.Compression.ZipFile]::ExtractToDirectory($download, $staging) } else { Copy-Item $download $staging }
        }

        foreach ($entry in $tool.files.PSObject.Properties) {
            $found = Get-ChildItem $staging -Recurse -File -Filter $entry.Name | Select-Object -First 1
            if (-not $found) { throw "$($entry.Name) is missing from $name" }
            Assert-Hash $found.FullName $entry.Value $entry.Name
            Copy-Item $found.FullName (Join-Path $bin $entry.Name) -Force
        }
        foreach ($license in $tool.licenseFiles) {
            $target = Join-Path (Join-Path $bin 'licenses') $license.name
            if ($license.archivePath) { Copy-Item (Join-Path $staging $license.archivePath) $target -Force }
            else { Get-File $license.url $target }
            Assert-Hash $target $license.sha256 $license.name
        }
    }
    # What was installed, for the app's diagnostics and the release notes.
    Copy-Item $LockFile (Join-Path $bin 'native-tools.lock.json') -Force
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Get-ChildItem $bin -File | ForEach-Object { '{0,-24} {1,8:N1} MB' -f $_.Name, ($_.Length / 1MB) }
