# Network-privacy audit tools

Reusable, redacting tools behind [docs/audits/](../../docs/audits/). None of them changes system settings,
installs a certificate, needs administrator rights, or sends anything to the internet on its own.

**Never commit or upload their output.** Output folders contain the hosts you contacted and, for real
downloads, file names. Logs never contain cookie values, tokens, query values or Authorization values (only
names / presence), but treat them as private anyway.

| Tool | Runs on | What it does |
| --- | --- | --- |
| `diag-endpoint.cjs` | any (Node) | Loopback origin server **and** HTTP proxy for synthetic `*.test` hosts. Logs method, host, path, query *keys*, status, bytes, UA, Origin, Range, Referer (origin+path), cookie *names*, Authorization *presence*, other header *names*. Refuses every host it does not serve; never forwards. |
| `engine-scenarios.cjs` | any (Node + yt-dlp + ffprobe) | Runs a checkout's **real** `engine.cjs`, `BrowserService.rememberSession` and `CookieVault` against the endpoint: direct download, retry, Range resume, extension-style context, cookie host/domain/path/Secure/expiry matrix, cross-host redirect, expired handle, HTTPS Secure cookie (`--tls`, needs `openssl`). |
| `run-real-app.cjs` + `real-app-harness.cjs` | Linux/Windows (Electron from the checkout) | Starts the checkout's **real** `electron/main.cjs` in a throwaway profile and temp folder and drives: T01 idle, T02 pasted direct link (loopback and, with `--remote-url`, the public test video), signed pasted link, hidden-probe lookup, cancel mid-download, renderer thumbnail. `--chromium-proxy` routes *every* Electron request to the endpoint (logged, refused). `--strace` (Linux) records process-attributed `connect()`/`execve`. |
| `summarize-run.cjs` | any | Groups a run's requests by scenario phase; summarizes `strace` connects. |
| `run-updater-probe.cjs` + `updater-probe.cjs` | any (Electron) | The checkout's own `electron-updater`, configured like `main.cjs`, against a loopback feed (exact headers) and against Grab's GitHub feed through the refusing proxy (destination hosts). |
| `scan-profile.cjs` | any (Windows defaults) | T06: scans `%APPDATA%\Grab` and `%TEMP%\grab-*` for signed query strings, JWTs, Netscape cookie lines, Cookie/Authorization headers, yt-dlp `cookies` fields and your markers; prints kinds and counts only, plus POSIX modes or `icacls` principals. |
| `inspect-installed.cjs` | any | Phase 1: compares the installed `resources\app.asar` file-by-file (SHA-256) with one or more checkouts and prints the extension's permissions. Read-only. |
| `windows/Capture-GrabConnections.ps1` | Windows (no admin) | Polls `Get-NetTCPConnection` for Grab, its child processes (yt-dlp, ffmpeg, ffprobe, deno, native host) and optionally Chrome/Edge/Brave; names remote addresses from the DNS client cache. |
| `windows/Run-GrabAudit.ps1` | Windows (no admin) | Guided T00/T01/T02/T03/T06/T07 runs against the installed app, writing to `%USERPROFILE%\GrabAudit\…`. |

The PowerShell scripts were written for this audit but **could not be executed in the audit sandbox** (no
Windows); run them once with `-Scenario T00` and report any error before relying on them.

## Windows procedure (installed app, non-admin account)

Prerequisites: Node.js LTS on PATH; a checkout of this repository (`git worktree add ..\grab-sec origin/security/privacy-minimization-20261016`
and one for `origin/main`, each with `npm ci`); Grab installed for the current user.

```powershell
cd <repo>\scripts\audit\windows
# 0. Which build is installed?  (compare against both checkouts)
node ..\inspect-installed.cjs --installed "$env:LOCALAPPDATA\Programs\Grab" --compare ..\..\..\..\grab-main --compare ..\..\..\..\grab-sec
.\Run-GrabAudit.ps1 -Scenario T00
# 1. Idle, host inventory of every Electron request (all refused; nothing leaves the PC)
.\Run-GrabAudit.ps1 -Scenario T01 -ChromiumProxy
# 1b. Idle, real network, process-attributed connections
.\Run-GrabAudit.ps1 -Scenario T01
# 2. Pasted public link; checks the 53,961,552-byte file
.\Run-GrabAudit.ps1 -Scenario T02
# 3. Extension downloads (Chrome, then Edge, then Brave), browsers included in the capture
.\Run-GrabAudit.ps1 -Scenario T03
# 6. After closing Grab: what stayed on disk, with ACL principals
.\Run-GrabAudit.ps1 -Scenario T06
# 7. Updater destinations (proxy mode) and the .updaterId file
.\Run-GrabAudit.ps1 -Scenario T07
```

Header-level evidence for yt-dlp (T02/T04) does not need the installed app: run `engine-scenarios.cjs` with
the pinned `bin\yt-dlp.exe` (`npm run fetch-bin`) on PATH:

```powershell
node scripts\audit\engine-scenarios.cjs --app ..\grab-sec --media C:\path\HSSMT.mp4 --out $env:USERPROFILE\GrabAudit\engine-sec --tls
node scripts\audit\engine-scenarios.cjs --app ..\grab-main --media C:\path\HSSMT.mp4 --out $env:USERPROFILE\GrabAudit\engine-main --tls
```

What these tools cannot see: HTTPS headers sent to real sites (no interception by design), UDP/QUIC and
DNS attribution on Windows without ETW (needs admin — ask before enabling), and anything the receiving
server derives on its own (IP, TLS fingerprint).
