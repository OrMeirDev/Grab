// A job known to need the user's browser session never contacts its site without that session,
// during lookup as well as download: after a restart, after the browser disconnects, and when the
// browser can't be reached. Public pages and the hidden probe's cookies keep working.
//
// Real: DownloadCoordinator, createDiscoveryService, createDownloadRunner, CookieVault (through
// browser-session.cjs), OutputAllocator, the browser-disconnect handling (CdpClient +
// watchConnection), and a local HTTP site that logs every request.
// Controlled adapters (each sends real HTTP requests to that site, so the site's log shows exactly
// what the discovery routing caused):
//   engine      - stands in for yt-dlp: GETs the link with the cookies of the jar it is given;
//   hiddenProbe - stands in for the clean hidden browser: visits the page with no cookies;
//   pageprobe   - stands in for the user's signed-in browser: calls connect() first, then visits the
//                 page with the browser profile's account cookie;
//   defaultBrowser/connectBrowser - a browser that is available, closed, or refuses the connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const browser = require('../electron/browser-session.cjs');
const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');

// Waits for a job state (real HTTP is involved, so no fixed number of turns); fails after 20 s.
async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const statusOf = (c, i = 0) => c.jobs[i]?.status;
const settled = (c, states, i = 0) => until(() => states.includes(statusOf(c, i)), states.join('/'));
const clock = { now: () => Date.now(), setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} };

// ---- HTTP with a Netscape cookie jar (what yt-dlp would send) -------------------------------------
function jarCookies(file, host) {
  if (!file) return '';
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/^#HttpOnly_/, '')).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t')).filter((f) => {
      const d = f[0].replace(/^\./, '');
      return host === d || host.endsWith('.' + d);
    }).map((f) => `${f[5]}=${f[6]}`).join('; ');
}
function get(url, { cookie = '', referer } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { ...(cookie ? { cookie } : {}), ...(referer ? { referer } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks), setCookie: res.headers['set-cookie'] || [] }));
    });
    req.on('error', () => resolve({ status: 0, type: '', body: Buffer.alloc(0), setCookie: [] }));
  });
}
const cookiesFrom = (setCookie, host) => setCookie.map((c) => {
  const [pair] = c.split(';');
  const [name, value] = pair.split('=');
  return { domain: host, path: '/', name, value, httpOnly: /httponly/i.test(c), session: true };
});

// ---- one "run" of Grab -------------------------------------------------------------------------
function grab({ site, saved, dir, browserState }) {
  const calls = { engine: [], hidden: 0, page: 0, connect: 0, downloads: [] };
  const host = new URL(site.base).hostname;
  const account = [{ domain: host, path: '/', name: 'account', value: 'member', httpOnly: true, session: true }];

  const engine = {
    analyze: async (url, o = {}) => {
      const cookie = jarCookies(o.cookieFile, host);
      calls.engine.push({ url, withCookies: !!cookie });
      const r = await get(url, { cookie, referer: o.requestContext?.referer || o.referer });
      if (r.status === 401 || r.status === 403) return { ok: false, kind: 'private', error: 'login required' };
      if (r.status !== 200) return { ok: false, kind: 'unavailable', error: 'HTTP ' + r.status };
      if (!/^video\//.test(r.type)) return { ok: false, kind: 'notfound', error: 'Unsupported URL' };
      return { ok: true, title: o.title || path.basename(new URL(url).pathname), site: 'Generic', infoFile: null, infoAt: null };
    },
    download: (job) => {
      if (calls.hold) return { done: new Promise((r) => { calls.release = r; }), stop: () => calls.release?.({ ok: false, stopped: true }) };
      const target = job.mediaUrl || job.url;
      const done = get(target, { cookie: jarCookies(job.cookieFile, host), referer: job.requestContext?.referer || job.referer }).then((r) => {
        calls.downloads.push({ url: target, status: r.status });
        if (r.status !== 200) return { ok: false, kind: 'private', error: 'HTTP ' + r.status };
        fs.writeFileSync(job.outputBase + '.mp4', r.body);
        return { ok: true, file: job.outputBase + '.mp4' };
      });
      return { done, stop() {} };
    },
  };
  const visit = async (url, cookie) => {
    const page = await get(url, { cookie });
    const src = /<video[^>]*src="([^"]+)"/.exec(page.body.toString())?.[1];
    return { page, candidates: src ? [{ url: new URL(src, url).href, kind: 'file', requestContext: { userAgent: 'UA', referer: url } }] : [] };
  };
  const hiddenProbe = {
    findMedia: async (url) => {
      calls.hidden++;
      const { page, candidates } = await visit(url, '');
      const cookies = cookiesFrom(page.setCookie, host);
      return { candidates, title: '', cookieRef: cookies.length ? browser.rememberCookies(cookies, { source: 'probe' }) : null };
    },
  };
  const pageprobe = {
    findMedia: async (url, { connect }) => {
      await connect();
      calls.page++;
      const cookie = account.map((c) => `${c.name}=${c.value}`).join('; ');
      const { page, candidates } = await visit(url, cookie);
      const cookies = [...account, ...cookiesFrom(page.setCookie, host)];
      return { candidates, title: '', reusedTab: false, requestContext: { userAgent: 'UA', referer: url }, cookieRef: browser.rememberCookies(cookies, { source: 'browser' }) };
    },
  };
  const browserSession = {
    ...browser,
    defaultBrowser: () => ({ name: 'Chrome', scheme: 'chrome' }),
    connectBrowser: async () => {
      calls.connect++;
      if (browserState.mode === 'closed') throw Object.assign(new Error('Open Chrome and enable remote debugging'), { kind: 'browserSession' });
      if (browserState.mode === 'denied') throw Object.assign(new Error('Could not connect to Chrome; allow the connection'), { kind: 'browserSession' });
      if (browserState.mode === 'unsupported') throw Object.assign(new Error('Firefox is not supported'), { kind: 'browserUnsupported' });
      if (!browserState.cdp?.connected) {
        const socket = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() { this.readyState = 3; this.emit('close'); } });
        browserState.cdp = browser.watchConnection(new browser.CdpClient(socket));
      }
      return browserState.cdp;
    },
  };
  const discovery = createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession });
  const runner = createDownloadRunner({ engine, browserSession, allocator: new OutputAllocator() });
  const c = new DownloadCoordinator({
    clock, random: () => 0,
    store: { load: async () => saved.list || [], save: async (l) => { saved.list = JSON.parse(JSON.stringify(l)); } },
    getSettings: async () => ({ folder: dir, format: 'mp4', quality: 'best' }),
    recordCompletion: async () => {},
    releaseContext: (job) => { if (job.cookieRef) browser.forgetCookies(job.cookieRef); },
    hasSession: (ref) => browser.hasCookies(ref),
    discover: (url, o) => discovery.analyze(url, o),
    startDownload: (plan, onProgress) => runner.start(plan, onProgress),
  });
  return { c, calls };
}

async function withSite(fn) {
  const site = await require('./fixtures/media-site.cjs').start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-session-discovery-'));
  try { return await fn(site, dir); } finally {
    browser.disconnectBrowser();
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every request to the members-only area since `from` (page and media alike).
const membersRequests = (site, from) => site.log.slice(from).filter((l) => l.url.startsWith('/members/'));
const withoutSession = (site, from) => membersRequests(site, from).filter((l) => !/account=member/.test(l.cookie || '')).map((l) => l.url);

// Run 1: look up `link` (it needs the session), maybe start downloading, quit Grab.
async function firstRun({ site, saved, dir, link, interrupt }) {
  const state = { mode: 'available' };
  const one = grab({ site, saved, dir, browserState: state });
  one.c.add([{ url: link }], { useBrowser: true });
  await settled(one.c, ['ready', 'error']);
  assert.equal(one.c.jobs[0].status, 'ready', JSON.stringify(one.c.jobs[0].error));
  assert.deepEqual(withoutSession(site, 0), [], 'explicit browser mode uses the session from the very first request');
  if (interrupt) {
    one.calls.hold = true;
    one.c.downloadOne(one.c.jobs[0].id);
    await until(() => !!one.calls.release, 'the download to start');
    assert.equal(one.c.jobs[0].status, 'downloading');
  }
  await one.c.shutdown();
  browser.disconnectBrowser(); // quitting Grab
  return one;
}

const LINKS = {
  direct: { path: '/members/clip.mp4', fromPage: false },
  embedded: { path: '/members/watch', fromPage: true },
};

for (const [kind, link] of Object.entries(LINKS)) {
  for (const interrupt of [false, true]) {
    test(`restart: ${kind === 'direct' ? 'direct authenticated extractor' : 'embedded player'}, ${interrupt ? 'interrupted (restored paused)' : 'found, not started'}: every lookup and download request carries the session`, () => withSite(async (site, dir) => {
      const saved = {};
      await firstRun({ site, saved, dir, link: site.base + link.path, interrupt });
      assert.equal(saved.list[0].fromPage === true, link.fromPage);

      const from = site.log.length;
      const two = grab({ site, saved, dir, browserState: { mode: 'available' } });
      await two.c.init();
      const job = two.c.jobs[0];
      assert.equal(job.status, interrupt ? 'paused' : 'ready');
      if (interrupt) two.c.resume(job.id); else two.c.downloadOne(job.id);
      await settled(two.c, ['done', 'error']);

      assert.deepEqual(withoutSession(site, from), [], 'no request to the members area without the session');
      assert.equal(two.calls.hidden, 0, 'the clean hidden probe is not used');
      assert.deepEqual(two.calls.engine.filter((e) => !e.withCookies), [], 'no cookieless yt-dlp lookup');
      assert.equal(two.calls.connect >= 1, true, 'the browser session was acquired first');
      assert.equal(two.c.jobs[0].status, 'done', JSON.stringify(two.c.jobs[0].error));
      assert.ok(membersRequests(site, from).length >= 2);
      assert.ok(!two.c.jobs[0].autoRetried, 'the automatic retry is unused');
      if (!link.fromPage) assert.equal(two.calls.page, 1, 'the direct extractor is used again with the session (no embedded-media detour)');
      assert.equal(two.calls.downloads.at(-1).url, link.fromPage ? site.base + '/members/media' : site.base + link.path);
    }));
  }
}

for (const mode of ['closed', 'denied', 'unsupported']) {
  test(`restart with the browser ${mode}: an explicit session error, and the site is never contacted`, () => withSite(async (site, dir) => {
    const saved = {};
    await firstRun({ site, saved, dir, link: site.base + '/members/watch', interrupt: false });
    const from = site.log.length;
    const two = grab({ site, saved, dir, browserState: { mode } });
    await two.c.init();
    two.c.downloadOne(two.c.jobs[0].id);
    await settled(two.c, ['done', 'error']);
    const job = two.c.jobs[0];
    assert.equal(job.status, 'error');
    assert.equal(job.error.kind, 'sessionRequired');
    assert.equal(job.signInHint, true, 'the row offers the browser guide');
    assert.deepEqual(membersRequests(site, from).map((l) => l.url), [], 'the members area saw no request at all');
    assert.equal(two.calls.hidden, 0);
    assert.equal(two.calls.engine.length, 0);
    assert.ok(!job.autoRetried);
  }));
}

test('browser disconnect, then download/resume: looked up again through the browser, never without the session', () => withSite(async (site, dir) => {
  const state = { mode: 'available' };
  const g = grab({ site, saved: {}, dir, browserState: state });
  g.c.add([{ url: site.base + '/members/clip.mp4' }], { useBrowser: true });
  await settled(g.c, ['ready', 'error']);
  assert.equal(g.c.jobs[0].status, 'ready');
  const from = site.log.length;
  state.cdp.disconnect(); // the user closed the browser; its account cookies are dropped
  state.mode = 'closed';
  g.c.downloadOne(g.c.jobs[0].id);
  await settled(g.c, ['done', 'error']);
  assert.equal(g.c.jobs[0].status, 'error');
  assert.equal(g.c.jobs[0].error.kind, 'sessionRequired');
  assert.deepEqual(membersRequests(site, from).map((l) => l.url), [], 'nothing sent while the browser is gone');

  state.mode = 'available'; // the browser is open again
  g.c.retry(g.c.jobs[0].id);
  await until(() => statusOf(g.c) !== 'error', 'the retry to start');
  await settled(g.c, ['done', 'error']);
  assert.equal(g.c.jobs[0].status, 'done', JSON.stringify(g.c.jobs[0].error));
  assert.deepEqual(withoutSession(site, from), []);
  assert.deepEqual(g.calls.engine.slice(1).filter((e) => !e.withCookies), [], 'after the first lookup, no cookieless yt-dlp call');
  assert.ok(!g.c.jobs[0].autoRetried);
}));

test('a restored job that needs the session but has no provenance (saved by an older version) is treated as needing the browser', () => withSite(async (site, dir) => {
  const saved = { list: [{ id: 'old-1', url: site.base + '/members/clip.mp4', label: '', name: 'clip', status: 'ready', progress: 0, site: 'Generic', siteKey: '127.0.0.1', needsSession: true }] };
  const from = site.log.length;
  const g = grab({ site, saved, dir, browserState: { mode: 'available' } });
  await g.c.init();
  g.c.downloadOne('old-1');
  await settled(g.c, ['done', 'error']);
  assert.deepEqual(withoutSession(site, from), []);
  assert.equal(g.calls.hidden, 0);
  assert.equal(g.c.jobs[0].status, 'done', JSON.stringify(g.c.jobs[0].error));
}));

test('public pages keep the ordinary lookup, and the hidden probe\'s cookies still work, after a restart too', () => withSite(async (site, dir) => {
  // In one session: found through the hidden probe, downloaded with the cookies its player got.
  const live = grab({ site, saved: {}, dir, browserState: { mode: 'closed' } }); // no browser needed
  live.c.add([{ url: site.base + '/watch' }]);
  await settled(live.c, ['ready', 'error']);
  assert.equal(live.c.jobs[0].status, 'ready', JSON.stringify(live.c.jobs[0].error));
  assert.equal(live.calls.hidden, 1);
  live.c.downloadOne(live.c.jobs[0].id);
  await settled(live.c, ['done', 'error']);
  assert.equal(live.c.jobs[0].status, 'done', 'the public player cookies from the hidden probe were used');
  assert.equal(live.calls.connect, 0);
  browser.disconnectBrowser();

  // Found, Grab restarted, then downloaded: the ordinary sequence again, no browser.
  const saved = {};
  const one = grab({ site, saved, dir, browserState: { mode: 'closed' } });
  one.c.add([{ url: site.base + '/watch' }]);
  await settled(one.c, ['ready', 'error']);
  assert.equal(one.c.jobs[0].status, 'ready');
  await one.c.shutdown();
  browser.disconnectBrowser();
  const two = grab({ site, saved, dir, browserState: { mode: 'closed' } });
  await two.c.init();
  two.c.downloadOne(two.c.jobs[0].id);
  await until(() => statusOf(two.c) !== 'ready', 'the download to start');
  await settled(two.c, ['done', 'error']);
  assert.equal(two.c.jobs[0].status, 'done', JSON.stringify(two.c.jobs[0].error));
  assert.equal(two.calls.connect, 0, 'a public page never needs the browser');
  assert.ok(two.calls.hidden >= 1, 'looked up again through the ordinary sequence');
}));
