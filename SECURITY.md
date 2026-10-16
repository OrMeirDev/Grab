# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab
of this repository), not in a public issue. Include the Grab version (Settings → software updates)
and steps to reproduce. Please don't attach cookies, session files or diagnostics from a signed-in
account; `diagnostics.log` is designed not to contain them.

## What Grab protects

- **Your browser session.** Ordinary pasted public links do not require browser access. Browser
  downloads use the extension the user loads in the intended active Chrome/Edge/Brave profile;
  Native Messaging restricts the extension origin and authenticates the local desktop connection.
  The legacy debugging connection still requires its browser switch and permission prompt. Grab
  never opens a sign-in page, creates a browser profile or bypasses permission. Cookies stay in
  main behind opaque handles, expire after 4 hours and are dropped when their profile disconnects.
  yt-dlp receives only a temporary domain-scoped jar, deleted when the run ends or at startup
  after a crash. A session-bound job reacquires that session before any protected request.
- **The app window.** Sandboxed renderer, strict Content-Security-Policy, no navigation away, no
  new windows, only clipboard permissions. Every request from the window to the main process is
  checked for its sender and validated; the window cannot choose files, folders, cookies or
  programs.
- **The tools it runs.** yt-dlp, FFmpeg and Deno are pinned to exact releases with SHA-256 hashes
  (`native-tools.lock.json`), checked when fetched and before packaging. yt-dlp ignores user
  configuration files. The installed app never falls back to programs found on PATH.

## Not in scope

DRM-protected media (reported as unsupported; Grab does not circumvent it), access controls of
sites, and players that never expose an HTTP media source.

## Known gaps

The installer is not code-signed yet, and `main` has no branch protection. The
[release workflow](docs/releasing.md) gates publication on exact-commit CI, browser and Windows
checks and verifies the installer/update digests before publishing. See [handoff](docs/handoff.md)
for current scope and [desktop checks](docs/windows-manual-checklist.md) for personal accounts.
