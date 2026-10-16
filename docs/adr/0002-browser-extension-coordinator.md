# ADR 0002: Browser integration feeds the main-owned coordinator

Date: 2026-10-15. Status: implemented in the unified 1.7.0-rc.1 candidate.

The extension and audit branches diverged before the main-owned coordinator existed. The unified
branch retains ADR 0001: neither React nor the browser extension owns queue scheduling, retries,
history or success. The BrowserService is a browser adapter: it discovers installed browsers,
registers the native host, selects an explicit browser/profile, runs bounded discovery and hands
private context to the application's discovery service. Both pasted links and Send to GRAB enter
the same DownloadCoordinator. Guarded IPC exposes job-id commands; no raw engine:start or arbitrary
cookie/info-file paths are restored to the renderer.

The audit fixes, media request-context fixes and the later cancellable lookup fixes are reconciled
rather than choosing one branch's main.cjs. The shared candidate budget stays 12 (the audit's fifth-
candidate regression), with per-source and total deadlines; it is not the old unbounded scan.

Cookie acquisition has three distinct outcomes: a valid snapshot (possibly empty), a disconnected
browser, or a missing/expired scope. Only a valid response creates a CookieVault handle; the other
outcomes never call the extractor. A handle is bound to one extension instance and dropped when
that instance disconnects. Persisted jobs retain the chosen browser/profile and non-secret status
routing ids; they reacquire context after restart. Media URLs, headers, choice tokens and cookie
handles stay private to main. Only verified files can produce a completed status.

For an explicitly browser-assisted YouTube job, the adapter acquires a page-scoped session before calling the original page's
extractor. This bounded Native Messaging request reads cookies only for that first-party URL and
returns the browser user agent; it does not navigate, start playback or wait for media candidates.
Short links use the canonical youtube.com cookie scope while retaining the original extractor URL.
Generic embedded players retain their existing media-discovery path. Connection presentation
follows live instances; past test results cannot override a reconnect or disconnect.

Ordinary pasted links default to the direct extractor and bounded clean public-page scan. They
do not consult the saved browser choice or require an installed extension, even after a previous
job used that site with a session. Browser use is explicit per job (or restored from a known
session-bound job); Mako remains the Edge-player exception. The extension answers desktop ping
with a correlated pong, so Check connection exercises the same real port used by Send.

The native host uses a versioned private copy of the already-shipped Electron runtime, named
GrabBrowserHost.exe. This avoids locking the app executable/DLLs or matching the installer's
Grab.exe process check while Chrome keeps the native port alive. No new system Node/Python is
required. A packaged smoke test runs this actual host with a minimal PATH and renames the original
app executable while the host is live. Full uninstall unregisters hosts before stopping them and
removing private runtime copies; app updates retain the stable extension folder.

Browser aliases, site rules, default and deadlines are validated in the pure browser policy. The
renderer retains the existing appearance and adds only the requested browser selection, connection
setup, phase/cancel and profile/video choices. Settings and incoming sends serialize in main.

Verification: the combined unit/integration suite, real extension/native host/authenticated media
suite, packaged-runtime proof, real Electron UI/layout checks, and Windows installed-app upgrade,
pause/merge/quit/update checks all target the same combined source commit. Personal Chrome/Edge
profiles, real accounts and real mako playback remain a separate explicit manual checklist.
