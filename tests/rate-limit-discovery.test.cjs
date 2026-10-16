// HTTP 429 (a rate limit) and "confirm you're not a bot" checks are different answers:
// - 429: the site asked us to slow down. The lookup stops at the first 429, wherever it comes from
//   (the link itself, the retry with the browser session's cookies, or a source found in a page),
//   and the site is held until the user presses "resume <site>". The user's browser and the
//   hidden browser are not tried, and no further request goes to the site.
// - A bot check: the user's signed-in browser may get past it, so the lookup goes on through it.
//   If the site still asks with the session and the page shows no video, the site is held too
//   (it is not reported as "no video at this link").
//
// Real: DownloadCoordinator, createDiscoveryService, errorKind (domain/engine-errors.cjs),
// CookieVault (browser-session.cjs). Controlled adapters send real HTTP requests to a local site
// whose answers are scripted per request, so its log shows exactly what discovery caused:
//   engine      - stands in for yt-dlp: GETs the link (with the cookie jar it is given) and turns
//                 the answer into yt-dlp's error text, classified by the real errorKind;
//   hiddenProbe - the clean hidden browser: visits the page with no cookies;
//   pageprobe   - the user's signed-in browser (available here): connects, then visits the page
//                 with the account cookie.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const browser = require('../electron/browser-session.cjs');
const { errorKind } = require('../electron/domain/engine-errors.cjs');
const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');

test('errorKind: HTTP 429 is a rate limit; a bot check is a block', () => {
  assert.equal(errorKind('ERROR: [generic] Unable to download webpage: HTTP Error 429: Too Many Requests'), 'rateLimited');
  assert.equal(errorKind('ERROR: unable to download video data: HTTP Error 429: Too Many Requests'), 'rateLimited');
  assert.equal(errorKind("ERROR: [youtube] x: Sign in to confirm you're not a bot"), 'blocked');
  assert.equal(errorKind('ERROR: [x] y: Private video'), 'private');
});

// ---- a site whose answers are scripted per path and request number ----------------------------
// steps: '429' | 'bot' (a "confirm you're not a bot" page) | 'empty' (a page with no player) |
// 'page:<src>' (a page whose player plays <src>) | 'media'. The last step repeats.
async function scriptedSite(script) {
  const log = [];
  const count = new Map();
  const server = http.createServer((req, res) => {
    const n = (count.get(req.url) || 0) + 1;
    count.set(req.url, n);
    log.push({ path: req.url, host: (req.headers.host || '').split(':')[0], cookie: req.headers.cookie || '', n });
    const steps = script[req.url] || ['404'];
    const step = steps[Math.min(n, steps.length) - 1];
    const html = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>Lesson</title>${body}`); };
    if (step === '429') { res.writeHead(429, { 'retry-after': '3600' }); res.end('Too Many Requests'); return; }
    if (step === 'bot') return html("<p>Sign in to confirm you're not a bot</p>");
    if (step === 'empty') return html('<p>Lesson 1</p>');
    if (step.startsWith('page:')) return html(`<video src="${step.slice(5)}"></video>`);
    if (step === 'media') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(Buffer.alloc(1024)); return; }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    log,
    url: (path, host = '127.0.0.1') => `http://${host}:${port}${path}`,
    requests: (path) => log.filter((l) => l.path === path).length,
    close: () => new Promise((r) => server.close(r)),
  };
}

function get(url, { cookie = '' } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: cookie ? { cookie } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', () => resolve({ status: 0, type: '', body: '' }));
  });
}
const jarCookies = (file) => (file ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/^#HttpOnly_/, ''))
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')).map((f) => `${f[5]}=${f[6]}`).join('; ') : '');

function grab(site) {
  const calls = { engine: [], hidden: 0, page: 0, connect: 0 };
  const engine = {
    analyze: async (url, o = {}) => {
      const cookie = jarCookies(o.cookieFile);
      calls.engine.push({ url, withCookies: !!cookie });
      const r = await get(url, { cookie });
      const fail = (message) => ({ ok: false, kind: errorKind(message), error: message });
      if (r.status === 429) return fail('ERROR: [generic] Unable to download webpage: HTTP Error 429: Too Many Requests');
      if (r.status !== 200) return fail(`ERROR: HTTP Error ${r.status}`);
      if (/not a bot/.test(r.body)) return fail("ERROR: [generic] Sign in to confirm you're not a bot");
      if (!/^video\//.test(r.type)) return fail('ERROR: Unsupported URL: ' + url);
      return { ok: true, title: o.title || 'lesson', site: 'Generic', infoFile: null, infoAt: null };
    },
  };
  const visit = async (url, cookie) => {
    const page = await get(url, { cookie });
    const src = /<video[^>]*src="([^"]+)"/.exec(page.body)?.[1];
    return src ? [{ url: new URL(src, url).href, kind: 'file', requestContext: { userAgent: 'UA', referer: url } }] : [];
  };
  const hiddenProbe = { findMedia: async (url) => { calls.hidden++; return { candidates: await visit(url, ''), title: '', cookieRef: null }; } };
  const host = new URL(site.url('/')).hostname;
  const account = [{ domain: host, path: '/', name: 'account', value: 'member', httpOnly: true, session: true }];
  const pageprobe = {
    findMedia: async (url, { connect }) => {
      await connect();
      calls.page++;
      const candidates = await visit(url, 'account=member');
      return { candidates, title: '', reusedTab: false, requestContext: { userAgent: 'UA', referer: url }, cookieRef: browser.rememberCookies(account, { source: 'browser' }) };
    },
  };
  let cdp = null;
  const browserSession = {
    ...browser,
    defaultBrowser: () => ({ name: 'Chrome', scheme: 'chrome' }),
    // The user's browser is open, debugging is on and the connection is allowed.
    connectBrowser: async () => {
      calls.connect++;
      if (!cdp?.connected) {
        const socket = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() { this.readyState = 3; this.emit('close'); } });
        cdp = browser.watchConnection(new browser.CdpClient(socket));
      }
      return cdp;
    },
  };
  const discovery = createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession });
  const c = new DownloadCoordinator({
    clock: { now: () => Date.now(), setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} },
    random: () => 0,
    getSettings: async () => ({ folder: '/tmp', format: 'mp4', quality: 'best' }),
    recordCompletion: async () => {},
    releaseContext: (job) => { if (job.cookieRef) browser.forgetCookies(job.cookieRef); },
    hasSession: (ref) => browser.hasCookies(ref),
    discover: (url, o) => discovery.analyze(url, o),
    startDownload: () => { throw new Error('no download in these tests'); },
  });
  return { c, calls };
}

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const held = (c) => c.snapshot().blockedSites.map((b) => b.key);
const job = (c, url) => c.jobs.find((j) => j.url === url);
// Nothing more happens for a while (lookups run on immediate timers here).
const quiet = () => new Promise((r) => setTimeout(r, 300));

async function withSite(script, fn) {
  const site = await scriptedSite(script);
  try { return await fn(site); } finally {
    browser.disconnectBrowser();
    await site.close();
  }
}

test('429 on the lookup: the site is held at once; no browser, no hidden browser, no second request; "resume" continues', () => withSite({
  '/a/lesson.mp4': ['429', 'media'],
  '/b/other.mp4': ['media'],
}, async (site) => {
  const { c, calls } = grab(site);
  const limited = site.url('/a/lesson.mp4');
  const other = site.url('/b/other.mp4', 'localhost');
  c.add([{ url: limited }, { url: other }]);
  await until(() => held(c).includes('127.0.0.1') && job(c, other).status === 'ready', 'the hold and the other site');
  await quiet();
  assert.equal(job(c, limited).status, 'waiting');
  assert.equal(job(c, limited).error, null);
  assert.equal(calls.connect, 0, 'the user\'s browser is not contacted');
  assert.equal(calls.page, 0);
  assert.equal(calls.hidden, 0, 'the hidden browser is not used');
  assert.equal(site.requests('/a/lesson.mp4'), 1, 'one request, the one that got 429');
  c.resumeSite('127.0.0.1');
  await until(() => job(c, limited).status === 'ready', 'the lookup after resume');
  assert.equal(site.requests('/a/lesson.mp4'), 2);
  assert.deepEqual(held(c), []);
}));

test('429 on the extractor with the explicitly chosen browser session: held at once; no source in the page is tried', () => withSite({
  '/c/lesson': ['page:/c/media.mp4', '429'],
  '/c/media.mp4': ['media'],
}, async (site) => {
  const { c, calls } = grab(site);
  const link = site.url('/c/lesson');
  c.add([{ url: link }], { useBrowser: true });
  await until(() => held(c).includes('127.0.0.1'), 'the hold');
  await quiet();
  assert.equal(job(c, link).status, 'waiting');
  assert.equal(calls.page, 1, 'the chosen browser acquired the session');
  assert.deepEqual(calls.engine.map((e) => e.withCookies), [true], 'only the authenticated extractor is used');
  assert.equal(site.requests('/c/lesson'), 2, 'the browser\'s visit, then the extractor that got 429');
  assert.equal(site.requests('/c/media.mp4'), 0, 'no source was tried after the 429');
}));

test('429 on a source the hidden browser found: held at once; the user\'s browser is not tried', () => withSite({
  '/f/page': ['page:/f/media.mp4'],
  '/f/media.mp4': ['429', 'media'],
}, async (site) => {
  const { c, calls } = grab(site);
  const link = site.url('/f/page');
  c.add([{ url: link }]);
  await until(() => held(c).includes('127.0.0.1') || job(c, link).status !== 'analyzing' && job(c, link).status !== 'waiting', 'the lookup to end');
  await quiet();
  assert.equal(job(c, link).status, 'waiting', JSON.stringify(job(c, link).error));
  assert.deepEqual(held(c), ['127.0.0.1']);
  assert.equal(calls.hidden, 1);
  assert.equal(calls.connect, 0, 'the user\'s browser is not contacted');
  assert.equal(site.requests('/f/media.mp4'), 1);
  assert.equal(site.requests('/f/page'), 2, 'the plain lookup and the hidden browser\'s visit, nothing after the 429');
}));

test('bot check in explicit browser mode with a player: found through that session', () => withSite({
  '/d/lesson': ['page:/d/media.mp4', 'bot'],
  '/d/media.mp4': ['media'],
}, async (site) => {
  const { c, calls } = grab(site);
  const link = site.url('/d/lesson');
  c.add([{ url: link }], { useBrowser: true });
  await until(() => ['ready', 'error'].includes(job(c, link).status), 'the lookup');
  assert.equal(job(c, link).status, 'ready', JSON.stringify(job(c, link).error));
  assert.equal(job(c, link).mediaUrl, site.url('/d/media.mp4'));
  assert.equal(job(c, link).sessionSource, 'browser');
  assert.equal(calls.page, 1);
  assert.deepEqual(held(c), []);
}));

test('bot check in explicit browser mode without a video: the site is held, not reported as "no video"', () => withSite({
  '/e/lesson': ['empty', 'bot'],
}, async (site) => {
  const { c, calls } = grab(site);
  const link = site.url('/e/lesson');
  c.add([{ url: link }], { useBrowser: true });
  await until(() => held(c).includes('127.0.0.1') || job(c, link).status === 'error', 'the lookup to end');
  await quiet();
  assert.equal(job(c, link).status, 'waiting', JSON.stringify(job(c, link).error));
  assert.equal(job(c, link).error, null);
  assert.deepEqual(held(c), ['127.0.0.1']);
  assert.equal(calls.page, 1, 'the browser was tried');
  assert.equal(site.requests('/e/lesson'), 2, 'browser visit and authenticated extractor; nothing after');
}));

test('a bot check in ordinary mode holds the site without connecting to a browser', () => withSite({
  '/public/lesson': ['bot'],
}, async (site) => {
  const { c, calls } = grab(site);
  const link = site.url('/public/lesson');
  c.add([{ url: link }]);
  await until(() => held(c).includes('127.0.0.1'), 'the hold');
  await quiet();
  assert.equal(site.requests('/public/lesson'), 1);
  assert.equal(calls.connect, 0);
  assert.equal(calls.hidden, 0);
  assert.equal(calls.page, 0);
}));
