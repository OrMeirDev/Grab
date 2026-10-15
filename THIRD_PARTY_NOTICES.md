# Third-party software bundled with Grab

Grab's installer includes the following programs, unmodified, in `resources/bin`, at the exact
versions recorded in `resources/native-tools.lock.json` (and `native-tools.lock.json` in the
source). Each is distributed under its own license; the license texts are in
`resources/bin/licenses/`. Grab runs them as separate programs.

## FFmpeg (ffmpeg.exe, ffprobe.exe)
- Version: N-127511-g01cf1a5396 (FFmpeg commit 01cf1a5396), Windows 64-bit "gpl" build from
  yt-dlp/FFmpeg-Builds release `autobuild-2026-10-13-20-20`.
- License: GNU General Public License v3 or later (this build enables GPL components). License
  text: `bin/licenses/ffmpeg-LICENSE.txt` (from the build archive).
- Corresponding source: FFmpeg at commit 01cf1a5396 (https://github.com/FFmpeg/FFmpeg), built with
  the scripts and component versions of https://github.com/yt-dlp/FFmpeg-Builds at tag
  `autobuild-2026-10-13-20-20`.

## yt-dlp (yt-dlp.exe)
- Version: 2026.08.19. License: The Unlicense (public domain); text: `bin/licenses/yt-dlp-LICENSE.txt`.
- Source: https://github.com/yt-dlp/yt-dlp/tree/2026.08.19
- The in-app "update engine" button replaces this copy with a newer official yt-dlp release in
  the user's data folder.

## Deno (deno.exe)
- Version: 2.9.7. License: MIT; text: `bin/licenses/deno-LICENSE.txt`.
- Source: https://github.com/denoland/deno/tree/v2.9.7

## Simple Icons (site logos)
- License: CC0 1.0 for the icon data. Project: https://github.com/simple-icons/simple-icons
- The YouTube, Vimeo, Instagram and TikTok logos are trademarks of their owners, shown only
  to indicate which sites Grab can download from.

## Electron, React, Vite, lucide-react, electron-updater, ws
- Licenses: MIT (lucide-react: ISC). Electron includes Chromium; its notices are in
  `LICENSES.chromium.html` next to Grab.exe.
- Included through the npm packages listed in package.json.
