const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizeContext, contextFromHeaders, RequestContexts, mediaExpiry, redactMediaSecrets } = require('../electron/request-context.cjs');
const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');
const browser = require('../electron/browser-session.cjs');
const entry = path.join(__dirname, '../electron/engine.cjs');
const sandbox = { module: { exports: {} }, require: createRequire(entry), process, __dirname: path.dirname(entry) };
vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nmodule.exports.args = { sessionArgs, downloadArgs, cleanError };', sandbox);
const { sessionArgs, downloadArgs, cleanError } = sandbox.module.exports.args;

test('only safe playback headers are replayed; omitted Referer/Origin remain omitted', () => {
  assert.deepEqual(contextFromHeaders({ 'USER-AGENT': 'Browser 999', Cookie: 'secret', Authorization: 'secret' }), { userAgent: 'Browser 999', referer: '', origin: '' });
  assert.deepEqual(normalizeContext({ userAgent: 'bad\r\nCookie: injected', referer: 'https://player.example/', origin: 'x\0bad', Cookie: 'never' }), { referer: 'https://player.example/' });
  assert.deepEqual(Array.from(sessionArgs({ referer: 'https://enclosing.example/', requestContext: contextFromHeaders({ 'User-Agent': 'Player UA' }) })), ['--user-agent', 'Player UA']);
  assert.equal(sessionArgs({ requestContext: { origin: 'ok\r\nAuthorization: bad' } }).length, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-cache-expiry-'));
  const infoFile = path.join(dir, 'cached.json');
  fs.writeFileSync(infoFile, '{}');
  try {
    const base = { url: 'https://page.example/', mediaUrl: 'https://cdn.example/master.m3u8?hdnea=exp%3D1700000000%7Ehmac%3Dfixture', name: 'Lesson', folder: dir, infoFile, infoAt: Date.now() };
    assert.ok(downloadArgs(base).includes(base.mediaUrl));
    assert.ok(!downloadArgs(base).includes('--load-info-json'));
    const fresh = { ...base, mediaUrl: 'https://cdn.example/master.m3u8', infoExpiresAt: Date.now() + 60000 };
    assert.ok(downloadArgs(fresh).includes('--load-info-json'));
    assert.ok(!downloadArgs({ ...fresh, infoExpiresAt: Date.now() - 1 }).includes('--load-info-json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CDP request IDs are scoped to sessions and redirect hops keep separate headers', () => {
  const tracker = new RequestContexts(() => 'Default UA', () => {});
  const request = (session, url, extra = {}) => tracker.request(session, { requestId: 'same-id', request: { url, headers: { 'User-Agent': 'Provisional ' + session } }, ...extra });
  request('frame-a', 'https://first.example/master.m3u8');
  request('frame-b', 'https://other.example/master.m3u8');
  tracker.extra('frame-b', { requestId: 'same-id', headers: { 'User-Agent': 'Actual B', Origin: 'https://other.example' } });
  tracker.extra('frame-a', { requestId: 'same-id', headers: { 'User-Agent': 'Actual A', Referer: 'https://first.example/' } });
  request('frame-a', 'https://redirected.example/master.m3u8', { redirectResponse: {}, redirectHasExtraInfo: true });
  tracker.extra('frame-a', { requestId: 'same-id', headers: { 'User-Agent': 'Redirect UA' } });
  assert.equal(tracker.get('https://other.example/master.m3u8').userAgent, 'Actual B');
  assert.equal(tracker.get('https://first.example/master.m3u8').userAgent, 'Actual A');
  assert.deepEqual(tracker.get('https://redirected.example/master.m3u8'), { userAgent: 'Redirect UA', referer: '', origin: '' });
});

test('late redirect metadata repairs pairing when the earlier hop had no ExtraInfo', () => {
  const tracker = new RequestContexts(() => 'Default', () => {});
  tracker.extra('frame', { requestId: 'id', headers: { 'User-Agent': 'Redirect destination UA', Origin: 'https://destination.example' } });
  tracker.request('frame', { requestId: 'id', request: { url: 'https://source.example/x', headers: { 'User-Agent': 'Source UA' } } });
  tracker.request('frame', { requestId: 'id', redirectResponse: {}, redirectHasExtraInfo: false, request: { url: 'https://destination.example/x', headers: {} } });
  assert.equal(tracker.get('https://source.example/x').userAgent, 'Source UA');
  assert.equal(tracker.get('https://destination.example/x').userAgent, 'Redirect destination UA');
});

test('a late request event cannot overwrite a newer request for the same URL', () => {
  const tracker = new RequestContexts(() => 'Default', () => {});
  const url = 'https://cdn.example/master.m3u8?token=opaque%2Fvalue';
  for (const requestId of ['old', 'new']) tracker.request('frame', { requestId, request: { url, headers: { 'User-Agent': requestId } } });
  tracker.extra('frame', { requestId: 'old', headers: { 'User-Agent': 'Old actual UA' } });
  assert.equal(tracker.get(url).userAgent, 'new');
});

test('recognizes expiry without changing opaque signed URLs and redacts path and query tokens', () => {
  const url = 'https://cdn.example/hdntl=exp=1792130002~acl=%2f*~hmac=path-secret/index.m3u8?hdnea=exp%3D1792044381%7Ehmac%3Dquery-secret&signature=other-secret';
  assert.equal(mediaExpiry(url), 1792044381000);
  assert.equal(mediaExpiry('https://cdn.example/master.m3u8'), null);
  assert.equal(mediaExpiry('https://cdn.example/invalid%zz?exp=1792130002'), 1792130002000);
  assert.doesNotMatch(redactMediaSecrets(url), /path-secret|query-secret|other-secret/);
  const cleaned = cleanError('ERROR: HTTP Error 403 Forbidden: ' + url);
  assert.match(cleaned, /403/);
  assert.doesNotMatch(cleaned, /path-secret|query-secret|other-secret/);
});

test('403 from an old tab gets one fresh authorized lookup and preserves fresh context', async () => {
  const page = 'https://lesson.example/episode';
  const context = { userAgent: 'New browser', referer: page, origin: 'https://lesson.example' };
  const calls = [];
  const handlers = mainHandlers({ analyze: async (url, options) => {
    if (url === page) return { ok: false, kind: 'notfound' };
    if (url.includes('old')) return { ok: false, kind: 'forbidden', httpStatus: 403, error: 'HTTP Error 403' };
    assert.deepEqual(options.requestContext, context);
    return { ok: true, infoFile: 'fresh.json' };
  } }, { findMedia: async (_url, options) => {
    calls.push(options.refresh);
    return { cookieRef: browser.rememberCookies([]), reusedTab: !options.refresh, candidates: [{ url: `https://cdn.example/${options.refresh ? 'fresh' : 'old'}.m3u8`, requestContext: options.refresh ? context : {} }] };
  } });
  const result = await handlers.get('engine:analyze')({ sender }, page, { requireSession: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.requestContext, context);
  assert.deepEqual(calls, [false, true]);
});

test('a repeated 403 stays forbidden and lookup refresh is bounded', async () => {
  let probes = 0;
  const handlers = mainHandlers({ analyze: async (url) => url === 'https://lesson.example/episode'
    ? { ok: false, kind: 'notfound' } : { ok: false, kind: 'forbidden', httpStatus: 403, error: 'Server denied playback' } }, {
    findMedia: async () => { probes++; return { cookieRef: browser.rememberCookies([]), reusedTab: true, candidates: [{ url: 'https://cdn.example/master.m3u8' }] }; },
  });
  const result = await handlers.get('engine:analyze')({ sender }, 'https://lesson.example/episode', { requireSession: true });
  assert.equal(result.kind, 'forbidden');
  assert.equal(result.httpStatus, 403);
  assert.equal(probes, 2);
});

test('an original 403 is preserved when browser lookup finds no usable media', async () => {
  const handlers = mainHandlers({ analyze: async () => ({ ok: false, kind: 'forbidden', httpStatus: 403, error: 'Server denied playback' }) }, {
    findMedia: async () => ({ reusedTab: false, candidates: [] }),
  });
  const result = await handlers.get('engine:analyze')({ sender }, 'https://lesson.example/denied');
  assert.equal(result.kind, 'forbidden');
  assert.equal(result.httpStatus, 403);
});

test('cancelled contextual downloads stay stopped and remove their temporary cookie jar', async () => {
  const browser = require('../electron/browser-session.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-context-cancel-'));
  const cookieRef = browser.rememberCookies([{ domain: '.example', path: '/', name: 'playback', value: 'temporary', session: true }]);
  const requestContext = { userAgent: 'Original player UA', referer: 'https://player.example/', origin: 'https://player.example' };
  let finish;
  let jar;
  const handlers = mainHandlers({ download: (job) => {
    assert.deepEqual(job.requestContext, requestContext);
    jar = job.cookieFile;
    return { child: { kill: () => finish({ ok: false, kind: 'other', error: 'terminated' }) }, done: new Promise((resolve) => { finish = resolve; }) };
  } }, {});
  try {
    const pending = handlers.get('engine:start')({ sender }, { id: 'cancel', folder: dir, cookieRef, requestContext });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(jar), true);
    handlers.get('engine:stop')({ sender }, 'cancel');
    const result = await pending;
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(jar), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
