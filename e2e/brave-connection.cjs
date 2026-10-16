// Real portable Brave on a disposable Windows runner. First reproduce the old registration
// failure, then repair and prove Brave/Chrome coexist without mixing their profile identities.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../electron/browser/setup.cjs');
const P = require('../extension/lib/protocol.js');
const { BrowserHub } = require('../electron/browser/hub.cjs');
const { BrowserService } = require('../electron/browser/service.cjs');
const session = require('../electron/browser-session.cjs');
const engine = require('../electron/engine.cjs');
const { Chromium, findChromium, sleep } = require('../test-support/chromium-harness.cjs');
const { createSessionFixture } = require('../test-support/session-fixture.cjs');
const root = path.join(__dirname, '..');
const braveExe = process.env.GRAB_TEST_BRAVE;
const skip = process.platform !== 'win32' ? 'Windows only' : !braveExe || !fs.existsSync(braveExe) ? 'no portable Brave' : false;
if (process.env.GRAB_REQUIRE_BRAVE_TEST === '1' && skip) throw new Error('Required Brave test cannot run: ' + skip);

async function until(fn, ms = 30000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await fn(); if (r) return r; await sleep(100); }
  throw new Error('Timed out waiting for ' + label);
}

test('real Brave: legacy failure, repair, concurrent Chrome and automatic authenticated Send', { skip, timeout: 240000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab brave proof '));
  const legacyKey = 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\' + P.HOST_NAME;
  const chromeKey = setup.REGISTRY_KEYS.chrome(P.HOST_NAME);
  const chromiumKey = 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\' + P.HOST_NAME;
  const saved = new Map();
  for (const key of [legacyKey, chromeKey, chromiumKey]) { saved.set(key, await setup.windowsRegistry.get(key)); await setup.windowsRegistry.remove(key); }
  const options = { sourceRoot: root, integrationDir: dir, browsers: ['brave'], runtime: process.execPath, appVersion: 'brave-test' };
  const installed = await setup.install(options);
  // The RC3 registration existed only under BraveSoftware, which this browser does not read.
  const manifest = await setup.windowsRegistry.get(chromeKey);
  await setup.windowsRegistry.set(legacyKey, manifest);
  await setup.windowsRegistry.remove(chromeKey);
  const hub = new BrowserHub({ integrationDir: dir, allowedOrigins: [installed.origin], appVersion: 'brave-test' });
  await hub.start();
  const browsers = [];
  let fixture;
  let svc;
  t.after(async () => {
    for (const browser of browsers) await browser.stop();
    svc?.shutdown(); hub.stop();
    for (const [key, value] of saved) { if (value) await setup.windowsRegistry.set(key, value); else await setup.windowsRegistry.remove(key); }
    await fixture?.close();
    await sleep(300); fs.rmSync(dir, { recursive: true, force: true });
  });
  const brave = await new Chromium({ exe: braveExe, extensionDir: installed.extensionDir }).start(); browsers.push(brave);
  const popup = await brave.newTab(`chrome-extension://${installed.extensionId}/popup/popup.html`);
  const message = (payload) => brave.evaluate(popup, `chrome.runtime.sendMessage(${JSON.stringify(payload)})`);
  await t.test('old Brave-only registration produces host_missing and no live instance', async () => {
    const status = await until(async () => { const s = await message({ type: 'popup:status' }); return s?.conn?.errorKind === 'host_missing' ? s : null; }, 30000, 'legacy host_missing');
    assert.equal(status.conn.appOnline, false);
    assert.equal(hub.instances().length, 0);
  });
  await setup.install(options);
  svc = new BrowserService({ ...options, engine, session, getSettings: () => ({ browser: { defaultBrowser: 'chrome', siteRules: [] } }), deps: { isRunning: async () => true } });
  svc.hub = hub; svc.identity = setup.readExtensionIdentity(path.join(root, 'extension'));
  svc.detected = { browsers: [{ id: 'brave', exe: braveExe }, { id: 'chrome', exe: findChromium() }], systemDefault: 'chrome' };
  await t.test('Repair connects as Brave and Check connection answers from that profile', async () => {
    await message({ type: 'popup:reconnect' });
    await until(() => hub.instances().find((i) => i.browser === 'brave'), 30000, 'real Brave identity');
    const result = await svc.test('brave');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.instance.key.startsWith('brave:'));
    assert.equal(svc.state().browsers.find((b) => b.id === 'chrome').instances.length, 0);
  });
  await setup.install({ ...options, browsers: ['chrome'] });
  await t.test('adding Chrome leaves both browsers connected with separate identities', async () => {
    const chrome = await new Chromium({ extensionDir: installed.extensionDir }).start(); browsers.push(chrome);
    await until(() => hub.instances().length === 2, 30000, 'concurrent browser connections');
    for (const kind of ['chrome', 'brave']) {
      assert.equal((await svc.test(kind)).ok, true, kind);
      assert.equal(svc.state().browsers.find((b) => b.id === kind).instances.length, 1);
    }
    assert.notEqual(hub.instances()[0].instanceId, hub.instances()[1].instanceId);
  });
  await t.test('Brave popup send downloads automatically with its session while Chrome is the saved default', async () => {
    const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
    const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
    const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
    const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
    fixture = await createSessionFixture({ env: process.env });
    const login = await brave.newTab(fixture.cdnOrigin + '/login'); await sleep(600); await brave.closeTab(login);
    const page = await brave.newTab(fixture.url('/hls')); await sleep(1500);
    const history = [];
    const runner = createDownloadRunner({ engine, browserSession: session, allocator: new OutputAllocator() });
    const discovery = createDiscoveryService({ engine, browserSession: session, getBrowserService: () => svc,
      hiddenProbe: { findMedia: async () => assert.fail('extension send must keep the active session') } });
    const coordinator = new DownloadCoordinator({ random: () => 0, getSettings: async () => ({ folder: dir, format: 'mp4', quality: 'best' }),
      discover: (url, opts) => discovery.analyze(url, opts), startDownload: (plan, progress) => runner.start(plan, progress),
      hasSession: (ref) => session.hasCookies(ref), recordCompletion: async (entry) => history.push(entry),
      releaseContext: (job) => { if (job.cookieRef) svc.releaseSession(job.cookieRef); if (job.infoFile) fs.rmSync(job.infoFile, { force: true }); },
      reportJob: (ref, report) => svc.reportJob(ref, report) });
    svc.acceptIncoming = async (incoming) => {
      assert.equal(incoming.browserId, 'brave');
      const r = coordinator.add([{ url: incoming.url }], { browser: incoming.browserId, instance: incoming.instanceKey, ref: incoming.ref, sourceId: incoming.sourceId, autoQueue: true });
      return r.added ? 'accepted' : 'duplicate';
    };
    const incoming = (instance, m) => { if (m.type === 'send-to-grab') svc.onSend(instance, m); };
    hub.on('message', incoming);
    try {
      const tabs = await brave.pages(); const target = tabs.find((p) => p.targetId === page); assert.ok(target);
      const tabId = await brave.evaluate(popup, `(async () => (await chrome.tabs.query({})).find((t) => t.url === ${JSON.stringify(fixture.url('/hls'))}).id)()`);
      fixture.clearRequests();
      const ack = await message({ type: 'popup:send', tabId });
      assert.equal(ack.result.status, 'accepted', JSON.stringify(ack));
      await until(() => coordinator.jobs[0]?.status === 'done' || coordinator.jobs[0]?.status === 'error', 60000, 'automatic Brave download');
      assert.equal(coordinator.jobs[0].status, 'done', JSON.stringify(coordinator.snapshot()));
      assert.equal(coordinator.jobs[0].browserPick, 'brave');
      assert.equal(history.length, 1);
      assert.ok(fs.statSync(history[0].file).size > 1000);
      const media = fixture.requests.filter((r) => r.path.startsWith('/media/'));
      assert.ok(media.length > 0 && media.every((r) => r.authorized));
    } finally { hub.removeListener('message', incoming); await coordinator.shutdown(); }
  });
});
