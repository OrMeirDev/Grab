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
- Finds embedded Mux and other players inside open Shadow DOM and frames, with network manifest discovery

## Pages that use your browser session

For Mako (`mako.co.il` and its subdomains), Grab looks up the page's player directly in your running Edge profile. Other sites use your Windows default browser when yt-dlp cannot read a page or needs authentication. It does not open a sign-in window or create a separate profile.

1. Open the browser named in the link's connection guide and enable **Allow remote debugging** at its displayed address: `edge://inspect/#remote-debugging` for Mako, or the default browser's equivalent for other sites.
2. Leave that browser running in the profile where you can play the video. Accept its connection permission when Grab connects.
3. Paste the page URL in Grab as usual. An exact open tab is scanned without navigation or playback changes; otherwise Grab opens a background tab in the existing context and closes that tab when lookup finishes.

Lookup reads player attributes (including signed Mux manifest URLs), open Shadow DOM, frame execution contexts and media network requests. Cookies for the page and discovered URLs are passed to yt-dlp in a temporary domain-scoped cookie jar, together with the player request's User-Agent, Referer and Origin. The jar is deleted after lookup/download. A failed download of an embedded source is looked up again to refresh expiring URLs.

On Windows the connection discovers the standard profile directory for Edge, Chrome, Brave, Vivaldi, Opera and Chromium. Firefox is reported as unsupported. Custom user-data directories need an additional endpoint selection option. If the requested page exists in multiple browser contexts, Grab asks you to leave it open in the intended context.

## Develop

```bash
npm install
npm run fetch-bin   # downloads yt-dlp, ffmpeg and deno into bin/ (not in git: too large)
npm run dev         # app with hot reload
npm test            # session, collector and download-context regression tests
npm run dist        # build the installer into release/
npm run release     # build and publish a GitHub release (needs GH_TOKEN)
```

To publish an update: bump `version` in `package.json`, then run `npm run release`.

## Not supported

DRM-protected streams and players without a downloadable HTTP media source (for example, some WebRTC players). Signed URLs can work when the active browser session has access; expired URLs must be refreshed. Grab does not bypass DRM or access controls. Closed Shadow DOM cannot be traversed by the page collector; network discovery can still find exposed HTTP media requests.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled FFmpeg (GPL), yt-dlp and Deno.
