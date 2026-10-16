# Grab privacy hardening — 2026-10-16

Scope: complete the network/privacy audit without changing paste routing, the accepted purple/RTL UI,
browser/profile isolation, or Mako's Edge rule. No native binary upgrade and no DRM changes.

Base: PR #6 `4baebaeb581942dca330f3138081aca3344cac7c`, which includes the unmerged privacy work in PR #5.
These changes are not in the published 1.7.0 installer.

| Finding | Implementation | Verification still required |
| --- | --- | --- |
| F01 session values in metadata | Disk cache excludes cookies, authorization and private cookie records; full metadata is bounded in memory and reused over stdin. Rotated/anonymous cookies retain exact scope. | Installed Windows account/Mako scenarios |
| F02 stable updater identifier | Common non-device staging header through the updater's public API; internal updater logging disabled. | Packaged updater capture |
| F03 optional application UA tokens | Remove only Grab/Electron product tokens from application sessions; captured browser UA stays unchanged. | Real Electron capture and installed Windows |
| F04 dictionary traffic | Disable languages and spellchecker on default and every hidden-probe session. | Linux Electron proxy capture and Windows confirmation |
| F05 malformed cookie jar | Retains PR #6's fix and seven regression tests. | Windows verify |
| F06 cross-origin playback headers | Preserve known media-origin context; unknown targets get origin-only Referer and no replayed Origin; remove cross-origin redirect authorization. | Mako and authorized real-account compatibility |
| F07 account attribution on extension sends | Keep the approved session-preserving behavior. This is required product behavior, not anonymity. | Personal-profile check |
| F08–F11 storage/scope improvements | Retained; temporary/cache/log directories also receive restrictive Windows ACLs. | Standard-user Windows ACL proof |
| F12 browser identity timeouts | One bounded retry only for an actual ancestry-query timeout; unknown never becomes a guessed browser. | Windows extension/Brave checks |
| F13 extension stale detection | Bump unpacked extension to 1.1.4 because its permission set changed. Repair + Reload remain required. | Reload Chrome/Edge/Brave |
| F14 logs directory permissions | Owner-only directory; restrict existing rotated logs on POSIX; do not follow directory symlinks. | Windows ACL checks |
| F15 incomplete validation | Add standalone Windows privacy tests and Windows verify on relevant PRs. | All checks on final commit; installed personal-profile tests and Settings screenshots |
| F16 host-only expansion | Mandatory in-process policy, strict urllib jars, scope-preserving authenticated metadata, explicit refusal of unguarded contextual external network downloaders. | Standalone Windows exe + real account compatibility |

## Validation policy

Do not mark a Linux fixture as a personal-browser test. Do not mark a skipped check as passed. No merge or
release until the final-head CI/browser/Windows workflows and the installed non-admin checks required in
`docs/security-privacy.md` pass. The source branch remains reviewable while those gates are pending.

`tests/privacy-engine.integration.test.cjs` uses only synthetic account material and a local recording
server. Raw captures from a real account must stay on that test computer and must never be committed or
uploaded in public artifacts. The receiving service always sees its own requests and can attribute an
authenticated request to the account; this hardening does not provide anonymity.

Architecture and compatibility constraints: [ADR 0003](adr/0003-download-network-privacy.md).
