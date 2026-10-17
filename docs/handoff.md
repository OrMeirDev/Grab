# Grab 1.7.0 — current state (2026-10-16)

## Unreleased privacy hardening

The hardening branch builds on PR #6 and the privacy changes from PR #5. See
[the findings/status matrix](hardening-status.md) and [ADR 0003](adr/0003-download-network-privacy.md).
Its required extension version is 1.1.4. This work is separate from the published stable installer;
final-head CI, installed Windows checks and real-account compatibility remain release gates.

### Local upgrade follow-up (2026-10-17)

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

[Release process](releasing.md), [release notes](releases/1.7.0.md),
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
