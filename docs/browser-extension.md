# Browser extension integration

Browser integration is included in **Grab 1.7.0** on main and in the stable Windows release. It supports Chrome, Edge and Brave using each active profile. Each intended profile loads the unpacked extension once; no extension-store publication is required.

Install using [the Hebrew guide](INSTALL-WINDOWS-HE.md). For development, use a clean checkout of main, then npm ci, npm run fetch-bin and npm run dev. npm run dist builds a local installer without publishing. Stable releases use the [verified publication workflow](releasing.md).

## One-time browser setup

1. Open GRAB → **הגדרות** → **דפדפן והרחבה**.
2. Click **התקנה** next to the installed browser you want to use. The per-user native host is registered, and the unpacked extension is copied to a stable folder.
3. Open the selected browser's extensions page:

   | Browser | Address |
   | --- | --- |
   | Microsoft Edge | `edge://extensions` |
   | Google Chrome | `chrome://extensions` |
   | Brave | `brave://extensions` |

4. Enable **Developer mode**, click **Load unpacked**, and select the folder displayed in GRAB. By default it is `%LOCALAPPDATA%\Grab\browser-integration\extension`.
5. Keep that folder in place. Pin the extension if you want its toolbar button.
6. Return to GRAB and click **בדוק חיבור**. The chosen browser/profile must show **מחובר**.
7. Repeat for additional browsers/profiles. Adding a second browser preserves the first browser's setup.

The shipped GRAB/Electron executable runs the native host; installed users do not need a separate Node.js or Python installation. Normal extension use does not require enabling remote debugging. The older CDP path remains available for browsers that have never been set up with the extension.

The application can prepare the files and native registration. Loading/enabling the unpacked extension is a browser-controlled manual step.

## Choosing the browser

The route follows the intake automatically: ordinary paste or extension Send, without a dropdown beside the paste field. Extension Send uses the sending browser/profile. For a session-bound job without a sending browser, the effective choice is: **saved site rule → saved default → initial installed-browser suggestion**. A missing selected browser/profile causes an explicit error; GRAB does not silently move the job to another session.

- A new configuration includes `mako.co.il → Edge`, including actual subdomains. It does not select Edge for a different website whose URL merely contains that text.
- Edit/remove the rule in Settings. It does not force Edge for other sites.
- Select the general default in Settings for jobs that require a session without a sending browser. It does not affect ordinary pasted links.
- If multiple profiles connect, select the intended one and give it a useful alias. Profile labels are aliases, not verified Windows profile-folder names.
- Open a remembered disconnected profile yourself if needed. GRAB will not substitute another signed-in profile.

“Detected/installed browser” means its executable exists. “Connected” means the actual extension connection is live. “Not connected now” alone does not prove an extension is missing.

## Both workflows

**Paste a URL:** paste directly into Grab; no route/browser selection is needed. YouTube/public links use the direct extractor with no extension or browser dependency. Failed ordinary lookups do not silently switch to the signed-in browser. For an account-dependent or complex embedded page, send it from the extension. Mako retains its Edge-player exception. A browser-assisted job uses the selected extension session, shows discovery/validation phases, and can be cancelled. If the player needs a click, use **פתח את הנגן**, start playback in the selected browser, and leave the job running within its deadline.

**Send to GRAB:** while GRAB is running, open a video page in a configured browser, open the extension popup, and click **שלח ל־Grab**. If multiple candidates exist, choose the intended video. The download queues and starts automatically after discovery, without choosing a route in Grab. Acceptance means the request joined the queue; completion is reported only after an actual output file passes verification. The sending session is preserved even when GRAB's default is a different browser.

Existing user tabs are not reloaded or closed. Fresh re-probes use job-owned temporary tabs. A signed source that expires/refuses access receives at most one fresh discovery in the same session, bypassing the existing cached candidate. Rate limiting is passed back to queue backoff rather than treated as session expiry.

## Repair, remove, and development commands

**תיקון** updates the stable extension folder and native registration. Reload the extension in the browser afterwards when its code/version changed, then test the connection. Registered browsers follow a moved/upgraded GRAB runtime during startup repair. Grab 1.7.0 requires extension **1.1.3**. In Brave, open `brave://extensions` and Reload after Repair. Chrome and Brave share the supported Windows native-host key; the host identifies the actual launching browser from its parent processes. Repair migrates the old unused BraveSoftware key.

For a development checkout, the following Windows commands use the same setup implementation:

```powershell
npm run browser:setup -- install edge
npm run browser:setup -- install chrome brave
npm run browser:setup -- repair
npm run browser:setup -- health
```

To remove it, first remove/disable the extension in each browser, then run:

```powershell
npm run browser:setup -- uninstall
```

Only GRAB's own registrations and integration folders are removed. Saved browser preferences are retained. Development commands require the repository's npm environment; the installed application performs setup through its UI.

## Troubleshooting

| Result | Action |
| --- | --- |
| Browser unavailable | Install the selected supported browser or explicitly select another one. |
| Extension not connected | Open the intended profile, verify the extension is enabled, and use its reconnect button or GRAB's connection test. |
| Host/registration/ID problem | Click **תיקון**, load/reload the displayed extension folder, and retest. |
| Wrong profile / several profiles | Choose the intended connected profile in Settings; open a remembered profile if it is closed. |
| Playback action required | Open the player from the queue row and start playback before the discovery deadline. |
| No video found / timeout | Check that the exact page plays in that selected profile, then retry. |
| Session expired / refused source | Refresh sign-in in the browser and retry the original page URL. |
| Rate limited | Wait, then explicitly resume the affected site. Switching browsers is not an automatic retry. |
| Engine failure after discovery | A found media URL is not sufficient evidence of a downloadable source; inspect the stated engine error. |
| Protected media | DRM/license extraction is unsupported. |

Settings expose bounded connection/discovery times. Download inactivity has its own watchdog; a valid long download is not limited to the short discovery deadline. Cancel cleans up job-owned work while preserving normal browser windows/tabs.

## Verification

```powershell
npm test
npm run test:media
npx playwright install chromium
$env:GRAB_REQUIRE_EXTENSION_TEST='1'
npm run e2e:extension
npm run dist -- --publish never
$env:GRAB_PACKAGED_DIR='release/win-unpacked'
npm run test:package
```

`npm test` runs browser selection/setup, protocol, session separation, deadlines, cancellation, and existing regression checks. Media integration may skip when engines are absent; `test:media` requires the real engines.

`e2e:extension` loads the real unpacked extension in throwaway unbranded Chromium, exercises the real Native Messaging host and desktop hub, and downloads generated session/header-bound HLS through BrowserService and yt-dlp into a verified MP4. It covers playback-required, existing tabs, redirects, multiple profiles, cancellation, browser startup and worker/host restart. It never uses personal browsing profiles. The required-test flag makes missing prerequisites a failure instead of a misleading skip.

The workflow also downloads hash-pinned portable Brave into a disposable runner and runs `e2e/brave-connection.cjs`. This must reproduce the old ignored-key failure, repair it, identify real Brave separately from concurrent Chromium, answer Check connection and automatically download authenticated generated HLS sent from Brave while Chrome is the saved default. It never changes a personal profile or ships the test browser.

The package check inspects the actual `app.asar` and unpacked assets, installs from those resources, and starts the host using `Grab.exe` with no system Node/Python on PATH.

The **Browser integration** GitHub Actions workflow runs Linux/Windows checks, real Windows Chromium/engine tests, and package verification; it produces a test-installer artifact and does not publish a release. Treat only a completed successful workflow as verification evidence.

### Personal Windows and mako checklist

- [ ] Install/connect the extension in the actual Edge profile used for mako.
- [ ] Leave Chrome as the general default and verify that the mako rule selects Edge while other sites keep Chrome.
- [ ] Paste a fresh real mako page and verify the final downloaded file plays with sound.
- [ ] Repeat with an existing tab; verify that it remains open and is not reloaded.
- [ ] If prompted for playback, use the queue action and verify it opens the correct live player.
- [ ] Cancel discovery and a download; verify that the row settles and other tabs stay intact.
- [ ] Connect actual Chrome/Brave profiles and send from each extension; verify its own session is used even if the saved default differs.
- [ ] Close/reopen GRAB and the browsers; verify saved preferences, connection recovery, and the installed build.

Automated fixtures do not prove access to personal mako sessions or the owner's actual installed profiles. Those checks remain manual until performed on that Windows PC.

## Stable release

Version 1.7.0 combines the audit branch, the media request-context fixes and the browser extension. The main-process DownloadCoordinator owns both paste and Send-to-GRAB jobs; private media URLs, headers and cookie handles never enter renderer snapshots or queue.json. Browser/profile choices survive restart. Cookie acquisition errors fail before the extractor is called; each disconnected extension profile loses only its own vault handles. The pinned engines, process-tree shutdown, verified output and upgrade checks remain enabled.

See [Hebrew installation](INSTALL-WINDOWS-HE.md) and [desktop checks](windows-manual-checklist.md). The installer and checksums are in the stable GitHub release; publication requires CI, Browser integration and Windows verify on the same main commit.
