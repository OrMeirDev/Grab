// Actual pinned yt-dlp, trusted plugin and receiving server. Synthetic secrets only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');
const MEDIA = require('./fixtures/sample-media.cjs');
const root = path.resolve(__dirname, '..');
const engineDir = process.env.GRAB_TEST_YTDLP_DIR;
const exe = engineDir && path.join(engineDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const skip = !exe || !fs.existsSync(exe) ? 'Set GRAB_TEST_YTDLP_DIR to the pinned engine' : false;
const guard = ['--no-plugin-dirs', '--plugin-dirs', path.join(root, 'engine-plugins'), '--use-postprocessor', 'GrabPrivacy:when=pre_process'];

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-private-network-'));
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url);
    seen.push({ host: url.hostname, path: url.pathname, cookie: req.headers.cookie || '', referer: req.headers.referer || '', origin: req.headers.origin || '', ua: req.headers['user-agent'] });
    if (url.pathname === '/redirect.mp4') {
      res.writeHead(302, { Location: 'http://sub.example.test/final.mp4' }); res.end();
    } else if (url.pathname === '/cross.mp4') {
      res.writeHead(302, { Location: 'http://unrelated.test/final.mp4' }); res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MEDIA.length,
        ...(url.pathname === '/rotate.mp4' ? { 'Set-Cookie': 'ROTATED=lookup-only; Path=/' } : {}) });
      res.end(MEDIA);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, http_proxy: proxy, HTTP_PROXY: proxy, https_proxy: proxy, HTTPS_PROXY: proxy,
    ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '', YTDLP_NO_PLUGINS: '', GRAB_HEADER_ORIGINS: '["http://example.test"]', GRAB_CONTEXT_KEY: 'ab'.repeat(32) };
  const run = (args, { environment = {}, input } = {}) => new Promise((resolve) => {
    const child = execFile(exe, ['--ignore-config', ...guard, '--socket-timeout', '3', '--retries', '0', '--no-warnings', ...args],
      { env: { ...env, ...environment }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  return { dir, seen, run, env, vault: new CookieVault({ tmpDir: dir }) };
}
const hostCookie = { name: 'HOST', value: 'exact-only', domain: 'example.test', hostOnly: true, path: '/', session: true };
const domainCookie = { name: 'DOMAIN', value: 'subdomains-ok', domain: '.example.test', hostOnly: false, path: '/', session: true };

test('F16: real requests preserve host-only scope on direct requests and redirects', { skip, timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  await f.vault.withJar(f.vault.remember([hostCookie, domainCookie]), async (file) => {
    for (const host of ['example.test', 'sub.example.test', 'a.b.example.test', 'unrelated.test', 'example.test.attacker.test']) {
      const r = await f.run(['--cookies', file, '-J', '--skip-download', '--', `http://${host}/video.mp4`]);
      assert.equal(r.code, 0, r.stderr);
    }
    const r = await f.run(['--cookies', file, '-J', '--skip-download', '--', 'http://example.test/redirect.mp4']);
    assert.equal(r.code, 0, r.stderr);
  });
  assert.ok(f.seen.some((r) => r.host === 'example.test' && /HOST=exact-only/.test(r.cookie)));
  for (const r of f.seen) {
    if (r.host !== 'example.test') assert.doesNotMatch(r.cookie, /HOST=/, r.host);
    if (!/(^|\.)example\.test$/.test(r.host)) assert.equal(r.cookie, '', r.host);
    if (r.host === 'sub.example.test') assert.match(r.cookie, /DOMAIN=subdomains-ok/);
  }
});

test('F06: observed origin keeps exact playback headers; a new redirect target gets origin-only Referer', { skip, timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const r = await f.run(['--user-agent', 'Recorded browser UA', '--referer', 'http://page.test/watch/private-id#fragment', '--add-headers', 'Origin:http://page.test',
    '-J', '--skip-download', '--', 'http://example.test/cross.mp4']);
  assert.equal(r.code, 0, r.stderr);
  const initial = f.seen.find((r) => r.host === 'example.test');
  assert.equal(initial.referer, 'http://page.test/watch/private-id');
  assert.equal(initial.origin, 'http://page.test');
  assert.equal(initial.ua, 'Recorded browser UA');
  const redirected = f.seen.filter((r) => r.host === 'unrelated.test');
  assert.ok(redirected.length);
  for (const row of redirected) { assert.equal(row.referer, 'http://page.test/'); assert.equal(row.origin, ''); }
});

test('F16: metadata round trips preserve anonymous rotated cookie scope', { skip, timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const lookup = await f.run(['-J', '--skip-download', '--', 'http://example.test/rotate.mp4']);
  assert.equal(lookup.code, 0, lookup.stderr);
  const info = JSON.parse(lookup.stdout);
  const rotated = info.grab_cookie_records.find((r) => r.name === 'ROTATED');
  assert.equal(rotated.domain_specified, false);
  // Simulate a same-host lookup followed by media on a previously unknown child host.
  info.url = 'http://sub.example.test/video.mp4';
  delete info.formats;
  const before = f.seen.length;
  const result = await f.run(['--load-info-json', '-', '-f', 'b', '-o', path.join(f.dir, 'child.mp4')], { input: JSON.stringify(info) });
  assert.equal(result.code, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.ok(fs.existsSync(path.join(f.dir, 'child.mp4')));
  assert.ok(f.seen.length > before);
  for (const row of f.seen.slice(before)) assert.doesNotMatch(row.cookie, /ROTATED=/, JSON.stringify(row));
});

test('a disabled or unavailable mandatory plugin fails before any site request', { skip, timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(['-J', '--skip-download', '--', 'http://example.test/video.mp4'], { environment: { YTDLP_NO_PLUGINS: '1' } });
  assert.notEqual(result.code, 0);
  assert.equal(f.seen.length, 0);
});

test('F01: real cached download keeps lookup cookies in memory and sends them only to their host', { skip, timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const engine = require('../electron/engine.cjs');
  engine.setUserBinDir(engineDir);
  const old = {};
  for (const key of Object.keys(f.env)) {
    if (/proxy|GRAB_HEADER_ORIGINS|GRAB_CONTEXT_KEY/i.test(key)) { old[key] = process.env[key]; process.env[key] = f.env[key]; }
  }
  let info;
  try {
    info = await engine.analyze('http://example.test/rotate.mp4');
    assert.equal(info.ok, true, info.error);
    const cached = fs.readFileSync(info.infoFile, 'utf8');
    assert.doesNotMatch(cached, /lookup-only|grab_cookie_records|grab_cookie_signature/);
    const before = f.seen.length;
    const result = await engine.download({ url: 'http://example.test/rotate.mp4', outputBase: path.join(f.dir, 'cached'), format: 'mp4',
      infoFile: info.infoFile, infoAt: info.infoAt }, () => {}).done;
    assert.equal(result.ok, true, result.error);
    assert.ok(f.seen.slice(before).some((row) => row.host === 'example.test' && /ROTATED=lookup-only/.test(row.cookie)));
  } finally {
    if (info?.infoFile) engine.releaseInfo(info.infoFile);
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('a tampered private cookie record is rejected before any request', { skip, timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const lookup = await f.run(['-J', '--skip-download', '--', 'http://example.test/rotate.mp4']);
  assert.equal(lookup.code, 0, lookup.stderr);
  const info = JSON.parse(lookup.stdout);
  info.grab_cookie_records[0].domain_specified = true;
  const before = f.seen.length;
  const result = await f.run(['--load-info-json', '-', '-f', 'b', '-o', path.join(f.dir, 'tampered.mp4')], { input: JSON.stringify(info) });
  assert.notEqual(result.code, 0);
  assert.equal(f.seen.length, before);
});
