# Grab end-to-end checks

Each check builds the app, runs it in Electron with a throwaway profile on the second monitor (if
there is one), and writes screenshots to `e2e/output/<check>/` (not in git).

| Command | What it checks |
| --- | --- |
| `npm run e2e:media-context` | generated HLS behind a blob player: actual Electron request headers → analyze/start IPC → yt-dlp download → ffprobe video/audio verification |
| `npm run e2e:glass-menu` | the glass quality menu: opens, keyboard, picks, closes |
| `npm run e2e:hidden-probe` | GRB-12: the hidden player probe against a local fixture site: player request context (Referer/Origin), page cookies in the jar, ranking (no internet needed) |
| `npm run e2e:layout` | overlapping or clipped text at the smallest and a typical window size (he/en) |
| `npm run e2e:liquid-glass` | the liquid glass drop: edge positions every frame while it moves |
| `npm run e2e:queue-cooldown` | GRB-01/02: after a YouTube download's 5–10 s rest the next one starts by itself, and reloading the window meanwhile neither loses nor repeats a job (yt-dlp replaced by an instant fake, nothing downloaded) |
| `npm run e2e:screenshots` | every screen in Hebrew at 1347×852 (settings and history copied from the real profile, read only) |

Full-app fixtures call `test-support/electron-profile.cjs` before importing the engine or main.
It isolates Electron's data/session/download/log/temp paths, APPDATA/LOCALAPPDATA and temporary
environment variables, and uses an in-memory native-host registry. Isolating only `userData`
is insufficient: native-host repair uses LOCALAPPDATA, and startup scavenging uses the temp root.
The isolation regression exercises real setup/uninstall and cache scavenging against synthetic
pre-existing-installation canaries; every full-app launcher must use the shared helper.

Screenshots explicitly copy settings/history from the source profile into the fixture; those
source files are not written. Review screenshots before sharing because copied content may be
personal. Generated evidence and temporary fixture data remain local.

If an older full-app fixture redirected the installed native host to development Electron,
stop the development app and launch the installed Grab normally; its startup repair restores
the host from its own resources. Settings → Browser → Repair is the explicit repair path.
Check the resulting runtime/manifest paths before resuming personal-browser testing. This
repair is a separate local action; the isolated fixtures do not repair the personal installation.

The media-context check uses generated media and a loopback server only; it does not read the
real profile, contact Mako, or use signed-in accounts. Put `yt-dlp`, `ffmpeg`, and `ffprobe` on
PATH (or install the development tools first). It has no screenshots and needs no Vite build.
`npm run test:media` exercises the same header-bound HLS fixture through the real application
IPC handlers and downloader without Electron. This command fails if media tools are missing;
the normal `npm test` suite explicitly skips that integration check when they are unavailable.

On a Linux test container without a display, run the Electron check with Xvfb. Electron's
`--no-sandbox` launch switch may be needed when the container only permits running as root;
this is a test-launch setting, not an application code change. Live Windows/default-browser
and Mako verification remain separate from these local fixture checks.
