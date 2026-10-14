// DownloadCoordinator with a fake clock, fake lookups and fake downloads (GRB-01, GRB-02, GRB-14).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
const { restore } = require('../electron/domain/job.cjs');
const { siteKey, sameLinkKey } = require('../electron/domain/site-policy.cjs');

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

class FakeClock {
  constructor() { this.t = 1_000_000; this.timers = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.t + Math.max(0, ms), fn }); return id; }
  clearTimeout(id) { this.timers = this.timers.filter((x) => x.id !== id); }
  pending() { return this.timers.length; }
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await settle();
  }
}

const YT = (n) => `https://www.youtube.com/watch?v=video${n}`;

// A coordinator wired to fakes. lookups: url -> result; downloads finish when the test says so.
function setup({ lookups = {}, settings = { folder: '/dl', format: 'mp4', quality: 'best' }, store, random = () => 0 } = {}) {
  const clock = new FakeClock();
  const starts = [];
  const discovers = [];
  const history = [];
  const released = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const snapshots = [];
  const c = new DownloadCoordinator({
    clock, random, store, newId: (() => { let n = 0; return () => `j${++n}`; })(),
    getSettings: async () => settings,
    recordCompletion: async (e) => { history.push(e); },
    releaseContext: (job, o) => released.push({ id: job.id, cookieRef: job.cookieRef, ...o }),
    onChange: (s) => snapshots.push(s),
    discover: async (url, options) => {
      discovers.push({ url, ...options, signal: undefined, onPhase: undefined });
      const r = typeof lookups[url] === 'function' ? lookups[url](options) : lookups[url];
      return r || { ok: true, title: 'T ' + url.slice(-1), site: 'Youtube', duration: 60, height: 720, infoFile: '/tmp/i.json', infoAt: clock.now() };
    },
    startDownload: (plan, onProgress) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      const attempt = { plan, onProgress, stopped: false, finish: (r = { ok: true, file: `/dl/${plan.name}.mp4` }) => { concurrent--; resolve(r); } };
      attempt.stop = () => { attempt.stopped = true; };
      starts.push(attempt);
      return { outputBase: `/dl/${plan.name}`, done, stop: () => attempt.stop() };
    },
  });
  const status = () => c.jobs.map((j) => j.status);
  return { c, clock, starts, discovers, history, released, snapshots, status, max: () => maxConcurrent };
}

async function readyJobs(t, urls) {
  t.c.add(urls.map((url) => ({ url, label: '' })));
  await t.clock.advance(10_000); // lookups: immediate, then 2 s gaps (random = 0)
  assert.ok(t.c.jobs.every((j) => j.status === 'ready'), t.status().join());
}

test('GRB-01: after the YouTube rest the next queued download starts by itself, exactly once', async () => {
  const t = setup();
  await readyJobs(t, [YT(1), YT(2)]);
  t.c.downloadAll();
  await settle();
  assert.equal(t.starts.length, 1);
  t.starts[0].finish();
  await settle();
  assert.deepEqual(t.status(), ['done', 'queued']);
  assert.equal(t.c.snapshot().resting, true);
  await t.clock.advance(4_999);
  assert.equal(t.starts.length, 1, 'still resting');
  await t.clock.advance(1);
  assert.equal(t.starts.length, 2, 'the rest ending starts the next one');
  assert.equal(t.c.snapshot().resting, false);
  t.starts[1].finish();
  await t.clock.advance(20_000);
  assert.equal(t.starts.length, 2, 'nothing started twice');
  assert.deepEqual(t.status(), ['done', 'done']);
  assert.equal(t.c.running, false);
  assert.equal(t.max(), 1);
});

test('the rest is random between 5 and 10 seconds and only applies to YouTube', async () => {
  const t = setup({ random: () => 0.5, lookups: { 'https://vimeo.com/2': { ok: true, title: 'V', site: 'Vimeo' } } });
  await readyJobs(t, [YT(1), 'https://vimeo.com/2', YT(3)]);
  t.c.downloadAll();
  await settle();
  t.starts[0].finish();
  await settle();
  assert.equal(t.starts.length, 2, 'Vimeo starts right away');
  t.starts[1].finish();
  await t.clock.advance(7_499);
  assert.equal(t.starts.length, 2);
  await t.clock.advance(1);
  assert.equal(t.starts.length, 3, '5 s + 0.5 × 5 s after the last download');
});

test('pause stops the attempt; the next download waits for it to end; resume continues it', async () => {
  const t = setup();
  await readyJobs(t, [YT(1), YT(2)]);
  t.c.downloadAll();
  await settle();
  t.starts[0].onProgress({ percent: 40, speed: '1MiB/s', eta: 'NA' });
  await settle();
  assert.equal(t.c.snapshot().jobs[0].progress, 40);
  assert.equal(t.c.snapshot().jobs[0].eta || '', '', 'NA is not shown');
  t.c.pause('j1');
  assert.equal(t.starts[0].stopped, true);
  assert.deepEqual(t.status(), ['paused', 'queued']);
  await t.clock.advance(60_000);
  assert.equal(t.starts.length, 1, 'no overlap while the old process is still exiting');
  t.starts[0].finish({ ok: false, stopped: true });
  await t.clock.advance(5_000);
  assert.equal(t.starts.length, 2);
  assert.equal(t.starts[1].plan.id, 'j2');
  t.c.resume('j1');
  t.starts[1].finish();
  await t.clock.advance(5_000);
  assert.equal(t.starts.length, 3);
  assert.equal(t.starts[2].plan.id, 'j1');
  assert.equal(t.starts[2].plan.outputBase, '/dl/T 1', 'resume keeps the file name');
  assert.equal(t.max(), 1);
});

test('a blocked site waits for "resume site"; other sites carry on; download-all does not lift it', async () => {
  const t = setup({ lookups: { 'https://vimeo.com/2': { ok: true, title: 'V', site: 'Vimeo' } } });
  await readyJobs(t, [YT(1), 'https://vimeo.com/2', YT(3)]);
  t.c.downloadAll();
  await settle();
  t.starts[0].finish({ ok: false, kind: 'blocked', error: 'HTTP Error 429' });
  await settle();
  assert.deepEqual(t.c.snapshot().blockedSites, [{ key: 'youtube', othersActive: true }]);
  assert.equal(t.starts.length, 2);
  assert.equal(t.starts[1].plan.url, 'https://vimeo.com/2');
  t.starts[1].finish();
  await t.clock.advance(30_000);
  assert.equal(t.starts.length, 2, 'YouTube stays paused');
  assert.deepEqual(t.status(), ['queued', 'done', 'queued']);
  t.c.downloadAll();
  await t.clock.advance(30_000);
  assert.equal(t.starts.length, 2, 'a batch action does not lift the block (GRB-14)');
  t.c.resumeSite('youtube');
  await t.clock.advance(10_000);
  assert.equal(t.starts.length, 3);
  assert.equal(t.starts[2].plan.url, YT(1), 'resumes the blocked job first, in queue order');
});

test('a block found during lookup pauses that site\'s lookups only', async () => {
  let blocked = true;
  const t = setup({ lookups: { [YT(1)]: () => (blocked ? { ok: false, kind: 'blocked' } : undefined), 'https://vimeo.com/2': { ok: true, site: 'Vimeo', title: 'V' } } });
  t.c.add([{ url: YT(1) }, { url: YT(3) }, { url: 'https://vimeo.com/2' }]);
  await t.clock.advance(30_000);
  assert.deepEqual(t.status(), ['waiting', 'waiting', 'ready']);
  assert.deepEqual(t.discovers.map((d) => d.url), [YT(1), 'https://vimeo.com/2']);
  blocked = false;
  t.c.resumeSite('youtube');
  await t.clock.advance(30_000);
  assert.deepEqual(t.status(), ['ready', 'ready', 'ready']);
});

test('lookups run one at a time with a 2–4 s gap', async () => {
  const t = setup({ random: () => 1 });
  t.c.add([{ url: YT(1) }, { url: YT(2) }, { url: YT(3) }]);
  await settle();
  assert.equal(t.discovers.length, 1);
  await t.clock.advance(3_999);
  assert.equal(t.discovers.length, 1);
  await t.clock.advance(1);
  assert.equal(t.discovers.length, 2);
  await t.clock.advance(4_000);
  assert.equal(t.discovers.length, 3);
});

test('a failed generic-page download looks inside the page once; a second failure is an error', async () => {
  const page = 'https://courses.example/lesson';
  const t = setup({ lookups: { [page]: (o) => (o.forcePage
    ? { ok: true, title: 'Lesson', site: 'Generic', mediaUrl: 'https://stream.example/m.m3u8?token=new', cookieRef: 'c2', requestContext: { userAgent: 'UA' } }
    : { ok: true, title: 'Lesson', site: 'Generic', mediaUrl: 'https://stream.example/m.m3u8?token=old', cookieRef: 'c1' }) } });
  await readyJobs(t, [page]);
  t.c.downloadOne('j1');
  await settle();
  assert.equal(t.starts[0].plan.mediaUrl, 'https://stream.example/m.m3u8?token=old');
  assert.equal(t.starts[0].plan.cookieRef, 'c1');
  t.starts[0].finish({ ok: false, kind: 'other', error: 'HTTP Error 403' });
  await t.clock.advance(20_000);
  assert.equal(t.discovers.at(-1).forcePage, true);
  assert.ok(t.released.some((r) => r.cookieRef === 'c1'), 'the expired session context is released');
  assert.equal(t.starts.length, 2, 'queued again by itself after the new lookup');
  assert.equal(t.starts[1].plan.mediaUrl, 'https://stream.example/m.m3u8?token=new');
  t.starts[1].finish({ ok: false, kind: 'other', error: 'HTTP Error 403' });
  await t.clock.advance(20_000);
  assert.deepEqual(t.status(), ['error']);
  assert.deepEqual(t.c.snapshot().jobs[0].error, { message: 'HTTP Error 403', kind: 'other', stage: 'download', browser: null });
  t.c.retry('j1');
  await t.clock.advance(20_000);
  assert.equal(t.discovers.at(-1).forcePage, true, 'retry of a page video looks inside the page again');
});

test('a failed site download is fetched again once with fresh information', async () => {
  const t = setup();
  await readyJobs(t, [YT(1)]);
  t.c.downloadOne('j1');
  await settle();
  assert.equal(t.starts[0].plan.infoFile, '/tmp/i.json');
  t.starts[0].finish({ ok: false, kind: 'other', error: 'expired' });
  await t.clock.advance(10_000);
  assert.equal(t.starts.length, 2);
  assert.equal(t.starts[1].plan.infoFile, null);
  t.starts[1].finish({ ok: false, kind: 'unavailable', error: 'gone' });
  await t.clock.advance(10_000);
  assert.deepEqual(t.status(), ['error']);
});

test('lookup failures carry the browser hint; DRM stays reported as protected', async () => {
  const t = setup({ lookups: {
    'https://a.example/1': { ok: false, kind: 'notfoundPage', error: 'x', browser: { name: 'Brave', scheme: 'brave', supported: true } },
    'https://a.example/2': { ok: false, kind: 'protected', error: 'DRM' },
    'https://a.example/3': { ok: false, kind: 'browserContext', error: 'x', browser: { name: 'Edge' } },
  } });
  t.c.add([{ url: 'https://a.example/1' }, { url: 'https://a.example/2' }, { url: 'https://a.example/3' }]);
  await t.clock.advance(20_000);
  const [a, b, c] = t.c.snapshot().jobs;
  assert.equal(a.signInHint, true);
  assert.equal(a.error.kind, 'notfoundPage');
  assert.equal(b.error.kind, 'protected');
  assert.equal(!!b.signInHint, false);
  assert.equal(!!c.signInHint, false);
  assert.deepEqual(c.error.browser, { name: 'Edge' });
  const before = t.discovers.length;
  t.c.retry(a.id);
  await t.clock.advance(5_000);
  assert.equal(t.discovers.length, before + 1, 'retry looks it up again');
  assert.equal(t.discovers.at(-1).url, 'https://a.example/1');
});

test('intake: duplicates in one paste and in the queue become one job; signed queries are kept', () => {
  const t = setup();
  const signed = 'https://stream.example/v.m3u8?token=a.b.c&Expires=1';
  const r = t.c.add([{ url: YT(1), label: 'one' }, { url: YT(1) }, { url: YT(1) + '#t=10' }, { url: signed }, { url: 'https://WWW.YOUTUBE.COM/watch?v=video1' }]);
  assert.deepEqual(r, { added: 2, skipped: 3 });
  assert.equal(t.c.jobs[1].url, signed);
  assert.deepEqual(t.c.add([{ url: signed }]), { added: 0, skipped: 1 });
  assert.equal(t.c.jobs[0].name, 'one');
});

test('site keys: unrelated multi-level domains never share a block; known services group their hosts', () => {
  assert.notEqual(siteKey('https://a.co.uk/x'), siteKey('https://b.co.uk/y'));
  assert.equal(siteKey('https://youtu.be/x'), 'youtube');
  assert.equal(siteKey('https://m.youtube.com/watch'), 'youtube');
  assert.equal(siteKey('https://vm.tiktok.com/x'), 'tiktok');
  assert.equal(siteKey('https://player.vimeo.com/video/1'), 'vimeo');
  assert.equal(siteKey('https://twitter.com/a'), siteKey('https://x.com/a'));
  assert.equal(siteKey('https://www.dailymotion.com/v'), 'dailymotion.com');
  assert.equal(sameLinkKey('https://A.example/x?b=1#frag'), 'https://a.example/x?b=1');
});

test('history is recorded by the coordinator, once, when the file is saved', async () => {
  const t = setup({ settings: { folder: '/dl', format: 'mp3', quality: 'best' } });
  await readyJobs(t, [YT(1)]);
  t.c.rename('j1', 'My name');
  t.c.downloadOne('j1');
  t.c.downloadOne('j1');
  t.c.downloadAll();
  await settle();
  assert.equal(t.starts.length, 1, 'repeated commands start one attempt');
  assert.equal(t.starts[0].plan.name, 'My name');
  t.starts[0].finish({ ok: true, file: '/dl/My name.mp3' });
  await t.clock.advance(20_000);
  assert.deepEqual(t.history, [{ name: 'My name', url: YT(1), file: '/dl/My name.mp3', site: 'Youtube', format: 'mp3' }]);
  assert.equal(t.c.fileOf('j1'), '/dl/My name.mp3');
});

test('snapshots never carry session material, signed media addresses or lookup files', async () => {
  const page = 'https://courses.example/lesson';
  const t = setup({ lookups: { [page]: { ok: true, title: 'L', site: 'Generic', mediaUrl: 'https://s.example/m.m3u8?token=secret', cookieRef: 'cookie-handle', requestContext: { userAgent: 'UA', origin: 'https://o' }, infoFile: '/tmp/info.json' } } });
  await readyJobs(t, [page]);
  const json = JSON.stringify(t.snapshots.at(-1));
  for (const secret of ['token=secret', 'cookie-handle', 'info.json', 'userAgent', 'requestContext', 'mediaUrl']) assert.equal(json.includes(secret), false, secret);
});

test('the queue survives a restart without secrets; interrupted downloads come back paused', async () => {
  let saved = null;
  const store = { load: async () => saved || [], save: async (list) => { saved = JSON.parse(JSON.stringify(list)); } };
  const page = 'https://courses.example/lesson';
  const t = setup({ store, lookups: { [page]: { ok: true, title: 'L', site: 'Generic', mediaUrl: 'https://s.example/m?token=secret', cookieRef: 'c' } } });
  await readyJobs(t, [YT(1), page, YT(3)]);
  t.c.downloadAll();
  await settle();
  t.starts[0].finish();
  await t.clock.advance(1_000);
  assert.equal(JSON.stringify(saved).includes('secret'), false);
  assert.equal(JSON.stringify(saved).includes('"cookieRef"'), false);
  await t.c.shutdown();
  assert.equal(t.starts[1].stopped, true);
  assert.deepEqual(saved.map((j) => j.status), ['paused', 'queued'], 'done is left to history');

  const t2 = setup({ store });
  await t2.c.init();
  assert.deepEqual(t2.status(), ['paused', 'paused']);
  assert.equal(t2.c.jobs[0].fromPage, true);
  assert.equal(t2.c.jobs[0].outputBase, '/dl/L');
  await t2.clock.advance(60_000);
  assert.equal(t2.starts.length, 0, 'nothing starts by itself after a restart');
  assert.equal(restore({ id: 'x', url: YT(1), status: 'analyzing' }).status, 'waiting');
  assert.equal(restore({ id: 'x', url: YT(1), status: 'done' }), null);
  assert.equal(restore({ id: 'x', url: YT(1), status: 'bogus' }), null);
});

test('a lookup or download refused during an engine update is retried shortly', async () => {
  let updating = true;
  const t = setup({ lookups: { [YT(1)]: () => (updating ? { ok: false, kind: 'engineUpdating' } : undefined) } });
  t.c.add([{ url: YT(1) }]);
  await settle();
  assert.deepEqual(t.status(), ['waiting']);
  updating = false;
  await t.clock.advance(3_000);
  assert.deepEqual(t.status(), ['ready']);
  t.c.downloadOne('j1');
  await settle();
  t.starts[0].finish({ ok: false, kind: 'engineUpdating' });
  await t.clock.advance(6_000);
  assert.equal(t.starts.length, 2);
});

test('busy while a lookup or download runs; removing a running download stops it', async () => {
  const t = setup();
  assert.equal(t.c.busy(), false);
  await readyJobs(t, [YT(1), YT(2)]);
  assert.equal(t.c.busy(), false);
  t.c.downloadOne('j1');
  await settle();
  assert.equal(t.c.busy(), true);
  t.c.remove('j1');
  assert.equal(t.starts[0].stopped, true);
  assert.deepEqual(t.c.jobs.map((j) => j.id), ['j2']);
  t.starts[0].finish({ ok: false, stopped: true });
  await t.clock.advance(20_000);
  assert.equal(t.c.busy(), false);
  assert.deepEqual(t.history, []);
});

test('reorder moves a job to the target job\'s place', async () => {
  const t = setup();
  t.c.add([{ url: YT(1) }, { url: YT(2) }, { url: YT(3) }]);
  t.c.move('j3', 'j1');
  assert.deepEqual(t.c.jobs.map((j) => j.id), ['j3', 'j1', 'j2']);
  t.c.move('j3', 'j2');
  assert.deepEqual(t.c.jobs.map((j) => j.id), ['j1', 'j2', 'j3']);
});
