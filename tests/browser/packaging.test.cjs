// Run after electron-builder: GRAB_PACKAGED_DIR=release/win-unpacked npm run test:package.
// Checks the actual archive and unpacked resources, not only the packaging configuration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const packaged = process.env.GRAB_PACKAGED_DIR && path.resolve(process.env.GRAB_PACKAGED_DIR);

test('packaged browser service loads; resources install a native host that uses only the shipped runtime', {
  skip: !packaged ? 'Set GRAB_PACKAGED_DIR after building the Windows package' : false,
  timeout: 45000,
}, async (t) => {
  const resources = path.join(packaged, 'resources');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab packaged proof '));
  const extracted = path.join(dir, 'application');
  const integrationDir = path.join(dir, 'connection');
  let child;
  let hub;
  let closed;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 2000);
      await closed;
      clearTimeout(timeout);
    }
    hub?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  require('@electron/asar').extractAll(path.join(resources, 'app.asar'), extracted);
  const packedRequire = createRequire(path.join(extracted, 'package.json'));
  const { BrowserService } = packedRequire('./electron/browser/service.cjs');
  const setup = packedRequire('./electron/browser/setup.cjs');
  const { BrowserHub } = packedRequire('./electron/browser/hub.cjs');
  const protocol = packedRequire('./extension/lib/protocol.js');
  const { encodeFrame, FrameParser } = packedRequire('./native-host/framing.cjs');
  assert.equal(typeof BrowserService, 'function', 'all runtime module dependencies were packaged');
  const identity = setup.readExtensionIdentity(path.join(resources, 'extension'));
  for (const f of ['background.js', 'lib/collector.js', 'popup/popup.html', 'icons/icon128.png']) {
    assert.ok(fs.existsSync(path.join(resources, 'extension', f)), f);
  }
  const registry = new Map();
  const runtime = path.join(packaged, 'Grab.exe');
  const installed = await setup.install({ sourceRoot: resources, integrationDir, browsers: ['edge'], runtime,
    registry: { get: async (k) => registry.get(k), set: async (k, v) => registry.set(k, v) }, appVersion: 'package-test' });
  assert.equal(installed.extensionId, identity.id);
  assert.equal(fs.readFileSync(path.join(integrationDir, 'extension', 'background.js'), 'utf8'), fs.readFileSync(path.join(resources, 'extension', 'background.js'), 'utf8'));
  if (process.platform !== 'win32') return; // archive checks are portable; launch evidence is Windows-only

  hub = new BrowserHub({ integrationDir, allowedOrigins: [identity.origin] });
  await hub.start();
  const manifest = JSON.parse(fs.readFileSync(registry.values().next().value, 'utf8'));
  child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${manifest.path}" ${identity.origin} --parent-window=0"`], {
    windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), NODE_OPTIONS: '', NODE_PATH: '' },
  });
  closed = new Promise((resolve) => child.once('close', resolve));
  const received = [];
  let stderr = '';
  child.on('error', (e) => { stderr += e.message; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => parser.push(d));
  const parser = new FrameParser({ onMessage: (m) => received.push(m), onError: () => assert.fail('Non-protocol stdout from packaged runtime') });
  const until = async (predicate) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const found = received.find(predicate);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Packaged native host exited: ' + stderr);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('No reply from packaged native host: ' + stderr);
  };
  await until((m) => m.type === 'app-status' && m.online);
  child.stdin.write(encodeFrame(protocol.make('hello', { instanceId: 'packaged-proof', extVersion: '1', protocol: protocol.PROTOCOL_VERSION })));
  await until((m) => m.type === 'welcome');
  assert.equal(hub.instances()[0].browser, 'edge');
  child.stdin.end();
  await closed;
  assert.equal(child.exitCode, 0);
});
