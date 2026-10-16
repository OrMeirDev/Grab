# 0003 — Enforce the browser's cookie boundary inside the download process

Status: implemented on the hardening branch; installed Windows and real-account release gates remain mandatory.

## Problem

Netscape jars preserve `hostOnly` on disk, but Python's default policy sends such cookies to child hosts.
Filtering cookies before a run cannot constrain later redirects. yt-dlp also serializes host-only cookies
with a Domain attribute in its info JSON, losing that distinction during reuse. The JSON cache can retain
browser, rotated and anonymous cookie values after the temporary jar has been deleted.

## Decision

Ship one application-owned yt-dlp postprocessor plugin as an unpacked resource. Every lookup and download
clears default plugin search paths, selects only that resource, and explicitly requires `GrabPrivacy`.
yt-dlp resolves the named processor while constructing the downloader, before requesting the site. Missing
files, plugin disablement or incompatible engine APIs therefore stop the run rather than weakening policy.
The pinned binary and native-tools lock are unchanged.

The plugin sets `DomainStrictNonDomain`, preserves existing host-only flags when yt-dlp reloads its own
cookie strings, and uses the verified urllib handler for network requests. Each newly created handler's
cookie jar receives the policy. Cookie records include their exact scope and a per-application-process HMAC
so authenticated metadata round trips cannot widen anonymous/rotated cookies or inject unauthenticated
cookie records. The signing key and complete info JSON stay in process memory; neither is put in argv,
diagnostics or persisted state. HMAC protects context integrity, not other processes running as this user.

The disk cache contains only randomly named lifecycle markers, with no metadata, URL hashes, signed URLs,
cookie/authorization fields or private cookie records. A marker is never considered complete without
its live memory entry. Full info is piped to `--load-info-json -` only
when reused. A 32 MiB budget, four-hour timer, job release and startup cleanup bound retention. Cache
capacity failure falls back to a fresh extraction, as a cache write failure already did.

Observed playback headers are preserved for the original media origin. Newly encountered cross-origin
targets receive an origin-only Referer and no replayed Origin; HTTPS-to-HTTP requests receive no Referer.
Cookie headers are recalculated per request. External network downloaders cannot guarantee this policy:
they are refused when cookies or contextual authentication/playback headers are present. Native HTTP/HLS
downloaders remain available; FFmpeg local remux/conversion is unaffected.

Application-owned Electron sessions drop only the optional Grab/Electron product UA tokens and disable
both spellchecking and dictionary languages. Captured Chrome/Edge/Brave UAs remain unchanged. Updater
requests use a common non-device UUID through the upstream requestHeaders API; default update checks
remain enabled and the existing opt-out/manual checks remain available.

## Verification and limits

`tests/privacy-engine.integration.test.cjs` runs the actual pinned binary against a synthetic receiving
server: exact/child/deep/unrelated hosts, redirects, header minimization, metadata scope restoration and
mandatory-plugin failure. Storage tests verify that secrets stay off disk/argv and survive private stdin.
Windows CI must exercise the standalone `.exe`, unpacked plugin resources, restrictive ACLs and installer
upgrades. Personal Chrome/Edge/Brave, members-only content and Mako need authorized installed-app checks.

Private yt-dlp networking methods are intentionally used because no CLI flag enforces the policy. An
in-app engine update must pass these tests before support is claimed; incompatibility must remain a
failure with no unguarded retry. Providers requiring a different handler/external network downloader may
be unsupported under this policy. This controls unnecessary disclosure; it provides no anonymity or
guarantee against server-side attribution.
