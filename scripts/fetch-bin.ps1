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

function Assert-Hash($file, $expected, $what) {
    $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
    if ($actual -ne $expected.ToLowerInvariant()) {
        throw "SHA-256 mismatch for ${what}: expected $expected, got $actual. Nothing was installed from it."
    }
}

try {
    foreach ($tool in $lock.tools) {
        $name = Split-Path $tool.url -Leaf
        $download = Join-Path $tmp $name
        Get-File $tool.url $download
        Assert-Hash $download $tool.sha256 $name

        $staging = Join-Path $tmp $tool.name
        New-Item -ItemType Directory -Force $staging | Out-Null
        if ($name -like '*.zip') { Expand-Archive $download -DestinationPath $staging } else { Copy-Item $download $staging }

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
