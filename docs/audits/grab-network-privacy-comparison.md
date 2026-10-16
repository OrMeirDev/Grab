# Grab network privacy: main vs. security branch

Same machine (Linux audit sandbox), same tools, same pinned yt-dlp 2026.08.19, same synthetic hosts and cookies,
same public test video, run back-to-back on 2026-10-16. Main `c647100` (= merge base; main has not moved) vs.
`security/privacy-minimization-20261016` `02817d9`. Details and finding IDs: [audit report](grab-network-privacy-audit.md).

Windows was not available: this is a Linux before/after. The Windows comparison must be repeated with
`scripts/audit/windows/Run-GrabAudit.ps1` on one machine for both builds.

## Runs compared

| Run | main | security | Tool |
| --- | --- | --- | --- |
| Engine scenarios (T02, T03-equivalent, T04a–e) | `run-main` | `run-sec` | `engine-scenarios.cjs --tls` |
| Real app, 300 s idle + T02 local/remote + signed link + hidden probe + cancel + thumbnail, Chromium-wide proxy, `strace` | `app-main` | `app-sec` | `run-real-app.cjs --chromium-proxy --strace` |
| Updater, generic feed + GitHub config, 2 checks × 2 restarts | `upd-main` | `upd-sec` | `run-updater-probe.cjs` |
| Disk scan after the real-app run | `app-main/scan.json` | `app-sec/scan.json` | `scan-profile.cjs` |

Raw outputs stayed in the audit sandbox (not committed): they contain loopback ports and random synthetic values only,
but the policy is to keep captures local.

## Over the network

| Observation | main | security | Same? |
| --- | --- | --- | --- |
| T01 idle 300 s: application requests | 0 | 0 | ✅ |
| T01 startup: `redirector.gvt1.com` (dictionary) | 1 | 1 | ✅ (F04 in both) |
| Non-loopback `connect()` from any process (`strace`) | none (only endpoint + sandbox egress proxy for yt-dlp → Vercel) | none | ✅ |
| T02 local: requests / headers | 2 GET; no Cookie/Auth/Referer/Origin; yt-dlp random Chrome UA; `Accept-Language: en-us,en;q=0.5` | identical | ✅ |
| T02 remote (public HSSMT.mp4 via Vercel) | done, **53,961,552 bytes** | done, **53,961,552 bytes** | ✅ |
| T02 503 once → retry; cut at 1 MiB → `Range: bytes=1047552-` 206 | file complete, size matches | file complete, size matches | ✅ |
| T03-equivalent: cookies reaching the media host | `mediasession`, `sitewide` | `mediasession`, `sitewide` | ✅ |
| T03-equivalent: UA/Referer/Origin | browser values replayed | identical | ✅ |
| T04a: cookies **sent** to `media.grab-audit.test/media/…` | `path_ok, hostonly_ok, session_cookie, domain_ok, inconsistent_hostonly_dot` | `path_ok, hostonly_ok, session_cookie, domain_ok` | changed (malformed cookie no longer widened) |
| T04b: sibling `cdn.` / parent / look-alike host | sent `domain_wide`, `inconsistent_hostonly_dot` to `cdn.` and parent; nothing to look-alike | **lookup failed, 0 requests** (jar rejected) — F05 | ❌ regression (fail-closed) |
| T04c: cross-host redirect | no cookies at the new host; Referer+Origin forwarded | identical | ✅ (F06 in both) |
| T04d: forgotten handle | `contextExpired`, 0 requests | identical | ✅ |
| T04e: Secure cookie over HTTPS | sent to its host only | identical | ✅ |
| Hidden probe UA (page, media, yt-dlp replay) | `Grab/1.7.0 … Electron/44.7.2` | identical | ✅ (F03 in both) |
| Hidden probe dictionary fetch | 1 per probe | 1 per probe | ✅ (F04) |
| Thumbnail fetch | `Grab/…` UA, no Referer, cookie not stored | identical | ✅ |
| Updater: destination / UA / `x-user-staging-id` | `github.com` / `electron-builder` / persistent UUID | identical | ✅ (F02 in both) |
| Updater: background checks can be disabled | no | **yes** (default on) — unit test only | improvement (packaged run unverified) |

## At rest (local disk)

| Observation | main | security |
| --- | --- | --- |
| `history.json` with a signed pasted link (`?token&Expires&sig`) | **stored with values** (scanner: 3 signed-query hits, markers found in `history.json` and `.bak`) | **not stored**; 0 hits |
| `diagnostics.log` URL detail | scheme+host+path | origin only; only allowlisted fields |
| `history.json`, `queue.json`, `diagnostics.log` modes (POSIX) | `0644` | `0600` |
| `logs/` directory mode | `0755` | `0755` (F14) |
| Temporary jar contents (T04a) | 9 cookies incl. other-path, Secure-on-HTTP, expired | 4 in-scope cookies |
| Temp jar / `grab-info` file after cancel and at exit | removed | removed |
| `grab-info/*.json` session-cookie values while a job lives | present | present (F01) |
| `.updaterId` | present | present |

## Verdict per change on the branch

| Branch change | Effect measured | Kept? |
| --- | --- | --- |
| Desktop cookie scope filter (`cookie-scope.cjs`) | fewer cookie values written to disk; nothing extra sent before either | ✅ keep |
| Host-only preservation in the Netscape jar | correct for well-formed cookies; **broken for the malformed shape by a regex typo** | ✅ keep, **fix F05 first** |
| Signed URLs out of history (+ purge of old records) | confirmed | ✅ keep |
| Origin-only, allowlisted diagnostics | confirmed | ✅ keep |
| `0600` state files, private info dir | confirmed on POSIX; Windows unverified | ✅ keep |
| Background update opt-out | unit-tested; no runtime evidence | ✅ keep; verify packaged |
| `tabs` permission removed | packaged manifest confirmed; browser behavior unverified (F13) | ✅ keep; verify in all three browsers |

**Net:** the branch reduces what Grab **stores**. It does not change what Grab **sends**, apart from optional
update checks. The remaining over-the-wire minimizations (F02, F03, F04) and the at-rest cookie copy (F01) are
pre-existing and are proposed as separate follow-ups.
