# Grab refactor handoff (2026-10-15)

Branch `claude/modest-pasteur-6315xe`, from `main` at `b1e1de8` (the audited `5813a6e` plus the e2e
scripts). Not merged, no PR, no release. Windows verification (§4): run 19 of `windows-verify.yml` on
`229467c` (after the 429 change, §4.4a) and run 18 on `fca984e` are green: tests, fetch-bin/verify-bin, two NSIS test builds, the 1.6.7 upgrade and
29/29 installed-app checks, including pause during a real FFmpeg merge, a real in-app update while a
download runs, and the queue under a site's rate limit. What only a person can check (personal
browser profiles, a real account, real content, Brave, the unsigned installer on a desktop) is
still **Pending** (§4.5), so Windows verification is not complete.

## 1. Findings: status and evidence

Revalidated against `b1e1de8` before any change: all 17 active findings were still present. GRB-01
was reproduced in the real Electron app (`e2e/queue-cooldown.cjs` failed: second row stuck in
`queued`). GRB-17 is cancelled; no DRM work was done.

| ID | Status | What changed | Evidence |
| --- | --- | --- | --- |
| GRB-01 | **Fixed** | Minimal React fix first (`a9ba674`), then the rest's end is a coordinator event | e2e failed before / passes after; fake-clock tests (job 2 starts exactly once at 5 000 ms, mixed/blocked/pause cases). Windows: the same e2e on real Electron with real timers passes (second download started ≥ 5 s after the first, after a reload); not the installed app (needs YouTube itself) |
| GRB-02 | **Fixed** | `DownloadCoordinator` in main owns states, schedules, retries, history; durable `queue.json` (no cookies, headers, media addresses, lookup files or thumbnails; a pasted link that itself carries a token/signature/credentials is not saved; links in error text are cut to scheme://host/path) | e2e: window reload during the rest, 2 starts / 2 done; restore tests; snapshot privacy test |
| GRB-03 | **Fixed** | Router: trusted frame + contracts on every channel; no renderer-chosen info file, cookie handle, folder or path; `--ignore-config`, `--` | router/contract tests; real yt-dlp test |
| GRB-04 | **Fixed** | Build-time CSP, sandbox, no navigation/popups/webviews, clipboard-only permissions | in-app check: CSP present, 0 violations, navigation and `window.open` blocked, paste works |
| GRB-05 | **Fixed** | Electron 44.7.2, electron-builder 26.15.3, Vite 8.3.4; audit 20 → 8 moderate (build-time only) | pixel/computed-style comparison; all e2e on Electron 44; NSIS installer built, installed over 1.6.7 and driven on Windows (§4.2) |
| GRB-06 | **Fixed** | `native-tools.lock.json` (exact releases, SHA-256 checked against upstream sums), hash-checked `fetch-bin.ps1` (now hashes/unzips through .NET: it failed from a PowerShell 7 window), `verify-bin` before packaging, no PATH/WinGet in the installed app | lock and verify tests; `tests/fetch-bin.windows.test.cjs` (failed on `561d6e7`, passes on `83a7c6b`); installed `resources/bin` verified against the lock on Windows (W-01f) |
| GRB-07 | **Fixed (real-profile checks pending)** | `CookieVault`: 4 h TTL, release per job, account cookies dropped when the browser connection is lost (a running yt-dlp keeps its jar until it ends), a job known to need the user's browser session (`needsSession` + `sessionSource`, missing provenance = browser) is looked up again **through the browser session only**: no cookieless yt-dlp call, no clean hidden probe; browser closed/refused/unsupported → explicit `sessionRequired` error before any request to the site; expired or dropped handle → this session-only lookup, checked before any network work; never counts as the automatic retry; jar/info scavenging at start, 0600/0700 on POSIX | `tests/session-discovery.test.cjs` (real coordinator + real discovery; fixture logs every request): direct extractor and embedded player × found / interrupted, browser closed / denied / unsupported, disconnect then retry, missing provenance, public + hidden-probe cookies; real-yt-dlp + real Chromium + real discovery restart test. On `2d13a5b` 10 of these fail (cookieless `/members/clip.mp4` or `/members/watch` during the lookup); all pass on the fix. Windows: jar folder ACL owner-only (icacls), jar gone after completion, removal and forced kill + restart (W-08a/b/c); session-required job with the browser unreachable in the installed app: explicit error, 0 requests to the protected area (W-04a) |
| GRB-08 | **Fixed** | `process-runner`: per-kind deadlines, idle limit, bounded output, cancel; lookup time and candidate budgets | stalled/giant/missing/cancel tests with real processes |
| GRB-09 | **Fixed** | Tree stop (taskkill /T, process groups), registry, engine never replaced while busy, quit/update wait for exit, one attempt per job | grandchild-killed test now also on Windows; installed app on Windows: pause ends yt-dlp, never two attempts at once (W-06a), quit ends every process and saves paused (W-07a), pause during the real FFmpeg merge ends FFmpeg too (W-06b), installing an update while a download runs: the download's processes end before the installer starts (W-07e) |
| GRB-10 | **Partly** | CI on PRs and pushes (Linux + Windows tests, build, e2e) | green runs. Branch protection, signing, release pipeline: owner actions (§4) |
| GRB-11 | **Partly** | Delivered height/codecs recorded in history; README states the quality setting is a preference | real yt-dlp test parses the record. Hard cap: owner decision (§5) |
| GRB-12 | **Fixed** | Shared `CandidatePolicy`; hidden probe keeps request context and page cookies; budget 12 instead of 4; player-element sources ranked/kept | fifth-candidate test; `e2e/hidden-probe.cjs` (fixture refuses without cookie+Referer); real-Chromium test |
| GRB-13 | **Partly** | Connection keyed by endpoint (profile + instance), README lists unverified browsers | per-endpoint test; real-Chromium CDP test (Linux). Endpoint/profile chooser not built (§5) |
| GRB-14 | **Fixed** | Exact host keys + aliases; in-paste dedup; signed queries kept; "download all" keeps other sites' blocks | site-key and intake tests; installed app on Windows: a 429 holds only that site, nothing is sent to it while held, other sites continue, "resume" continues without losing or repeating a job (W-02c/d/e) |
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
- Tests: 15 files, 103 tests on Linux / 104 on Windows (one browser test per installed Chromium-family browser): unit, fake-clock, architecture, real Chromium/Chrome/Edge, real yt-dlp, real FFmpeg merge (POSIX), Windows-only output/ACL/fetch-bin. Windows driver: `scripts/windows/` (installed-app checks, process helper, test-build stamp). e2e: `queue-cooldown`, `hidden-probe` (new), `layout` (now seeds through the coordinator).

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
run 18 (https://github.com/OrMeirDev/Grab/actions/runs/38693067423), commit `fca984e50236a4c4d5c7d6fc6757c9591007a148`; CI run 30 on the same commit: green. The
commit after it changes only this document. A clean throwaway
machine with throwaway browser profiles, not a person's PC: it proves the build, the installers,
the upgrade, the update and the app's own behavior, not real signed-in profiles (§4.5).

Native tools (pinned, verified in `bin/` and again in the installed `resources/bin`): yt-dlp
2026.08.19, FFmpeg/ffprobe N-127511-g01cf1a5396 (autobuild-2026-10-13), Deno 2.9.7.

### 4.1 Windows unit and build checks

| Step | Result |
| --- | --- |
| `npm ci` (with install scripts) | pass |
| `npm run fetch-bin` / `npm run verify-bin` | pass: `Native tools verified: yt-dlp 2026.08.19, ffmpeg N-127511-g01cf1a5396, deno 2.9.7` |
| `npm test` with `GRAB_TEST_YTDLP_DIR=bin` | 104 tests: 99 pass, 0 fail, 5 skipped (four `engine.test.cjs` cases that need a fake yt-dlp.exe, run in the Linux job; the POSIX-only merge test, done on Windows as W-06b). Includes on Windows: real yt-dlp.exe tests, the real-yt-dlp + real-discovery + real-Chrome restart test, exact-tab reuse on Chrome and Edge (throwaway profiles), process-tree kill, output names, cookie-jar ACL, fetch-bin |
| `npm run build` | pass |
| `npx electron e2e/queue-cooldown.cjs` (real Electron, real timers, **fake** yt-dlp) | PASS both downloads finished; second started 8070 ms after the first; starts: 2; reloaded: true |
| Test build A: `stamp-test-build.cjs` + `npm run dist -- --publish never` | `Grab-Setup-1.6.8-test.18.exe`, 253,379,193 bytes, SHA-256 `19e59a515addadc370f8d8053cff001bca5ceb3f5f18a40893877035f4bd5011`; unsigned |
| Test build B (same app id and install folder, newer) | `Grab-Setup-1.6.9-test.18.exe`, 253,379,267 bytes, SHA-256 `d4fd1209a82cde27030b6021c018a804e968a58ce98a19d6e71afd359ab3d06f`; unsigned; served with its `test.yml` from a feed on the runner |

Both test builds read app updates from `http://127.0.0.1:47290/` (the runner itself), set only by
`scripts/windows/stamp-test-build.cjs` in the CI workspace (refuses a non-test version or a feed off
the machine; never committed). `package.json` in git keeps the GitHub feed; nothing was published.
A `-test.N` version puts electron-builder and electron-updater on the `test` channel (`test.yml`).
No test signing was needed: with no `publisherName` electron-updater skips the signature check —
the same as the current, unsigned production builds — and still verifies the SHA-512 in `test.yml`.

Found and fixed in the previous round (each shown failing on Windows first): `npm run fetch-bin`
from a PowerShell 7 window (`tests/fetch-bin.windows.test.cjs`, failed on `561d6e7`, fixed in
`83a7c6b`); two test races (real-engine restart test, Edge's late first page load).

### 4.2 Installer, 1.6.7 upgrade and installed app (same run)

`scripts/windows/verify-upgrade.cjs` (refuses to run off a disposable runner) installs the released
1.6.7 (210,579,138 bytes, SHA-256 `c747ea63…b052d0`, checked), opens it, gives it a Hebrew download
folder, MP4/720p and one history entry, installs test build A over it silently, then
`scripts/windows/installed-app.cjs` drives the installed app's own window (DevTools port on the app)
against the local fixture site, and ends by letting A update itself to B. Evidence artifact
`grab-windows-evidence-18` (results JSON, screenshots, diagnostics log, fixture request log,
process trace); installers in `grab-test-installer-18` (kept 14 days, never published).

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| W-01a | 1.6.7 installs silently from the hash-checked installer and starts | Pass | per-user install in `%LOCALAPPDATA%\Programs\Grab`, exit 0, first try |
| W-01d / W-01e | A installs over 1.6.7 in the same place; `settings.json` and `history.json` kept | Pass | registry 1.6.7 → 1.6.8-test.18 |
| W-01f | installed `resources/bin` = lock; every tool runs | Pass | versions above |
| W-01b / W-01c / W-10a | 1.6.7's history and settings shown; Hebrew RTL, CSP, four pages | Pass | `01`–`04` screenshots |
| W-03a / W-03b / W-03c | public MP4 (exact size), MP3 (ffprobe), player set by page script (hidden probe; download carries cookie + Referer) | Pass | |
| W-02a | duplicates in one paste and against the queue → one row + notice | Pass | |
| W-06a | pause during a download ends yt-dlp; resume; never two attempts at once | Pass | |
| **W-06b** | **pause during the real FFmpeg merge** | Pass | bundled FFmpeg `-i merge.fv720.mp4 -i merge.fa128.m4a -c copy -map 0:v:0 -map 1:a:0 … merge.temp.mp4`, child of yt-dlp.exe → yt-dlp.exe → Grab.exe; frozen after 20,447,280 B of the merged file (unchanged 0.7 s later); streams complete (598,829,409 + 1,940,521 B). After Pause: yt-dlp 0, FFmpeg 0, row paused, kept merge.fa128.m4a, merge.fv720.mp4, merge.temp.mp4, no `merge.mp4`, nothing in history. After resume: merge.mp4 = audio:aac, video:h264, 120 s, 0 new stream requests, 2 attempts, max 1 at once |
| W-07a / W-07b / W-07c | quit during a download; reopened paused, nothing started; resume completes | Pass | |
| W-08a / W-08c / W-08b | no cookie jar after completion, after removal, after forced kill + restart | Pass | |
| W-04a | job needing the browser session, browser unreachable: explicit error, 0 requests to the protected area | Pass | |
| **W-02b** | four links, two sites: looked up one at a time, ≥ 2 s apart in real time | Pass | lookup gaps 6,609 ms, 4,839 ms, 5,495 ms |
| **W-02c** | 429 on a download: only that site is held; no request to it while held; the other site's job downloads | Pass | held 14,355 ms, 0 requests to 127.0.0.1 meanwhile; q4 (localhost) done; q2, q3 queued; `11-site-held.png` |
| **W-02d** | after "resume": the held jobs download; one attempt at a time; no job lost or repeated | Pass | download order q1.mp4 → q2.mp4(429) → q4.mp4 → q2.mp4 → q2.mp4 → q3.mp4; requests per link q1 2, q2 4, q3 2, q4 2; one file each; 5 attempts, max 1 at once (after a 429 the next attempt fetches the link's information again: two requests, one attempt) |
| **W-02e** | 429 during a lookup: that site's lookups wait, the other site's continue; after "resume" each finishes once | Pass | while held: q5 1, q6 0, q7 1; after resume: q5 2, q6 1, q7 1 |
| **W-07d** | A finds B on the local feed and downloads it through its own banner | Pass | `app-update.yml`: generic, `http://127.0.0.1:47290/`, channel `test`; banner "גרסה חדשה של Grab זמינה: 1.6.9-test.18 עדכן עכשיו"; feed: 200 /test.yml; 404 /Grab-Setup-1.6.9-test.18.exe.blockmap; 200 /Grab-Setup-1.6.9-test.18.exe |
| **W-07e** | "restart" to install while a download runs: the download's processes end **before** the installer starts; job saved paused | Pass | download active (G Generic 1% 204.01KiB/s · נותרו 00:11); yt-dlp exited 2026-10-15T06:52:43.0846126Z, 2026-10-15T06:52:43.0823871Z; installer `Grab-Setup-1.6.9-test.18.exe` created 2026-10-15T06:52:44.0330630Z (949 ms later); 84 samples, 0 with both alive; `queue.json`: paused at 1.3%, `update.mp4.part` kept |
| **W-07f** | version changed in place; settings and history unchanged | Pass | registry 1.6.8-test.18 → 1.6.9-test.18, file 1.6.8.0 → 1.6.9.0, same folder; settings and history (11 entries) byte-identical to just before the install |
| **W-07g** | after the update the job is restored paused; nothing requested until resume | Pass | started by the installer with `--updated`; row paused; requests for the file: whileInstallerStartedAppRan 0, untilResume 0 |
| **W-07h** | resume after the update: one file, full size, no yt-dlp/FFmpeg left | Pass | update.mp4 full size; yt-dlp 0, FFmpeg 0 left; max 1 attempt at once |

How the new checks are made deterministic (test harness only; Grab, yt-dlp and FFmpeg unchanged):

- **Merge (W-06b).** The fixture serves a DASH manifest with a video-only stream (about 600 MB of
  synthetic constant-bitrate H.264, made on the runner with the bundled FFmpeg) and an audio-only
  AAC stream, so the real yt-dlp downloads both and the bundled FFmpeg merges them
  (`-i <name>.fv720.mp4 -i <name>.fa128.m4a -c copy -map 0:v:0 -map 1:a:0 … <name>.temp.mp4`).
  The harness (`procs.ps1`) finds that exact FFmpeg (not yt-dlp's startup probe, not an MP3
  conversion), waits until it has written more than 4 MB of the merged file, and freezes it
  (`NtSuspendProcess`), so Pause always lands mid-merge. Then Pause is clicked in the app.
- **Update (W-07d–h).** Two real test builds; the feed is a plain file server in the driver; the
  app's own check, "update now" and "restart" buttons are used (no installer started by hand).
  Order evidence: the exit times of the download's yt-dlp processes (handles opened before the
  click, `GetProcessTimes`) against the installer's own creation time (read from the running
  process), both kernel timestamps, plus ~200 ms samples that never show both alive. The WMI
  process trace is kept only as a coarse timeline: it stamps events in ~1 s batches and once
  missed the installer's start (runs 12 and 15), so it is not used for ordering. The installer starts the new version itself (`--updated`); the driver closes it
  normally and reopens it with its DevTools port to read the queue.
- **Queue and rate limit (W-02b–e).** Two sites on one fixture (`127.0.0.1` and `localhost`; Grab
  keys sites by host); `/rl/<n>/…` answers 429 to the n-th request for that path; `/paced/<ms>/…`
  serves slowly. All times are real elapsed time in the installed app.

What the queue checks prove, and what they don't: Grab's existing behavior for a rate limit is a
**hold until the user presses "resume <site>"** (banner), not a timer — so "no request during the
cooldown" is measured for the whole hold (several seconds while the other site downloads), and
"continuation after the wait" is after "resume". The timed waits are the 2–4 s gap between lookups
(measured here: W-02b) and the 5–10 s rest after a **YouTube** download, which only a YouTube link
triggers: on Windows it is covered by the real-Electron e2e with a fake yt-dlp (real timers, not
the installed app) and by the fake-clock unit tests; with real YouTube it stays a manual check.

### 4.3 Coordinator-level merge test (Linux CI and locally)

`tests/merge-pause.integration.test.cjs`: the real coordinator, download runner, engine, yt-dlp and
FFmpeg against the same DASH fixture (~150 MB). The harness stops the merging FFmpeg (SIGSTOP) after
it has written > 2 MB, pauses, checks that Grab's stop reached FFmpeg (SIGTERM pending), lets it go,
then: no final file, nothing in history, the two finished streams kept; resume reuses them (no new
request), merges once, one `merge.mp4` with audio and video, two attempts in all. Passes locally
(4/4 runs) and in Linux CI run 30 (test 53, not skipped; FFmpeg installed by the job). POSIX
only; Windows: W-06b.

### 4.4 Scenarios 1–10

| # | Scenario | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Public MP4 and MP3 | **Pass** (local fixture) | W-03a/b. A real public site: Pending (no content authorized) |
| 2 | Queue, cooldown, duplicates, rate limits | **Pass** (local fixture) | W-02a–e in the installed app (real time). YouTube's 5–10 s rest: real-Electron e2e on Windows (fake yt-dlp) + fake-clock tests; with YouTube itself: Pending |
| 3 | Protected lesson: identify → quit → reopen → resume, every request with the session | **Partial** | Real yt-dlp.exe + real discovery + real Chrome (throwaway profile, local members site): Pass. Installed app with a real signed-in profile and account: Pending |
| 4 | Browser closed / denied / disconnected → explicit error, nothing sent | **Partial** | Closed/unreachable: Pass in the installed app (W-04a). Denied, disconnected: coordinator + discovery tests on Windows; with a real browser: Pending |
| 5 | Chrome, Edge, Brave real profiles | **Pending** | Throwaway profiles only (Chrome 154, Edge 153): exact-tab reuse without reload, own tab closed. These are not personal-profile evidence |
| 6 | Pause/resume during download and during the FFmpeg merge | **Pass** | W-06a, W-06b (real merge, bundled FFmpeg), merge test on Linux |
| 7 | Quit / install update while a job is active | **Pass** | W-07a–c (quit), W-07d–h (real in-app update from a local feed) |
| 8 | Cookie-jar permissions and cleanup | **Pass** | ACL (icacls), W-08a/b/c |
| 9 | Output collisions, reserved names, long Hebrew titles, deep paths | **Pass** | `tests/windows-output.test.cjs` (real yt-dlp.exe); Hebrew download folder in the installed app |
| 10 | History, Library, Settings, Hebrew RTL | **Pass** | W-10a, W-01b/c, screenshots |

Product defects found in this round: **none**. Every failure on the way was in the harness or a
test, fixed and recorded in the commits: the feed file name (`test.yml`, run 11), finding the
running download by its output name (the link is not on yt-dlp's command line when it loads the
saved lookup, run 12), W-02d's expectation (after a 429 the next attempt fetches the link's
information again: two requests, one attempt), the installer's creation time and the attempt's own exit
times instead of WMI trace times (runs 12 and 15: the trace drops events and batches its times),
attempts named by process id and creation time (Windows reused an id, run 15), a crashed start of the published 1.6.7 installer (`0xC0000005`, run 13: one
recorded retry; our test installers are never retried), a 20 s browser-start bound too short
while the new merge test runs in parallel (runs 14 and CI 26: now 60 s with the browser's stderr),
and one miss of a pre-existing timing bound (run 17: the process runner's 300 ms deadline fired,
but the stop, which starts `taskkill.exe`, ended 5215 ms after the start against a 5000 ms bound;
first miss in 17 Windows runs; the bound is unchanged and a failure now reports the time; this
session may not re-run jobs, so the next push repeated it: run 18 green).

Seen, not changed: right after start the sidebar says "המנוע לא נמצא" (red) for about a second
until `yt-dlp --version` answers (pre-existing text; backlog).

### 4.4a HTTP 429 separated from bot checks (owner decision, after run 18)

Before: yt-dlp's "HTTP Error 429" and "confirm you're not a bot" were one kind (`blocked`), so a
429 during a lookup went on to the user's browser (a page load on a rate-limited site) and, if
that browser's session got an answer, the site was never held. Now:

- `errorKind`: HTTP 429 → `rateLimited`; bot check → `blocked` (`domain/engine-errors.cjs`).
- Discovery stops at the first 429 wherever it comes from — the link, the retry with the browser
  session's cookies, a source found by the hidden or the user's browser — and returns it: no
  browser, no hidden browser, no further request (`discovery-service.cjs`).
- A bot check still goes through the user's browser. If the site still asks with the session and
  the page has no video source, the result is `blocked` (site held), not "no video at this link"
  (a defect the new tests found: it was reported as `notfoundPage`, an error).
- The coordinator holds the site for both kinds, at lookup and at download (`HOLDS_SITE`).

On Windows, run 19 (https://github.com/OrMeirDev/Grab/actions/runs/38748221063, commit
`229467c`; CI run 34 green) repeated all 29 upgrade and installed-app checks: Pass; `npm test` 112
tests, 107 pass, 0 fail, 5 skipped. In the installed app the 429 lookup (W-02e) now ends
`rateLimited` with no browser probe in the diagnostics log; run 18 had tried Edge first
(`probe: browser, failed: browserSession`, then `blocked`). Test installers of run 19:
`Grab-Setup-1.6.8-test.19.exe` SHA-256 `8e23b41d006fe0578be6616263eedc9ab3a53e364d4ef1fc5f04086b7aecfee9`,
`Grab-Setup-1.6.9-test.19.exe` SHA-256 `0f6fac7c3487017b7d9048e60cccc0515c2fff22b388bf74ffa807bbf289ec2c`
(artifact `grab-test-installer-19`, until 2026-10-29). The detailed numbers in §4.1–4.2 are run 18's.

Tests (`tests/rate-limit-discovery.test.cjs`: real coordinator, real discovery, real `errorKind`,
browser available; a local site scripted per request): 429 on the lookup, on the session retry,
on a hidden-probe source; bot check with a player in the page (unchanged: found through the
browser) and with no video source (held). Plus both kinds at download (`download-coordinator`) and
the real yt-dlp's 429 at lookup and download (`real-engine.integration`). Before the change 7 of
these failed (the old code went to the browser and its retry succeeded, so the site was never
held; tried sources after a 429; reported "no video"; the real yt-dlp's 429 classified `blocked`);
after it all pass.

### 4.5 Still pending: needs a real desktop, a personal profile, a real account or real content

Run on a Windows PC with the latest test installers (or a newer run's), only with profiles,
accounts and content the owner authorizes. Throwaway profiles on the runner do not count here.
Step-by-step version (Hebrew, with backup, expected texts and restore):
[windows-manual-checklist.md](windows-manual-checklist.md).

- [ ] Personal Chrome, Edge and Brave profiles (each the default browser in turn): the
      remote-debugging permission prompt, exact-tab reuse with no reload, background tab closed,
      quit and reopen the browser, the same page open in two contexts (expect the ambiguity error).
- [ ] A members-only/course page with a real account: look it up, quit Grab, reopen, press
      download: the browser connection is asked for again, then it downloads, and the site's own
      logs/devtools show no request without the session. Same after closing the browser between
      lookup and download, after denying the permission, and after disconnecting it.
- [ ] One real public video (MP4 and MP3) from a site the owner chooses; two YouTube links with
      "download all" to see the 5–10 s rest with YouTube itself.
- [ ] The unsigned installer on a normal desktop: SmartScreen prompt, Start-menu and desktop
      shortcuts, uninstall.
- [ ] After the owner's signed production release exists: one update through the real GitHub feed
      (release pipeline, not this branch).

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
| A 429 during a lookup: also try the user's browser? (§4.4a) | **Decided: no** — HTTP 429 holds the site at once; bot checks keep the browser path | — |

## 6. Commands and results (Linux; Windows in §4)

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` / `npm test` (pinned yt-dlp + Chromium + FFmpeg) | 103 tests: 99 pass, 0 fail, 4 skipped (fetch-bin, Windows output names, jar ACL: Windows only; the Windows default-browser lookup case) |
| `node --test tests/merge-pause.integration.test.cjs` (×4) | pass 4/4 |
| `npm run build` | pass (Vite 8.3.4) |
| `xvfb-run electron e2e/queue-cooldown.cjs` | PASS (2 starts, reload during rest) |
| `xvfb-run electron e2e/hidden-probe.cjs` | PASS |
| `xvfb-run electron e2e/layout.cjs` | all sizes ok |
| `npm audit` | 8 moderate (one build-time chain, not shipped); was 20 (1 critical, 14 high, 5 moderate) |
| `electron-builder --win dir` | packages `win-unpacked` with the expected asar/resources (signing skipped) |
| CI run 30 (`fca984e`) | test (ubuntu), test (windows), e2e: success |
| Windows verify run 18 (`fca984e`) | success: §4.1, §4.2 |
| CI run 34, Windows verify run 19 (`229467c`, 429 change) | success: §4.4a |
| Windows verify runs 11–17 (this round) | failures, each a harness or test issue, fixed and listed in §4.4 |

## 7. Backlog

| Item | Status | Blocked by | Blocks | Lane / size |
| --- | --- | --- | --- | --- |
| Personal-profile, real-account and real-content checks (§4.5) | Ready | A Windows PC, owner-authorized profiles, account and content | Calling Windows verification complete; release | QA / M |
| Brave on Windows | Ready | Brave installed on a test PC (not on GitHub runners) | Brave support claim | QA / S |
| Unsigned installer on a desktop (SmartScreen, shortcuts, uninstall) | Ready | A Windows desktop | Release | QA / S |
| Update through the real GitHub feed | Blocked | Signed production release (owner) | Production release | Release / S |
| Branch protection + required checks | Ready | Owner admin | Merge policy | Release / S |
| Code signing + release workflow with checksums/provenance | Planned | Certificate, secrets | Production release | Release / M |
| Production release configuration | Ready | Owner decision | Production release | Release / S |
| GPL source-offer decision for FFmpeg | Ready | Owner/legal | Release | Release / S |
| Startup shows "המנוע לא נמצא" until yt-dlp answers (pre-existing) | Proposed | Owner (visible text) | — | Frontend / S |
| Windows process-tree supervision via Job Objects (beyond taskkill /T) | Optional | — (pause, merge-pause, quit and update checks pass with taskkill /T) | — | Platform / M |
| Endpoint/profile chooser (GRB-13) | Deferred by owner | — | Custom-profile users | Browser + frontend / M |
| Notice in the guide for unverified browsers | Proposed | Owner decision | — | Frontend / S |
| Pin GitHub Actions to commit SHAs | Ready | — | Supply-chain hardening | Release / S |
| Merge this branch | Ready | Owner review | Everything above | — |

Out of scope by owner decision: GRB-17 (accessibility overhaul) and any DRM work.
