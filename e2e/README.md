# Grab end-to-end checks

Each check builds the app, runs it in Electron with a throwaway profile on the second monitor (if
there is one), and writes screenshots to `e2e/output/<check>/` (not in git).

| Command | What it checks |
| --- | --- |
| `npm run e2e:glass-menu` | the glass quality menu: opens, keyboard, picks, closes |
| `npm run e2e:layout` | overlapping or clipped text at the smallest and a typical window size (he/en) |
| `npm run e2e:liquid-glass` | the liquid glass drop: edge positions every frame while it moves |
| `npm run e2e:screenshots` | every screen in Hebrew at 1347×852 (settings and history copied from the real profile, read only) |

Safety: nothing here changes the PC.
- Settings and history are copied from the real profile into the throwaway one; the real profile is never written.
