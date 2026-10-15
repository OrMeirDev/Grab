# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab
of this repository), not in a public issue. Include the Grab version (Settings → software updates)
and steps to reproduce. Please don't attach cookies, session files or diagnostics from a signed-in
account; `diagnostics.log` is designed not to contain them.

## What Grab protects

- **Your browser session.** Grab connects to your already-running browser only after you enable
  its remote-debugging switch and accept its prompt. It never opens a sign-in page, creates a
  browser profile or bypasses that permission. Cookies it reads stay in the main process behind
  opaque handles, expire after 4 hours, and reach yt-dlp only as a temporary, domain-scoped file
  that is deleted when the run ends (and at the next start after a crash).
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

The installer is not code-signed yet, and `main` has no branch protection. See
[docs/handoff.md](docs/handoff.md) for the open items and the checks still pending on Windows.
