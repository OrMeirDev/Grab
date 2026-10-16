# Grab privacy and security hardening

## Threat model and guarantee

Grab can minimize optional telemetry and local retention. It cannot make ordinary HTTP(S) requests invisible to the service that receives them. The remote service will observe connection metadata and required protocol/authentication details. Passing this audit is **not** proof of anonymity, non-attribution, or evasion of automated-client detection.

## Outbound-traffic inventory

| Flow | Destination | Data necessarily exposed | Privacy control / validation |
| --- | --- | --- | --- |
| Paste-link metadata and download (yt-dlp / FFmpeg) | Video website and media CDN | Source address, destination, requested resource, protocol fingerprints, required headers and any authorization | The direct-link flow does not require browser connection. Compare captures with/without session and record request counts. |
| Browser extension observation | Browser-internal API only | Media URLs and limited playback context kept in extension session storage | Time-bounded per-tab observations; check host permissions and navigation cleanup. |
| Extension native messaging | Local browser native host -> desktop loopback/pipe | Extension instance ID, browser kind, metadata and scoped cookies when explicitly requested | Local-only authenticated channel; avoid mistaking local device identifiers for external telemetry. |
| Browser-assisted media download | Video website and media CDN | IP, signed resource URL, User-Agent, Referer/Origin when needed, scoped session cookies | Inspect domain/path scoping and redirect handling. The service may identify the signed-in account. |
| Application updater | GitHub releases | Source address and update requests | Installed app checks updates after startup and periodically; explicitly document this connection. |
| Explicit yt-dlp update | GitHub releases | Source address and update requests | Run only on explicit action; inspect downloaded executable and version. |
| Hidden-page probe | Page, player frames, assets and media endpoints | Browser-generated HTTP requests including third-party page resources | Prefer visible capture in an authorized environment; distinguish this traffic from direct downloads. |

## Evidence from code review

- `electron/engine.cjs`: yt-dlp is launched with `--ignore-config`, and contextual cookies/User-Agent/Referer/Origin can be sent when needed.
- `electron/application/discovery-service.cjs`: ordinary pasted links first use direct extraction, and browser context is job-scoped.
- `extension/background.js`: webRequest observation is restricted to media-like traffic; tab observations have a TTL, and cookie requests use scoped URLs.
- `electron/infrastructure/cookie-vault.cjs`: cookie snapshots reside in main-process memory and temporary jars are cleaned on normal termination and next startup.
- `electron/main.cjs`: updater checks run automatically after window load and every four hours on packaged builds.
- `electron/infrastructure/diagnostics.cjs`: diagnostic data is now allowlisted and URL data reduced to origin.
- `electron/domain/records.cjs`: secret-bearing URLs are excluded from persistent history.

## Acceptance gates before merge

1. Linux and Windows CI unit suites green, browser integration green, Electron E2E green.
2. No breakage for ordinary pasted links, authenticated browser-extension jobs, Mako Edge rule, cancellation and restart.
3. Compare a Windows network/process trace for ordinary link, extension, auto-updater and explicit update. Record all destination hosts and the reasons for connections.
4. Check browser permissions, cookies path/domain matching and temporary-file ACLs under a non-admin Windows account.
5. Never upload a packet capture, signed URL, cookie jar, or private diagnostic log to a public pull request.
6. Compare server-side activity against Chrome/Edge without treating a successful download as evidence of non-detection.

## Limitations

This code review does not validate live Windows packet contents or network fingerprints. Any further privacy claim requires instrumented runtime tests. The extension's broad host permissions and automatic update checks are known trade-offs; changing them needs a separate functionality review.

## Current code-level cookie boundary

The extension requests browser cookies for specific media URLs and redirects. The desktop
independently checks the returned cookies against scheme, hostname, path boundaries and expiry
before constructing the temporary yt-dlp jar. A `hostOnly` flag is not promoted to domain-wide
scope. Cookies still authenticate the user to the content provider when the provider requires
them; that fact cannot be concealed by changing application logs.

## Local Windows runtime verification

Run only on a test account and a video owned or licensed for testing. Keep all raw captures
and authenticated data on the test machine; do not put them into CI artifacts or public PRs.

1. Install the exact commit from the security branch in a disposable Windows VM/profile.
2. Use Windows Resource Monitor or a local packet-capture utility with process attribution,
   and record the application, yt-dlp, FFmpeg, Chromium and updater process connections.
3. With no download active, record DNS queries and destination hosts for five minutes, including
   application startup and update-check traffic.
4. Download one public video using a pasted URL, with no browser integration. Record destinations,
   request counts and the presence/absence of cookies and authentication headers.
5. Using Chrome, Edge and Brave separately, download an owned authenticated test video through
   the extension. Verify session cookies reach only authorized endpoints, and are removed after
   cancellation and completion.
6. Repeat with an owned HLS video with redirects and a separate media CDN; compare the
   receiving server's sanitized logs with the browser playback baseline.
7. Verify non-admin Windows ACLs on cache directories, temporary cookie files and log files.
8. Compare the result against the pre-hardening build using the same URLs, account, machine
   and time window. Report exact observed data and compatibility failures without sharing secrets.

**Stop/go:** no release or merge until the installed-Windows checks above and all GitHub
checks on the exact branch head pass. Network traffic cannot be made invisible to its receiver.

## Latest implementation additions

- Browser manifest no longer requests the redundant `tabs` permission; its existing HTTP(S) host access still allows the documented media discovery and active-tab flow. Validate extension reload on all three browsers.
- Cookie snapshots preserve the extension's `hostOnly` metadata when producing Netscape jars. Desktop validation also checks host, path, scheme and expiration.
- Background application update checks can be disabled explicitly from Settings. The default remains **on** for security, manual update checks remain available, and downloaded update files still require user action.
- These controls do not modify network protocol fingerprints or bypass a service's access restrictions. They reduce unnecessary local permissions or background connections, not server-visible authenticated requests.
