// Real BrowserService + discovery routing + CookieVault. The in-process extension returns no
// visible player source, like YouTube's blob/segmented player; no real site is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BrowserService } = require('../../electron/browser/service.cjs');
const session = require('../../electron/browser-session.cjs');
const setup = require('../../electron/browser/setup.cjs');
const { createDiscoveryService } = require('../../electron/application/discovery-service.cjs');

function fixture(t) {
  const calls = [];
  const instance = { key: 'chrome:personal', browser: 'chrome', instanceId: 'personal', extVersion: setup.readExtensionIdentity(path.join(__dirname, '../../extension')).version };
  const hub = new EventEmitter();
  hub.live = [instance];
  hub.instances = () => hub.live;
  hub.failures = [];
  hub.sendTo = (key, type, m) => {
    calls.push({ type, key });
    if (type === 'discover') queueMicrotask(() => hub.emit('message', instance, { type: 'job-failed', jobId: m.jobId, reason: 'timeout' }));
    return true;
  };
  hub.request = async (key, type, m) => {
    calls.push({ type, key, url: m.url });
    return { type: 'cookies', jobId: m.jobId, available: true, userAgent: 'Browser UA/1', cookies: [
      { domain: '.youtube.com', name: 'SID', value: 'PAGE-SESSION', path: '/', secure: true, httpOnly: true, session: true },
      { domain: '.other.test', name: 'other', value: 'DO-NOT-LEAK', path: '/', session: true },
    ] };
  };
  const engine = { analyze: async (url, opts) => {
    const cookies = opts.cookieFile ? fs.readFileSync(opts.cookieFile, 'utf8') : '';
    calls.push({ type: 'extractor', url, cookies, context: opts.requestContext, cookieFile: opts.cookieFile });
    return { ok: true, title: 'YouTube lesson', site: 'Youtube' };
  } };
  const svc = new BrowserService({ getSettings: () => ({ browser: { defaultBrowser: 'chrome' } }), engine, session });
  svc.identity = { version: instance.extVersion };
  svc.hub = hub;
  svc.detected = { browsers: [{ id: 'chrome', exe: '/test/chrome' }], systemDefault: 'chrome' };
  svc.health = { installed: true, results: [{ browser: 'chrome', detected: true, registered: true, problems: [], state: 'connected' }] };
  const discovery = createDiscoveryService({ engine, browserSession: session, getBrowserService: () => svc });
  t.after(() => svc.dropInstanceSession(instance.key));
  return { svc, hub, calls, discovery, instance, engine };
}

test('YouTube extension lookup uses its page extractor after scoped session acquisition, without scanning the player', async (t) => {
  const f = fixture(t);
  const url = 'https://www.youtube.com/watch?v=fixture123';
  const out = await f.discovery.analyze(url, { browser: 'chrome', instance: f.instance.key, requireSession: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(f.calls.map((x) => x.type), ['page-session-request', 'extractor']);
  const extraction = f.calls[1];
  assert.equal(extraction.url, url);
  assert.match(extraction.cookies, /SID\tPAGE-SESSION/);
  assert.ok(!extraction.cookies.includes('DO-NOT-LEAK'));
  assert.equal(extraction.context.userAgent, 'Browser UA/1');
  assert.equal(out.needsSession, true);
  assert.equal(out.instanceKey, f.instance.key);
  assert.equal(fs.existsSync(extraction.cookieFile), false);
});

test('cached health does not keep a disconnected browser connected', (t) => {
  const f = fixture(t);
  assert.equal(f.svc.state().browsers.find((x) => x.id === 'chrome').state, 'connected');
  f.hub.live = [];
  assert.notEqual(f.svc.state().browsers.find((x) => x.id === 'chrome').state, 'connected');
});

test('explicit default-browser YouTube selection acquires its session before the first network request', async (t) => {
  const f = fixture(t);
  const out = await f.discovery.analyze('https://www.youtube.com/watch?v=fixture123', { requireSession: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(f.calls.map((x) => x.type), ['page-session-request', 'extractor']);
  assert.match(f.calls[1].cookies, /SID\tPAGE-SESSION/);
});

test('a refused page snapshot prevents every extractor request', async (t) => {
  const f = fixture(t);
  f.hub.request = async (_key, _type, m) => ({ type: 'cookies', jobId: m.jobId, available: false, cookies: [] });
  const out = await f.discovery.analyze('https://www.youtube.com/watch?v=fixture123', { browser: 'chrome' });
  assert.equal(out.kind, 'sessionExpired');
  assert.equal(f.calls.some((x) => x.type === 'extractor' || x.type === 'discover'), false);
});

test('short YouTube links acquire the YouTube session while preserving the original extractor URL', async (t) => {
  const f = fixture(t);
  const url = 'https://youtu.be/fixture123';
  const out = await f.discovery.analyze(url, { browser: 'chrome' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(f.calls[0].url, 'https://www.youtube.com/');
  assert.equal(f.calls[1].url, url);
  assert.match(f.calls[1].cookies, /SID\tPAGE-SESSION/);
});

for (const url of ['https://www.youtube.com/watch?v=fixture123', 'https://youtu.be/fixture123', 'https://vimeo.com/123', 'https://public.example/clip.mp4']) {
  test(`ordinary paste is direct even with an installed extension and saved browser: ${new URL(url).hostname}`, async (t) => {
    const f = fixture(t);
    f.hub.live = [];
    const out = await f.discovery.analyze(url);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(f.calls.map((x) => x.type), ['extractor']);
    assert.equal(f.calls[0].cookieFile, undefined);
    assert.equal(out.needsSession, undefined);
  });
}

test('using the browser once does not force the next ordinary paste on the same site through it', async (t) => {
  const f = fixture(t);
  const url = 'https://www.youtube.com/watch?v=fixture123';
  assert.equal((await f.discovery.analyze(url, { browser: 'chrome' })).ok, true);
  f.calls.length = 0;
  f.hub.live = [];
  assert.equal((await f.discovery.analyze(url)).ok, true);
  assert.deepEqual(f.calls.map((x) => x.type), ['extractor']);
});

for (const kind of ['private', 'forbidden', 'blocked', 'notfound', 'rateLimited']) {
  test(`ordinary lookup failure stays in ordinary mode (${kind}), without an extension fallback`, async (t) => {
    const f = fixture(t);
    let requests = 0;
    f.engine.analyze = async () => { requests++; return { ok: false, kind }; };
    // Public-page scanning is allowed; it must not touch the user's signed-in browser.
    const discovery = createDiscoveryService({ engine: f.engine, browserSession: session, getBrowserService: () => f.svc,
      hiddenProbe: { findMedia: async () => ({ candidates: [] }) } });
    const out = await discovery.analyze('https://public.example/watch');
    assert.equal(out.kind, kind === 'notfound' ? 'notfoundPage' : kind);
    assert.equal(requests, 1);
    assert.deepEqual(f.calls, []);
  });
}

test('an extension job that times out reports its stage in the lookup result and in diagnostics, as an enum only', async (t) => {
  const { Diagnostics } = require('../../electron/infrastructure/diagnostics.cjs');
  for (const [stage, recorded] of [['waiting_load', 'waiting_load'], ['locating', 'locating'], [undefined, undefined]]) {
    const f = fixture(t);
    f.hub.sendTo = (key, type, m) => {
      if (type === 'discover') queueMicrotask(() => f.hub.emit('message', f.instance, { type: 'job-failed', jobId: m.jobId, reason: 'timeout', ...(stage ? { stage } : {}) }));
      return true;
    };
    const diagnostics = new Diagnostics();
    const discovery = createDiscoveryService({ engine: f.engine, browserSession: session, getBrowserService: () => f.svc, record: (e, d) => diagnostics.record(e, d) });
    const out = await discovery.analyze('https://members.example/lesson/7', { browser: 'chrome', instance: f.instance.key, requireSession: true });
    assert.equal(out.kind, 'discoveryTimeout', JSON.stringify(out));
    assert.equal(out.jobStage, recorded);
    const [entry] = diagnostics.recent().filter((d) => d.event === 'lookup');
    assert.equal(entry.jobStage, recorded);
    assert.equal(entry.strategy, 'browser');
  }
});

test('PDF extension discovery uses the sending profile, scoped cookies and PDF adapter; no video calls', async t => {
  const f = fixture(t);
  const requests = [];
  const { createPdfDownloader } = require('../../electron/infrastructure/pdf-downloader.cjs');
  f.svc.pdf = createPdfDownloader({ fetchImpl: async (url, opts) => {
    requests.push({ url, headers: opts.headers });
    return new Response('%PDF-1.7\n%%EOF', { headers: { 'content-type': 'application/pdf' } });
  } });
  const page = 'https://www.youtube.com/lesson';
  const candidate = { url: 'https://docs.test/lesson.pdf?sig=a%2Bb', kind: 'pdf', context: { userAgent: 'Sending UA', referer: page } };
  f.hub.sendTo = (key, type, m) => {
    f.calls.push({ key, type, m });
    if (type === 'discover') queueMicrotask(() => f.hub.emit('message', f.instance, { type: 'candidates', final: true, jobId: m.jobId, candidates: [candidate] }));
    return true;
  };
  f.hub.request = async (key, type, m) => {
    f.calls.push({ key, type, m });
    return { type: 'cookies', jobId: m.jobId, available: true, cookies: [
      { domain: 'docs.test', name: 'SID', value: 'PDF-SESSION', path: '/', secure: true, session: true },
      { domain: 'other.test', name: 'OTHER', value: 'NO', path: '/', session: true },
    ] };
  };
  const r = await f.discovery.analyze(page, { contentType: 'pdf', browser: 'chrome', instance: f.instance.key, itemId: 'pdf-one', requireSession: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.instanceKey, f.instance.key);
  assert.equal(r.mediaUrl, candidate.url);
  assert.equal(r.site, 'PDF');
  assert.deepEqual(f.calls.map(c => c.type), ['discover', 'cookies-request']);
  assert.equal(f.calls[0].m.contentType, 'pdf');
  assert.equal(requests[0].headers.Cookie, 'SID=PDF-SESSION');
  assert.equal(requests[0].headers['User-Agent'], 'Sending UA');
  assert.equal(session.hasCookies(r.cookieRef), true);
  f.svc.dropInstanceSession(f.instance.key);
  assert.equal(session.hasCookies(r.cookieRef), false);
});

test('PDF browser choices do not request any document before selection and cannot cross queue items', async t => {
  const f = fixture(t);
  let pdfCalls = 0;
  f.svc.pdf = { analyze: async url => { pdfCalls++; return { ok: true, title: 'PDF', site: 'PDF', mediaUrl: url }; } };
  const page = 'https://site.test/lesson';
  f.hub.sendTo = (_key, type, m) => {
    if (type === 'discover') queueMicrotask(() => f.hub.emit('message', f.instance, { type: 'candidates', final: true, jobId: m.jobId, candidates: [
      { url: 'https://docs.test/a.pdf', kind: 'pdf' }, { url: 'https://docs.test/b.pdf', kind: 'pdf' },
    ] }));
    return true;
  };
  const r = await f.discovery.analyze(page, { contentType: 'pdf', browser: 'chrome', itemId: 'one' });
  assert.equal(r.kind, 'pdfChoice'); assert.equal(pdfCalls, 0);
  assert.deepEqual(r.choices.map(c => c.label), ['a.pdf', 'b.pdf']);
  const bad = await f.discovery.analyze(page, { contentType: 'pdf', browser: 'chrome', itemId: 'other', choice: { token: r.token, index: 0 } });
  assert.equal(bad.ok, false); assert.equal(pdfCalls, 0);
  const selected = await f.discovery.analyze(page, { contentType: 'pdf', browser: 'chrome', itemId: 'one', choice: { token: r.token, index: 1 } });
  assert.equal(selected.ok, true, JSON.stringify(selected)); assert.equal(pdfCalls, 1);
  assert.equal(selected.mediaUrl, 'https://docs.test/b.pdf');
});

test('automatic browser discovery offers both types and keeps scoped PDF cookies on selection', async t => {
  const f = fixture(t);
  const page = 'https://whop.test/course';
  const requests = [];
  f.svc.pdf = require('../../electron/infrastructure/pdf-downloader.cjs').createPdfDownloader({ fetchImpl: async (url, opts) => {
    requests.push({ url, headers: opts.headers });
    return new Response('%PDF-1.7\n%%EOF', { headers: { 'content-type': 'application/pdf' } });
  } });
  const candidates = [
    { url: 'https://video.test/lesson.mp4', kind: 'file', fromPlayer: true },
    { url: 'https://docs.test/opaque?sig=a%2Bb', kind: 'pdf', context: { userAgent: 'Sending UA', referer: page } },
  ];
  f.hub.sendTo = (key, type, m) => {
    f.calls.push({ key, type, m });
    if (type === 'discover') queueMicrotask(() => f.hub.emit('message', f.instance, { type: 'candidates', final: true, jobId: m.jobId, candidates }));
    return true;
  };
  f.hub.request = async (_key, _type, m) => ({ type: 'cookies', jobId: m.jobId, available: true,
    cookies: [{ domain: 'docs.test', name: 'SID', value: 'PDF-SESSION', path: '/', secure: true, session: true }] });
  const opts = { contentType: 'auto', browser: 'chrome', instance: f.instance.key, itemId: 'mixed-one', requireSession: true };
  const r = await f.discovery.analyze(page, opts);
  assert.equal(r.kind, 'fileChoice'); assert.equal(requests.length, 0);
  assert.equal(f.calls[0].m.contentType, 'auto');
  assert.deepEqual(r.choices.map(c => c.label.split(' · ')[0]), ['וידאו', 'PDF']);
  const selected = await f.discovery.analyze(page, { ...opts, choice: { token: r.token, index: 1 } });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(selected.contentType, 'pdf'); assert.equal(selected.instanceKey, f.instance.key);
  assert.equal(requests[0].url, candidates[1].url);
  assert.equal(requests[0].headers.Cookie, 'SID=PDF-SESSION');
  assert.equal(f.calls.some(c => c.type === 'extractor'), false);
});
