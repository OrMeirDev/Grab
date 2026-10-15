# Playback request context

Some HLS delivery services bind their access tokens to playback request headers. In the
reported Mako case, a signed playlist returned HTTP 403 with only Referer/Origin; replaying
the originating browser's exact User-Agent as well downloaded the complete 43:07 episode.
This manual result is evidence for the regression, not a live verification of this branch.

## Implementation

- The hidden Electron probe captures actual `onSendHeaders` values and returns each
  candidate with its own User-Agent, Referer and Origin. It uses its runtime User-Agent
  instead of a fixed Chrome version. Relevant anonymous-session cookies retain their
  existing domain/path scope through temporary cookie jars.
- Mako page URLs (`mako.co.il` and its subdomains) use the existing Edge profile for the
  authorized browser lookup, guide and connection check. Other sites keep the Windows
  default browser. Missing Edge access asks for Edge; it does not silently try Brave.
  Browser connections are cached per endpoint so overlapping Edge/default-browser work
  cannot borrow or disconnect each other's session.
- The authorized browser probe correlates `requestWillBeSentExtraInfo` with
  request IDs scoped to each CDP session. Out-of-order ExtraInfo and redirected request
  IDs are handled without borrowing another request's context.
- Analyze IPC returns the selected candidate's context. The queue forwards it unchanged
  to start IPC and yt-dlp, which also uses it for variant playlists and fragments.
  Captured absent Referer/Origin values remain absent; Cookie/Authorization are never
  promoted to global command-line headers.
- Known signed-URL expiry fields shorten cached-info freshness. Signed URLs are passed
  without decoding/re-encoding. Cache files are unique per lookup and created with mode
  0600 where supported.
- A 403 from an old existing-tab candidate can trigger one fresh lookup in a background
  tab in that same authorized context. The user's tab is not navigated or reloaded.
  The renderer's existing single automatic download retry remains unchanged.
- A persistent 403 is reported as a server refusal, not an internet outage, missing video,
  or proof of DRM. Error URLs redact query values and Akamai path tokens.

## Verification

`npm test` covers CDP event ordering, request isolation, IPC context/cookie lifetime,
expiry, redaction, bounded refresh, cancellation, Mako-only Edge routing and independent
Edge/default-browser connections. Routing is tested with an isolated Windows registry/profile
fixture, including a Brave default and lookalike domains. Three request-context regression cases were run
against the original implementation and failed before the fix.

`npm run test:media` requires yt-dlp, ffmpeg and ffprobe on PATH. It generates a short
H.264/AAC fixture and serves HLS on loopback with an exact encoded signature plus required
playback headers. It verifies a missing-UA 403, two concurrent contextual downloads through
the real analyze/start handlers and downloader (including cached info), all fragment
requests, an ordinary MP4 download, and video/audio output with ffprobe.

`npm run e2e:media-context` additionally runs the actual hidden Electron probe against a
blob player that fetches signed HLS through XHR/fetch. The first extractor miss is forced
to exercise the fallback, while probe capture, candidate analysis, start IPC and media
download are real. This uses a disposable profile and generated local media only.

Windows/Edge integration and a live Mako download inside GRAB require separate
verification on a suitable machine and authorized session. A green fixture check does not
establish that a remote site's bot protection will accept a fresh session.
