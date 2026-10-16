# Grab

Unified candidate: **1.7.0-rc.1**, including the browser extension and the audit fixes. [Install and test on your Windows PC (Hebrew)](docs/INSTALL-1.7.0-rc.1-HE.md). [Extension setup and troubleshooting](docs/browser-extension.md).

Windows app for downloading videos and audio from YouTube and ~1,300 other sites, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp). Hebrew, right-to-left interface.

## Install

For **1.7.0-rc.1**, use the installer artifact from the successful [Browser integration workflow](https://github.com/OrMeirDev/Grab/actions/workflows/browser-integration.yml) on `feature/browser-extension-integration`, following the [Hebrew installation instructions](docs/INSTALL-1.7.0-rc.1-HE.md). The latest published release does not include this candidate. Its matching [Windows verify workflow](https://github.com/OrMeirDev/Grab/actions/workflows/windows-verify.yml) must also pass.

Published versions remain available under [Releases](https://github.com/OrMeirDev/Grab/releases). Installed copies update themselves when a new version is published to their update channel; this candidate is installed manually.

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
- Detects installed Chrome, Edge and Brave; supports a saved default, site rules and per-download browser/profile selection
- A locally loaded browser extension uses the active signed-in session and can send a page directly to Grab

## Pages that use your browser session

The 1.7.0 candidate uses a locally loaded extension in **Chrome, Edge or Brave**. It uses the selected active browser/profile and does not open an in-app sign-in page or require remote debugging for extension use.

1. In Grab, open **הגדרות → דפדפן והרחבה**, then click **התקנה** next to the intended browser.
2. In that browser's extensions page, enable **Developer mode**, choose **Load unpacked**, and select the stable extension folder shown by Grab. Repeat in each intended profile.
3. Return to Grab, test the connection, and choose the browser/profile and general default. New settings include `mako.co.il → Edge`; other sites follow the saved default. An explicit per-download choice takes precedence over a site rule.
4. Paste the original page URL in Grab, or send it through the extension. Existing tabs are scanned without reloading, starting playback or closing them. Grab closes only tabs it opened for the job.

See [extension setup and troubleshooting](docs/browser-extension.md) for connection, profile choice, repair and playback-required steps. The older remote-debugging path remains available for browsers that have never been set up with the extension; it is not needed for the setup above. Firefox is unsupported. Automated tests use throwaway profiles; personal Chrome/Edge/Brave sessions still need the [manual checks](docs/INSTALL-1.7.0-rc.1-HE.md).

Lookup reads player attributes (including signed Mux manifest URLs), open Shadow DOM, frame execution contexts and media network requests. Cookies for the page and discovered URLs are passed to yt-dlp in a temporary domain-scoped cookie jar, together with the player request's User-Agent, Referer and Origin. The jar is deleted after lookup/download. A failed download of an embedded source is looked up again to refresh expiring URLs.

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
npm run release     # build and publish a GitHub release (needs GH_TOKEN)
```

Architecture and contributor rules: [docs/architecture.md](docs/architecture.md), [AGENTS.md](AGENTS.md).
CI (`.github/workflows/ci.yml`) runs the tests on Linux and Windows and the end-to-end checks.
`.github/workflows/windows-verify.yml` (code pushes to `claude/**` and `feature/browser-extension-integration`, or by hand) builds two test installers
on Windows, upgrades the released 1.6.7 with it and drives the installed app
(`scripts/windows/`); the installer is a workflow artifact, never a release.

To publish an update: bump `version` in `package.json`, then run `npm run release` (see docs/handoff.md for the release checks still to automate).

## Not supported

DRM-protected streams and players without a downloadable HTTP media source (for example, some WebRTC players). Signed URLs can work when the active browser session has access; expired URLs must be refreshed. Grab does not bypass DRM or access controls. Closed Shadow DOM cannot be traversed by the page collector; network discovery can still find exposed HTTP media requests.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bundled FFmpeg (GPL), yt-dlp and Deno.
