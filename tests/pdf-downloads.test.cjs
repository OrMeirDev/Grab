const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPdfDownloader } = require('../electron/infrastructure/pdf-downloader.cjs');
const { pdfLinks } = require('../electron/domain/pdf.cjs');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');
const { toDurable } = require('../electron/domain/job.cjs');
const { listLibrary } = require('../electron/infrastructure/library-indexer.cjs');
const { normalizeHistoryEntry } = require('../electron/domain/records.cjs');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const noVideo = { analyze: () => { throw new Error('PDF must not invoke video extractor'); }, download: () => { throw new Error('PDF must not invoke video engine'); } };
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'state did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture(t, routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-pdf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const pdf = createPdfDownloader({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); options.signal.throwIfAborted();
    const route = routes[new URL(url).pathname];
    assert.ok(route, 'unexpected network request: ' + url);
    return typeof route === 'function' ? route(url, options) : new Response(route.body, { status: route.status || 200, headers: route.headers });
  } });
  return { pdf, calls, dir };
}

test('PDF links: relative, base, embedded, MIME/download hints, entity decode and exact signed queries; no scripts or unsafe URLs', () => {
  const links = pdfLinks(`<base href="/docs/"><a href="a.PDF?x=1&amp;sig=a%2Bb#page=2">Guide</a><iframe src="a.PDF?x=1&amp;sig=a%2Bb"></iframe><object data="/file?id=2" type="application/pdf"></object><a href='/download' download='lesson.pdf'>Lesson</a><script>"<a href='fake.pdf'>"</script><a href="javascript:alert(1)" type="application/pdf">bad</a>`, 'https://site.test/lesson');
  assert.deepEqual(links.map(c => c.url), ['https://site.test/docs/a.PDF?x=1&sig=a%2Bb', 'https://site.test/file?id=2', 'https://site.test/download']);
});

test('real coordinator → discovery → runner saves the exact original PDF, records PDF and indexes it; no video calls', async t => {
  const f = fixture(t, { '/lesson': { body: '<iframe src="/download?id=7" type="application/pdf"></iframe>' }, '/download': { body: PDF, headers: { 'content-type': 'application/pdf', 'content-length': String(PDF.length), 'content-disposition': "attachment; filename*=UTF-8''lesson%20one.pdf" } } });
  const browserSession = { isMakoPage: () => false, withSessionCookies: (_, work) => work() };
  const discovery = createDiscoveryService({ pdf: f.pdf, engine: noVideo, browserSession });
  const runner = createDownloadRunner({ pdf: f.pdf, engine: noVideo, browserSession, allocator: new OutputAllocator() });
  const history = [];
  const c = new DownloadCoordinator({ discover: discovery.analyze, startDownload: runner.start, getSettings: async () => ({ folder: f.dir, format: 'mp3', quality: 'best' }), recordCompletion: async e => history.push(e) });
  t.after(() => c.shutdown());
  c.add([{ url: 'https://site.test/lesson' }], { contentType: 'pdf', autoQueue: true });
  await until(() => c.jobs[0].status === 'done');
  const saved = fs.readFileSync(c.jobs[0].file);
  assert.equal(createHash('sha256').update(saved).digest('hex'), createHash('sha256').update(PDF).digest('hex'));
  assert.equal(path.basename(c.jobs[0].file), 'lesson one.pdf');
  assert.equal(history[0].format, 'pdf');
  assert.equal(normalizeHistoryEntry(history[0], () => 'id').format, 'pdf');
  assert.equal((await listLibrary(f.dir))[0].file, c.jobs[0].file);
  assert.equal(f.calls.length, 3);
});

test('multiple PDFs require an item-bound choice; URLs stay out of public snapshots and durable queue', async t => {
  const f = fixture(t, { '/page': { body: '<a href="/a.pdf?sig=secret">A</a><a href="/b.pdf">B</a>' }, '/a.pdf': { body: PDF }, '/b.pdf': { body: PDF } });
  const r = await f.pdf.analyze('https://site.test/page', { itemId: 'one' });
  assert.equal(r.kind, 'pdfChoice'); assert.equal(f.calls.length, 1);
  assert.deepEqual(r.choices, [{ index: 0, label: 'A' }, { index: 1, label: 'B' }]);
  const bad = await f.pdf.analyze('https://site.test/page', { itemId: 'two', choice: { token: r.token, index: 0 } });
  assert.equal(bad.kind, 'pdfChoiceExpired');
  const choice = await f.pdf.analyze('https://site.test/page', { itemId: 'one' });
  const selected = await f.pdf.analyze('https://site.test/page', { itemId: 'one', choice: { token: choice.token, index: 1 } });
  assert.equal(selected.mediaUrl, 'https://site.test/b.pdf');
  assert.equal(selected.referer, 'https://site.test/page');
  const durable = toDurable({ id: 'one', url: 'https://site.test/page', status: 'paused', contentType: 'pdf', mediaUrl: 'https://site.test/a.pdf?sig=secret' });
  assert.equal(durable.contentType, 'pdf'); assert.ok(!JSON.stringify(durable).includes('secret'));
});

test('extension/session PDF never falls back to an anonymous lookup when browser is unavailable', async t => {
  const f = fixture(t, {});
  const d = createDiscoveryService({ pdf: f.pdf, engine: noVideo, browserSession: {} });
  assert.equal((await d.analyze('https://site.test/private', { contentType: 'pdf', requireSession: true })).kind, 'sessionRequired');
  assert.equal(f.calls.length, 0);
});

test('scoped session cookies follow domain/path/secure rules across redirects; vault jars are removed', async t => {
  const f = fixture(t, {
    '/start': { status: 302, headers: { location: 'https://sub.site.test/private/file' } },
    '/private/file': { body: PDF },
  });
  const vault = new CookieVault({ tmpDir: f.dir });
  const ref = vault.remember([
    { domain: 'site.test', hostOnly: true, path: '/', name: 'HOST', value: 'ONLY', secure: true, session: true },
    { domain: '.site.test', hostOnly: false, path: '/private', name: 'PATH', value: 'OK', secure: true, session: true },
    { domain: '.other.test', hostOnly: false, path: '/', name: 'OTHER', value: 'NO', secure: true, session: true },
  ]);
  let jar;
  const r = await vault.withJar(ref, cookieFile => { jar = cookieFile; return f.pdf.analyze('https://site.test/start', { cookieFile }); });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].headers.Cookie, 'HOST=ONLY');
  assert.equal(f.calls[1].headers.Cookie, 'PATH=OK');
  assert.equal(fs.existsSync(jar), false);
});

test('HTML disguised as .pdf, missing files and rate limits fail without writing a final PDF', async t => {
  const f = fixture(t, { '/fake.pdf': { body: '<html>Please log in</html>', headers: { 'content-type': 'application/pdf' } }, '/blocked': { status: 429 }, '/bad.pdf': { body: '%PDF-1.7\ntruncated' } });
  assert.equal((await f.pdf.analyze('https://site.test/fake.pdf')).kind, 'pdfNotFound');
  assert.equal((await f.pdf.analyze('https://site.test/blocked')).kind, 'rateLimited');
  for (const name of ['fake', 'bad']) {
    const r = await f.pdf.download({ url: `https://site.test/${name}.pdf`, outputBase: path.join(f.dir, name) }).done;
    assert.equal(r.kind, 'pdfInvalid');
    assert.equal(fs.existsSync(path.join(f.dir, name + '.pdf')), false);
    assert.equal(fs.existsSync(path.join(f.dir, name + '.pdf.part')), false);
  }
});

test('PDF downloader never overwrites an existing completed file', async t => {
  const f = fixture(t, { '/file': { body: PDF } });
  const base = path.join(f.dir, 'existing'); fs.writeFileSync(base + '.pdf', 'ORIGINAL');
  assert.equal((await f.pdf.download({ url: 'https://site.test/file', outputBase: base }).done).ok, false);
  assert.equal(fs.readFileSync(base + '.pdf', 'utf8'), 'ORIGINAL');
});

test('stopping a PDF download cancels the network body and cleans its partial file', async t => {
  let started;
  const ready = new Promise(r => { started = r; });
  const f = fixture(t, { '/slow': (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(PDF); started();
    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } })) });
  const base = path.join(f.dir, 'slow');
  const run = f.pdf.download({ url: 'https://site.test/slow', outputBase: base });
  await ready; run.stop();
  assert.equal((await run.done).stopped, true);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('real coordinator and discovery retain restored PDF session provenance and make zero anonymous requests', async t => {
  const f = fixture(t, {});
  const discovery = createDiscoveryService({ pdf: f.pdf, engine: noVideo, browserSession: {} });
  let downloads = 0;
  const c = new DownloadCoordinator({
    discover: discovery.analyze,
    startDownload: () => { downloads++; throw new Error('must not download'); },
    store: { load: async () => [{ id: 'private-pdf', url: 'https://site.test/private', contentType: 'pdf', status: 'paused', needsSession: true, sessionSource: 'browser', browserPick: 'chrome', instancePick: 'chrome:personal' }], save: async () => {} },
  });
  t.after(() => c.shutdown());
  await c.init(); c.resume('private-pdf');
  await until(() => c.jobs[0].status === 'error');
  assert.equal(c.jobs[0].error.kind, 'sessionRequired');
  assert.equal(f.calls.length, 0); assert.equal(downloads, 0);
});

test('original PDF downloads through a real local HTTP server with a redirect, encoded query and gzip transfer', async t => {
  const http = require('node:http');
  const seen = [];
  const compressed = require('node:zlib').gzipSync(PDF);
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/lesson') { res.setHeader('Content-Type', 'text/html'); res.end('<a href="/redirect?sig=a%2Bb">Open</a><embed src="/redirect?sig=a%2Bb" type="application/pdf">'); }
    else if (req.url === '/redirect?sig=a%2Bb') { res.writeHead(302, { Location: '/original.pdf?sig=a%2Bb' }); res.end(); }
    else if (req.url === '/original.pdf?sig=a%2Bb') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }); res.end(compressed); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-real-pdf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pdf = createPdfDownloader();
  const source = `http://127.0.0.1:${server.address().port}/lesson`;
  const found = await pdf.analyze(source);
  assert.equal(found.ok, true, JSON.stringify(found));
  const result = await pdf.download({ ...found, url: source, outputBase: path.join(dir, 'original') }).done;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(result.file), PDF);
  assert.deepEqual(seen, ['/lesson', '/redirect?sig=a%2Bb', '/original.pdf?sig=a%2Bb', '/original.pdf?sig=a%2Bb']);
});
