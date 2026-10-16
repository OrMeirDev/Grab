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
