# Grab network privacy audit

Audit date 2026-10-16 · security branch `security/privacy-minimization-20261016` @ `02817d9` · main @ `c647100`
Companion reports: [comparison with main](grab-network-privacy-comparison.md) ·
[regression results](grab-security-regression-results.md) · tools and Windows procedure: [scripts/audit/](../../scripts/audit/README.md)

## Bottom line

1. **On the wire, the security branch sends exactly what main sends.** Every download request we captured
   (direct link, extension-style context, hidden probe, redirect, retry, resume) was byte-for-byte the same
   shape on both revisions. The branch's real gains are **at rest** (history, diagnostics, file modes, what is
   written into the temporary cookie jar) plus an **opt-out** for background update checks.
2. **Four pre-existing disclosures go out over the network that the branch does not touch.** In order of weight:
   - **F02:** the auto-updater attaches a persistent per-install UUID to every update request.
   - **F03:** the hidden probe and renderer announce `Grab/1.7.0 … Electron/44.7.2`, and that User-Agent is replayed into yt-dlp.
   - **F04:** Electron fetches a spellchecker dictionary from Google at startup and again on every hidden-probe lookup. Observed on Linux.
   - **F01:** the lookup cache file keeps the user's **session cookie values** on disk after the cookie jar is deleted.
3. **The branch introduces one correctness regression (F05).** A one-character regex typo in `cookie-vault.cjs`
   makes yt-dlp reject the whole cookie jar for a malformed host-only cookie. It fails closed, without leaking anything.
4. **No Windows evidence exists yet.** This audit ran in a Linux sandbox without an installed Grab or real
   browsers. Everything Windows-specific is **unverified**, and the tools to collect it are provided.

Nothing here makes Grab anonymous. Every destination still sees the source IP, TLS/HTTP fingerprints, the
requested resource and, for authenticated content, the user's account.

## Evidence labels

| Label | Meaning |
| --- | --- |
| **OBSERVED-L** | Captured in this audit on Linux, against the real code of the revision, by the loopback audit endpoint (`diag-endpoint.cjs`) and/or `strace` connect() traces. |
| **OBSERVED-CI** | GitHub Actions on the exact commit. |
| **CODE** | Inferred from source; not observed at runtime. |
| **UNVERIFIED** | Requires Windows / installed app / real browser profile; not run. |

How the Linux evidence was produced (all reproducible with `scripts/audit/`):

- `engine-scenarios.cjs` — the revision's own `engine.cjs` + `BrowserService.rememberSession` + `CookieVault`
  driving the pinned yt-dlp 2026.08.19 against the endpoint; synthetic `*.test` hosts are reached through the
  endpoint acting as an HTTP proxy, HTTPS via a throwaway test CA (one case only).
- `run-real-app.cjs` — the revision's real `electron/main.cjs` (window, coordinator, discovery, hidden probe,
  yt-dlp, history, queue, diagnostics) in a throwaway profile, run under `strace -f -e connect` and with
  Chromium's `--proxy-server` pointed at the endpoint, so **every** Electron request (all network contexts)
  was logged by host and refused. The public test video was downloaded for real through yt-dlp.
- `run-updater-probe.cjs` — the revision's own `electron-updater`, configured as in `main.cjs`.
- `scan-profile.cjs` — what was left on disk, values never printed.

Limits: a dev (unpacked) run has `app.isPackaged === false`, so Grab's **automatic** update checks do not run
there; T07 used the updater directly. The Linux run used Electron's Linux spellchecker; Windows may differ.

## What Grab sends, by flow

| Flow | Process | Destination | Data sent (beyond IP/TLS) | Evidence |
| --- | --- | --- | --- | --- |
| Pasted direct link — lookup | yt-dlp | the media host | `GET <url>` with yt-dlp's standard headers: a **randomized stock-Chrome UA** (Windows NT 10.0, Chrome 145–151 seen, one per run), `Accept`, `Accept-Language: en-us,en;q=0.5`, `Accept-Encoding`, `Sec-Fetch-Mode: navigate`. **No Cookie, Authorization, Referer or Origin.** Connection closed after the headers (64–256 KiB arrived on loopback). | OBSERVED-L (both revisions) |
| Pasted direct link — download | yt-dlp | the media host | Same headers, one full `GET` without `Range`. On a transient 503: one immediate retry. On a cut connection: `Range: bytes=<offset>-` → 206, completed. | OBSERVED-L |
| Pasted link, real public video (HSSMT.mp4, Vercel) | yt-dlp | `mybook-gat0vxna1-…vercel.app` | 2 connections (lookup + download), file **53,961,552 bytes** verified, both revisions. Public, no Vercel authentication, no `Set-Cookie`. | OBSERVED-L (through the sandbox's egress proxy, so TLS contents not visible) |
| Extension-delivered job | yt-dlp | media host (+ observed redirect/segment hosts) | Browser's UA, Referer and Origin **as the browser sent them for that request**; cookies only for the job's scope URLs, re-checked by the desktop (host/host-only/path/Secure/expiry). YouTube sends instead carry the **full `www.youtube.com` cookie set** (page session) | OBSERVED-L for the yt-dlp side (synthetic context); CODE for the browser side; real browsers UNVERIFIED |
| Hidden player probe (pasted page whose video yt-dlp can't see) | Electron (hidden window) then yt-dlp | the page, all its subresources, its media hosts | Electron UA **`… Grab/1.7.0 Chrome/152… Electron/44.7.2 …`**; page cookies set during the probe (throwaway in-memory session) are replayed by yt-dlp; Referer = page URL | OBSERVED-L |
| Renderer thumbnails | Electron (main window) | thumbnail host named by the site's metadata (any `https:` host — CSP `img-src 'self' data: https:`) | `Grab/… Electron/…` UA, `sec-ch-ua*` client hints, no Referer, no cookies; a 1-year `Set-Cookie` from the host was **not** stored or replayed | OBSERVED-L |
| Spellchecker dictionary | Electron (browser process) | `redirector.gvt1.com` (Google) | `GET …/en-us-10-1.bdic` at startup and **once per hidden-probe lookup** (each probe is a fresh in-memory session). 451,968-byte file written to `<userData>/Dictionaries/` when allowed | OBSERVED-L; Windows UNVERIFIED |
| Auto-update check | Electron `net` (electron-updater 6.8.9) | `github.com` (GitHub provider; redirects to GitHub's release CDN not observed) | `User-Agent: electron-builder`, **`x-user-staging-id: <persistent UUID>`** (same on every check and across restarts; stored in `<userData>/.updaterId`) | OBSERVED-L (headers against a loopback feed; destination host against the real config); packaged timing CODE |
| Explicit engine update | yt-dlp `-U` | GitHub (yt-dlp releases) | only on the user's click; yt-dlp's own update request | CODE |
| Idle (no paste, 300 s) | all | none | **0 application requests** besides the startup dictionary fetch (dev run; no auto-update in dev) | OBSERVED-L |
| Extension ↔ desktop | native host | loopback / named pipe | local only; not network-visible | CODE + OBSERVED-CI (bridge tests) |

## Scenario results

**T01 — idle 300 s (OBSERVED-L, both revisions):** the only connection was `CONNECT redirector.gvt1.com:443`
~0.1 s after the window opened (F04). No update check (dev build), no telemetry, no browser connection. `strace`:
no non-loopback `connect()` from any process. Packaged behavior: CODE — the security branch checks for updates
3 s after load and every 4 h unless *Settings → automatic update checks* is off (F02 applies to each check);
main always checks. **UNVERIFIED on Windows.**

**T02 — pasted direct MP4 (OBSERVED-L, both revisions):** full download of the public video, **53,961,552 bytes**,
no browser or extension involved, 2 requests (lookup + download). No Cookie, Authorization, Referer or Origin.
UA = yt-dlp's randomized stock-Chrome string (not Grab-identifying). Retry and `Range` resume behave as
described above. **UNVERIFIED on Windows** (same yt-dlp release, Windows build).

**T03 — browser extension (CODE + OBSERVED-L for the desktop side; real browsers UNVERIFIED):** compared with T02,
an extension job additionally sends the browser's own UA, the observed Referer/Origin, and the scoped cookies
the browser would send to the media URL (or, for YouTube, the page-session cookies). Captured with a synthetic
context: cookies `mediasession`, `sitewide` (both in scope) reached the media host; nothing else. Chrome,
Edge and Brave runs were not possible here. CI ran the real extension in Chromium and portable Brave
(OBSERVED-CI, authenticated download passed).

**T04 — cookie scope isolation (OBSERVED-L):**

| Check | Result (security branch) | main |
| --- | --- | --- |
| Host-only stays host-only | ⚠️ not sent to a sibling (`cdn.`), the parent or look-alike hosts — **but sent to subdomains of its own host** (F16; corrected 2026-10-16, the first version of this report did not test subdomains) | same |
| Domain cookie not sent to unrelated domains | ✅ `.unrelated.test`, `.audit.test` (look-alike suffix) dropped by the desktop filter | yt-dlp didn't send them, but **main wrote them into the jar** |
| Path restriction (`/media` vs `/account`, `/med` prefix trap) | ✅ dropped before the jar | written into the jar; not sent by yt-dlp |
| Secure not over HTTP | ✅ dropped before the jar; over HTTPS the Secure cookie reached its own host only | written into the jar; not sent |
| Expired rejected | ✅ dropped before the jar | written into the jar |
| Redirect to an unrelated host | ✅ no cookies at `other-site.test`; **Referer (full page URL) and Origin were forwarded** to it (F06) | same |
| Forgotten/expired handle | ✅ `contextExpired`, zero requests | same |
| One browser's cookies in another browser | ✅ by unit/integration tests (`two profiles never share…`, `disconnect drops only that extension profile session…`); not observed live | same tests |
| Canceled/completed jobs | ✅ real app: jar `grab-cookies-*/cookies.txt` and `grab-info/*.json` existed during the download and were gone 3 s after *remove*; nothing left at exit | same |
| Malformed `hostOnly:true` + `.domain` cookie | ❌ **jar rejected by yt-dlp → lookup fails, zero requests** (F05) | widened to domain scope, sent to `cdn.` and the parent domain |

**T05 — authenticated content: UNVERIFIED.** No authorized account or test video was available. The synthetic
T03/T04 runs show the mechanics; they are not a substitute.

**T06 — diagnostics and persistence (OBSERVED-L, after the real-app run):**

| File | security branch | main |
| --- | --- | --- |
| `history.json` / `.bak` | signed pasted link (`?token&Expires&sig`) **not stored**; other links stored in full (by design) | **signed link stored with its token**; scanner: 3 signed-query hits |
| `logs/diagnostics.log` | origin only (`https://host`) | scheme+host+path (query stripped) |
| `queue.json` / `.bak` | no secrets | no secrets |
| File modes (POSIX) | `0600` for history/queue/diagnostics; `logs/` dir `0755` | `0644`, `logs/` `0755` |
| Temp `grab-cookies-*` | removed after each run/cancel; none at exit | same |
| Temp `grab-info/*.json` | **contains session-cookie values while the job lives** (F01); removed on completion/removal and at next start | same |
| `.updaterId` | persistent UUID (F02) | same |
| Windows ACLs | **UNVERIFIED** (the test `Windows: the cookie jar folder is not readable by other users` is skipped off Windows; `windows-verify.yml` not run) | — |

**T07 — update traffic (OBSERVED-L via the updater's own code):**
- **Background checks:** the security branch gates them on `settings.automaticUpdateChecks` (default on); unit test passes. Packaged runtime is UNVERIFIED.
- **Manual "Check for updates":** unaffected by the setting (CODE).
- **Destination:** `github.com` (`OrMeirDev/Grab` releases).
- **Headers:** `User-Agent: electron-builder` and the persistent `x-user-staging-id` (F02). `autoDownload` is off, so nothing downloads without a click.
- **Explicit engine update:** `yt-dlp -U` against GitHub, only on click (CODE).

## Findings

Priorities: P0 credential leak / cross-origin or cross-session exposure · P1 unnecessary sensitive disclosure ·
P2 optional metadata minimization · P3 docs/diagnostics/correctness. "Before" = main `c647100`, "After" = security `02817d9`.

| ID | Scenario | Observed data | Destination | Before | After | Risk | Recommended change | Evidence |
|---|---|---|---|---|---|---|---|---|
| **F01** P1 | T03/T04/T06 | yt-dlp's `-J` output, cached as `%TEMP%\grab-info\<sha1>-<uuid>.json`, contains the session cookies' **values** (`"cookies": "name=value; Domain=…"` per format) | local disk (per-user temp) | present | present | Session cookies outlive the deleted jar for as long as the job waits (ready/queued/paused, up to the 4 h info age); readable by anything running as the user; contradicts "cookies live only in CookieVault" | Before writing the info file, remove the cookie pairs that came from the browser jar (they are re-supplied by the jar at download); keep cookies the site set during the lookup. Verified: with `cookies` fields stripped, `--load-info-json` + jar still sent the session cookie. Stripping *all* `cookies` fields is **not** safe (anonymous jobs may need lookup-time cookies) | OBSERVED-L: `engine-scenarios` T03/T04a `infoFileContainsCookieValues: true` (both revisions); real app `CANCEL:during` shows the file next to the jar |
| **F02** P1 | T07 | `x-user-staging-id: <UUID>` — identical on every check and across restarts, persisted in `<userData>\.updaterId` | `github.com` (update feed) | present on every check (startup+3 s, every 4 h) | present on every check; background checks can be turned off | A stable install identifier linking every check (and IP changes) to one device. Grab does not use staged rollouts (`stagingPercentage` appears nowhere) | Send a constant instead: `autoUpdater.requestHeaders = { 'x-user-staging-id': '<fixed nil UUID>' }` (public API; `computeFinalHeaders` overrides the generated id; local staging comparison unaffected) | OBSERVED-L: `run-updater-probe` (generic feed): header present len 36, same hash across 4 checks / 2 restarts, both revisions; CODE: `AppUpdater.js:387` |
| **F03** P2 | hidden probe, thumbnails | `User-Agent: … Grab/1.7.0 Chrome/152… Electron/44.7.2 Safari/537.36` | every page and subresource the hidden probe loads; the media hosts (yt-dlp **inherits** it as the "player context"); thumbnail CDNs | present | present | Announces the app and exact version to arbitrary third parties; makes Grab traffic trivially fingerprintable and distinguishable from the browser | `app.userAgentFallback = app.userAgentFallback.replace(/ Grab\/\S+/, '').replace(/ Electron\/\S+/, '')` once at startup (verified: applies to fresh probe partitions). Remove the unused, stale `UA` constant in `hidden-probe.cjs` | OBSERVED-L: endpoint log, `HP-hidden-probe` and thumbnail requests, both revisions |
| **F04** P2 | T01, hidden probe | `GET /…/en-us-10-1.bdic` (Hunspell dictionary) | `redirector.gvt1.com` (Google) | at startup and per hidden-probe lookup | same | Third-party contact unrelated to downloading; repeats per probe (fresh partition each time) | `session.defaultSession.setSpellCheckerLanguages([])` and the same for each probe partition (verified on Linux: stops the request; `setSpellCheckerEnabled(false)` and `webPreferences.spellcheck:false` do **not**) | OBSERVED-L (Chromium-wide proxy: 1 at start + 1 per probe; 451,968-byte file when allowed). **Windows UNVERIFIED** (Windows may use the OS spellchecker) |
| **F05** P3 (correctness, fail-closed) | T04 | jar line `.grab-audit.test<TAB>FALSE…` for `hostOnly:true` + leading-dot domain | — | widened to domain scope (sent to `cdn.` and parent) | **whole jar rejected** (`http.cookiejar` AssertionError) → lookup fails, 0 requests | Lost downloads for that job; no leak. Chrome's API should not produce this shape [Likely] | `cookie-vault.cjs`: `/^\\./` → `/^\./`; add a test for the inconsistent shape | OBSERVED-L: `engine-scenarios` T04b (security fails, main sends) + direct yt-dlp repro |
| **F06** P2 (unknown) | T04c | `Referer: <full page URL>` and `Origin` replayed to **every** host, including an unrelated redirect target; fallback Referer is the full pasted page URL | redirect targets, CDNs | same | same | A browser would usually send only the origin cross-origin (`strict-origin-when-cross-origin`); page paths can identify content/users | **Do not change blindly** (hotlink checks may need it). Measure on real sites first; candidate: origin-only Referer for hosts other than the observed one | OBSERVED-L: `other-site.test` received Referer `http://www.grab-audit.test/watch/42` + Origin |
| **F07** P2 (by design) | T03 | full `www.youtube.com` page-session cookies for YouTube sends, even public videos | youtube.com | same | same | Download attributed to the signed-in account | None without an owner decision (AGENTS.md: sends use the sending profile's session) | CODE: `service.cjs` `pageSession` |
| **F08** — improvement | T06 | signed pasted URL with token | local `history.json` | **stored** | **not stored** (and older records purged on load) | — | keep | OBSERVED-L scan: main 3 hits, security 0 |
| **F09** — improvement | T06 | URL path in diagnostics | local `diagnostics.log` | path kept | origin only, allowlisted fields | — | keep | OBSERVED-L |
| **F10** — improvement | T06 | history/queue/diagnostics permissions | local | `0644` | `0600` (POSIX); Windows relies on profile ACL | — | keep; verify Windows ACLs | OBSERVED-L; Windows UNVERIFIED |
| **F11** — improvement | T04 | out-of-scope cookies (other path, Secure-on-HTTP, expired, unrelated domains) | temp jar on disk | written to the jar (not sent) | dropped before the jar | — | keep (fix F05) | OBSERVED-L T04a |
| **F12** P3 | CI | `instance.browser === 'unknown'` | — | — | 5 of 10 branch runs failed `Browser integration` | Flaky gate, fails closed | Longer/less contended CIM query or retry in `browser-kind.cjs`; separate PR | OBSERVED-CI |
| **F13** P3 | T03 | extension `manifest.json` permission set changed (`tabs` removed) but version still `1.1.3`; setup's stale check compares versions | — | — | — | Existing installs may keep the old permission set until the browser reloads the unpacked extension | Bump the extension version with permission changes; verify on Chrome/Edge/Brave | CODE: `setup.cjs:237` |
| **F14** P3 | T06 | `logs/` directory created `0755` | local | `0755` | `0755` | File names visible to other local users on POSIX (contents are `0600`) | `mkdirSync(..., { mode: 0o700 })` | OBSERVED-L |
| **F15** P3 | process | `windows-verify.yml` not run; no before/after screenshots for the new Settings checkbox; PR bundles seven responsibilities | — | — | — | AGENTS.md gates not met | Dispatch `windows-verify.yml` on the branch; `npm run e2e:screenshots` on Windows; consider splitting | OBSERVED-CI / PR #5 |

| **F16** P1 | T04 | a **host-only** cookie (`example.test`, `FALSE` in the jar — exactly what Chrome reports) is sent by yt-dlp to `media.example.test` and `a.b.example.test` | subdomains of the cookie's host (never unrelated domains, siblings or the parent) | same | same | A browser would send it to the exact host only. yt-dlp uses Python's `http.cookiejar` default policy, which ignores Netscape host-only semantics (`DomainStrictNonDomain` is off) and has no CLI switch. The desktop filter cannot prevent it once a job's own scope includes the cookie's host | Needs a design decision (separate PR): e.g. give yt-dlp host-only cookies only for runs whose hosts equal the cookie host, or a yt-dlp cookie-policy change upstream. Not fixed by the F05 hotfix | OBSERVED-L: `tests/cookie-vault-jar.test.cjs` (last test fails on main, `02817d9` and the hotfix alike) |

No **P0** was observed: no cookie reached an unrelated domain, no credential crossed a redirect to another site, no
session was reused across profiles, and nothing was sent without the session when one was required. F16 is the
exception to browser-exact scope: host-only cookies can reach subdomains of their own host.

## Classification of each observed disclosure

| Disclosure | Class |
| --- | --- |
| Source IP, TLS/HTTP fingerprint, requested URL (incl. signed query when pasted) | Required by HTTP/networking |
| yt-dlp randomized Chrome UA, `Accept*`, `Sec-Fetch-Mode` | Required by HTTP (a UA is expected); not identifying |
| `Range` on resume, one retry on 503, the lookup request before the download | Required by HTTP / destination; the lookup's partial body is wasteful, not sensitive |
| Browser UA/Referer/Origin replayed for extension jobs | Required by the destination service (playback context) — keep |
| Scoped session cookies for extension jobs | Required only for authenticated content |
| YouTube page-session cookies on every YouTube send | Required only for authenticated content — applied to all sends by product decision (F07) |
| Referer/Origin forwarded to cross-host redirects and CDNs | Unknown — needs further testing (F06) |
| `Grab/<ver> Electron/<ver>` UA tokens | **Optional and removable** (F03) |
| `x-user-staging-id` | **Optional and removable** (F02) |
| Google dictionary fetch | **Optional and removable** (F04) |
| Update check itself | Optional (user can disable on the security branch); recommended on by default for security fixes |
| Thumbnail fetch (IP + UA to the thumbnail host) | Optional, low value to remove; F03 removes the identifying part |
| Session cookie values in `grab-info` cache | **Optional and removable** (F01, local) |

## Proposed changes (Phase 7) — not implemented, awaiting approval

Each would go in its own branch and PR (AGENTS.md: one responsibility per PR), with a regression test and a
repeat of the relevant capture (`run-real-app.cjs --chromium-proxy`, `run-updater-probe.cjs`, `engine-scenarios.cjs`).

| # | Change | Files | Regression risk | Test |
| --- | --- | --- | --- | --- |
| 1 | F05 regex fix | `electron/infrastructure/cookie-vault.cjs` | none known | unit: inconsistent host-only cookie → `FALSE` line with **no** leading dot; real yt-dlp loads the jar |
| 2 | F02 constant staging header | `electron/main.cjs` | staged rollouts would stop working (unused today) | unit on the configured headers + updater probe shows a constant |
| 3 | F03 drop `Grab/` and `Electron/` UA tokens | `electron/main.cjs` (before first window), `electron/hidden-probe.cjs` (remove dead `UA`) | a site keyed to Electron UA — unlikely; looks more like stock Chrome | E2E `hidden-probe` asserts the UA has no `Grab/`/`Electron/` |
| 4 | F04 no dictionary download | `electron/main.cjs`, `electron/hidden-probe.cjs` | no spellcheck underline in the URL field (not useful for links) | harness with `--chromium-proxy` shows no `gvt1` CONNECT; **must be confirmed on Windows** |
| 5 | F01 strip browser-jar cookies from the cached info JSON | `electron/engine.cjs` | if a site rotates a cookie during lookup the rotated value is kept (correct); needs YouTube members-only + Mako regression run on Windows | engine test: info file contains no jar values; download still sends them |
| 6 | F14 `logs/` mode 0700 | `electron/infrastructure/diagnostics.cjs` | none | extend `diagnostics-privacy.test.cjs` |

Not proposed: removing or trimming User-Agent, Referer, Origin or Range for downloads (F06 needs real-site evidence
first), and anything that would make pasted links depend on the browser extension.

## What remains unverified

- Everything on an installed Windows build: T01 idle with real auto-update, T02 with `yt-dlp.exe`/FFmpeg from
  `bin\`, process attribution of Grab/yt-dlp/ffmpeg/deno, Windows spellchecker behavior (F04), `%TEMP%` and
  `%APPDATA%\Grab` ACLs for a non-admin user, `windows-verify.yml`.
- T03 on real Chrome, Edge and Brave profiles with the extension (including `tabs` removal after reload, F13),
  Mako's Edge path, T05 with an authorized authenticated video.
- HTTPS header contents to real sites (deliberately not intercepted); GitHub's handling of the update request
  beyond the first host.
