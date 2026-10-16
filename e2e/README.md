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

Safety: nothing here changes the PC.
- Settings and history are copied from the real profile into the throwaway one; the real profile is never written.

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
