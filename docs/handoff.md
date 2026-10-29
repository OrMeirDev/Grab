# Grab 1.9.0 — automatic file detection release (2026-10-29)

The owner explicitly requested a new installer now, and made installer publication part of every
future request to merge to main. This standing scope is recorded in AGENTS.md and releasing.md.
Version 1.9.0 includes automatic video/PDF intake from PR #20 (b6d5bd7), extension 1.3.0,
and the existing UI, direct video routing and per-profile session behavior. Native tools unchanged.

Publication must consume the verified Windows bundle from successful CI, Browser integration
and Windows verify push runs on this exact release source. Earlier feature/PR results are not
substitutes. The owner confirmed manual Whop PDFs on 1.8.1; automatic personal-profile Sends
remain an installed acceptance check, not a claim from the controlled fixtures.

---

# Automatic video/PDF intake — development (2026-10-29)

The owner confirmed the Whop PDF download works on 1.8.1 and requested automatic type detection
in the app and extension. This branch removes the two mode selectors and adds auto discovery,
including mixed video/PDF choices. Extension 1.3.0; no app release/version change in this feature
branch. Existing concrete jobs/history remain compatible. Ordinary platforms retain direct
video extraction; authenticated auto scans stay in the selected profile. No UI font/style changes.

Windows verification: automatic PDF Send from a signed-in Whop page, video Send, a mixed page
with both file types, a pasted opaque public PDF, a mixed batch with video format settings, pause
and restore both types. Repair/Reload extension 1.3.0. Personal-account results remain pending;
controlled fixtures and screenshots do not claim those checks.

---

# Grab 1.8.1 — PDF detection repair (2026-10-28)

The owner requested distribution of the PDF fix to their computer. Stable app version 1.8.1,
extension 1.2.1; native tools unchanged. Publish only after the existing same-source CI,
Browser integration and Windows verify gates. The published update feed carries the installer;
local installation and personal Whop acceptance cannot be claimed from CI alone.

The fix retains bounded per-document PDF observations, recognizes Content-Disposition PDF
filenames, and recovers positively identified PDF Resource Timing entries loaded before the
worker observed them. Opaque unhinted URLs and expired signatures remain limitations. No UI,
font sizes, session routing or native tools changed. See docs/pdf-downloads.md for local checks.

---

# Grab 1.8.0 — PDF release preparation (2026-10-27)

The owner requested a software update on 2026-10-27, authorizing publication of the PDF feature
and a new stable update. Application version: **1.8.0**; extension: **1.2.0**; native tools unchanged.
Release behavior and limitations: [PDF downloads](pdf-downloads.md).

Local validation: 272 compatible-suite tests passed, 26 platform/tool skips. The three existing
native-host suites cannot open Unix sockets on this execution host; full CI must pass before
publication. Renderer build, real HTTP PDF transfer and the Electron hidden-probe check pass.
An isolated headless UI harness replaces only the unavailable singleton-lock API: queue-cooldown
and the full PDF UI flow pass. Before/after screenshots cover all screens and both dialogs;
history/library match, settings differ only in their temporary folder, and intake changes are
intentional. PDF mode/choice rendering has no horizontal overflow at 1347×852.

Publication must use successful CI, Browser integration and Windows verify push runs on the exact
same main release source, then the existing immutable-bundle publication workflow. Personal-profile
PDF Sends, every live website/account, a genuine local standard user and the owner's local in-app
update are not claimed as performed. The installed Windows acceptance checklist remains in the
PDF guide. Installer signing and pinned tools are unchanged.

---

# Grab 1.7.1 — release preparation (2026-10-17)

The owner explicitly requested publication of stable **1.7.1** on 2026-10-17, continuing the
integrated main source `78d9371742dc8c4d70c39f86bd9d0c4eb5591135`. This preparation changes the
application version and current release/upgrade documentation; bundled tools remain pinned.
The extension is **1.1.6**. Publication must consume the verified installer from three successful
main workflows on the exact 1.7.1 source SHA, as described in [releasing](releasing.md).

The owner's installed d024572 build passed three public download runs, including exact-offset
resume and full decode of the resulting files. Source 78d9371 additionally includes PR #15:
resuming a job with a remembered profile starts its closed browser and never substitutes another
profile. PR #15 passed all three workflows, including 29/29 installed-app/upgrade checks after
one Windows verify rerun. A later main Brave Send run reported `sessionExpired`; preserve that
evidence and require the fresh 1.7.1 integration run to pass before publication.

Personal-profile Sends in all three browsers, installed Mako resume with the PR #15 fix, a local
genuine standard user and the local in-app updater have not all been completed. These coverage
limits remain explicit; release authorization does not turn them into performed checks. The
installer remains unsigned. The public and synthetic-session acceptance work continues separately.

Current release notes: [1.7.1](releases/1.7.1.md). The historical source notes below describe the
individual hardening candidates and the preceding 1.7.0 release; their earlier authorization/gate
statements do not override the owner's current 1.7.1 publication request.

## Hardening verification history

The hardening branch builds on PR #6 and the privacy changes from PR #5. See
[the findings/status matrix](hardening-status.md) and [ADR 0003](adr/0003-download-network-privacy.md).
Its required extension version is 1.1.6. This work is separate from the published stable installer;
final-head CI, installed Windows checks and real-account compatibility remain release gates.

### Local upgrade follow-up (2026-10-17)

Extension discovery bounds each DOM scan to 1.5 seconds, injects without waiting for document idle,
and reserves discovery time after at most 8 seconds waiting for a job-owned tab to finish loading.
Discarded user tabs are left dormant; other existing tabs are scanned without playback and never
navigated or closed. A pending injection is reused rather than accumulating requests; late results
are ignored. Network observations remain usable when a DOM scan times out. Cancellation stops the
loading wait and only closes the job-owned tab. Controlled-worker regressions cover stalled scans,
discarded tabs, incomplete loads, cancellation and the unchanged total deadline. The Windows real
extension fixture includes a page whose image response never finishes. The owner's intermittent
Mako/Edge cold-start timeout is not yet attributed conclusively: repeat installed cold starts and
resume checks with the updated extension, preserving existing personal tabs and sanitized timings.
The extension version is bumped to 1.1.5 so same-version application upgrades refresh its files;
Reload is still required in each browser before those checks.

Extension 1.1.6 makes a discovery timeout attributable. `progress` and `job-failed` carry an optional
`stage` from a fixed protocol enum: `locating`, `opening`, `waiting_load` or `discovering`. The UI
state is unchanged; waiting for the load event is still shown as discovering. The app keeps the
last valid stage, also when its own timer ends the job. That stage reaches the lookup result as
`jobStage` and diagnostics as an enum-only field; other values are dropped. Protocol version and
permissions are unchanged. The bump makes an installed 1.1.5 report as outdated, so Repair and
Reload are needed. When an installed cold-start timeout recurs, record the lookup's `jobStage`.

Resuming a restored session job whose browser is closed now starts that browser, as a first
connection already did, then still waits only for the remembered profile. Before this, the
installed d024572 candidate failed such a resume with `wrongProfile` after 10 s without starting
Edge (2026-10-17, Mako job paused at 14% and Grab restarted). A running browser is never started
again, and another profile is never substituted. Windows check: with Edge closed, resume a paused
Mako job after restarting Grab, and expect a new lookup through Edge, then completion.

Private native-host runtimes are now content-verified against the installed executable,
runtime files and locales, including same-version/same-size rebuilds. Startup auto-repair
checks the bytes before reusing a connection. A new private copy is staged and verified before
selection; an existing host copy is not overwritten. Verify this with an installed same-version
upgrade and compare hashes of the selected host, DLLs and locales to the installed application.

Diagnostics now reapply the current allowlist to existing logs and numbered rotations at startup,
before a new event is written. Malformed/oversized legacy input is dropped; no unredacted backup is
created. If migration cannot finish, disk logging waits and retries rather than appending to the old
file. Verify the installed upgrade with synthetic old records in both active and rotated logs, and
inspect only sanitized results/counts. The real-engine fixture also releases its cached metadata
through the engine lifecycle, including failed assertions.

The owner's local report confirms public downloads and Mako/Edge, including session reacquisition
after restart, on packaged candidate source 3caa352. Extension sends/sending-profile retention,
real standard-user acceptance and the in-app updater remain unverified locally. These results do not
approve a later candidate automatically. No merge or production release is implied.

The owner confirmed RC4 works well on the desktop and authorized merging all integrated work,
retiring unused branches and publishing the full 1.7.0 release. Stable 1.7.0 retains the approved
RC4 application and extension 1.1.3; this preparation changes versioning, release automation and
documentation. There is no UI redesign or engine upgrade.

## Current behavior

- Paste ordinary public links directly; no browser/extension dependency or route dropdown.
- Send from the extension queues and downloads automatically using that browser/profile.
- Mako retains the Edge rule. Account/session jobs never fall back to anonymous requests.
- Chrome, Edge and Brave use active profiles. Brave and Chrome share the supported Windows host
  registration while process ancestry identifies the actual launching browser.
- The main-owned queue, pause/restore, verified output, cookie vault and process-tree shutdown
  remain in place. Restored jobs are paused until the user resumes.

## Release and verification

[Release process](releasing.md), [release notes](releases/1.7.1.md),
[Windows installation](INSTALL-WINDOWS-HE.md), [extension setup](browser-extension.md).
The Release workflow requires successful CI, Browser integration and Windows verify push runs
for the exact same release source SHA on main. It downloads the tested Windows bundle, checks its source
commit/tree, every SHA-256, updater SHA-512 and engine lock, then publishes the complete draft
as the latest stable release. The proof artifact records the check URLs and asset digests.
Publication-only repairs may resume the tested immutable tag after proving that no shipped input
changed and passing fresh main CI. Source and publication SHAs are recorded separately; see the
release guide for the narrow allowed path list.

Stable installer source `b001f7271485585bbdf396f2457bbb3619512b16` passed
[CI 50](https://github.com/OrMeirDev/Grab/actions/runs/38892306734),
[Browser integration 16](https://github.com/OrMeirDev/Grab/actions/runs/38892306892) and
[Windows verify 29](https://github.com/OrMeirDev/Grab/actions/runs/38892306711), including 29/29
installed-app/upgrade checks. Its eight-file bundle and updater digests were verified after download.

The established RC4 baseline passed CI 47, Browser integration 13 (18 extension checks, 5 actual
Brave checks, 3 real media checks, packaged runtime), and Windows verify 28 (29/29 upgrade and
installed-app checks). Full evidence is in the [archived handoff](archive/handoff-through-1.7.0-rc.4.md).
Stable publication additionally requires fresh checks on main; old green runs cannot substitute.
The owner's smoke approval does not claim every live platform/account scenario was tested.

## Branch retirement

The audit branch and both media branches are ancestors of the unified extension branch.
After successful publication, cleanup retires only these four named branches when they are
ancestors of main, with a deletion lease so new work cannot be removed:

- `claude/modest-pasteur-6315xe`
- `codex/active-chrome-media-20261012`
- `codex/preserve-media-request-context`
- `feature/browser-extension-integration`

All commit history remains reachable from main. The old media PR is superseded by the unified
merge. The cleanup is not a general deletion policy for future branches.

## Boundaries

The installer remains unsigned, as earlier stable versions. Branch protection/signing are
separate owner setup; this release does not require new credentials or change those settings.
DRM work and GRB-17 remain out of scope. Historical audits and candidate instructions live in
[archive](archive/); they do not describe the current installation path.
