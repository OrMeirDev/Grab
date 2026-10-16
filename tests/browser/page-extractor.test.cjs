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
  return { svc, hub, calls, discovery, instance };
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

test('automatic YouTube selection uses the configured session before the first network request', async (t) => {
  const f = fixture(t);
  const out = await f.discovery.analyze('https://www.youtube.com/watch?v=fixture123');
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
  const out = await f.discovery.analyze(url);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(f.calls[0].url, 'https://www.youtube.com/');
  assert.equal(f.calls[1].url, url);
  assert.match(f.calls[1].cookies, /SID\tPAGE-SESSION/);
});
