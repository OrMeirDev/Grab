# Grab

Windows app for downloading videos and audio from YouTube and ~1,300 other sites, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp). Hebrew, right-to-left interface.

## Install

Download `Grab-Setup-x.y.z.exe` from the [latest release](https://github.com/OrMeirDev/Grab/releases/latest) and run it. Installed copies update themselves: when a new release is published, Grab shows an "update available" bar.

The installer is not code-signed, so Windows SmartScreen warns on first run: click **More info → Run anyway**.

## Features

- Paste many links at once; text before a link (e.g. `שיעור 2: https://…`) becomes the file name
- Looks up title, length and thumbnail, then downloads one at a time with live progress
- MP4 (H.264, plays everywhere) or MP3, quality cap, per-row or "download all"
- Pauses the whole queue the moment YouTube starts rate-limiting, instead of making it worse
- History, library of downloaded files, searchable list of supported sites
- One-click update of the yt-dlp engine

## Develop

```bash
npm install
npm run fetch-bin   # downloads yt-dlp, ffmpeg and deno into bin/ (not in git: too large)
npm run dev         # app with hot reload
npm run dist        # build the installer into release/
npm run release     # build and publish a GitHub release (needs GH_TOKEN)
```

To publish an update: bump `version` in `package.json`, then run `npm run release`.

## Not supported

Sites that protect video with DRM or signed/expiring tokens (Netflix, paid course platforms on bunny.net, etc.). Grab does not bypass such protection.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled FFmpeg (GPL), yt-dlp and Deno.
