# Grab

Stable version: **1.7.1**. [Download the Windows installer](https://github.com/OrMeirDev/Grab/releases/download/v1.7.1/Grab-Setup-1.7.1.exe). [Installation in Hebrew](docs/INSTALL-WINDOWS-HE.md). [Release notes](docs/releases/1.7.1.md).

Windows app for downloading videos and audio from YouTube and ~1,300 other sites, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp). Hebrew, right-to-left interface.

## Install

Download [Grab-Setup-1.7.1.exe](https://github.com/OrMeirDev/Grab/releases/download/v1.7.1/Grab-Setup-1.7.1.exe) from [Releases](https://github.com/OrMeirDev/Grab/releases/latest) and install over your existing copy. Settings and history are retained. The release includes updater metadata, checksums and the [Hebrew guide](docs/INSTALL-WINDOWS-HE.md). Ordinary stable updates are also available inside Grab.

The installer is not code-signed, so Windows SmartScreen warns on first run: click **More info → Run anyway**.

## Features

- Paste many links at once; text before a link (e.g. `שיעור 2: https://…`) becomes the file name
- Looks up title, length and thumbnail, then downloads one at a time with live progress
- MP4 or MP3, per-row or "download all". MP4 prefers H.264/AAC (plays on almost every device); when a site offers no such format, the best available codec is saved in an MP4 file. The quality setting is a preference: Grab picks the closest available, and if nothing at or below it exists, a higher one. History records the resolution and codec actually delivered
- Pauses a site's downloads the moment it starts rate-limiting (other sites carry on), until you resume it
- The queue survives a window reload and a restart (running downloads come back paused)
- History, library of downloaded files, searchable list of supported sites
- One-click update of the yt-dlp engine
- Finds embedded Mux and other players inside open Shadow DOM and frames, with network manifest discovery
- Detects installed Chrome, Edge and Brave; supports a saved default, site rules and connected-profile settings
- A locally loaded browser extension uses the active signed-in session and can send a page directly to Grab

## Pages that use your browser session

Grab 1.7.1 uses a locally loaded extension in **Chrome, Edge or Brave**. It uses the selected active browser/profile and does not open an in-app sign-in page or require remote debugging for extension use.

1. In Grab, open **הגדרות → דפדפן והרחבה**, then click **התקנה** next to the intended browser.
2. In that browser's extensions page, enable **Developer mode**, choose **Load unpacked**, and select the stable extension folder shown by Grab. Repeat in each intended profile.
3. Return to Grab, test the connection, and choose the browser/profile and general default. New settings include `mako.co.il → Edge`. Sending from the extension uses that browser/profile; ordinary pasted links do not use the default.
4. Send an account/embedded page through the extension; it joins the queue and downloads automatically. Paste ordinary public links directly into Grab without browser setup or a route selector. Existing tabs are scanned without reloading, starting playback or closing them. Grab closes only tabs it opened for the job.

See [extension setup and troubleshooting](docs/browser-extension.md) for connection, profile choice, repair and playback-required steps. The older remote-debugging path remains available for browsers that have never been set up with the extension; it is not needed for the setup above. Firefox is unsupported. Automated tests use throwaway profiles; personal Chrome/Edge/Brave sessions still need the [manual checks](docs/windows-manual-checklist.md).

Lookup reads player attributes (including signed Mux manifest URLs), open Shadow DOM, frame execution contexts and media network requests. Session cookies stay behind private handles; the engine receives the necessary session and playback context without placing cookie values in command-line arguments or renderer state. The mandatory yt-dlp plugin enforces host-only, domain, path and Secure cookie scope, including redirects and HLS fragments. A failed download of an embedded source is looked up again to refresh expiring URLs in the same session.

Cookies from the page are kept in memory for at most 4 hours behind a job's private session handle. Disconnecting an extension profile drops its handles. A restored download reacquires the selected session before network work; Grab reports a missing browser/profile explicitly. When several extension profiles are connected, choose the intended one instead of letting Grab guess.

## Develop

```bash
npm install
npm run fetch-bin   # yt-dlp, ffmpeg and deno into bin/, exactly as pinned in native-tools.lock.json (hash-checked)
npm run dev         # app with hot reload
npm test            # unit + integration tests (the real-Chromium/real-yt-dlp ones skip when absent)
npm run e2e:queue-cooldown   # end-to-end checks in the real app; see e2e/README.md
npm run verify-bin  # bin/ matches native-tools.lock.json (also runs before dist/release)
npm run dist        # build the installer into release/
npm run release     # CI-only verified publication; see docs/releasing.md
```

Architecture and contributor rules: [docs/architecture.md](docs/architecture.md), [AGENTS.md](AGENTS.md).
CI (`.github/workflows/ci.yml`) runs the tests on Linux and Windows and the end-to-end checks.
[Browser integration](.github/workflows/browser-integration.yml) checks the real extension/Brave and prepares the tested installer bundle. [Windows verify](.github/workflows/windows-verify.yml) installs over 1.6.7 and checks pause/merge/quit, session cleanup, queue and in-app update. After all main checks succeed, [Release](.github/workflows/release.yml) publishes that exact installer and its update metadata. See [releasing](docs/releasing.md) for the version/tag process.

Current project state: [handoff](docs/handoff.md). Historical audits and RC installation guides: [archive](docs/archive/).

## Not supported

DRM-protected streams and players without a downloadable HTTP media source (for example, some WebRTC players). Signed URLs can work when the active browser session has access; expired URLs must be refreshed. Grab does not bypass DRM or access controls. Closed Shadow DOM cannot be traversed by the page collector; network discovery can still find exposed HTTP media requests.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled FFmpeg (GPL), yt-dlp and Deno.
