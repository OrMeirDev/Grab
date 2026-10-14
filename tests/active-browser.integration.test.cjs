// The signed-in-browser lookup (pageprobe.cjs + browser-session.cjs) against a real Chromium over
// the DevTools protocol, with a local fixture site. Checks what mocks can't: an exact open tab is
// scanned without navigating, playing or closing it; a background tab Grab opens is closed again;
// the page's HttpOnly cookie reaches the domain-scoped jar; the player's request context is kept.
//
// Uses a throwaway profile (never the user's). Skipped when no Chromium/Chrome is installed; set
// GRAB_TEST_CHROME to a browser executable to choose one. Runs once per installed browser (Linux:
// Chromium; Windows: Chrome, Edge, Brave when present). Not a substitute for the Windows checks
// with a real signed-in Chrome/Edge/Brave profile (see docs/handoff.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { testBrowsers, killTree, removeProfile } = require('./helpers/browsers.cjs');

const BROWSERS = testBrowsers();
if (!BROWSERS.length) test('active browser (no Chromium-family browser installed)', { skip: 'no Chromium found' }, () => {});

for (const B of BROWSERS) {
test(`active browser (${B.name}): exact tab reused untouched, own tab closed, cookies and context kept`, { timeout: 120000 }, async () => {
  const site = await require('./fixtures/media-site.cjs').start();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-chrome-'));
  const pageUrl = site.base + '/watch';
  const chrome = spawn(B.path, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', pageUrl], { stdio: 'ignore' });
  const browserSession = require('../electron/browser-session.cjs');
  const { findMedia } = require('../electron/pageprobe.cjs');
  const endpointFile = path.join(profile, 'DevToolsActivePort');
  try {
    for (let i = 0; i < 200 && !fs.existsSync(endpointFile); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(endpointFile), 'Chromium wrote its DevTools endpoint');
    const connect = () => browserSession.connectBrowser({ endpointFile });
    const cdp = await connect();
    const pages = async () => (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
    for (let i = 0; i < 100 && !(await pages()).some((t) => t.url === pageUrl); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500)); // the user's tab has loaded its player
    const before = await pages();
    const userTab = before.find((t) => t.url === pageUrl);
    assert.ok(userTab, 'the page is open in a tab');
    const requestsBefore = site.log.filter((l) => l.url === '/watch').length;

    // 1. The exact open tab is scanned as it is.
    const reused = await findMedia(pageUrl, { connect, timeoutMs: 3000 });
    assert.equal(reused.reusedTab, true);
    const after = await pages();
    assert.equal(after.length, before.length, 'no tab opened or closed');
    assert.equal(after.find((t) => t.targetId === userTab.targetId)?.url, pageUrl, 'the user tab is still there, at the same address');
    assert.equal(site.log.filter((l) => l.url === '/watch').length, requestsBefore, 'the user tab was not reloaded or navigated');
    assert.ok(reused.candidates.some((c) => c.url === site.base + '/media/clip'), reused.candidates.map((c) => c.url).join(' '));
    await browserSession.withSessionCookies(reused.cookieRef, async (file) => {
      assert.match(fs.readFileSync(file, 'utf8'), /#HttpOnly_127\.0\.0\.1\tFALSE\t\/\tFALSE\t0\tplay\tgranted/);
    });

    // 2. Another page of the same site: a background tab in the same context, closed afterwards.
    const other = await findMedia(site.base + '/other', { connect, timeoutMs: 9000 });
    assert.equal(other.reusedTab, false);
    const source = other.candidates.find((c) => c.url === site.base + '/media/other.mp4');
    assert.ok(source, other.candidates.map((c) => c.url).join(' '));
    assert.equal(source.requestContext.referer, site.base + '/other');
    assert.ok(source.requestContext.userAgent);
    for (let i = 0; i < 50 && (await pages()).length !== before.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await pages()).map((t) => t.targetId).sort(), before.map((t) => t.targetId).sort(), 'only the tab Grab opened was closed');
    assert.equal(cdp.listenerCount('event'), 0);
  } finally {
    browserSession.disconnectBrowser();
    await killTree(chrome);
    await site.close();
    await new Promise((r) => setTimeout(r, 300));
    await removeProfile(profile);
  }
});
}
