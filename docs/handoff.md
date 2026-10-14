# Grab refactor handoff (2026-10-14)

Branch `claude/modest-pasteur-6315xe`, from `main` at `b1e1de8` (the audited `5813a6e` plus the e2e
scripts). Not merged, no PR, no release. Windows verification (§4): run 10 of `windows-verify.yml` on
`ee8f20b` is green (run 8 on `1c9d699` too): tests, fetch-bin/verify-bin, NSIS test installer, 1.6.7 upgrade, 19/19
installed-app checks. Real signed-in browser profiles, Brave, update-while-active and pause during
the FFmpeg merge are still **Pending** (§4.4), so Windows verification is not complete.

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
| GRB-05 | **Fixed** | Electron 44.7.2, electron-builder 26.15.3, Vite 8.3.4; audit 20 → 8 moderate (build-time only) | pixel/computed-style comparison; all e2e on Electron 44; NSIS installer built, installed over 1.6.7 and driven on Windows (§4.2) |
| GRB-06 | **Fixed** | `native-tools.lock.json` (exact releases, SHA-256 checked against upstream sums), hash-checked `fetch-bin.ps1` (now hashes/unzips through .NET: it failed from a PowerShell 7 window), `verify-bin` before packaging, no PATH/WinGet in the installed app | lock and verify tests; `tests/fetch-bin.windows.test.cjs` (failed on `561d6e7`, passes on `83a7c6b`); installed `resources/bin` verified against the lock on Windows (W-01f) |
| GRB-07 | **Fixed (real-profile checks pending)** | `CookieVault`: 4 h TTL, release per job, account cookies dropped when the browser connection is lost (a running yt-dlp keeps its jar until it ends), a job known to need the user's browser session (`needsSession` + `sessionSource`, missing provenance = browser) is looked up again **through the browser session only**: no cookieless yt-dlp call, no clean hidden probe; browser closed/refused/unsupported → explicit `sessionRequired` error before any request to the site; expired or dropped handle → this session-only lookup, checked before any network work; never counts as the automatic retry; jar/info scavenging at start, 0600/0700 on POSIX | `tests/session-discovery.test.cjs` (real coordinator + real discovery; fixture logs every request): direct extractor and embedded player × found / interrupted, browser closed / denied / unsupported, disconnect then retry, missing provenance, public + hidden-probe cookies; real-yt-dlp + real Chromium + real discovery restart test. On `2d13a5b` 10 of these fail (cookieless `/members/clip.mp4` or `/members/watch` during the lookup); all pass on the fix. Windows: jar folder ACL owner-only (icacls), jar gone after completion, removal and forced kill + restart (W-08a/b/c); session-required job with the browser unreachable in the installed app: explicit error, 0 requests to the protected area (W-04a) |
| GRB-08 | **Fixed** | `process-runner`: per-kind deadlines, idle limit, bounded output, cancel; lookup time and candidate budgets | stalled/giant/missing/cancel tests with real processes |
| GRB-09 | **Fixed** | Tree stop (taskkill /T, process groups), registry, engine never replaced while busy, quit/update wait for exit, one attempt per job | grandchild-killed test now also on Windows; installed app on Windows: pause ends yt-dlp, never two attempts at once (W-06a), quit ends every process and saves paused (W-07a). Update-while-active: Pending (§4.4) |
| GRB-10 | **Partly** | CI on PRs and pushes (Linux + Windows tests, build, e2e) | green runs. Branch protection, signing, release pipeline: owner actions (§4) |
| GRB-11 | **Partly** | Delivered height/codecs recorded in history; README states the quality setting is a preference | real yt-dlp test parses the record. Hard cap: owner decision (§5) |
| GRB-12 | **Fixed** | Shared `CandidatePolicy`; hidden probe keeps request context and page cookies; budget 12 instead of 4; player-element sources ranked/kept | fifth-candidate test; `e2e/hidden-probe.cjs` (fixture refuses without cookie+Referer); real-Chromium test |
| GRB-13 | **Partly** | Connection keyed by endpoint (profile + instance), README lists unverified browsers | per-endpoint test; real-Chromium CDP test (Linux). Endpoint/profile chooser not built (§5) |
| GRB-14 | **Fixed** | Exact host keys + aliases; in-paste dedup; signed queries kept; "download all" keeps other sites' blocks | site-key and intake tests |
| GRB-15 | **Fixed** | `OutputAllocator`: device names, path length, unique per job and folder, kept for resume, `%` escaped | allocator tests; on Windows with the real yt-dlp.exe: `CON`/`nul`/`COM1`/`LPT9`/`aux.mp4`, a long Hebrew title in a 9-level Hebrew folder (≤ 259 chars), `Lesson (2)`/`(3)` beside an existing file (`tests/windows-output.test.cjs`) |
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
- Tests: 14 files, 102 tests on Linux / 103 on Windows (one browser test per installed Chromium-family browser): unit, fake-clock, architecture, real Chromium/Chrome/Edge, real yt-dlp, Windows-only output/ACL/fetch-bin. Windows driver: `scripts/windows/`. e2e: `queue-cooldown`, `hidden-probe` (new), `layout` (now seeds through the coordinator).

## 3. Visible behavior changes (everything else is unchanged)

1. The queue comes back after a restart; running/queued downloads come back **paused**.
2. "Download all" no longer lifts a blocked site; the banner's "resume <site>" does (GRB-14).
3. A link pasted twice in one batch becomes one row.
4. Electron 44 renders glyph edges slightly differently (≈0.5% of pixels; no layout/colour change).
   Everything else: pixel-identical screenshots before/after each batch.
5. A download that needed your browser session is looked up again, through your browser only, when
   you resume it after a restart (the browser may ask for its connection permission again). Same
   after the browser connection is lost: its cookies are dropped, and the next download of such a
   job looks it up again. If the browser is closed or refuses the connection, the row shows "the
   site needs <browser> where you are signed in; open it, allow the connection and try again" (new
   text) with the guide link, and nothing is sent to the site.
6. A pasted link that itself carries a token, signature or credentials is not saved in the queue,
   so it is not there after a restart; restored rows have no thumbnail until looked up again.
   History still keeps the pasted link (it is what "download again" uses).

## 4. Windows verification

Where: GitHub-hosted `windows-latest` (Microsoft Windows Server 2025 Datacenter 10.0.26100), Node
v22.23.3, Chrome 154.0.8037.58, Edge 153.0.4234.48, no Brave. Workflow `.github/workflows/windows-verify.yml`,
run 10 (https://github.com/OrMeirDev/Grab/actions/runs/38625116763), commit
`ee8f20bcefa56af8a9d15d46babff2b49dcf608b`; CI run 21 on the same commit: green. Run 8
(`1c9d699`) gave the same results. Commits after `ee8f20b` change only docs. This is a clean
throwaway machine with throwaway browser profiles, not a person's PC: it proves the build, the
installer, the upgrade and the app's own behavior, not real signed-in profiles (§4.4).

Native tools (pinned, verified in `bin/` and again in the installed `resources/bin`): yt-dlp
2026.08.19, FFmpeg/ffprobe N-127511-g01cf1a5396 (autobuild-2026-10-13), Deno 2.9.7.

### 4.1 Windows unit and build checks

| Step | Result |
| --- | --- |
| `npm ci` (with install scripts) | pass |
| `npm run fetch-bin` | pass (failed before `83a7c6b`: see below) |
| `npm run verify-bin` | `Native tools verified: yt-dlp 2026.08.19, ffmpeg N-127511-g01cf1a5396, deno 2.9.7` |
| `npm test` with `GRAB_TEST_YTDLP_DIR=bin` | 103 tests: 99 pass, 0 fail, 4 skipped (the four `engine.test.cjs` cases that need a fake yt-dlp.exe; they run in the Linux job). Includes on Windows: real yt-dlp.exe tests, the real-yt-dlp + real-discovery + real-Chrome restart test, exact-tab reuse on Chrome and on Edge (throwaway profiles), process-tree kill, output names, cookie-jar ACL, fetch-bin |
| `npm run build` | pass |
| `npm run dist -- --publish never` (version stamped `1.6.8-test.10`, not committed) | `Grab-Setup-1.6.8-test.10.exe`, 253,379,319 bytes, SHA-256 `112da9aec9798095c92d8fa03271000e79198d32fafc11f178755ec35c5e701e`; unsigned |

Found and fixed on the way (each shown failing on Windows first):

- `npm run fetch-bin` stopped at "Get-FileHash is not recognized" when started from a PowerShell 7
  window (Windows PowerShell inherits 7's module path). `tests/fetch-bin.windows.test.cjs` failed on
  `561d6e7` (CI job 116020637761) and passes since `83a7c6b`: hashing and unzipping now use .NET.
- Test-only: run 9 (on `d865648`, docs-only change) failed in the real-yt-dlp restart test: part C
  copied its saved job from part B's store, which drops the job once B's finished download is
  saved, so it passed or failed depending on when that save landed. Reproduced on Linux by
  delaying part C 500 ms (same error), fixed by giving both parts the same job literal.
- Test-only: Edge lists its start tab at the page address before loading it; the exact-tab test
  now waits for the page's first load (the logged extra request had no cookie: a first load, not a
  reload by Grab). Grab sends no navigate/reload to a reused tab (`pageprobe.cjs`).

### 4.2 Installer, 1.6.7 upgrade and installed app (same run)

`scripts/windows/verify-upgrade.cjs` installs the released 1.6.7 (210,579,138 bytes, SHA-256
`c747ea63…b052d0`, checked), opens it, gives it a Hebrew download folder, MP4/720p and one history
entry, opens it again, installs the test build over it silently, then
`scripts/windows/installed-app.cjs` drives the installed app's own window (DevTools port on the app,
local fixture site serving real H.264/AAC media slowly). Evidence artifact
`grab-windows-evidence-10` (results JSON, screenshots, diagnostics log, fixture request log);
installer artifact `grab-test-installer-10` (kept until 2026-10-28, never published).

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| W-01a | 1.6.7 installs silently from the hash-checked installer and starts | Pass | per-user install in `%LOCALAPPDATA%\Programs\Grab`, exit 0 |
| W-01d | test build installs over 1.6.7 in the same place | Pass | registry 1.6.7 → 1.6.8-test.10, same folder, exit 0 |
| W-01e | upgrade keeps `settings.json` and `history.json` | Pass | identical before/after |
| W-01f | installed `resources/bin` = lock; every tool runs | Pass | versions above |
| W-01b / W-01c | History shows the 1.6.7 entry; Settings show its folder, MP4, 720p | Pass | `02-history.png`, `04-settings.png` |
| W-10a | Hebrew RTL, CSP present, version shown, four pages | Pass | `01`–`04` screenshots |
| W-03a / W-03b | public link → MP4 (exact size); → MP3 (ffprobe: mp3) | Pass | `lesson.mp4` 2,515,202 B, `song.mp3` |
| W-03c | player set by page script, found by the hidden probe; the download carries the page cookie and Referer | Pass | fixture log: `/media/clip` with cookie, Referer `/player`; strategy `hidden-browser` |
| W-02a | duplicates in one paste and against the queue → one row + notice | Pass | |
| W-06a | pause ends yt-dlp/ffmpeg; resume completes; never two attempts at once | Pass | max 1 attempt (2 yt-dlp.exe = one-file launcher + child), 2 attempts in total, one file, no `.part` |
| W-07a | quit (window close) during a download: no yt-dlp/ffmpeg/Grab left, job saved paused | Pass | `queue.json` status `paused` |
| W-07b | reopened: shown paused, nothing started | Pass | 0 requests for the file until resume; only `yt-dlp --version` running at start |
| W-07c | resume the restored download | Pass | done |
| W-08a | no cookie jar after a normal completion | Pass | |
| W-08c | removing a running download ends yt-dlp, deletes its jar | Pass | no partial files left |
| W-08b | jar left by a forced kill is removed at the next start | Pass | jar present after `taskkill /F`, gone after restart |
| W-04a | job needing the browser session, browser (Edge, default) unreachable: explicit error, nothing sent | Pass | "האתר דורש את Edge…", 0 requests to `/members/*`; `08-session-required.png` |

Driver mistakes fixed during the runs (not product defects): install folder taken from the
uninstaller path (1.6.7 writes no `InstallLocation`), yt-dlp attempts counted per process tree, rows
matched by their name field, "nothing started" proven by the request log.

### 4.3 Scenarios 1–10

| # | Scenario | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Public MP4 and MP3 | **Pass** (local fixture) | W-03a/b. A real public site (e.g. YouTube) was not used: no real content was authorized for this run |
| 2 | Queue, cooldown, duplicates, rate limits | **Partial** | Duplicates: Pass on Windows (W-02a). Cooldown and block/rate-limit handling: fake-clock tests (pass on Windows) and the Electron e2e on Linux; not exercised in the installed app on Windows |
| 3 | Protected lesson: identify → quit → reopen → resume, every request with the session | **Partial** | Windows, real yt-dlp.exe + real discovery + real Chrome (throwaway profile, local members site): pass. Installed app with a real signed-in profile: Pending |
| 4 | Browser closed / denied / disconnected → explicit error, no protected request | **Partial** | Closed/unreachable: Pass in the installed app (W-04a). Denied, disconnected: coordinator + discovery tests pass on Windows; with a real browser: Pending |
| 5 | Chrome, Edge, Brave real profiles | **Pending** | Exact-tab reuse without reload, own tab closed, cookies/context: Pass on Chrome 154 and Edge 153 with throwaway profiles. Real profiles, permission prompt, browser restart, context ambiguity, Brave: Pending |
| 6 | Pause/resume during download and during the FFmpeg merge | **Partial** | During download: Pass (W-06a). During the merge: Pending (needs a source with separate video and audio) |
| 7 | Quit / install update while a job is active | **Partial** | Quit: Pass (W-07a/b/c). Install update while active: Pending (needs an update feed; publishing is not authorized) |
| 8 | Cookie-jar permissions and cleanup | **Pass** | ACL (icacls: no Everyone/Users/Authenticated Users, owner present); completion, removal, forced kill + restart (W-08a/b/c) |
| 9 | Output collisions, reserved names, long Hebrew titles, deep paths | **Pass** | `tests/windows-output.test.cjs` with the real yt-dlp.exe; Hebrew download folder in the installed app |
| 10 | History, Library, Settings, Hebrew RTL | **Pass** | W-10a, W-01b/c, screenshots |

Seen, not changed: right after start the sidebar says "המנוע לא נמצא" (red) for about a second
until `yt-dlp --version` answers (`01-downloads.png`; the one-file yt-dlp.exe starts slowly). The
same text is in the audited code; changing it is a visible-text change (backlog). The test build's
"check for updates" fails ("הבדיקה נכשלה"): it is a pre-release version with no matching release,
which is the intended isolation from production updates.

### 4.4 Still pending (needs a person, a real profile or an update feed)

Run on a Windows PC with the test installer above (or a newer run's), with only profiles and content
the owner authorizes:

- [ ] Real Chrome, Edge and Brave profiles (each the default browser in turn): the remote-debugging
      permission prompt, exact-tab reuse with no reload, background tab closed, quit and reopen the
      browser, the same page open in two contexts (expect the ambiguity error).
- [ ] A members-only/course page: look it up, quit Grab, reopen, press download: the browser
      connection is asked for again, then it downloads; the site's logs/devtools show no request
      without the session. Same after closing the browser between lookup and download, and after
      denying the permission (explicit error, nothing sent).
- [ ] Pause during the FFmpeg merge of a video with separate audio: no `ffmpeg.exe`/`yt-dlp.exe`
      left, resume completes.
- [ ] "Install update" while a download runs (needs a test update feed the owner sets up; not
      production): processes end, queue saved, restored paused.
- [ ] One real public video (MP4 and MP3) from a site the owner chooses.

Owner actions (not authorized for this session):

- Protect `main` and require the CI checks (GitHub → Settings → Branches/Rulesets).
- Code-signing certificate for the installer and updates; then a release workflow that builds the
  tested commit, signs, attaches checksums and the native-tool versions.
- Production release configuration (publish target, channels, who can release).
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

## 6. Commands and results (Linux; Windows in §4)

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` / `npm test` (pinned yt-dlp + Chromium) | 102 tests: 98 pass, 0 fail, 4 skipped (fetch-bin, Windows output names, jar ACL: Windows only; the Windows default-browser lookup case) |
| `npm run build` | pass (Vite 8.3.4) |
| `xvfb-run electron e2e/queue-cooldown.cjs` | PASS (2 starts, reload during rest) |
| `xvfb-run electron e2e/hidden-probe.cjs` | PASS |
| `xvfb-run electron e2e/layout.cjs` | all sizes ok |
| `npm audit` | 8 moderate (one build-time chain, not shipped); was 20 (1 critical, 14 high, 5 moderate) |
| `electron-builder --win dir` | packages `win-unpacked` with the expected asar/resources (signing skipped) |
| CI run 21 (`ee8f20b`) | test (ubuntu), test (windows), e2e: success |
| Windows verify run 10 (`ee8f20b`), run 8 (`1c9d699`) | success: §4.1, §4.2 |
| Windows verify run 9 (`d865648`) | failure: test race, fixed in `ee8f20b` (§4.1) |

## 7. Backlog

| Item | Status | Blocked by | Blocks | Lane / size |
| --- | --- | --- | --- | --- |
| Real-profile and members-site checks (§4.4) | Ready | A Windows PC, authorized profiles and content | Calling Windows verification complete; release | QA / M |
| Update-while-active check (§4.4) | Blocked | A test update feed (owner) | Release | QA + Release / S |
| Pause during the FFmpeg merge (§4.4) | Ready | Authorized source with separate audio | — | QA / S |
| Branch protection + required checks | Ready | Owner admin | Merge policy | Release / S |
| Code signing + release workflow with checksums/provenance | Planned | Certificate, secrets | Production release | Release / M |
| Production release configuration | Ready | Owner decision | Production release | Release / S |
| GPL source-offer decision for FFmpeg | Ready | Owner/legal | Release | Release / S |
| Startup shows "המנוע לא נמצא" until yt-dlp answers (pre-existing) | Proposed | Owner (visible text) | — | Frontend / S |
| Windows process-tree supervision via Job Objects (beyond taskkill /T) | Optional | — (pause/quit checks pass with taskkill /T) | — | Platform / M |
| Endpoint/profile chooser (GRB-13) | Deferred by owner | — | Custom-profile users | Browser + frontend / M |
| Notice in the guide for unverified browsers | Proposed | Owner decision | — | Frontend / S |
| Pin GitHub Actions to commit SHAs | Ready | — | Supply-chain hardening | Release / S |
| Merge this branch | Ready | Owner review | Everything above | — |

Out of scope by owner decision: GRB-17 (accessibility overhaul) and any DRM work.
