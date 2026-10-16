# Grab 1.7.0 — current state (2026-10-16)

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
for the exact same current main SHA. It downloads the tested Windows bundle, checks its source
commit/tree, every SHA-256, updater SHA-512 and engine lock, then publishes the complete draft
as the latest stable release. The proof artifact records the check URLs and asset digests.

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
