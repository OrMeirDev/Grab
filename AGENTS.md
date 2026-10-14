# Working on Grab (people and AI assistants)

Read this before changing code. Architecture: [docs/architecture.md](docs/architecture.md).
Decisions: [docs/adr/](docs/adr/). Current state and open work: [docs/handoff.md](docs/handoff.md).

## Owner scope (binding)

- The current workflow is accepted. Keep paste-and-download, the purple styling, Hebrew RTL,
  the current screens and successful downloads. Make targeted, verified fixes; no redesign.
- **No DRM work of any kind**: no DRM player/CDM, license acquisition, protected offline playback,
  DRM export or expanded DRM detection. A DRM page is reported as "protected", nothing more.
- GRB-17 (accessibility overhaul) is cancelled. Keep existing controls and their behavior.
- Use the user's **active browser session**. Never add an in-app sign-in page, a fresh browser
  profile or a permission bypass. Never navigate, play or close a tab Grab didn't open; close only
  background tabs Grab created.

## Where things go

| Change | Place | Never |
| --- | --- | --- |
| Queue states, scheduling, retries, blocks, history records | `electron/application/download-coordinator.cjs` | in React; in IPC handlers |
| How a link is looked up (strategies) | `electron/application/discovery-service.cjs` | in the renderer |
| What counts as media, ranking | `electron/domain/candidate-policy.cjs` | copied into a probe |
| Pure rules (names, sites, records, job shape) | `electron/domain/` (no Electron/fs/process) | with side effects |
| yt-dlp, processes, files, cookies, storage | `electron/*.cjs`, `electron/infrastructure/` | in the renderer |
| A new renderer → main call | a schema in `electron/main.cjs` via `router.handle` + `electron/preload.cjs` | a raw `ipcMain.handle`, a path or cookie chosen by the page |
| Screens and components | `src/features/<feature>/`, `src/components/`, `src/design/` | business rules |
| Pure renderer helpers | `src/domain/`, `src/presentation/` | React or `window.grab` |
| Reaching the preload bridge | `src/platform/grabApi.js` only | `window.grab` anywhere else |

`tests/architecture.test.cjs` enforces the import rules. If it fails, move the code; change the
rule only together with docs/architecture.md and an ADR.

## Rules that protect users

- No cookies, cookie files, request headers, signed media URLs or lookup files in renderer
  snapshots, history, `queue.json`, logs or diagnostics (`infrastructure/diagnostics.cjs` redacts;
  `domain/secrets.cjs` keeps token-bearing pasted links out of `queue.json`). Exception, by design:
  history keeps the link the user pasted, because "download again" needs it.
- A job that needed the user's session must never send a request without it: no live handle →
  look it up again first (`needsSession` in the coordinator).
- Cookies live only in `CookieVault` behind opaque handles; an expired handle is an error that
  triggers a new lookup, never a download without the session.
- Every engine process goes through `process-runner.cjs` (deadline, bounded output, tree stop).
- Downloads write only to a name from `OutputAllocator`; success requires the file to exist.
- Bundled tools change only through `native-tools.lock.json` (exact release + SHA-256), in its own PR.
- Don't skip, disable or loosen a test to get green.

## Checks before a pull request

```bash
npm test                      # unit + integration (Chromium/yt-dlp ones skip when absent)
npm run build
xvfb-run -a npx electron --no-sandbox e2e/queue-cooldown.cjs   # Linux; on Windows: npm run e2e:queue-cooldown
xvfb-run -a npx electron --no-sandbox e2e/hidden-probe.cjs
```

Scheduling or session changes need a fake-clock test (`tests/download-coordinator.test.cjs`) and a
note of the Windows checks they need (docs/handoff.md → Windows checks). A UI change needs before/
after screenshots of every screen (`npm run e2e:screenshots`) and must not change them unless the
change is the point. Keep each PR to one responsibility; refactors, upgrades and features separate.
