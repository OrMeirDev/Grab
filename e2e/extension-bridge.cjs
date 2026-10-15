// End-to-end check of the extension bridge in a REAL Chromium: the unpacked extension is loaded,
// the browser starts the real native host, which connects to the app hub; discovery jobs run
// against a local members-only site. Windows only. Run: npm run e2e:extension
//
// Uses an unbranded Chromium (Playwright's) because branded Chrome/Edge no longer honour
// --load-extension. That makes this evidence for the shared Chromium extension code, NOT proof that
// Edge, Chrome or Brave on this PC are set up: see docs/browser-extension.md for those checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../electron/browser/setup.cjs');
const protocol = require('../extension/lib/protocol.js');
const { BrowserHub } = require('../electron/browser/hub.cjs');
const { discover } = require('../electron/browser/discovery.cjs');
const { pickInstance } = require('../electron/browser/selection.cjs');
const { Chromium, findChromium, sleep } = require('../test-support/chromium-harness.cjs');
const { createSessionFixture, ffmpegAvailable } = require('../test-support/session-fixture.cjs');

const root = path.join(__dirname, '..');
const binDir = path.join(root, 'bin');
const env = { ...process.env, PATH: [fs.existsSync(binDir) ? binDir : '', process.env.PATH].filter(Boolean).join(path.delimiter) };
const skip = process.platform !== 'win32' ? 'Windows only' : !findChromium() ? 'no Chromium found' : !ffmpegAvailable(env) ? 'ffmpeg not available' : false;

const edge = { id: 'chrome', name: 'Chromium (test)', exe: null };
const cfg = { connectMs: 15000, launchGraceMs: 15000, discoveryMs: 40000 };

async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('Timed out: ' + what);
}

test('real Chromium + real extension + real native host + hub', { skip, timeout: 600000 }, async (t) => {
  const fixture = await createSessionFixture({ env });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab e2e '));
  const registry = {
    // The test Chromium reads the "Chromium" registry key; Chrome/Edge/Brave keys are never touched here.
    get: (k) => setup.windowsRegistry.get(k),
    set: (k, v) => setup.windowsRegistry.set(k.replace('Google\\Chrome', 'Chromium'), v),
    remove: (k) => setup.windowsRegistry.remove(k.replace('Google\\Chrome', 'Chromium')),
  };
  const chromiumKey = 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\' + protocol.HOST_NAME;
  const installed = await setup.install({ sourceRoot: root, integrationDir: dir, browsers: ['chrome'], runtime: process.execPath, appVersion: 'e2e', registry });
  const hub = new BrowserHub({ integrationDir: dir, allowedOrigins: [installed.origin], appVersion: 'e2e' });
  const browsers = [];
  let launches = 0;
  const startBrowser = async (opts = {}) => {
    const b = await new Chromium({ extensionDir: installed.extensionDir, ...opts }).start();
    browsers.push(b);
    launches++;
    return b;
  };
  t.after(async () => {
    for (const b of browsers) await b.stop();
    hub.stop();
    await setup.windowsRegistry.remove(chromiumKey);
    await fixture.close();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (name, fn) => t.test(name, { timeout: 120000 }, fn);
  const discoverOn = (instanceKey, url, extra = {}) => discover({
    hub, browser: edge, url, settings: cfg, getInstance: () => ({ instance: hub.instances().find((i) => i.key === instanceKey) }), ...extra,
  });

  // GRAB is started AFTER the browser: the host keeps waiting and connects by itself.
  const first = await startBrowser();
  await sleep(2500);
  assert.equal(hub.instances().length, 0, 'app not started yet');
  await hub.start();
  const instance = await until(() => hub.instances()[0], 30000, 'extension connection after GRAB started');
  assert.equal(instance.browser, 'chrome');
  const key = instance.key;

  // The "signed-in" session: visit /login on the CDN host in the browser.
  const loginTab = await first.newTab(fixture.cdnOrigin + '/login');
  await sleep(800);
  await first.closeTab(loginTab);

  await run('direct MP4 in a video element', async () => {
    const r = await discoverOn(key, fixture.url('/direct'));
    assert.ok(r.candidates.some((c) => c.url === fixture.url('/files/clip.mp4') && c.kind === 'file'), JSON.stringify(r.candidates));
  });

  await run('HLS loaded by fetch behind a blob-backed player, signed URL intact, headers observed', async () => {
    fixture.clearRequests();
    const r = await discoverOn(key, fixture.url('/hls'));
    const c = r.candidates.find((x) => x.kind === 'hls');
    assert.ok(c, JSON.stringify(r.candidates));
    assert.equal(c.url, fixture.mediaUrl('episode1', 'master.m3u8'), 'signed query preserved byte for byte');
    assert.ok(!r.candidates.some((x) => x.url.startsWith('blob:')), 'blob handle never offered as a URL');
    assert.ok(!r.candidates.some((x) => /\.ts(\?|$)/.test(x.url)), 'segments excluded');
    assert.equal(c.context.origin, fixture.pageOrigin);
    assert.ok(c.context.referer.startsWith(fixture.pageOrigin));
    assert.match(c.context.userAgent, /Mozilla/);
  });

  await run('HLS via XMLHttpRequest, DASH and an opaque URL (content-type only)', async () => {
    const x = await discoverOn(key, fixture.url('/xhr-hls'));
    assert.ok(x.candidates.some((c) => c.kind === 'hls'));
    const d = await discoverOn(key, fixture.url('/dash'));
    assert.ok(d.candidates.some((c) => c.kind === 'dash' && c.url.includes('token=t1')));
    const o = await discoverOn(key, fixture.url('/opaque'));
    assert.ok(o.candidates.some((c) => c.kind === 'opaque' && c.url.includes('/stream/9001?sess=abc')), JSON.stringify(o.candidates));
  });

  await run('player inside an iframe on another host', async () => {
    const r = await discoverOn(key, fixture.url('/iframe'));
    assert.ok(r.candidates.some((c) => c.kind === 'hls'), JSON.stringify(r.candidates));
  });

  await run('redirect from the page host to the CDN host is recorded', async () => {
    const r = await discoverOn(key, fixture.url('/play'));
    const c = r.candidates.find((x) => x.kind === 'hls' && x.url === fixture.mediaUrl('episode1', 'master.m3u8'));
    assert.ok(c, JSON.stringify(r.candidates));
    assert.ok(c.redirects.some((u) => u.startsWith(fixture.pageOrigin + '/go/')), 'redirect hop captured: ' + JSON.stringify(c.redirects));
  });

  await run('ads and tracking pixels do not hide the real video; two real videos are reported as plausible', async () => {
    const { rank } = require('../extension/lib/media.js');
    const ads = await discoverOn(key, fixture.url('/ads'));
    assert.equal(rank(ads.candidates).plausible[0].kind, 'hls');
    assert.ok(!ads.candidates.some((c) => c.url.includes('pixel.gif')));
    const two = await discoverOn(key, fixture.url('/two'));
    assert.equal(rank(two.candidates).ambiguous, true);
  });

  await run('page with no video fails with noVideo instead of waiting out the deadline', async () => {
    const started = Date.now();
    await assert.rejects(discoverOn(key, fixture.url('/none')), { kind: 'noVideo' });
    assert.ok(Date.now() - started < 35000);
  });

  await run('existing tab: fresh cached observations are used, no second tab opens, the tab stays', async () => {
    const tab = await first.newTab(fixture.url('/hls'));
    await sleep(2500);
    const before = (await first.pages()).length;
    const phases = [];
    const r = await discoverOn(key, fixture.url('/hls'), { onPhase: (p) => phases.push(p) });
    assert.ok(r.candidates.some((c) => c.kind === 'hls'));
    assert.equal((await first.pages()).length, before, 'no tab opened or closed');
    assert.ok((await first.pages()).some((p) => p.targetId === tab), 'the user tab is still open');
    await first.closeTab(tab);
  });

  await run('cancel mid-discovery closes only the temporary tab', async () => {
    const mine = await first.newTab(fixture.url('/direct'));
    await sleep(500);
    const before = (await first.pages()).map((p) => p.targetId).sort();
    const c = new AbortController();
    const p = discoverOn(key, fixture.url('/none'), { signal: c.signal });
    await until(async () => (await first.pages()).length > before.length, 10000, 'temp tab to open');
    c.abort();
    await assert.rejects(p, { kind: 'cancelled' });
    await until(async () => JSON.stringify((await first.pages()).map((x) => x.targetId).sort()) === JSON.stringify(before), 10000, 'temp tab to close');
    await first.closeTab(mine);
  });

  await run('cookies: only the HttpOnly session cookie for the media host, nothing for hosts outside the job scope', async () => {
    const r = await discoverOn(key, fixture.url('/hls'));
    const c = r.candidates.find((x) => x.kind === 'hls');
    const jobId = r.jobId;
    const inScope = await hub.request(key, 'cookies-request', { jobId, urls: [c.url] });
    assert.deepEqual(inScope.cookies.map((x) => x.name), ['grabsid']);
    assert.equal(inScope.cookies[0].value, fixture.secret);
    assert.equal(inScope.cookies[0].httpOnly, true);
    const outside = await hub.request(key, 'cookies-request', { jobId, urls: ['https://example.org/'] });
    assert.deepEqual(outside.cookies, [], 'URL outside the job scope returns nothing');
    const unknownJob = await hub.request(key, 'cookies-request', { jobId: 'someone-else', urls: [c.url] });
    assert.deepEqual(unknownJob.cookies, [], 'unknown job gets nothing');
  });

  await run('service worker termination and native host crash: the connection comes back by itself', async () => {
    // Stop the extension's service worker the way the browser does when it is idle (the port closes, the host exits).
    const page = (await first.pages())[0];
    const { sessionId } = await first.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await first.send('ServiceWorker.enable', {}, sessionId);
    await first.send('ServiceWorker.stopAllWorkers', {}, sessionId);
    await until(() => hub.instances().length === 0, 20000, 'instance to drop after worker stop');
    // An alarm wakes the worker again (at most about half a minute) and it reconnects without any user action.
    await until(() => hub.instances().length === 1, 60000, 'reconnect after service worker restart');
    const pid = hub.hostPid(key);
    assert.ok(pid > 0);
    process.kill(pid);
    await until(() => hub.instances().length === 0, 20000, 'instance to drop after host crash');
    const again = await until(() => hub.instances()[0], 60000, 'reconnect after host crash');
    assert.equal(again.key, key, 'same profile, same instance id');
  });

  await run('a page whose player needs a click reports playback_required, then continues after the click', async () => {
    const b = await startBrowser({ autoplay: false });
    const second = await until(() => hub.instances().find((i) => i.key !== key), 30000, 'second profile connects');
    const signIn = await b.newTab(fixture.cdnOrigin + '/login'); await sleep(800); await b.closeTab(signIn);
    const phases = [];
    const p = discoverOn(second.key, fixture.url('/needs-click'), { jobId: 'job-click', onPhase: (ph) => phases.push(ph), settings: { ...cfg, discoveryMs: 60000 } });
    await until(() => phases.includes('playback_required'), 40000, 'playback_required phase');
    const tabs = await b.pages();
    const temp = tabs.find((x) => x.url.endsWith('/needs-click'));
    assert.ok(temp, 'temporary tab is reachable');
    assert.equal(hub.sendTo(second.key, 'reveal-tab', { jobId: 'job-click' }), true);
    await b.evaluate(temp.targetId, "document.getElementById('start').click()");
    const r = await p;
    assert.ok(r.candidates.some((c) => c.kind === 'hls'));
    // Two profiles: the first one never saw that job.
    assert.ok(first.cdp, 'first profile still alive');
  });

  await run('GRAB started with the browser closed: it is launched once and the extension connects', async () => {
    for (const b of browsers.splice(0)) await b.stop();
    await until(() => hub.instances().length === 0, 20000, 'instances gone');
    let relaunched = null;
    const r = await discover({
      hub, browser: { id: 'chrome', name: 'Chromium (test)', exe: 'C:\\unused.exe' }, url: fixture.url('/direct'), settings: cfg,
      getInstance: () => pickInstance({ browserId: 'chrome', instances: hub.instances() }),
      deps: { isRunning: async () => false, launch: () => { relaunched = startBrowser(); } },
    });
    assert.ok(relaunched, 'browser launched by the discovery path');
    assert.ok(r.candidates.some((c) => c.kind === 'file'));
    assert.ok(launches >= 3);
  });
});
