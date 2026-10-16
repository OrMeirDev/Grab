// The yt-dlp wrapper against a fake yt-dlp (a small Node script on POSIX): argument boundaries,
// verified output, engine replacement while busy. GRB-03, GRB-08, GRB-09.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POSIX = process.platform !== 'win32';
const skip = !POSIX && 'needs a fake yt-dlp.exe; covered by the Linux job';

// A fresh copy of engine.cjs whose user bin folder holds a fake yt-dlp. behavior: JS run by the fake.
function fakeEngine(behavior) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-fake-engine-'));
  const log = path.join(dir, 'args.json');
  const exe = path.join(dir, 'yt-dlp');
  fs.writeFileSync(exe, `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst TEST_MEDIA = require(${JSON.stringify(require.resolve('./fixtures/sample-media.cjs'))});\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\n${behavior}\n`, { mode: 0o755 });
  const enginePath = require.resolve('../electron/engine.cjs');
  delete require.cache[enginePath];
  const engine = require(enginePath);
  engine.setUserBinDir(dir);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { engine, dir, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('analyze ignores user config files and passes the link after --', { skip }, async () => {
  const f = fakeEngine(`process.stdout.write(JSON.stringify({ title: 'T', extractor_key: 'Youtube', duration: 5, url: 'https://fixture.example/video.mp4', ext: 'mp4' }));`);
  try {
    const r = await f.engine.analyze('https://www.youtube.com/watch?v=x&sig=keep');
    assert.equal(r.ok, true);
    assert.equal(r.site, 'Youtube');
    const args = f.calls()[0];
    assert.equal(args[0], '--ignore-config');
    assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=x&sig=keep']);
    assert.equal(f.engine.isInfoFile(r.infoFile), true);
    assert.equal(f.engine.isInfoFile('/etc/passwd'), false);
    fs.rmSync(r.infoFile, { force: true });
  } finally { f.cleanup(); }
});

test('analyze can be cancelled and classifies failures', { skip }, async () => {
  const f = fakeEngine(`if (args.includes('https://a.example/hang')) setInterval(() => {}, 1000); else { console.error('ERROR: [youtube] x: Sign in to confirm you are not a bot'); process.exit(1); }`);
  try {
    assert.equal((await f.engine.analyze('https://a.example/blocked')).kind, 'blocked');
    const controller = new AbortController();
    const pending = f.engine.analyze('https://a.example/hang', { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(f.engine.busy(), true);
    controller.abort();
    assert.equal((await pending).kind, 'cancelled');
    assert.equal(f.engine.busy(), false);
  } finally { f.cleanup(); }
});

test('lookup secrets stay off disk and argv; rotated and anonymous cookies survive through stdin', { skip }, async () => {
  const f = fakeEngine(`
    if (args.includes('-J')) console.log(JSON.stringify({ id: 'fixture', title: 'Private', ext: 'mp4',
      url: 'https://fixture.example/video.mp4', cookies: 'session=browser-secret; Domain=fixture.example',
      http_headers: { Authorization: 'Bearer private-token', Cookie: 'rotation=rotated-secret' },
      formats: [{ url: 'https://fixture.example/video.mp4', ext: 'mp4', cookies: 'anonymous=lookup-secret' }],
      grab_cookie_records: [{ name: 'session', value: 'browser-secret', domain_specified: false }] }));
    else {
      let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (s) => text += s);
      process.stdin.on('end', () => {
        const info = JSON.parse(text);
        if (!info.cookies.includes('browser-secret') || !info.formats[0].cookies.includes('lookup-secret') ||
            !info.http_headers.Cookie.includes('rotated-secret') || info.grab_cookie_records[0].domain_specified !== false) process.exit(3);
        const out = args[args.indexOf('-o') + 1].replace('.%(ext)s', '.mp4');
        require('fs').writeFileSync(out, TEST_MEDIA); console.log('GRABFILE|' + out);
      });
    }`);
  let info;
  try {
    info = await f.engine.analyze('https://fixture.example/watch');
    assert.equal(info.ok, true);
    const disk = fs.readFileSync(info.infoFile, 'utf8');
    for (const value of ['browser-secret', 'private-token', 'rotated-secret', 'lookup-secret', 'grab_cookie_records']) assert.ok(!disk.includes(value), value);
    assert.equal(JSON.parse(disk).__grab_private_context, true);
    const result = await f.engine.download({ url: 'https://fixture.example/watch', outputBase: path.join(f.dir, 'private'),
      format: 'mp4', infoFile: info.infoFile, infoAt: info.infoAt }, () => {}).done;
    assert.equal(result.ok, true);
    const args = f.calls().at(-1);
    assert.equal(args[args.indexOf('--load-info-json') + 1], '-');
    assert.ok(!JSON.stringify(args).includes('secret'));
    let fallbackArgs, fallbackInput;
    await f.engine.download({ url: 'https://fixture.example/watch', outputBase: path.join(f.dir, 'stale'),
      format: 'mp4', infoFile: info.infoFile, infoAt: info.infoAt, infoExpiresAt: Date.now() - 1 }, () => {}, {
      runImpl: (a, options) => { fallbackArgs = a; fallbackInput = options.input;
        return { stop() {}, done: Promise.resolve({ code: 1, err: 'fixture' }) }; },
    }).done;
    assert.ok(!fallbackArgs.includes('--load-info-json'));
    assert.equal(fallbackInput, undefined, 'a fresh extraction must not receive unrelated cached secrets on stdin');
    f.engine.releaseInfo(info.infoFile);
    assert.equal(fs.existsSync(info.infoFile), false);
  } finally { if (info?.infoFile) f.engine.releaseInfo(info.infoFile); f.cleanup(); }
});

test('a sanitized cache without its private context is never used as a complete lookup', { skip }, async () => {
  const engine = require('../electron/engine.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-orphan-info-'));
  try {
    const infoFile = path.join(dir, 'orphan.json');
    fs.writeFileSync(infoFile, JSON.stringify({ __grab_private_context: true }));
    let args;
    await engine.download({ url: 'https://fixture.example/watch', outputBase: path.join(dir, 'out'),
      format: 'mp4', infoFile, infoAt: Date.now() }, () => {}, { runImpl: (captured) => {
        args = captured; return { stop() {}, done: Promise.resolve({ code: 1, err: 'fixture' }) };
      } }).done;
    assert.ok(!args.includes('--load-info-json'));
    assert.equal(args.at(-1), 'https://fixture.example/watch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a download that exits 0 without its file is a failure; with it, a success', { skip }, async () => {
  const f = fakeEngine(`
    const o = args[args.indexOf('-o') + 1].replace('.%(ext)s', '.mp4').replace(/%%/g, '%');
    console.log('GRAB| 50.0%|1MiB/s|00:01');
    if (!args.includes('https://a.example/ghost')) require('fs').writeFileSync(o, TEST_MEDIA);
    console.log('GRABFILE|' + o);`);
  try {
    const progress = [];
    const ok = await f.engine.download({ url: 'https://a.example/v', outputBase: path.join(f.dir, '100% real'), format: 'mp4', quality: 'best' }, (p) => progress.push(p)).done;
    assert.equal(ok.ok, true);
    assert.equal(ok.file, path.join(f.dir, '100% real.mp4'));
    assert.equal(progress[0].percent, 50);
    assert.ok(f.calls()[0].includes(path.join(f.dir, '100%% real') + '.%(ext)s'), 'a % in the name is escaped for the template');
    const ghost = await f.engine.download({ url: 'https://a.example/ghost', outputBase: path.join(f.dir, 'ghost'), format: 'mp4', quality: 'best' }, () => {}).done;
    assert.equal(ghost.ok, false);
    assert.match(ghost.error, /without an output file/);
  } finally { f.cleanup(); }
});

test('stopping a download reports stopped; the engine is not replaced while anything runs', { skip }, async () => {
  const f = fakeEngine(`if (args[1] === '--version' || args.includes('--version')) console.log('2026.01.01'); else setInterval(() => {}, 1000);`);
  try {
    const run = f.engine.download({ url: 'https://a.example/long', outputBase: path.join(f.dir, 'x'), format: 'mp4', quality: 'best' }, () => {});
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await f.engine.updateEngine(), { ok: false, busy: true });
    run.stop();
    assert.deepEqual(await run.done, { ok: false, stopped: true });
    assert.equal(f.engine.busy(), false);
  } finally { f.cleanup(); }
});
