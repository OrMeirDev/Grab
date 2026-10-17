const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('fixture setup/repair and startup scavenging leave an existing installation and temp data untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-e2e-isolation-proof-'));
  const personal = path.join(dir, 'synthetic-personal');
  const isolated = path.join(dir, 'fixture');
  const canaries = [
    'local/Grab/browser-integration/install.json',
    'local/Grab/browser-integration/native-host/chrome.cmd',
    'local/Grab/browser-integration/extension/manifest.json',
    'roaming/Grab/settings.json',
    'temp/grab-info/legacy.json',
    'temp/grab-cookies-existing/cookies.txt',
  ];
  try {
    for (const name of canaries) {
      const file = path.join(personal, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'synthetic canary: ' + name);
    }
    // A child process keeps redirected environment variables and the registry
    // stand-in out of the test runner and all other tests. No real user paths.
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const [root, isolated] = process.argv.slice(1);
      const appPaths = new Map();
      const app = { setPath: (name, value) => appPaths.set(name, value) };
      const { registry, paths } = require(path.join(root, 'test-support/electron-profile.cjs')).isolateElectronProfile(app, isolated);
      assert.equal(os.tmpdir(), paths.temp);
      for (const [name, value] of Object.entries(paths)) {
        assert.equal(appPaths.get(name), value);
        assert.ok(fs.statSync(value).isDirectory());
      }
      const setup = require(path.join(root, 'electron/browser/setup.cjs'));
      (async () => {
        await setup.install({ sourceRoot: root, browsers: ['chrome'], runtime: process.execPath, appVersion: 'fixture' });
        assert.ok(fs.existsSync(path.join(isolated, 'local/Grab/browser-integration/install.json')));
        assert.equal(registry.size, 1);
        require(path.join(root, 'electron/engine.cjs')).cleanInfoCache();
        require(path.join(root, 'electron/browser-session.cjs')).scavengeCookieJars();
        await setup.uninstall();
        assert.equal(registry.size, 0);
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `, root, isolated], {
      env: { ...process.env, LOCALAPPDATA: path.join(personal, 'local'), APPDATA: path.join(personal, 'roaming'),
        TEMP: path.join(personal, 'temp'), TMP: path.join(personal, 'temp'), TMPDIR: path.join(personal, 'temp') },
      timeout: 30000, stdio: 'pipe',
    });
    for (const name of canaries) assert.equal(fs.readFileSync(path.join(personal, name), 'utf8'), 'synthetic canary: ' + name, name);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every full-app Electron fixture isolates its paths before importing application adapters', () => {
  const launchers = fs.readdirSync(path.join(root, 'e2e')).filter((name) => name.endsWith('.cjs'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(root, 'e2e', name), 'utf8') }))
    .filter(({ source }) => /require\([^\n]*main\.cjs/.test(source));
  assert.ok(launchers.length >= 6);
  for (const { name, source } of launchers) {
    const isolate = source.indexOf('.isolateElectronProfile(app,');
    const firstAppImport = source.search(/require\([^\n]*(?:main|engine|browser-session)\.cjs/);
    assert.ok(isolate >= 0 && isolate < firstAppImport, name + ' must isolate all paths before loading the app');
  }
});
