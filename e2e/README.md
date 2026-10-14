# Grab end-to-end checks

Each check builds the app, runs it in Electron with a throwaway profile on the second monitor (if
there is one), and writes screenshots to `e2e/output/<check>/` (not in git).

| Command | What it checks |
| --- | --- |
| `npm run e2e:glass-menu` | the glass quality menu: opens, keyboard, picks, closes |
| `npm run e2e:hidden-probe` | GRB-12: the hidden player probe against a local fixture site: player request context (Referer/Origin), page cookies in the jar, ranking (no internet needed) |
| `npm run e2e:layout` | overlapping or clipped text at the smallest and a typical window size (he/en) |
| `npm run e2e:liquid-glass` | the liquid glass drop: edge positions every frame while it moves |
| `npm run e2e:queue-cooldown` | GRB-01/02: after a YouTube download's 5–10 s rest the next one starts by itself, and reloading the window meanwhile neither loses nor repeats a job (yt-dlp replaced by an instant fake, nothing downloaded) |
| `npm run e2e:screenshots` | every screen in Hebrew at 1347×852 (settings and history copied from the real profile, read only) |

Safety: nothing here changes the PC.
- Settings and history are copied from the real profile into the throwaway one; the real profile is never written.
