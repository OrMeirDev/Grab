// The temporary cookie jar CookieVault writes for yt-dlp: Netscape format that yt-dlp accepts,
// host-only vs domain scope, and the desktop scope filter in front of it (cookie-scope.cjs).
// The yt-dlp tests use the real engine and run when GRAB_TEST_YTDLP_DIR names a folder with it.
// Not covered here: yt-dlp still sends host-only cookies to subdomains of their host (audit F16,
// docs/audits/grab-network-privacy-audit.md); that needs its own fix and its own test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');
const { filterScopedCookies } = require('../electron/domain/cookie-scope.cjs');

const DIR = process.env.GRAB_TEST_YTDLP_DIR;
const YTDLP = DIR && path.join(DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const skipYtDlp = !(YTDLP && fs.existsSync(YTDLP)) && 'set GRAB_TEST_YTDLP_DIR to run';
const now = Math.floor(Date.now() / 1000);
// the shape the extension delivers (extension/background.js answerCookies)
const cookie = (name, domain, extra = {}) => ({ name, value: `v-${name}`, domain, path: '/', secure: false, httpOnly: false, session: true, ...extra });

function vaultIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-jar-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, vault: new CookieVault({ tmpDir: dir }) };
}
const jarDirs = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('grab-cookies-'));
// [domain, includeSubdomains, path, secure, expires, name] per cookie line
const jarRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
  .map((l) => { const f = l.split('\t'); return { domain: f[0].replace(/^#HttpOnly_/, ''), httpOnly: f[0].startsWith('#HttpOnly_'), flag: f[1], path: f[2], secure: f[3], expires: f[4], name: f[5] }; });

async function rowsFor(t, cookies) {
  const { vault } = vaultIn(t);
  let rows;
  await vault.withJar(vault.remember(cookies), (file) => { rows = jarRows(file); });
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

test('jar: a host-only cookie is written for its exact host, with or without a leading dot in the input', async (t) => {
  const rows = await rowsFor(t, [
    cookie('plain', 'media.example.test', { hostOnly: true }),
    cookie('dotted', '.example.test', { hostOnly: true }), // inconsistent input: must stay host-only, not become invalid
    cookie('httponly', '.example.test', { hostOnly: true, httpOnly: true }),
  ]);
  assert.deepEqual([rows.plain.domain, rows.plain.flag], ['media.example.test', 'FALSE']);
  assert.deepEqual([rows.dotted.domain, rows.dotted.flag], ['example.test', 'FALSE']);
  assert.deepEqual([rows.httponly.domain, rows.httponly.flag, rows.httponly.httpOnly], ['example.test', 'FALSE', true]);
});

test('jar: domain cookies are domain-scoped whether or not the input has a leading dot', async (t) => {
  const rows = await rowsFor(t, [
    cookie('dotted', '.example.test', { hostOnly: false }),
    cookie('bare', 'example.test', { hostOnly: false }),
    // CDP and the hidden probe give no hostOnly flag: the leading dot decides
    cookie('cdpDomain', '.example.test'),
    cookie('cdpHost', 'media.example.test'),
  ]);
  assert.deepEqual([rows.dotted.domain, rows.dotted.flag], ['.example.test', 'TRUE']);
  assert.deepEqual([rows.bare.domain, rows.bare.flag], ['.example.test', 'TRUE']);
  assert.deepEqual([rows.cdpDomain.domain, rows.cdpDomain.flag], ['.example.test', 'TRUE']);
  assert.deepEqual([rows.cdpHost.domain, rows.cdpHost.flag], ['media.example.test', 'FALSE']);
});

test('jar: every line keeps the Netscape invariant yt-dlp asserts (leading dot <=> include subdomains)', async (t) => {
  const shapes = [];
  for (const domain of ['example.test', '.example.test', 'media.example.test', '.media.example.test']) {
    for (const hostOnly of [true, false, undefined]) shapes.push(cookie(`c${shapes.length}`, domain, hostOnly === undefined ? {} : { hostOnly }));
  }
  const rows = Object.values(await rowsFor(t, shapes));
  assert.equal(rows.length, shapes.length);
  for (const r of rows) assert.equal(r.domain.startsWith('.'), r.flag === 'TRUE', `${r.name}: ${r.domain} ${r.flag}`);
});

test('jar: path, Secure and expiry are carried as given', async (t) => {
  const rows = await rowsFor(t, [
    cookie('pathed', 'media.example.test', { hostOnly: true, path: '/media' }),
    cookie('secure', 'media.example.test', { hostOnly: true, secure: true }),
    cookie('persistent', 'media.example.test', { hostOnly: true, session: false, expires: now + 3600 }),
  ]);
  assert.equal(rows.pathed.path, '/media');
  assert.equal(rows.secure.secure, 'TRUE');
  assert.equal(rows.persistent.expires, String(now + 3600));
});

test('desktop scope filter in front of the jar: unrelated domains, paths, Secure on HTTP and expiry', () => {
  const snapshot = [
    cookie('exact', 'media.example.test', { hostOnly: true }),
    cookie('parentDomain', '.example.test', { hostOnly: false }),
    cookie('otherHost', 'cdn.example.test', { hostOnly: true }),
    cookie('unrelated', '.unrelated.test', { hostOnly: false }),
    cookie('lookalike', '.ample.test', { hostOnly: false }),
    cookie('rightPath', 'media.example.test', { hostOnly: true, path: '/media' }),
    cookie('otherPath', 'media.example.test', { hostOnly: true, path: '/account' }),
    cookie('prefixTrap', 'media.example.test', { hostOnly: true, path: '/med' }),
    cookie('secure', 'media.example.test', { hostOnly: true, secure: true }),
    cookie('expired', 'media.example.test', { hostOnly: true, session: false, expirationDate: now - 60 }),
    cookie('dottedHostOnly', '.example.test', { hostOnly: true }),
  ];
  const names = (url) => filterScopedCookies([url], snapshot).map((c) => c.name).sort();
  assert.deepEqual(names('http://media.example.test/media/v.mp4'), ['exact', 'parentDomain', 'rightPath'].sort());
  assert.deepEqual(names('https://media.example.test/media/v.mp4'), ['exact', 'parentDomain', 'rightPath', 'secure'].sort());
  // the desktop filter selects a parent's host-only cookie only for its exact host (what yt-dlp then
  // does with it on later requests is F16, not asserted here)
  assert.deepEqual(names('https://example.test/v.mp4'), ['dottedHostOnly', 'parentDomain'].sort());
});

test('cleanup: the jar folder is gone after success, after an error, and after a shutdown during a run', async (t) => {
  const { dir, vault } = vaultIn(t);
  const ref = vault.remember([cookie('a', 'media.example.test', { hostOnly: true })]);
  await vault.withJar(ref, (file) => { assert.ok(fs.existsSync(file)); assert.equal(jarDirs(dir).length, 1); });
  assert.deepEqual(jarDirs(dir), []);
  await assert.rejects(vault.withJar(ref, () => { throw new Error('yt-dlp failed'); }), /yt-dlp failed/);
  assert.deepEqual(jarDirs(dir), []);
  // cancel/quit while the engine still holds the jar: clear() removes it and forgets the session
  let release;
  const running = vault.withJar(ref, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  assert.equal(jarDirs(dir).length, 1);
  vault.clear();
  assert.deepEqual(jarDirs(dir), []);
  release();
  await running;
  await assert.rejects(vault.withJar(ref, () => {}), (e) => e.kind === 'contextExpired');
});

// ---- the real yt-dlp reading the vault's jar ---------------------------------------------------
// A loopback HTTP proxy that records which cookie names reach which host; nothing leaves the PC.
function cookieRecorder(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ host: new URL(req.url).host, names: String(req.headers.cookie || '').split(';').map((s) => s.split('=')[0].trim()).filter(Boolean) });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 0 });
    res.end();
  });
  t.after(() => srv.close());
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ seen, proxy: `http://127.0.0.1:${srv.address().port}` })));
}
const lookup = (file, url, proxy) => new Promise((resolve) => {
  execFile(YTDLP, ['--ignore-config', '--cookies', file, '-J', '--skip-download', url], { env: { ...process.env, http_proxy: proxy, HTTP_PROXY: proxy }, timeout: 60000 },
    (error, _out, stderr) => resolve({ code: error ? error.code : 0, stderr: String(stderr) }));
});

async function sentTo(t, cookies, hosts) {
  const { vault } = vaultIn(t);
  const { seen, proxy } = await cookieRecorder(t);
  const ref = vault.remember(cookies);
  const out = {};
  for (const host of hosts) {
    await vault.withJar(ref, async (file) => {
      const before = seen.length;
      const r = await lookup(file, `http://${host}/v.mp4`, proxy);
      assert.doesNotMatch(r.stderr, /cookiejar|LoadError|AssertionError/, `yt-dlp rejected the jar for ${host}`);
      assert.equal(r.code, 0, `yt-dlp failed for ${host}`);
      out[host] = seen.slice(before).flatMap((s) => s.names).sort();
    });
  }
  return out;
}

test('real yt-dlp accepts the jar for every cookie shape and sends nothing to unrelated hosts', { skip: skipYtDlp, timeout: 120000 }, async (t) => {
  const sent = await sentTo(t, [
    cookie('hostonly', 'example.test', { hostOnly: true }),
    cookie('dottedHostOnly', '.example.test', { hostOnly: true }),
    cookie('domain', '.example.test', { hostOnly: false }),
    cookie('bareDomain', 'example.test', { hostOnly: false }),
  ], ['example.test', 'other.test', 'notexample.test']);
  assert.deepEqual(sent['example.test'], ['bareDomain', 'domain', 'dottedHostOnly', 'hostonly']);
  assert.deepEqual(sent['other.test'], []);
  assert.deepEqual(sent['notexample.test'], []);
});

