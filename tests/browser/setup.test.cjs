const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const setup = require('../../electron/browser/setup.cjs');
const protocol = require('../../extension/lib/protocol.js');
const { BrowserHub } = require('../../electron/browser/hub.cjs');
const { encodeFrame, FrameParser } = require('../../native-host/framing.cjs');

const root = path.join(__dirname, '..', '..');
const IS_WIN = process.platform === 'win32';

function memoryRegistry() {
  const keys = new Map();
  return { keys, get: async (k) => keys.get(k) ?? null, set: async (k, v) => { keys.set(k, v); }, remove: async (k) => keys.delete(k) };
}
const tmpDir = (name = 'grab setup dir') => fs.mkdtempSync(path.join(os.tmpdir(), name + ' '));

test('the extension ID comes from the manifest key and matches the one the host allows', () => {
  const identity = setup.readExtensionIdentity(path.join(root, 'extension'));
  assert.match(identity.id, /^[a-p]{32}$/);
  assert.equal(identity.origin, `chrome-extension://${identity.id}/`);
  // Independent computation from the public key in the manifest.
  const key = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).key;
  const digest = require('node:crypto').createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  const expected = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(identity.id, expected);
  assert.equal(setup.extensionIdFromKey('AAAA'), setup.extensionIdFromKey('AAAA'));
});

test('install registers each chosen browser at its own key, with an explicit origin and a launcher that exists', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = memoryRegistry();
  const result = await setup.install({ sourceRoot: root, integrationDir: dir, browsers: ['edge', 'brave'], runtime: process.execPath, appVersion: '1.2.3', registry });
  assert.deepEqual(result.browsers, ['edge', 'brave']);
  assert.deepEqual([...registry.keys.keys()].sort(), [
    'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.grab.downloader.browser',
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.grab.downloader.browser',
  ]);
  for (const manifestPath of registry.keys.values()) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'com.grab.downloader.browser');
    assert.equal(manifest.type, 'stdio');
    assert.deepEqual(manifest.allowed_origins, [result.origin]);
    assert.ok(!manifest.allowed_origins.some((o) => o.includes('*')));
    assert.ok(fs.existsSync(manifest.path));
    assert.ok(manifest.path.startsWith(dir));
  }
  assert.ok(fs.existsSync(path.join(dir, 'extension', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, 'extension', 'background.js')));
  assert.ok(fs.existsSync(path.join(dir, 'extension', 'lib', 'protocol.js')));
  assert.ok(fs.existsSync(path.join(dir, 'extension', 'icons', 'icon128.png')));
  assert.ok(fs.existsSync(path.join(dir, 'native-host', 'host.cjs')));
  assert.equal(path.dirname(result.extensionDir), dir);
});

test('install is idempotent, repairs a damaged install and removes stale extension files', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = memoryRegistry();
  const args = { sourceRoot: root, integrationDir: dir, browsers: ['edge'], runtime: process.execPath, appVersion: '1', registry };
  await setup.install(args);
  fs.writeFileSync(path.join(dir, 'extension', 'stale-old-file.js'), 'old');
  fs.rmSync(path.join(dir, 'native-host', 'host.cjs'));
  fs.writeFileSync(path.join(dir, 'extension', 'background.js'), 'corrupted');
  await setup.install(args);
  assert.ok(!fs.existsSync(path.join(dir, 'extension', 'stale-old-file.js')));
  assert.ok(fs.existsSync(path.join(dir, 'native-host', 'host.cjs')));
  assert.equal(fs.readFileSync(path.join(dir, 'extension', 'background.js'), 'utf8'), fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8'));
  assert.equal(registry.keys.size, 1);
});

test('uninstall removes only Grab-owned registrations and folders', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = memoryRegistry();
  registry.keys.set('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.someone.else', 'C:\\other.json');
  await setup.install({ sourceRoot: root, integrationDir: dir, runtime: process.execPath, registry });
  assert.equal(registry.keys.size, 4);
  const { removed } = await setup.uninstall({ integrationDir: dir, registry });
  assert.deepEqual(removed.sort(), ['brave', 'chrome', 'edge']);
  assert.deepEqual([...registry.keys.keys()], ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.someone.else']);
  assert.ok(!fs.existsSync(path.join(dir, 'extension')));
  assert.ok(!fs.existsSync(path.join(dir, 'native-host')));
  assert.deepEqual((await setup.uninstall({ integrationDir: dir, registry })).removed, [], 'second run is a no-op');
});

test('adding a second browser preserves the first registration and repairs both on the next install', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = memoryRegistry();
  const args = { sourceRoot: root, integrationDir: dir, runtime: process.execPath, appVersion: '1', registry };
  await setup.install({ ...args, browsers: ['edge'] });
  await setup.install({ ...args, browsers: ['chrome'] });
  assert.deepEqual(setup.readInstall(dir).browsers, ['edge', 'chrome']);
  const report = await setup.health({ ...args, detected: [{ id: 'edge' }, { id: 'chrome' }] });
  for (const id of ['edge', 'chrome']) assert.deepEqual(report.results.find((r) => r.browser === id).problems, [], id);
  fs.rmSync(path.join(dir, 'native-host', 'framing.cjs'));
  assert.ok((await setup.health(args)).results.find((r) => r.browser === 'edge').problems.includes('host_script_missing'));
  await setup.install({ ...args, browsers: ['chrome'], appVersion: '2' });
  assert.ok(fs.existsSync(path.join(dir, 'native-host', 'framing.cjs')));
  assert.equal(setup.readInstall(dir).browsers.length, 2);
});

test('health distinguishes not installed, ID mismatch, missing host, stale version and a live connection', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = memoryRegistry();
  const detected = [{ id: 'edge' }, { id: 'chrome' }];
  const base = { integrationDir: dir, registry, detected, appVersion: '1', sourceRoot: root };
  let report = await setup.health(base);
  assert.equal(report.installed, false);
  assert.equal(report.results.find((r) => r.browser === 'edge').state, 'unknown', 'detected but never set up is unknown, not a failure');
  assert.equal(report.results.find((r) => r.browser === 'brave').state, 'not_detected');

  await setup.install({ sourceRoot: root, integrationDir: dir, browsers: ['edge', 'chrome'], runtime: process.execPath, appVersion: '1', registry });
  report = await setup.health(base);
  assert.deepEqual(report.results.find((r) => r.browser === 'edge').problems, []);

  const edgeManifest = registry.keys.get(setup.REGISTRY_KEYS.edge(setup.HOST_NAME));
  const m = JSON.parse(fs.readFileSync(edgeManifest, 'utf8'));
  fs.writeFileSync(edgeManifest, JSON.stringify({ ...m, allowed_origins: ['chrome-extension://' + 'a'.repeat(32) + '/'] }));
  assert.ok((await setup.health(base)).results.find((r) => r.browser === 'edge').problems.includes('id_mismatch'));
  fs.writeFileSync(edgeManifest, JSON.stringify({ ...m, allowed_origins: ['chrome-extension://*/'] }));
  assert.ok((await setup.health(base)).results.find((r) => r.browser === 'edge').problems.includes('bad_origin'));
  fs.writeFileSync(edgeManifest, JSON.stringify(m));

  fs.rmSync(m.path);
  assert.ok((await setup.health(base)).results.find((r) => r.browser === 'edge').problems.includes('host_missing'));
  await setup.install({ sourceRoot: root, integrationDir: dir, browsers: ['edge', 'chrome'], runtime: process.execPath, appVersion: '1', registry });

  const stale = await setup.health({ ...base, appVersion: '2' });
  assert.ok(stale.results.find((r) => r.browser === 'chrome').problems.includes('stale_version'));
  assert.equal(stale.results.find((r) => r.browser === 'chrome').state, 'setup_problem');

  const hub = new BrowserHub({ integrationDir: dir, allowedOrigins: [] });
  hub.byKey.set('chrome:x', { instance: { key: 'chrome:x', browser: 'chrome', instanceId: 'x', alias: '', extVersion: '1', connectedAt: 1 } });
  const live = await setup.health({ ...base, hub });
  assert.equal(live.results.find((r) => r.browser === 'chrome').state, 'connected');
  assert.equal(live.results.find((r) => r.browser === 'edge').state, 'unknown', 'a missing connection is not proof of a missing extension');
});

test('launcher text keeps paths with spaces and percent signs intact and refuses unsafe characters', () => {
  const text = setup.launcherText({ runtime: 'C:\\Program Files\\Grab\\Grab.exe', hostScript: 'C:\\Users\\a b\\100%\\host.cjs', browser: 'edge', integrationDir: 'C:\\Users\\a b' });
  assert.match(text, /"C:\\Program Files\\Grab\\Grab\.exe" "C:\\Users\\a b\\100%%\\host\.cjs" %\*/);
  assert.match(text, /set ELECTRON_RUN_AS_NODE=1/);
  assert.throws(() => setup.launcherText({ runtime: 'C:\\x"&calc&"\\a.exe', hostScript: 'h', browser: 'edge', integrationDir: 'd' }), /cannot be used/);
});

test('the generated launcher starts the real host through cmd.exe from a path with spaces', { skip: !IS_WIN }, async (t) => {
  const dir = tmpDir('grab launcher dir');
  const hubDir = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = memoryRegistry();
  const result = await setup.install({ sourceRoot: root, integrationDir: dir, browsers: ['edge'], runtime: process.execPath, appVersion: '1', registry });
  const hub = new BrowserHub({ integrationDir: hubDir, allowedOrigins: [result.origin] });
  await hub.start();
  t.after(() => hub.stop());
  const manifest = JSON.parse(fs.readFileSync(registry.keys.get(setup.REGISTRY_KEYS.edge(setup.HOST_NAME)), 'utf8'));
  // The browser launches the path from the manifest with the extension origin as the first argument.
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${manifest.path}" ${result.origin} --parent-window=0"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const received = [];
  const parser = new FrameParser({ onMessage: (m) => received.push(m) });
  child.stdout.on('data', (d) => parser.push(d));
  const wait = async (fn) => { const end = Date.now() + 10000; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out; got ' + JSON.stringify(received)); };
  await wait(() => received.find((m) => m.type === 'app-status' && m.online));
  child.stdin.write(encodeFrame(protocol.make('hello', { instanceId: 'cmdtest', extVersion: '1', protocol: 1 })));
  await wait(() => received.find((m) => m.type === 'welcome'));
  assert.equal(hub.instances()[0].browser, 'edge', 'launcher set GRAB_BROWSER');
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
});

test('real registry round trip under a throwaway host name (opt-in: GRAB_TEST_REGISTRY=1)', { skip: !IS_WIN || process.env.GRAB_TEST_REGISTRY !== '1' }, async (t) => {
  const dir = tmpDir();
  const hostName = 'com.grab.downloader.test' + Date.now();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await setup.install({ sourceRoot: root, integrationDir: dir, browsers: ['edge', 'chrome', 'brave'], runtime: process.execPath, hostName });
  try {
    for (const b of setup.BROWSER_IDS) {
      const value = await setup.windowsRegistry.get(setup.REGISTRY_KEYS[b](hostName));
      assert.ok(value && value.endsWith(`${hostName}.json`), b);
    }
  } finally {
    await setup.uninstall({ integrationDir: dir, hostName });
  }
  for (const b of setup.BROWSER_IDS) assert.equal(await setup.windowsRegistry.get(setup.REGISTRY_KEYS[b](hostName)), null);
  void execFileSync;
});

test('packaged integration isolates the shipped runtime so an active browser does not lock the app during upgrades', async (t) => {
  const dir = tmpDir('grab packaged isolation');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packaged = path.join(dir, 'installed');
  const resources = path.join(packaged, 'resources');
  const integrationDir = path.join(dir, 'connection');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture marker');
  fs.writeFileSync(path.join(packaged, 'Grab.exe'), 'fixture embedded runtime');
  fs.writeFileSync(path.join(packaged, 'node.dll'), 'fixture runtime dependency');
  fs.cpSync(path.join(root, 'extension'), path.join(resources, 'extension'), { recursive: true });
  fs.cpSync(path.join(root, 'native-host'), path.join(resources, 'native-host'), { recursive: true });
  const registry = memoryRegistry();
  const options = { sourceRoot: resources, integrationDir, runtime: path.join(packaged, 'Grab.exe'), appVersion: '1.7.0-rc.1', browsers: ['chrome'], registry };
  const installed = await setup.install(options);
  assert.equal(path.basename(installed.hostRuntime), 'GrabBrowserHost.exe');
  assert.notEqual(path.dirname(installed.hostRuntime), packaged);
  assert.equal(fs.readFileSync(installed.hostRuntime, 'utf8'), 'fixture embedded runtime');
  assert.equal(fs.readFileSync(path.join(path.dirname(installed.hostRuntime), 'node.dll'), 'utf8'), 'fixture runtime dependency');
  assert.ok(fs.readFileSync(path.join(integrationDir, 'native-host', 'grab-host-chrome.cmd'), 'utf8').includes(installed.hostRuntime));
  assert.equal((await setup.install(options)).hostRuntime, installed.hostRuntime, 'one prepared runtime per app revision');
  let stoppedAfterUnregister = false;
  await setup.uninstall({ integrationDir, registry, beforeRemove: async () => { assert.equal(registry.keys.size, 0); stoppedAfterUnregister = true; } });
  assert.equal(stoppedAfterUnregister, true);
  assert.equal(fs.existsSync(installed.hostRuntime), false);
  assert.equal(fs.existsSync(options.runtime), true, 'uninstalling browser integration never deletes Grab itself');
});
