// Main-process infrastructure: process runner (GRB-08/09), output names (GRB-15), atomic storage
// and async library (GRB-16), IPC contracts and sender checks (GRB-03), window policy (GRB-04).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('../electron/infrastructure/process-runner.cjs');
const { ProcessRegistry } = require('../electron/infrastructure/process-registry.cjs');
const { safeName, fitName } = require('../electron/domain/output-names.cjs');
const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
const { JsonStore } = require('../electron/infrastructure/json-store.cjs');
const { SettingsRepository, HistoryRepository } = require('../electron/infrastructure/repositories.cjs');
const { listLibrary } = require('../electron/infrastructure/library-indexer.cjs');
const { t, validateArgs } = require('../electron/ipc/contracts.cjs');
const { createRouter, trustedFrame } = require('../electron/ipc/router.cjs');
const { appUrlMatcher } = require('../electron/security/window-policy.cjs');

const NODE = process.execPath;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `grab-${name}-`));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return fn(); };

test('process runner: lines, exit code, bounded stderr tail', async () => {
  const lines = [];
  const r = await runProcess(NODE, ['-e', 'console.log("a\\nb"); console.error("x".repeat(5000)); process.exit(3)'], { onLine: (l) => lines.push(l), maxStderr: 100 }).done;
  assert.equal(r.code, 3);
  assert.deepEqual(lines.filter((l) => !l.startsWith('x')), ['a', 'b']);
  assert.equal(r.err.length, 100);
});

test('process runner: a stalled run ends at its deadline or after silence', async () => {
  const t0 = Date.now();
  const r = await runProcess(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }).done;
  assert.equal(r.timedOut, true);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `the stalled run ended ${elapsed} ms after it started (deadline 300 ms)`);
  const idle = await runProcess(NODE, ['-e', 'console.log("started"); setInterval(() => {}, 1000)'], { idleTimeoutMs: 300 }).done;
  assert.equal(idle.idle, true);
});

test('process runner: oversized output is cut off and the run stopped', async () => {
  const r = await runProcess(NODE, ['-e', 'process.stdout.write("y".repeat(4 * 1024 * 1024)); setInterval(() => {}, 1000)'], { maxStdout: 1024 * 1024 }).done;
  assert.equal(r.truncated, true);
  assert.ok(r.out.length <= 1024 * 1024);
});

test('process runner: a missing executable fails cleanly', async () => {
  const r = await runProcess(path.join(os.tmpdir(), 'no-such-tool-' + Date.now()), []).done;
  assert.equal(r.code, -1);
  assert.ok(r.spawnError);
});

// POSIX: the process group; Windows: taskkill /T (this test runs on the Windows CI job too).
test('process runner: cancel ends the whole tree (the child it started too) and waits for it', async () => {
  const dir = tmp('tree');
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = `const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const registry = new ProcessRegistry();
  const run = runProcess(NODE, ['-e', script], { signal: controller.signal, registry });
  assert.equal(registry.size, 1);
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(alive(grandchild), true);
  controller.abort();
  const r = await run.done;
  assert.equal(r.aborted, true);
  assert.equal(registry.size, 0);
  assert.ok(await until(() => !alive(grandchild)), 'grandchild survived');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('process registry: stopAll stops every run and resolves when they have exited', async () => {
  const registry = new ProcessRegistry();
  const runs = [1, 2].map(() => runProcess(NODE, ['-e', 'setInterval(() => {}, 1000)'], { registry }));
  assert.equal(registry.size, 2);
  assert.equal(await registry.stopAll(5000), true);
  assert.equal(registry.size, 0);
  for (const r of runs) assert.equal((await r.done).aborted, true);
});

test('output names: Windows-invalid characters, device names, trailing dots, length', () => {
  assert.equal(safeName('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.mp4'), '_nul.mp4');
  assert.equal(safeName('com1 '), '_com1');
  assert.equal(safeName('console'), 'console');
  assert.equal(safeName('name...  '), 'name');
  assert.equal(safeName(''), 'video');
  assert.equal(safeName('שיעור 2: מבוא'), 'שיעור 2 מבוא');
  assert.equal(safeName('x'.repeat(400)).length, 180);
  assert.equal(fitName('C:\\' + 'd'.repeat(240), 'name'), null);
  assert.ok(fitName('C:\\' + 'd'.repeat(150), 'n'.repeat(180)).length < 90);
});

test('output allocator: unique per folder and per job, kept for the job, never another file', () => {
  const dir = tmp('out');
  try {
    fs.writeFileSync(path.join(dir, 'Lesson.mp4'), 'old');
    const a = new OutputAllocator();
    const first = a.allocate('j1', dir, 'Lesson');
    assert.equal(path.basename(first), 'Lesson (2)');
    assert.equal(a.allocate('j1', dir, 'Lesson'), first, 'a job keeps its name');
    assert.equal(path.basename(a.allocate('j2', dir, 'Lesson')), 'Lesson (3)', 'reserved by j1');
    assert.equal(path.basename(a.allocate('j3', dir, 'lesson')), 'lesson (4)', 'case-insensitive like Windows');
    fs.writeFileSync(first + '.f137.mp4.part', '');
    assert.equal(a.findOutput(first), null, 'a partial file is not the result');
    fs.writeFileSync(first + '.mp4', 'new');
    assert.equal(a.findOutput(first), first + '.mp4');
    a.release('j1');
    assert.equal(path.basename(a.allocate('j4', dir, 'Lesson')), 'Lesson (5)', 'files on disk still count');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('json store: atomic replace, backup after a damaged write, serialized saves', async () => {
  const dir = tmp('store');
  try {
    const file = path.join(dir, 'x.json');
    const store = new JsonStore(file, { fallback: { n: 0 } });
    assert.deepEqual(await store.load(), { n: 0 });
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ n })));
    assert.deepEqual(await store.load(), { n: 5 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { n: 4 });
    fs.writeFileSync(file, '{"n": 6'); // a crash mid-write of an older version
    assert.deepEqual(await store.load(), { n: 4 });
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings and history repositories validate what they store', async () => {
  const dir = tmp('repo');
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ folder: '/d', format: 'exe', quality: '720', extra: 1 }));
    const settings = new SettingsRepository(dir, { folder: '/default', format: 'mp4', quality: 'best' });
    assert.deepEqual(await settings.get(), { folder: '/d', format: 'mp4', quality: '720', automaticUpdateChecks: true });
    assert.deepEqual(await settings.update({ format: 'mp3' }), { folder: '/d', format: 'mp3', quality: '720', automaticUpdateChecks: true });

    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ name: 'old', url: 'https://a.example/1', file: '/d/old.mp4', site: 'YouTube', format: 'mp4', completedAt: '2026-01-01T00:00:00.000Z' }, 'junk']));
    const history = new HistoryRepository(dir);
    const legacy = await history.all();
    assert.equal(legacy.length, 1);
    assert.ok(legacy[0].id);
    await Promise.all([history.add({ name: 'a', url: 'https://a.example/2', format: 'mp4' }), history.add({ name: 'b', url: 'https://a.example/3', format: 'mp3' })]);
    const reread = await new HistoryRepository(dir).all();
    assert.deepEqual(reread.map((e) => e.name), ['b', 'a', 'old']);
    assert.equal(reread[2].id, legacy[0].id, 'legacy ids are stable once given');
    assert.equal(await history.has('/d/old.mp4'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('library listing: async, three levels deep, skips what it cannot read', async () => {
  const dir = tmp('lib');
  try {
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
    for (const f of ['top.mp4', 'a/one.mp3', 'a/b/c/three.mkv', 'a/b/c/d/four.mp4', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x');
    const files = await listLibrary(dir);
    assert.deepEqual(files.map((f) => f.name).sort(), ['one.mp3', 'three.mkv', 'top.mp4']);
    assert.deepEqual(await listLibrary(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contracts reject non-http links, credentials, unknown fields, oversized input and extra arguments', () => {
  const url = t.url();
  assert.equal(url('https://a.example/x?token=signed.value', 'u'), 'https://a.example/x?token=signed.value');
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'https://user:pw@a.example/', 'not a link', 42]) assert.throws(() => url(bad, 'u'), { kind: 'contract' }, String(bad));
  const job = t.object({ id: t.id(), format: t.oneOf('mp4', 'mp3') });
  assert.deepEqual(job({ id: 'j', format: 'mp4' }, 'job'), { id: 'j', format: 'mp4' });
  assert.throws(() => job({ id: 'j', format: 'mp4', infoFile: 'C:/x.json' }, 'job'), /unexpected field "infoFile"/);
  assert.throws(() => job({ id: 'j', format: 'exe' }, 'job'), /expected one of/);
  assert.throws(() => t.string({ max: 10 })('x'.repeat(11), 's'), /length/);
  assert.throws(() => t.array(t.id(), { max: 2 })(['a', 'b', 'c'], 'list'), /at most 2/);
  assert.throws(() => validateArgs('c', [t.id()], ['a', 'b']), /at most 1/);
});

test('router: an untrusted sender or a malformed request never reaches the handler', async () => {
  const handlers = new Map();
  const rejected = [];
  let calls = 0;
  // The app's own address, built the way main.cjs builds it (a drive letter on Windows).
  const indexFile = path.resolve('/app/dist/index.html');
  const appUrl = require('url').pathToFileURL(indexFile).href;
  const appFrame = { url: appUrl };
  const win = { isDestroyed: () => false, webContents: { mainFrame: appFrame } };
  const isAppUrl = appUrlMatcher({ indexFile });
  const router = createRouter({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, isTrusted: trustedFrame(() => win, isAppUrl), onRejected: (c, why) => rejected.push(why) });
  router.handle('job:start', [t.object({ url: t.url() })], () => ++calls);
  const call = handlers.get('job:start');
  assert.equal(call({ senderFrame: appFrame }, { url: 'https://a.example/' }), 1);
  assert.throws(() => call({ senderFrame: { url: appUrl } }, { url: 'https://a.example/' }), /untrusted/, 'another frame at the same address');
  assert.throws(() => call({ senderFrame: { ...appFrame, url: 'https://evil.example/' } }, { url: 'https://a.example/' }), /untrusted/);
  assert.throws(() => call({}, { url: 'https://a.example/' }), /untrusted/);
  appFrame.url = 'https://evil.example/'; // the app frame navigated away
  assert.throws(() => call({ senderFrame: appFrame }, { url: 'https://a.example/' }), /untrusted/);
  appFrame.url = appUrl;
  assert.throws(() => call({ senderFrame: appFrame }, { url: 'file:///etc/passwd' }), { kind: 'contract' });
  assert.equal(calls, 1);
  assert.equal(rejected.length, 5);
});

test('window policy: only the app page itself counts as the app', () => {
  const prod = appUrlMatcher({ indexFile: path.resolve('/app/dist/index.html') });
  assert.equal(prod(require('url').pathToFileURL(path.resolve('/app/dist/index.html')).href + '#x'), true);
  assert.equal(prod('file:///C:/Users/me/Downloads/dropped.html'), false);
  assert.equal(prod('https://evil.example/'), false);
  const dev = appUrlMatcher({ indexFile: path.resolve('/app/dist/index.html'), devUrl: 'http://localhost:5173' });
  assert.equal(dev('http://localhost:5173/src/main.jsx'), true);
  assert.equal(dev('http://localhost:5174/'), false);
});
