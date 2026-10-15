// A download that needs the user's session, resumed after Grab restarts; session material when
// the browser connection is lost; what queue.json may hold. The real cookie vault, download runner
// and output allocator; the engine and lookups are fakes (no account, nothing online).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const browser = require('../electron/browser-session.cjs');
const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
const { toDurable } = require('../electron/domain/job.cjs');

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const clock = { now: () => 0, setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} };
const SESSION = [{ domain: '.members.example', path: '/', name: 'session', value: 'signed-in', httpOnly: true, secure: true, session: true }];

// One "run" of Grab: a coordinator over a shared saved queue. The site refuses any download
// whose cookie jar lacks the signed-in session cookie.
function grabRun({ saved, dir, lookups }) {
  const downloads = [];
  const discovers = [];
  const store = { load: async () => saved.list || [], save: async (list) => { saved.list = JSON.parse(JSON.stringify(list)); } };
  const engine = {
    download: (job) => {
      const jar = job.cookieFile ? fs.readFileSync(job.cookieFile, 'utf8') : '';
      const signedIn = /\tsession\tsigned-in/.test(jar);
      downloads.push({ url: job.mediaUrl || job.url, signedIn });
      if (!signedIn) return { done: Promise.resolve({ ok: false, kind: 'private', error: 'login required' }), stop() {} };
      const file = job.outputBase + '.mp4';
      fs.writeFileSync(file, 'video');
      return { done: Promise.resolve({ ok: true, file }), stop() {} };
    },
  };
  const runner = createDownloadRunner({ engine, browserSession: browser, allocator: new OutputAllocator() });
  const c = new DownloadCoordinator({
    clock, random: () => 0, store,
    getSettings: async () => ({ folder: dir, format: 'mp4', quality: 'best' }),
    recordCompletion: async () => {},
    releaseContext: (job) => { if (job.cookieRef) browser.forgetCookies(job.cookieRef); },
    discover: async (url, o) => { discovers.push({ url, forcePage: !!o.forcePage }); return lookups(url, o); },
    startDownload: (plan, onProgress) => runner.start(plan, onProgress),
  });
  return { c, downloads, discovers };
}

const CASES = [
  {
    name: 'a members-only video yt-dlp reads with the session cookies',
    url: 'https://members.example/watch/42',
    lookups: () => ({ ok: true, title: 'Members lesson', site: 'MembersSite', cookieRef: browser.rememberCookies(SESSION, { source: 'browser' }) }),
    expectForcePage: false,
  },
  {
    name: 'a video found inside the page\'s player',
    url: 'https://members.example/course/lesson-3',
    lookups: (url, o) => ({ ok: true, title: 'Lesson 3', site: 'Generic', mediaUrl: `https://cdn.example/l3.m3u8?token=${o.forcePage ? 'fresh' : 'first'}`, cookieRef: browser.rememberCookies(SESSION, { source: 'browser' }), requestContext: { userAgent: 'UA' } }),
    expectForcePage: true,
  },
];

for (const kase of CASES) {
  for (const interrupted of [false, true]) {
    test(`after a restart, ${kase.name} (${interrupted ? 'interrupted mid-download' : 'found, not started'}) is looked up again before any download, and downloads with the session`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-restart-'));
      const saved = {};
      try {
        // Run 1: look it up (the session is captured), maybe start it, then quit.
        const one = grabRun({ saved, dir, lookups: kase.lookups });
        one.c.add([{ url: kase.url }]);
        await settle();
        assert.equal(one.c.jobs[0].status, 'ready');
        if (interrupted) {
          // a download running when Grab quits: stopped and kept as paused
          one.c.jobs[0].status = 'queued';
          one.c.active = { jobId: one.c.jobs[0].id, stop() {}, stopped: false };
        }
        await one.c.shutdown();
        browser.disconnectBrowser(); // quitting Grab clears every cookie snapshot

        // Run 2: a fresh start from queue.json; the user presses download / resume.
        const two = grabRun({ saved, dir, lookups: kase.lookups });
        await two.c.init();
        const job = two.c.jobs[0];
        assert.equal(job.status, interrupted ? 'paused' : 'ready');
        if (interrupted) two.c.resume(job.id); else two.c.downloadOne(job.id);
        await settle(120);

        assert.deepEqual(two.downloads.filter((d) => !d.signedIn), [], 'no request to the site without the session');
        assert.equal(two.discovers.length, 1, 'looked up again first');
        assert.equal(two.discovers[0].forcePage, kase.expectForcePage);
        assert.equal(two.c.jobs[0].status, 'done');
        assert.equal(two.downloads.length, 1);
        assert.ok(!two.c.jobs[0].autoRetried, 'the one automatic retry is still unused');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('losing the browser connection drops the account cookies it gave (not the hidden probe\'s)', async () => {
  const fromBrowser = browser.rememberCookies(SESSION, { source: 'browser' });
  const fromProbe = browser.rememberCookies([{ domain: 'public.example', path: '/', name: 'play', value: 'ok' }], { source: 'probe' });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.send = () => {};
  socket.close = () => { socket.readyState = 3; socket.emit('close'); };
  const cdp = new browser.CdpClient(socket);
  browser.watchConnection(cdp);
  socket.close(); // the browser closed, or the user revoked the connection
  await assert.rejects(browser.withSessionCookies(fromBrowser, () => {}), { kind: 'contextExpired' });
  await browser.withSessionCookies(fromProbe, (file) => assert.match(fs.readFileSync(file, 'utf8'), /\tplay\tok/));
  browser.forgetCookies(fromProbe);
});

test('a jar already handed to a running download stays until that run ends, even if the browser disconnects', async () => {
  const ref = browser.rememberCookies(SESSION, { source: 'browser' });
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() { this.readyState = 3; this.emit('close'); } });
  browser.watchConnection(new browser.CdpClient(socket));
  let file;
  await browser.withSessionCookies(ref, async (f) => {
    file = f;
    socket.close();
    await settle(5);
    assert.equal(fs.existsSync(f), true, 'the running yt-dlp keeps its jar');
  });
  assert.equal(fs.existsSync(file), false);
});

test('queue.json keeps no signed or secret-bearing link: pasted links with tokens, thumbnails, error text', () => {
  const plain = toDurable({ id: 'a', url: 'https://www.youtube.com/watch?v=abc&t=10', status: 'ready', thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg?sqp=x&rs=SIGNED', error: null });
  assert.equal(plain.url, 'https://www.youtube.com/watch?v=abc&t=10');
  assert.equal('thumbnail' in plain, false, 'thumbnails are looked up again, not saved');
  for (const secret of [
    'https://cdn.example/v.m3u8?token=abc',
    'https://site.example/lesson?Signature=x&Expires=1',
    'https://site.example/l?X-Amz-Signature=1&X-Amz-Credential=2',
    'https://site.example/l?auth=1',
    'https://user:pw@site.example/l',
    'https://site.example/l#access_token=1',
    'https://vimeo.com/123456?h=abcdef',
  ]) {
    assert.equal(toDurable({ id: 'b', url: secret, status: 'ready' }), null, secret);
  }
  const failed = toDurable({ id: 'c', url: 'https://site.example/l', status: 'error', error: { stage: 'download', kind: 'other', message: 'HTTP Error 403 for https://cdn.example/v.mp4?token=abc' } });
  assert.equal(failed.error.message, 'HTTP Error 403 for https://cdn.example/v.mp4');
});
