# Grab architecture

A modular desktop monolith: one Electron app, a React renderer that only shows state and sends
commands, and a main process where one coordinator owns every download. Adapters wrap yt-dlp, the
two page probes, the user's browser session and storage, each behind a small interface so the
application code is testable without Electron. Decision record: [adr/0001](adr/0001-main-owned-download-coordinator.md).

```
renderer (React, sandboxed, CSP)            main process
─────────────────────────────────           ─────────────────────────────────────────────────────
features/* ── useDownloads ─┐               ipc/router (sender check + contracts)
                            │ commands ──▶  main.cjs (composition root)
                            │ ◀── snapshots     │
platform/grabApi (window.grab) ◀─ preload      ▼
                                            application/
                                              download-coordinator ─▶ discovery-service ─▶ engine (yt-dlp)
                                                     │                      │──▶ hidden-probe (Electron, clean session)
                                                     │                      └──▶ pageprobe + browser-session (CDP, user's browser)
                                                     ├──▶ download-runner ─▶ output-allocator, cookie-vault, engine
                                                     └──▶ repositories (history), json-store (queue)
                                            domain/ (pure rules)   infrastructure/ (process, files, storage, cookies, diagnostics)
```

## Modules

### Renderer (`src/`, ES modules)

| Area | Modules | Responsibility |
| --- | --- | --- |
| `app/` | `AppShell`, `routes`, `useEngine`, `useAppUpdate` | Compose screens; navigation, dialogs, notice line |
| `components/` | `Sidebar`, `AppUpdateBanner`, `SiteMark` | Shared presentation |
| `design/` | `GlassSelect`, `glassMotion` (liquid glass), `PageHeader`, `EmptyState`, `styles.css`, `theme.css` | Visual primitives and the purple theme; no Grab logic |
| `domain/` | `intake/parseLinks` | Pure: pasted text → links and labels |
| `presentation/` | `formatters`, `sitePresentation`, `updateMessages`, `errorMessages` | Pure: values → Hebrew text, brand marks |
| `platform/` | `grabApi` | The only reader of `window.grab` |
| `features/intake` | `LinkInput`, `IntakeActions`, `useLinkDraft` | Links box, site chips, "identify" |
| `features/downloads` | `DownloadsPage`, `DownloadQueue`, `QueueRow` (= `QueueThumb`, `QueueNameEditor`, `QueueMetadata`, `QueueStatus`/`QueueProgress`, `QueueActions`), `DownloadOptions`, `QueueSummary`, `BatchActions`, `SiteCooldownBanner`, `QueueNotice`, `useDownloads`, `useQueueReorder`, `rowState` | Show coordinator snapshots, emit commands |
| `features/history`, `library`, `settings`, `sites`, `browser` | pages, rows, dialogs, small hooks | Their screens |

### Browser extension integration

ADR: [0002](adr/0002-browser-extension-coordinator.md). The MV3 worker observes media in a chosen
existing browser profile. Native Messaging reaches BrowserHub through an authenticated per-user
pipe. BrowserService receives/discovers sources and provides private context to discovery-service;
Send to GRAB enters DownloadCoordinator directly. The renderer receives only snapshots and emits
validated job-id commands, including cancel, reveal and choose. Private runtime copies keep active
native hosts independent of app replacement during Windows updates.

### Main process (`electron/`, CommonJS)

| Layer | Module | Contract |
| --- | --- | --- |
| composition | `main.cjs` | Builds services, guarded IPC channels, window, lifecycle (quit waits for process trees) |
| ipc | `ipc/router.cjs`, `ipc/contracts.cjs` | Trusted frame + validated arguments → handler |
| security | `security/window-policy.cjs` | No navigation/new windows/webviews; clipboard-only permissions |
| application | `download-coordinator.cjs` | Commands → job state; snapshots; schedules; history completion; durable queue |
| application | `discovery-service.cjs` | Link → lookup result (ordinary: yt-dlp → clean public probe; explicit browser mode: selected session first), candidate and time budgets |
| application | `download-runner.cjs` | Plan → one attempt (allocated name, cookie jar, engine run) |
| domain | `job.cjs`, `site-policy.cjs`, `candidate-policy.cjs`, `output-names.cjs`, `records.cjs`, `engine-errors.cjs` | Pure rules |
| infrastructure | `process-runner.cjs`, `process-registry.cjs` | Deadlines, bounded output, tree stop, tracking |
| infrastructure | `output-allocator.cjs`, `json-store.cjs`, `repositories.cjs`, `library-indexer.cjs` | Files and storage |
| infrastructure | `cookie-vault.cjs`, `diagnostics.cjs` | Session material lifetime; redacted support log |
| adapters | `engine.cjs` (yt-dlp), `hidden-probe.cjs`, `pageprobe.cjs`, `browser-session.cjs`, `media-collector.cjs` | The outside world |

## Dependency rules (enforced by `tests/architecture.test.cjs`)

1. The renderer imports no Node built-ins and not `electron`; only `platform/grabApi.js` touches `window.grab`.
2. Renderer layers import downward: `domain`, `presentation`, `platform`, `design` import no other area;
   `components` → design/presentation; features → components/design/domain/presentation/platform
   (cross-feature only `downloads → intake`, for page composition); nothing imports `AppShell`.
3. `electron/domain/*` and `ipc/contracts.cjs` are pure (no Electron, fs, processes, network).
4. `electron/application/*` requires no Electron and no Node built-ins; it gets the platform injected.
5. Only `main.cjs`, `preload.cjs` and `hidden-probe.cjs` require `electron`.

## Job lifecycle

`waiting → analyzing → ready → queued → downloading → done`, plus `paused` (user, or interrupted by
quitting) and `error` (retry offered). These are the names the UI already used; the brief's
`discovering`/`cooling-down`/`interrupted` map to `analyzing`, the coordinator's rest/blocked state,
and `paused` after a restart. Only the coordinator changes states.

- Lookups: one at a time, 2–4 s apart. Downloads: one at a time; YouTube rests 5–10 s after each
  download and the rest's end starts the next (GRB-01).
- A site hold holds only that site's jobs until "resume <site>". Two answers cause it: a rate limit
  (HTTP 429, kind `rateLimited`) ends the lookup or download at once, wherever it comes from (the
  link, the retry with the browser session, a source found in a page), with no browser and no
  further request; a bot check ("confirm you're not a bot", kind `blocked`) holds ordinary jobs without opening a
  browser. In explicit browser mode it holds the site if the site still asks with that session.
- One automatic retry per job: a page video is looked up inside the page again (fresh signed links);
  anything else is fetched again with fresh info. An expired session handle is not that retry:
  it always triggers a new page lookup, never a download without the session.
- Pause/stop ends the whole yt-dlp/ffmpeg tree; the next attempt waits until it has exited.
- A process exit of 0 counts only when the output file exists.
- Quitting keeps running/queued jobs as `paused` in `queue.json` (no cookies, headers, media
  addresses, lookup files or thumbnails; a pasted link carrying a token/signature/credentials is
  not saved at all); nothing starts by itself after a restart.
- A job whose lookup used cookies keeps only `needsSession` and `sessionSource` (`browser` for the
  user's account session, `probe` for the hidden probe's public-page cookies) on disk.
  `requiresBrowserSession(job)` (domain/job.cjs) is true for `needsSession` unless the source is
  `probe`; missing provenance counts as the browser. Without a live cookie handle (after a
  restart, an expiry, or a browser disconnect, which drops account cookies; checked with
  `hasSession` before any network work) the job is looked up again. For a job that requires the
  browser session, that lookup (`discover(..., { requireSession })`) skips the cookieless yt-dlp
  call and the clean hidden probe, acquires the session from the user's browser first, and tries
  the site's own extractor with it before the page's player (unless the video came from the
  player). If the browser can't be reached it ends with `sessionRequired` without contacting the
  site. So no lookup or download request for such a job is sent without the session.

## IPC

Renderer → main: `downloads:*` commands with job ids (snapshot, add, rename, start, startAll, pause,
resume, retry, remove, move, resumeSite, show), settings (folder only from the folder dialog),
history read/clear, library list, open/reveal of approved files, engine/app version and updates,
browser default/check/setup/state and validated browser preferences; per-job browser/profile selection. Main → renderer: `downloads:changed` (numbered snapshots), `update:status`.
