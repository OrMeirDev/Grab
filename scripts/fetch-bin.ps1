# Downloads the third-party tools Grab bundles (yt-dlp, ffmpeg, ffprobe, deno) into bin/.
# They are not committed to git because each is far larger than GitHub's 100 MB file limit.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('grab-bin-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $bin, $tmp | Out-Null

function Get-File($url, $out) {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}

Get-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $bin 'yt-dlp.exe')

$ff = Join-Path $tmp 'ffmpeg.zip'
Get-File 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' $ff
Expand-Archive $ff -DestinationPath (Join-Path $tmp 'ffmpeg')
Get-ChildItem (Join-Path $tmp 'ffmpeg') -Recurse -Include 'ffmpeg.exe', 'ffprobe.exe' | Copy-Item -Destination $bin -Force

$deno = Join-Path $tmp 'deno.zip'
Get-File 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' $deno
Expand-Archive $deno -DestinationPath $bin -Force

Remove-Item -Recurse -Force $tmp
Get-ChildItem $bin | ForEach-Object { '{0,-12} {1,8:N1} MB' -f $_.Name, ($_.Length / 1MB) }
