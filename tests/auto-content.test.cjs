const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
const { createPdfDownloader } = require('../electron/infrastructure/pdf-downloader.cjs');
const { urlContentType } = require('../electron/domain/content-type.cjs');
const bytes = '%PDF-1.7\n%%EOF';
function fixture({ body = bytes, type = 'application/pdf', movie = { ok: false, kind: 'notfound' }, status = 200 } = {}) {
  const requests = [], engineCalls = [], released = [];
  const pdf = createPdfDownloader({ fetchImpl: async url => {
    requests.push(url);
    return new Response(new URL(url).pathname.endsWith('.pdf') ? bytes : body, { status, headers: { 'content-type': type } });
  } });
  const engine = { analyze: async url => { engineCalls.push(url); return movie; }, releaseInfo: file => released.push(file) };
  const discovery = createDiscoveryService({ pdf, engine, browserSession: { withSessionCookies: (_ref, fn) => fn(null) }, hiddenProbe: { findMedia: async () => ({ candidates: [] }) } });
  return { discovery, requests, engineCalls, released };
}
const auto = (itemId = 'one') => ({ contentType: 'auto', itemId });

test('URL hints recognize signed PDF disposition without changing it; video platforms retain their direct route', () => {
  assert.equal(urlContentType('https://files.test/opaque?response-content-disposition=inline%3Bfilename%3D%22book.pdf%22&sig=a%2Bb'), 'pdf');
  assert.equal(urlContentType('https://youtu.be/abc'), 'video');
  assert.equal(urlContentType('https://site.test/movie.mp4?sig=a'), 'video');
  assert.equal(urlContentType('https://whop.test/course'), null);
});

test('auto detects an opaque direct PDF from bytes without calling video or requiring a browser', async () => {
  const f = fixture();
  const r = await f.discovery.analyze('https://files.test/opaque?sig=a%2Bb', auto());
  assert.equal(r.ok, true); assert.equal(r.contentType, 'pdf');
  assert.equal(r.mediaUrl, f.requests[0]);
  assert.equal(f.engineCalls.length, 0);
});

test('ordinary public video links make no PDF/browser requests in auto mode', async () => {
  for (const url of ['https://youtu.be/abc', 'https://site.test/clip.mp4']) {
    const f = fixture({ movie: { ok: true, title: 'Clip' } });
    const r = await f.discovery.analyze(url, auto());
    assert.equal(r.ok, true); assert.equal(r.contentType, 'video');
    assert.deepEqual(f.engineCalls, [url]); assert.equal(f.requests.length, 0);
  }
});

test('PDF-only HTML is detected automatically, including choosing between two documents', async () => {
  const f = fixture({ body: '<a href="/one.pdf">First</a><a href="/two.pdf">Second</a>', type: 'text/html' });
  const page = 'https://site.test/lesson';
  const r = await f.discovery.analyze(page, auto());
  assert.equal(r.kind, 'pdfChoice');
  const selected = await f.discovery.analyze(page, { ...auto(), choice: { token: r.token, index: 1 } });
  assert.equal(selected.ok, true); assert.equal(selected.contentType, 'pdf');
  assert.equal(selected.mediaUrl, 'https://site.test/two.pdf');
});

test('mixed public page offers video and PDF, rejects cross-item choice, releases metadata and downloads the selected type', async () => {
  for (const index of [0, 1]) {
    const f = fixture({ body: '<video src="clip.mp4"></video><a href="/guide.pdf">Guide</a>', type: 'text/html', movie: { ok: true, title: 'Clip', infoFile: 'private-metadata' } });
    const page = 'https://site.test/lesson';
    const r = await f.discovery.analyze(page, auto());
    assert.equal(r.kind, 'fileChoice');
    assert.equal(r.choices.length, 2);
    assert.deepEqual(f.released, ['private-metadata']);
    assert.ok(!JSON.stringify(r).includes('https://'));
    const rejected = await f.discovery.analyze(page, { ...auto('other'), choice: { token: r.token, index } });
    assert.equal(rejected.kind, 'fileChoiceExpired');
    const selected = await f.discovery.analyze(page, { ...auto(), choice: { token: r.token, index } });
    assert.equal(selected.ok, true); assert.equal(selected.contentType, index === 0 ? 'video' : 'pdf');
  }
});

test('auto stops on HTTP 429 rather than making a second extractor request', async () => {
  const f = fixture({ status: 429, body: 'slow down' });
  assert.equal((await f.discovery.analyze('https://site.test/lesson', auto())).kind, 'rateLimited');
  assert.equal(f.engineCalls.length, 0);
});

test('session-required automatic lookup never makes a public PDF request', async () => {
  const f = fixture();
  const d = createDiscoveryService({ pdf: { analyze: () => { throw new Error('anonymous PDF request'); } },
    engine: {}, browserSession: {}, getBrowserService: () => ({ analyze: async (_url, opts) => ({ ok: false, kind: opts.contentType === 'auto' ? 'sessionRequired' : 'wrong-mode' }) }) });
  assert.equal((await d.analyze('https://whop.test/course', { ...auto(), requireSession: true })).kind, 'sessionRequired');
  assert.equal(f.requests.length, 0);
});
