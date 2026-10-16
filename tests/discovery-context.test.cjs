// Candidate policy, the hidden-probe candidate budget and context (GRB-12), cookie lifetime
// (GRB-07) and browser connection identity (GRB-13).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify, rankMedia, playerEmbeds, budget, CANDIDATE_BUDGET } = require('../electron/domain/candidate-policy.cjs');
const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
const { isNotPlayer } = require('../electron/media-collector.cjs');
const browser = require('../electron/browser-session.cjs');

const page = 'https://public.example/watch';

test('candidate policy: media kinds, rejections, ranking, embeds, budget', () => {
  assert.deepEqual(classify('https://a.example/v.m3u8?token=x'), { kind: 'stream' });
  assert.deepEqual(classify('https://a.example/clip', 'video/mp4'), { kind: 'file' });
  assert.deepEqual(classify('https://a.example/seg-001.ts'), { reject: 'segment' });
  assert.deepEqual(classify('https://doubleclick.net/x.mp4'), { reject: 'ad' });
  assert.deepEqual(classify('blob:https://a.example/x'), { reject: 'not-http' });
  assert.deepEqual(classify('https://a.example/page.html'), { reject: 'not-media' });
  const ranked = rankMedia([{ url: 'f', kind: 'file', size: 9 }, { url: 's', kind: 'stream', size: 0 }, { url: 'p', kind: 'file', size: 1, fromPlayer: true }]);
  assert.deepEqual(ranked.map((m) => m.url), ['p', 's', 'f']);
  assert.deepEqual(playerEmbeds(['https://player.vimeo.com/video/1', 'https://public.example/self', 'https://js.stripe.com/v3/x'], page, isNotPlayer), ['https://player.vimeo.com/video/1']);
  const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://a.example/${i % 15}.mp4` }));
  assert.equal(budget(many).length, CANDIDATE_BUDGET);
  assert.equal(new Set(budget(many).map((c) => c.url)).size, CANDIDATE_BUDGET);
});

test('hidden probe: a valid fifth source is found, with its player context and page cookies', async () => {
  const cookieRef = browser.rememberCookies([{ domain: 'public.example', path: '/', name: 'play', value: 'set-by-player', session: true }]);
  const tried = [];
  const service = createDiscoveryService({
    browserSession: browser,
    pageprobe: { findMedia: async () => { throw new Error('the active browser must not be touched'); } },
    hiddenProbe: { findMedia: async () => ({ title: 'Public', cookieRef, candidates: Array.from({ length: 6 }, (_, i) => ({
      url: `https://cdn.example/v${i}.m3u8`, kind: 'stream',
      requestContext: { userAgent: 'Probe UA', referer: 'https://player.example/embed', origin: 'https://player.example' },
    })) }) },
    engine: { analyze: async (url, o) => {
      if (url === page) return { ok: false, kind: 'notfound' };
      tried.push(url);
      assert.match(fs.readFileSync(o.cookieFile, 'utf8'), /play\tset-by-player/);
      assert.deepEqual(o.requestContext, { userAgent: 'Probe UA', referer: 'https://player.example/embed', origin: 'https://player.example' });
      return url.endsWith('v4.m3u8') ? { ok: true, title: 'Public' } : { ok: false, kind: 'other' };
    } },
  });
  const r = await service.analyze(page);
  assert.equal(r.ok, true);
  assert.equal(tried.length, 5, 'the fifth candidate is tried');
  assert.equal(r.mediaUrl, 'https://cdn.example/v4.m3u8');
  assert.equal(r.referer, 'https://player.example/embed');
  assert.equal(r.cookieRef, cookieRef);
  assert.equal(r.requestContext.origin, 'https://player.example');
});

test('a lookup stops checking candidates when its time budget is spent', async () => {
  let t = 0;
  const tried = [];
  const service = createDiscoveryService({
    now: () => t,
    browserSession: browser,
    pageprobe: { findMedia: async () => ({ candidates: [] }) },
    hiddenProbe: { findMedia: async () => ({ candidates: Array.from({ length: 10 }, (_, i) => ({ url: `https://cdn.example/${i}.mp4`, kind: 'file' })) }) },
    engine: { analyze: async (url) => { if (url !== page) { tried.push(url); t += 2 * 60 * 1000; } return { ok: false, kind: 'notfound' }; } },
  });
  const r = await service.analyze(page);
  assert.equal(r.ok, false);
  assert.ok(tried.length <= 4, `tried ${tried.length}`);
});

test('cookie vault: expiry is an error (never a silent unauthenticated run), forget, crash leftovers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-vault-'));
  let now = 0;
  try {
    const vault = new CookieVault({ tmpDir: dir, ttlMs: 1000, now: () => now });
    const ref = vault.remember([{ domain: '.a.example', path: '/', name: 's', value: 'v', session: true }]);
    await vault.withJar(ref, (file) => {
      assert.match(fs.readFileSync(file, 'utf8'), /\ts\tv/);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      }
    });
    assert.equal(await vault.withJar(undefined, (file) => file), undefined, 'no handle: no jar, no error');
    now = 1001;
    await assert.rejects(vault.withJar(ref, () => {}), { kind: 'contextExpired' });
    const other = vault.remember([{ domain: 'a.example', path: '/', name: 's', value: 'v' }]);
    vault.forget(other);
    await assert.rejects(vault.withJar(other, () => {}), { kind: 'contextExpired' });
    fs.mkdirSync(path.join(dir, 'grab-cookies-crashed'));
    fs.writeFileSync(path.join(dir, 'grab-cookies-crashed', 'cookies.txt'), 'secret');
    fs.mkdirSync(path.join(dir, 'unrelated'));
    assert.equal(vault.scavenge(), 1);
    assert.deepEqual(fs.readdirSync(dir), ['unrelated']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an expired session handle at download time looks the page up again instead of downloading without it', async () => {
  const discovers = [];
  const starts = [];
  const c = new DownloadCoordinator({
    clock: { now: () => 0, setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} },
    random: () => 0,
    getSettings: async () => ({ folder: '/dl', format: 'mp4', quality: 'best' }),
    recordCompletion: async () => {},
    discover: async (url, o) => { discovers.push(o.forcePage); return { ok: true, site: 'Generic', title: 'L', mediaUrl: 'https://s.example/m.m3u8', cookieRef: `ref${discovers.length}` }; },
    startDownload: (plan) => {
      starts.push(plan.cookieRef);
      return { done: Promise.resolve(starts.length === 1 ? { ok: false, kind: 'contextExpired' } : { ok: true, file: '/dl/L.mp4' }), stop() {} };
    },
  });
  c.add([{ url: page }]);
  for (let i = 0; i < 50 && c.jobs[0].status !== 'ready'; i++) await new Promise((r) => setImmediate(r));
  c.downloadOne(c.jobs[0].id);
  for (let i = 0; i < 200 && c.jobs[0].status !== 'done'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(c.jobs[0].status, 'done');
  assert.deepEqual(discovers, [false, true]);
  assert.deepEqual(starts, ['ref1', 'ref2']);
  assert.equal(c.jobs[0].autoRetried, undefined, 'the one automatic retry is still available');
});

test('browser connections are per endpoint: same browser name, different profile, different connection', async () => {
  const { WebSocketServer } = require('ws');
  const servers = await Promise.all([0, 1].map(async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => server.once('listening', r));
    server.on('connection', (s) => s.on('message', (raw) => { const m = JSON.parse(String(raw)); s.send(JSON.stringify({ id: m.id, result: {} })); }));
    return server;
  }));
  const dirs = servers.map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'grab-profile-')));
  try {
    const files = servers.map((server, i) => {
      const f = path.join(dirs[i], 'DevToolsActivePort');
      fs.writeFileSync(f, `${server.address().port}\n/devtools/browser/p${i}\n`);
      return f;
    });
    const a = await browser.connectBrowser({ browser: { name: 'Chrome', scheme: 'chrome', endpointFile: files[0] } });
    const again = await browser.connectBrowser({ browser: { name: 'Chrome', scheme: 'chrome', endpointFile: files[0] } });
    assert.equal(a, again);
    const b = await browser.connectBrowser({ browser: { name: 'Chrome', scheme: 'chrome', endpointFile: files[1] } });
    assert.notEqual(a, b, 'a second profile with the same browser name gets its own connection');
    assert.match(b.endpoint, /\/p1$/);
    browser.disconnectBrowser();
  } finally {
    for (const server of servers) { for (const s of server.clients) s.terminate(); await new Promise((r) => server.close(r)); }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('diagnostics keep the facts and drop every secret', () => {
  const { Diagnostics, redact } = require('../electron/infrastructure/diagnostics.cjs');
  const d = new Diagnostics();
  const e = d.record('lookup', {
    url: 'https://stream.mux.com/abc.m3u8?token=header.payload.signature#t=3',
    ok: false, kind: 'private', ms: 1200,
    error: 'HTTP Error 403 for https://cdn.example/v.mp4?Signature=xyz&Expires=1',
    cookieRef: 'handle', cookieFile: '/tmp/grab-cookies-1/cookies.txt', requestContext: { userAgent: 'UA', referer: 'https://p.example/?sid=1' },
    diagnostics: { framesScanned: 3, rejected: { ad: 2 } }, headers: { Cookie: 'a=b', Authorization: 'Bearer x' },
  });
  const text = JSON.stringify(e);
  for (const secret of ['token=', 'signature', 'Signature=', 'Expires', 'handle', 'cookies.txt', 'UA', 'sid=1', 'a=b', 'Bearer', '#t=3']) assert.equal(text.includes(secret), false, secret);
  assert.equal(e.url, 'https://stream.mux.com');
  assert.equal(e.error, undefined, 'free-form server errors must never persist');
  assert.equal(e.diagnostics, undefined, 'arbitrary nested diagnostic fields must never persist');
  assert.equal(d.recent(1)[0], e);
});
