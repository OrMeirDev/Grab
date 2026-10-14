# Grab refactor handoff (2026-10-14)

Branch `claude/modest-pasteur-6315xe`, from `main` at `b1e1de8` (the audited `5813a6e` plus the e2e
scripts). Not merged, no PR, no release. CI is green on Linux and Windows (run 7, commit `275dad1`).

## 1. Findings: status and evidence

Revalidated against `b1e1de8` before any change: all 17 active findings were still present. GRB-01
was reproduced in the real Electron app (`e2e/queue-cooldown.cjs` failed: second row stuck in
`queued`). GRB-17 is cancelled; no DRM work was done.

| ID | Status | What changed | Evidence |
| --- | --- | --- | --- |
| GRB-01 | **Fixed** | Minimal React fix first (`a9ba674`), then the rest's end is a coordinator event | e2e failed before / passes after; fake-clock tests (job 2 starts exactly once at 5 000 ms, mixed/blocked/pause cases) |
| GRB-02 | **Fixed** | `DownloadCoordinator` in main owns states, schedules, retries, history; durable `queue.json` (no cookies, headers, media addresses, lookup files or thumbnails; a pasted link that itself carries a token/signature/credentials is not saved; links in error text are cut to scheme://host/path) | e2e: window reload during the rest, 2 starts / 2 done; restore tests; snapshot privacy test |
| GRB-03 | **Fixed** | Router: trusted frame + contracts on every channel; no renderer-chosen info file, cookie handle, folder or path; `--ignore-config`, `--` | router/contract tests; real yt-dlp test |
| GRB-04 | **Fixed** | Build-time CSP, sandbox, no navigation/popups/webviews, clipboard-only permissions | in-app check: CSP present, 0 violations, navigation and `window.open` blocked, paste works |
| GRB-05 | **Fixed (Linux evidence)** | Electron 44.7.2, electron-builder 26.15.3, Vite 8.3.4; audit 20 → 8 moderate (build-time only) | pixel/computed-style comparison; all e2e on Electron 44; Windows unpacked build |
| GRB-06 | **Fixed** | `native-tools.lock.json` (exact releases, SHA-256 checked against upstream sums), hash-checked `fetch-bin.ps1`, `verify-bin` before packaging, no PATH/WinGet in the installed app | lock and verify tests; real pinned yt-dlp test in CI |
| GRB-07 | **Fixed, Windows ACL pending** | `CookieVault`: 4 h TTL, release per job, account cookies dropped when the browser connection is lost (a running yt-dlp keeps its jar until it ends), a job whose lookup used a session is looked up again after a restart **before any request**, expired handle → new lookup, jar/info scavenging at start, 0600/0700 on POSIX | vault tests; `tests/session-restart.test.cjs` (4 restart cases, disconnect, queue.json); real-yt-dlp restart test: every request after the restart carries the session (it failed on the previous commit: the first request, to the page, had no cookie) |
| GRB-08 | **Fixed** | `process-runner`: per-kind deadlines, idle limit, bounded output, cancel; lookup time and candidate budgets | stalled/giant/missing/cancel tests with real processes |
| GRB-09 | **Fixed on POSIX, Windows pending** | Tree stop (taskkill /T, process groups), registry, engine never replaced while busy, quit/update wait for exit, one attempt per job | grandchild-killed test; no-overlap fake-clock test |
| GRB-10 | **Partly** | CI on PRs and pushes (Linux + Windows tests, build, e2e) | green runs. Branch protection, signing, release pipeline: owner actions (§4) |
| GRB-11 | **Partly** | Delivered height/codecs recorded in history; README states the quality setting is a preference | real yt-dlp test parses the record. Hard cap: owner decision (§5) |
| GRB-12 | **Fixed** | Shared `CandidatePolicy`; hidden probe keeps request context and page cookies; budget 12 instead of 4; player-element sources ranked/kept | fifth-candidate test; `e2e/hidden-probe.cjs` (fixture refuses without cookie+Referer); real-Chromium test |
| GRB-13 | **Partly** | Connection keyed by endpoint (profile + instance), README lists unverified browsers | per-endpoint test; real-Chromium CDP test (Linux). Endpoint/profile chooser not built (§5) |
| GRB-14 | **Fixed** | Exact host keys + aliases; in-paste dedup; signed queries kept; "download all" keeps other sites' blocks | site-key and intake tests |
| GRB-15 | **Fixed, Windows pending** | `OutputAllocator`: device names, path length, unique per job and folder, kept for resume, `%` escaped | allocator tests; real yt-dlp writes `100% Lesson.mp4` |
| GRB-16 | **Fixed** | Atomic JSON with `.bak`, serialized writes, async bounded library listing | store/repository/library tests |
| GRB-18 | **Partly** | Redacted diagnostics log, AGENTS.md, SECURITY.md, ADR, architecture doc, exact-version notices, license texts bundled | redaction test. GPL source-offer review: owner (§4) |

## 2. Module map (what changed)

Full map and rules: [architecture.md](architecture.md). In short:

- Renderer: `src/App.jsx` and `src/pages.jsx` are gone, split into `app/`, `components/`, `design/`,
  `domain/`, `presentation/`, `platform/` and `features/{intake,downloads,history,library,settings,sites,browser}`.
  `QueueRow` is composed of `QueueThumb`, `QueueNameEditor`, `QueueMetadata`, `QueueStatus`/`QueueProgress`, `QueueActions`.
- Main: new `application/` (coordinator, discovery, download runner), `domain/` (job, site, candidate,
  output-name, record, engine-error rules), `infrastructure/` (process runner/registry, output allocator,
  JSON store, repositories, library indexer, cookie vault, diagnostics), `ipc/`, `security/`.
  `engine.cjs`, `hidden-probe.cjs`, `pageprobe.cjs`, `browser-session.cjs` stay as adapters.
- Tests: 11 files, 89 tests (unit, fake-clock, architecture, real Chromium, real yt-dlp). e2e: `queue-cooldown`, `hidden-probe` (new), `layout` (now seeds through the coordinator).

## 3. Visible behavior changes (everything else is unchanged)

1. The queue comes back after a restart; running/queued downloads come back **paused**.
2. "Download all" no longer lifts a blocked site; the banner's "resume <site>" does (GRB-14).
3. A link pasted twice in one batch becomes one row.
4. Electron 44 renders glyph edges slightly differently (≈0.5% of pixels; no layout/colour change).
   Everything else: pixel-identical screenshots before/after each batch.
5. A download that needed your browser session is looked up again when you resume it after a
   restart (the browser may ask for its connection permission again). Same after the browser
   connection is lost: its cookies are dropped, and the next download of such a job looks it up again.
6. A pasted link that itself carries a token, signature or credentials is not saved in the queue,
   so it is not there after a restart; restored rows have no thumbnail until looked up again.
   History still keeps the pasted link (it is what "download again" uses).

## 4. Windows checks still pending, and owner actions

Not run anywhere yet (this environment is Linux; CI runs unit tests on Windows only):

- [ ] `npm run fetch-bin` on Windows: hashes match, `bin/licenses/` filled, `npm run verify-bin` passes.
- [ ] `npm run dist`: the NSIS installer installs and starts; then update an installed **1.6.7** to the new build (settings and history kept; queue starts empty).
- [ ] A real YouTube download and a real page lookup through the hidden probe.
- [ ] Signed-in lookup with real Chrome, Edge and Brave profiles: consent prompt, exact-tab reuse (no reload), background tab closed, browser restart, two contexts.
- [ ] Pause during a download and during the FFmpeg merge: no `ffmpeg.exe`/`yt-dlp.exe` left in Task Manager; resume continues the `.part`.
- [ ] Quit during a download and "install update" during a download: processes gone, queue saved as paused.
- [ ] Cookie jar folder permissions in `%TEMP%` (owner-only ACL), and none left after a forced kill + restart.
- [ ] A members-only/course download: look it up, quit Grab, start it again, press download: the browser connection is asked for again, then the download works (no failed first attempt). Close the browser between lookup and download: same.
- [ ] Output names: `CON`, very long Hebrew titles, a deep download folder, two jobs with the same title.

Owner actions (not authorized for this session):

- Protect `main` and require the CI checks (GitHub → Settings → Branches/Rulesets).
- Code-signing certificate for the installer and updates; then a release workflow that builds the
  tested commit, signs, attaches checksums and the native-tool versions.
- Decide how to meet the GPL source obligation for the bundled FFmpeg build (the notices now name
  the exact source revision and build tag; a written offer or hosted source may still be needed —
  this is not legal advice).

## 5. Owner decisions

| Question | Current behavior | Options |
| --- | --- | --- |
| Quality: preference or hard maximum? (GRB-11) | **Decided: stays a preference** (closest at or below, else above) | — |
| Restored downloads after restart | **Decided: paused**, the user resumes | — |
| Cookie snapshots when the browser connection drops mid-session | **Done: dropped** (the audit's requirement); the job is looked up again | — |
| Endpoint/profile chooser for custom user-data folders (GRB-13) | **Decided: deferred** (new UI) | — |
| Mark unverified browsers in the guide's text | README only | Open: add a line in the guide? |
| Pasted links with a token in history.json | Kept (needed for "download again") | Open: drop such entries' links? |

## 6. Commands and results (this session, Linux)

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` / `npm test` | 89 tests: 86 pass, 3 skipped (the Windows-only browser test; the two real-yt-dlp tests without `GRAB_TEST_YTDLP_DIR`). With the pinned yt-dlp: 88 pass. In CI the yt-dlp test runs on Linux and the Windows test on Windows |
| `npm run build` | pass (Vite 8.3.4) |
| `xvfb-run electron e2e/queue-cooldown.cjs` | PASS (2 starts, reload during rest) |
| `xvfb-run electron e2e/hidden-probe.cjs` | PASS |
| `xvfb-run electron e2e/layout.cjs` | all sizes ok |
| `npm audit` | 8 moderate (one build-time chain, not shipped); was 20 (1 critical, 14 high, 5 moderate) |
| `electron-builder --win dir` | packages `win-unpacked` with the expected asar/resources (signing skipped) |
| CI run 7 | test (ubuntu), test (windows), e2e: success |

## 7. Backlog

| Item | Status | Blocked by | Blocks | Lane / size |
| --- | --- | --- | --- | --- |
| Windows verification list (§4) | Ready | A Windows machine | Release | QA / M |
| Branch protection + required checks | Ready | Owner admin | Merge policy | Release / S |
| Code signing + release workflow with checksums/provenance | Planned | Certificate, secrets | Production release | Release / M |
| GPL source-offer decision for FFmpeg | Ready | Owner/legal | Release | Release / S |
| Windows process-tree supervision via Job Objects (beyond taskkill /T) | Planned | Windows pause/quit check results | — | Platform / M |
| Endpoint/profile chooser (GRB-13) | Deferred by owner | — | Custom-profile users | Browser + frontend / M |
| Notice in the guide for unverified browsers | Proposed | Owner decision | — | Frontend / S |
| Pin GitHub Actions to commit SHAs | Ready | — | Supply-chain hardening | Release / S |
| Merge this branch | Ready | Owner review | Everything above | — |

Out of scope by owner decision: GRB-17 (accessibility overhaul) and any DRM work.
