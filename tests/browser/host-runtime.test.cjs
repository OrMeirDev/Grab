const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../../electron/browser/setup.cjs');
const { BrowserService } = require('../../electron/browser/service.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-runtime-content-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'installed');
  const sourceRoot = path.join(root, 'resources');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'locales'));
  fs.writeFileSync(path.join(sourceRoot, 'app.asar'), 'fixture marker');
  fs.writeFileSync(path.join(root, 'Grab.exe'), 'runtime-A');
  fs.writeFileSync(path.join(root, 'node.dll'), 'library-A');
  fs.writeFileSync(path.join(root, 'locales/en.pak'), 'locale-A');
  for (const name of ['extension', 'native-host']) fs.cpSync(path.join(__dirname, '../..', name), path.join(sourceRoot, name), { recursive: true });
  const keys = new Map();
  const registry = { get: async (k) => keys.get(k), set: async (k, v) => keys.set(k, v), remove: async (k) => keys.delete(k) };
  return { root, options: { sourceRoot, integrationDir: path.join(dir, 'connection'), runtime: path.join(root, 'Grab.exe'),
    appVersion: '1.7.0', browsers: ['edge'], registry } };
}

test('same-version/same-size source changes replace the private runtime without overwriting the old host', async (t) => {
  const { options } = fixture(t);
  const first = await setup.install(options);
  const stat = fs.statSync(options.runtime);
  fs.writeFileSync(options.runtime, 'runtime-B');
  fs.utimesSync(options.runtime, stat.atime, stat.mtime);
  assert.equal(fs.statSync(options.runtime).size, stat.size);
  const second = await setup.install(options);
  assert.notEqual(second.hostRuntime, first.hostRuntime);
  assert.equal(fs.readFileSync(second.hostRuntime, 'utf8'), 'runtime-B');
  assert.equal(fs.readFileSync(first.hostRuntime, 'utf8'), 'runtime-A');
  assert.equal(await setup.hostRuntimeIsCurrent({ ...options, hostRuntime: second.hostRuntime }), true);
  assert.equal((await setup.install(options)).hostRuntime, second.hostRuntime, 'verified copies are reused');
});

test('equal-sized changes to a copied exe, DLL or locale fail validation despite an intact ready marker', async (t) => {
  const { options } = fixture(t);
  let current = await setup.install(options);
  for (const [name, expected] of [['GrabBrowserHost.exe', 'runtime-A'], ['node.dll', 'library-A'], ['locales/en.pak', 'locale-A']]) {
    const target = path.join(path.dirname(current.hostRuntime), name);
    fs.writeFileSync(target, expected.replace('A', 'X'));
    assert.equal(await setup.hostRuntimeIsCurrent({ ...options, hostRuntime: current.hostRuntime }), false, name);
    const repaired = await setup.install(options);
    assert.notEqual(repaired.hostRuntime, current.hostRuntime);
    assert.equal(fs.readFileSync(path.join(path.dirname(repaired.hostRuntime), name), 'utf8'), expected);
    assert.equal(fs.readFileSync(target, 'utf8'), expected.replace('A', 'X'), 'do not rewrite a possibly running host');
    current = repaired;
  }
});

test('legacy version-only ready markers are replaced with a verified copy', async (t) => {
  const { options } = fixture(t);
  const old = await setup.install(options);
  fs.writeFileSync(path.join(path.dirname(old.hostRuntime), '.ready'), options.appVersion);
  const next = await setup.install(options);
  assert.notEqual(next.hostRuntime, old.hostRuntime);
  assert.match(fs.readFileSync(path.join(path.dirname(next.hostRuntime), '.ready'), 'utf8'), /^[a-f0-9]{64}$/);
});

test('an unexpected runtime file prevents reuse and is not carried into the repaired copy', async (t) => {
  const { options } = fixture(t);
  const old = await setup.install(options);
  fs.writeFileSync(path.join(path.dirname(old.hostRuntime), 'unexpected.dll'), 'synthetic extra');
  assert.equal(await setup.hostRuntimeIsCurrent({ ...options, hostRuntime: old.hostRuntime }), false);
  const next = await setup.install(options);
  assert.notEqual(next.hostRuntime, old.hostRuntime);
  assert.equal(fs.existsSync(path.join(path.dirname(next.hostRuntime), 'unexpected.dll')), false);
});

test('startup auto-repair validates content even when all recorded version/path fields still match', async (t) => {
  const { options } = fixture(t);
  const old = await setup.install(options);
  fs.writeFileSync(options.runtime, 'runtime-B');
  const resolveRuntime = setup.resolveRuntime;
  setup.resolveRuntime = () => options.runtime;
  try {
    const svc = new BrowserService({ ...options, getSettings: () => ({}) });
    svc.identity = setup.readExtensionIdentity(path.join(options.sourceRoot, 'extension'));
    await svc.autoRepair();
    const record = setup.readInstall(options.integrationDir);
    assert.notEqual(record.hostRuntime, old.hostRuntime);
    assert.equal(fs.readFileSync(record.hostRuntime, 'utf8'), 'runtime-B');
    assert.equal(svc.runtimeVerified, true);
    assert.equal(svc.health.results.find((r) => r.browser === 'edge').problems.includes('stale_version'), false);
    fs.rmSync(options.runtime);
    await svc.autoRepair();
    assert.equal(svc.runtimeVerified, false);
    assert.ok(svc.health.results.find((r) => r.browser === 'edge').problems.includes('stale_version'), 'failed content validation is visible in health');
  } finally { setup.resolveRuntime = resolveRuntime; }
});

test('a bad staging copy is discarded before any launcher or install record can select it', async (t) => {
  const { options } = fixture(t);
  const copyFile = fs.promises.copyFile;
  fs.promises.copyFile = async (source, target, ...rest) => {
    await copyFile(source, target, ...rest);
    if (path.basename(target) === 'GrabBrowserHost.exe') fs.writeFileSync(target, 'runtime-X');
  };
  try {
    await assert.rejects(setup.install(options), /Runtime copy did not match/);
    assert.equal(setup.readInstall(options.integrationDir), null);
    assert.equal(fs.existsSync(path.join(options.integrationDir, 'native-host')), false);
    assert.deepEqual(fs.readdirSync(path.join(options.integrationDir, 'runtimes')), []);
  } finally { fs.promises.copyFile = copyFile; }
});
