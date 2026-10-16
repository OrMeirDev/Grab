# Grab security regression results — `security/privacy-minimization-20261016`

Audit date: 2026-10-16. Companion reports: [network privacy audit](grab-network-privacy-audit.md),
[main vs. security comparison](grab-network-privacy-comparison.md).

## Exact revisions

| Ref | SHA | Notes |
| --- | --- | --- |
| `origin/main` | `c64710074da8f4b50681eea939ae287c3a7e5abd` | Equals the merge base: **main has not moved** since the branch was cut. |
| `origin/security/privacy-minimization-20261016` | `02817d91666f68b36542a938629dac559cd3833f` | 32 commits ahead of main, 0 behind. Draft PR [OrMeirDev/Grab#5](https://github.com/OrMeirDev/Grab/pull/5), mergeable state `clean`. |
| Diff | 21 files, +405 / −36 | `electron/` (10 files), `extension/manifest.json`, `src/features/settings/SettingsPage.jsx`, 7 test files, `docs/security-privacy.md`. |

Both revisions were tested from **isolated `git worktree` checkouts** in the audit sandbox; the working tree
of the repository was not modified by the tests.

## Test environment (what this run could and could not reach)

| Item | Value |
| --- | --- |
| Host | Linux cloud container (x86_64), Node 22.22.0, npm 10.9.4, Xvfb |
| Electron | 44.7.2 (from `package-lock.json`) |
| yt-dlp | 2026.08.19 `yt-dlp_linux`, SHA-256 `58162f9b…399230a`, verified against upstream `SHA2-256SUMS` (same release as `native-tools.lock.json`; the lock pins the Windows `.exe`) |
| FFmpeg/ffprobe | distribution build on PATH (not the pinned Windows build) |
| Windows, installed `Grab.exe`, Chrome/Edge/Brave with the extension | **Not available.** Every Windows-only check below is reported as BLOCKED, never as passed. |

## Results summary

| Area | security branch `02817d9` | main `c647100` | Evidence |
| --- | --- | --- | --- |
| Unit + integration (`npm test`), real yt-dlp enabled (`GRAB_TEST_YTDLP_DIR`) | **283 tests: 276 pass, 0 fail, 7 skip** | 271 tests: 264 pass, 0 fail, 7 skip | local run |
| Same suite without yt-dlp (first run) | 283: 269 pass, 0 fail, 14 skip | 271: 257 pass, 0 fail, 14 skip | local run |
| Renderer build (`npm run build`) | pass | pass | local run |
| Electron E2E (Xvfb): `queue-cooldown`, `hidden-probe`, `media-context`, `browser-ui`, `layout`, `glass-menu`, `liquid-glass` | **7/7 pass** | 7/7 pass | local run |
| Browser-extension E2E (`e2e/extension-bridge.cjs`, real Chromium + extension + native host) | BLOCKED locally (hard-gated to `win32`) — **passed in CI** on the exact head | not re-run | [Browser integration run 38912964308](https://github.com/OrMeirDev/Grab/actions/runs/38912964308), Windows job step 12 |
| Brave registration + automatic authenticated send (`e2e/brave-connection.cjs`) | BLOCKED locally — **passed in CI** on the exact head | not re-run | same run, step 14 |
| Windows unit suite | **passed in CI** on the exact head | — | [CI run 38912963872](https://github.com/OrMeirDev/Grab/actions/runs/38912963872) `test (windows-latest)` |
| Linux unit suite + Electron E2E in CI | **passed in CI** on the exact head | — | same CI run |
| Windows packaging (NSIS test build, packaged files, native host without system Node, release bundle/updater metadata) | **passed in CI** on the exact head | — | Browser integration run, steps 15–17 |
| Linux packaging (`electron-builder --linux dir`) | builds; packaged `app.asar` byte-matches `02817d9` for all 11 changed security files; extension manifest has no `tabs` | — | local run, `scripts/audit/inspect-installed.cjs` |
| `tests/browser/packaging.test.cjs` against the Linux package | fails: *"The Grab program file for the browser connection was not found"* — the test requires the Windows package (`Grab.exe`); **not a regression**, N/A on Linux | — | local run |
| `windows-verify.yml` (installed-app upgrade, cookie-jar ACL, pause/merge on Windows) | **NOT RUN** for this branch (triggers: `workflow_dispatch`, push to main) | last run on main | AGENTS.md requires it for cookie-jar changes |
| `npm run e2e:screenshots` (AGENTS.md requires before/after screenshots for UI changes; the branch adds a Settings checkbox) | BLOCKED (reads the real Windows profile under `%APPDATA%`) | — | no screenshot evidence found in PR #5 |

### Skipped tests (7, both branches) — none counted as passed

| Test | Reason |
| --- | --- |
| packaged browser service loads… | needs `GRAB_PACKAGED_DIR` with a Windows package |
| generated launcher starts the real host through `cmd.exe`… | Windows only |
| real registry round trip… | opt-in `GRAB_TEST_REGISTRY=1`, Windows registry |
| fetch-bin: plain and zipped tools… | Windows only |
| the signed-in lookup uses the default browser… | needs a real default browser profile |
| Windows: real yt-dlp writes device names… | Windows only |
| **Windows: the cookie jar folder is not readable by other users** | Windows only — **the non-admin ACL check is unverified** |

## CI history on the branch (flakiness)

At the exact head `02817d9` both workflows are green. Earlier on the same day, `Browser integration`
failed at 5 of 10 branch commits (`5e46cb7`, `8373123`, `bd486ef`, `51b0517`, `89b0458`), always in step 12
with:

```
AssertionError: Expected values to be strictly equal:
+ 'unknown'
- 'chrome'
    at e2e\extension-bridge.cjs:81  (instance.browser)
```

`89b0458` is a docs-only commit whose code is identical to the passing `0a05d24`, so this is a flake, not a
regression introduced by the branch. Likely cause [Likely]: `native-host/browser-kind.cjs` (unchanged by the
branch) identifies the launching browser through a PowerShell `Get-CimInstance` ancestry walk with a 4-second
timeout; several runs were started within seconds of each other on loaded runners. It fails closed
(`unknown`, never a wrong browser), so it is a reliability issue, not a session-isolation leak. See finding
F12 in the audit.

## Security-specific regression coverage (all executed and passing on `02817d9` unless stated)

| Requirement | Tests (file → name) | Result |
| --- | --- | --- |
| Cookie domain / host-only / path / Secure / expiry | `tests/cookie-scope.test.cjs` → *browser cookies are restricted by domain, host-only flag, path boundary and HTTPS*; *cookie scope never promotes cookies from unrelated destinations*; `tests/privacy-settings.test.cjs` → *host-only cookies remain host-only when passed to yt-dlp* | pass |
| Scope = media origin + observed redirects + player hosts | `tests/browser/media.test.cjs` → *scope for cookies is exactly the media origin…*; `service.test.cjs` → *redirect and player hosts widen the cookie scope only to hosts the browser really used* | pass |
| Profiles/browsers never share sessions | `service.test.cjs` → *two profiles never share candidates or credentials…*; *disconnect drops only that extension profile session…*; `bridge.test.cjs` → *two instances never exchange messages, replies or waiters* | pass |
| Session cleanup and cancellation | *cancelled contextual downloads stay stopped and remove their temporary cookie jar*; *download keeps cookies available until the child finishes, then deletes the jar*; *app shutdown removes cookie jars even while a download is pending*; *stopping during output verification kills the verifier and cleans up cookies* | pass |
| No request without the session | the restart/disconnect tests in `tests/session-discovery.test.cjs` (*…every lookup and download request carries the session*, *…the site is never contacted*, *browser disconnect, then download/resume…*) | pass |
| Temporary cookie jar | *cookie vault: expiry is an error…, forget, crash leftovers*; *cookie jars preserve domain/HttpOnly scope and disappear after success or failure* | pass (POSIX); Windows ACL test **skipped** |
| Diagnostics redaction | `tests/diagnostics-privacy.test.cjs` → *diagnostics redact path identifiers…*; *diagnostic files never contain sensitive URL paths or tokens*; *diagnostic allowlist rejects arbitrary error strings and unknown fields* | pass |
| History / signed-URL persistence | `tests/diagnostics-privacy.test.cjs` → *persistent history excludes signed URLs, including older records*; *queue.json keeps no signed or secret-bearing link…*; *snapshots never carry session material…* | pass |
| Local file permissions | `tests/diagnostics-privacy.test.cjs` → *JSON state files use restrictive permissions on POSIX*; `tests/private-info-dir.test.cjs` → *signed metadata cache is created with restricted permissions*; *…rejects ordinary files and symlinks* | pass (POSIX only) |
| Update opt-out | `tests/privacy-settings.test.cjs` → *automatic security update checks are on by default and can be disabled explicitly* | pass (unit level; the packaged updater was not run) |

## Gaps found by this audit that the suite does not cover

These were reproduced with the audit harnesses (`scripts/audit/`) and are detailed in the audit report:

1. **F05 — malformed host-only cookie makes yt-dlp reject the whole jar (security branch only).**
   `cookie-vault.cjs` uses `/^\\./` (backslash + any char) where `/^\./` was intended. A cookie with
   `hostOnly: true` and a leading-dot domain is written as `.domain<TAB>FALSE`; Python's cookie jar asserts
   and yt-dlp loads none of the cookies (observed: lookup fails, zero requests sent). On main the same input
   was widened to domain scope. Fail-closed, and Chrome's cookie API should not produce this shape
   [Likely], but there is no test for it.
2. **F01 — the lookup cache file holds session cookie values** (both branches). No test asserts that
   `grab-info/*.json` is free of cookie values.
3. There is no test that the hidden probe / renderer do not announce `Grab/<version> Electron/<version>`
   (F03), and none for third-party startup connections (F04).

## Not executed (and therefore not claimed)

- Any run of the **installed** Windows application, Windows ACL checks, `windows-verify.yml`.
- Chrome / Edge / Brave with the real extension on a user profile (T03), authenticated content (T05).
- Packaged auto-updater against GitHub (only the same `electron-updater` code against a loopback feed, and
  against GitHub through a refusing proxy, were run — see T07 in the audit).
- Mako (Edge player exception) — only the existing unit/E2E coverage (`browser-ui` E2E: *mako Edge rule*) ran.
