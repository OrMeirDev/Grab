const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../../extension/lib/protocol.js');
const session = require('../../electron/browser-session.cjs');
const { BrowserService } = require('../../electron/browser/service.cjs');
const { BrowserHub } = require('../../electron/browser/hub.cjs');
const { FakeBrowser } = require('../../test-support/fake-browser.cjs');

const ORIGIN = require('../../electron/browser/setup.cjs').readExtensionIdentity(path.join(__dirname, '..', '..', 'extension')).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { userAgent: 'UA/1', referer: 'https://site.test/lesson', origin: 'https://site.test' };
const cand = (url, extra = {}) => ({ url, kind: 'hls', size: 0, at: Date.now(), firstAt: Date.now(), fromPlayer: true, frameId: 0, context: ctx, redirects: [], hosts: [], ...extra });
const installedAll = { browsers: ['edge', 'chrome', 'brave'].map((id) => ({ id, name: id, exe: `C:\\fake\\${id}.exe` })), systemDefault: null };

async function rig(t, { settings = {}, detected = installedAll } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-svc-'));
  let saved = { browser: settings };
  const notes = [];
  const analyzeCalls = [];
  const engine = {
    // Records exactly what the downloader would be given, including the cookie file's content at call time.
    analyze: async (url, opts) => {
      const cookies = opts.cookieFile ? fs.readFileSync(opts.cookieFile, 'utf8') : null;
      analyzeCalls.push({ url, requestContext: opts.requestContext, referer: opts.referer, cookies, cookiePath: opts.cookieFile });
      return engine.result(url, analyzeCalls.length);
    },
    result: (url) => ({ ok: true, title: 'T', duration: 10, site: 'Generic' }),
  };
  const svc = new BrowserService({
    appVersion: '1', sourceRoot: path.join(__dirname, '..', '..'), integrationDir: dir,
    getSettings: () => saved, saveSettings: (p) => { saved = { ...saved, ...p }; },
    notify: (channel, payload) => notes.push([channel, payload]),
    askRenderer: async () => svc.answer || 'accepted', engine, session,
    deps: { isRunning: async () => true, launch() {} },
    registry: { get: async () => null, set: async () => {}, remove: async () => true },
  });
  await svc.init();
  svc.detected = detected;
  svc.health = { installed: true, results: ['edge', 'chrome', 'brave'].map((browser) => ({ browser, detected: true, registered: true, problems: [], state: 'unknown', instances: [] })) };
  const made = [];
  const connect = async (o = {}) => {
    const b = new FakeBrowser({ integrationDir: dir, origin: ORIGIN, ...o });
    made.push(b);
    await b.waitFor((m) => m.type === 'app-status' && m.online);
    b.hello({ extVersion: svc.identity.version });
    await b.waitFor((m) => m.type === 'welcome');
    b.cookieRequests = [];
    // A scripted extension: answers discover / cookies-request like the real one would.
    b.script = { discover: (m) => [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/v/master.m3u8?sig=a%2Bb')] })], cookies: () => [] };
    const seen = new Set();
    const tick = setInterval(() => {
      for (const m of b.received) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.type === 'discover') for (const out of b.script.discover(m)) b.write(out);
        if (m.type === 'cookies-request') { b.cookieRequests.push(m); b.write(protocol.make('cookies', { jobId: m.jobId, cookies: b.script.cookies(m) }, m.id)); }
      }
    }, 10);
    b.exited.then(() => clearInterval(tick));
    return b;
  };
  t.after(async () => { svc.shutdown(); for (const b of made) b.kill(); await sleep(60); fs.rmSync(dir, { recursive: true, force: true }); });
  return { svc, connect, engine, analyzeCalls, notes, get saved() { return saved; } };
}

const cookie = (domain, name, value, extra = {}) => ({ name, value, domain, path: '/', secure: true, httpOnly: true, hostOnly: !domain.startsWith('.'), session: true, expirationDate: 0, ...extra });
const fast = { connectMs: 2000, discoveryMs: 10000, probeMs: 10000 };

test('happy path: candidate validated with only the scoped cookies and the observed request context, file cleaned up', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  b.script.cookies = () => [cookie('cdn.test', 'sid', 'SECRET1'), cookie('.cdn.test', 'dom', 'D1'), cookie('unrelated.example', 'leak', 'LEAK')];
  const out = await r.svc.analyze('https://www.mako.co.il/v/1', { itemId: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.mediaUrl, 'https://cdn.test/v/master.m3u8?sig=a%2Bb', 'signed URL untouched');
  assert.deepEqual(out.requestContext, ctx);
  assert.equal(out.browser.id, 'edge', 'mako rule picked Edge');
  const call = r.analyzeCalls[0];
  assert.match(call.cookies, /cdn\.test\tFALSE\t\/\tTRUE\t0\tsid\tSECRET1/);
  assert.match(call.cookies, /#HttpOnly_/);
  assert.ok(!call.cookies.includes('LEAK'), 'a cookie for an unrelated host never reaches the downloader');
  assert.equal(fs.existsSync(call.cookiePath), false, 'temporary cookie file removed');
  assert.equal(b.cookieRequests[0].urls.length, 1);
  assert.ok(!JSON.stringify(out).includes('SECRET1'), 'no cookie value in the result handed to the renderer');
  assert.ok(!JSON.stringify(r.notes).includes('SECRET1'));
  assert.ok(!JSON.stringify(r.svc.state()).includes('SECRET1'));
  const phases = r.notes.filter(([c]) => c === 'browser:phase').map(([, p]) => p.phase);
  assert.deepEqual(phases.filter((p, i) => p !== phases[i - 1]), ['connecting', 'discovering', 'validating']);
});

test('redirect and player hosts widen the cookie scope only to hosts the browser really used', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  b.script.discover = (m) => [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/m.m3u8', { redirects: ['https://site.test/go/1'], hosts: ['seg.cdn2.test'] })] })];
  b.script.cookies = (m) => [cookie('site.test', 'a', '1'), cookie('cdn.test', 'b', '2'), cookie('seg.cdn2.test', 'c', '3'), cookie('other.test', 'd', '4')];
  await r.svc.analyze('https://x.test/p', { itemId: 2, browser: 'edge' });
  assert.deepEqual(b.cookieRequests[0].urls.map((u) => new URL(u).hostname).sort(), ['cdn.test', 'seg.cdn2.test', 'site.test']);
  const jar = r.analyzeCalls[0].cookies;
  assert.ok(jar.includes('\ta\t1') && jar.includes('\tb\t2') && jar.includes('\tc\t3'));
  assert.ok(!jar.includes('other.test'));
});

test('two profiles never share candidates or credentials; the remembered profile is used and not replaced', async (t) => {
  const r = await rig(t, { settings: { ...fast, instanceChoice: { edge: 'edge:prof-b' } } });
  const a = await r.connect({ instanceId: 'prof-a' });
  const b = await r.connect({ instanceId: 'prof-b' });
  a.script.discover = (m) => [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/from-a.m3u8')] })];
  a.script.cookies = () => [cookie('cdn.test', 'sid', 'FROM-A')];
  b.script.discover = (m) => [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/from-b.m3u8')] })];
  b.script.cookies = () => [cookie('cdn.test', 'sid', 'FROM-B')];
  const out = await r.svc.analyze('https://www.mako.co.il/v/1', { itemId: 3 });
  assert.equal(out.mediaUrl, 'https://cdn.test/from-b.m3u8');
  assert.ok(r.analyzeCalls[0].cookies.includes('FROM-B') && !r.analyzeCalls[0].cookies.includes('FROM-A'));
  assert.equal(a.received.filter((m) => m.type === 'discover' || m.type === 'cookies-request').length, 0);
  // The remembered profile goes away: no silent switch to the other one.
  await b.kill();
  await sleep(150);
  const gone = await r.svc.analyze('https://www.mako.co.il/v/1', { itemId: 4 });
  assert.equal(gone.ok, false);
  assert.equal(gone.kind, 'wrongProfile');
  assert.equal(a.received.filter((m) => m.type === 'discover').length, 0, 'profile A was not used instead');
});

test('several connected profiles and no saved choice: the user is asked, nothing is guessed', async (t) => {
  const r = await rig(t, { settings: fast });
  await r.connect({ instanceId: 'p1', alias: 'עבודה' });
  await r.connect({ instanceId: 'p2' });
  const out = await r.svc.analyze('https://www.mako.co.il/v/1', { itemId: 5 });
  assert.equal(out.kind, 'browserChoice');
  assert.deepEqual(out.options.map((o) => o.key).sort(), ['edge:p1', 'edge:p2']);
  assert.ok(out.options.some((o) => o.label === 'עבודה'));
  const picked = await r.svc.analyze('https://www.mako.co.il/v/1', { itemId: 5, instance: 'edge:p2' });
  assert.equal(picked.ok, true);
  assert.equal(picked.instanceKey, 'edge:p2');
});

test('an expired or refused signed URL gets exactly one fresh discovery in the same session', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  let round = 0;
  b.script.discover = (m) => { round++; return [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand(`https://cdn.test/v/r${round}.m3u8?token=${round}`)] })]; };
  r.engine.result = (url) => (url.includes('r1.m3u8') ? { ok: false, kind: 'forbidden', httpStatus: 403, error: 'HTTP 403' } : { ok: true, title: 'ok' });
  const ok = await r.svc.analyze('https://x.test/p', { itemId: 6, browser: 'edge' });
  assert.equal(ok.ok, true);
  assert.equal(ok.mediaUrl, 'https://cdn.test/v/r2.m3u8?token=2');
  assert.equal(round, 2);
  assert.deepEqual(b.received.filter((m) => m.type === 'discover').map((m) => m.refresh), [false, true], 'retry really bypasses the existing tab and cached URL');

  round = 0;
  r.engine.result = () => ({ ok: false, kind: 'forbidden', httpStatus: 403, error: 'HTTP 403' });
  const dead = await r.svc.analyze('https://x.test/p', { itemId: 7, browser: 'edge' });
  assert.equal(dead.kind, 'sessionExpired');
  assert.equal(round, 2, 'no endless retry loop');
  assert.equal(dead.browser.id, 'edge');
});

test('an already expired signed URL is not even tried', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  const past = Math.floor(Date.now() / 1000) - 600;
  b.script.discover = (m) => [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand(`https://cdn.test/m.m3u8?exp=${past}&sig=x`)] })];
  r.engine.mediaExpiry = (url) => { const m = /exp=(\d+)/.exec(url); return m ? Number(m[1]) * 1000 : null; };
  const out = await r.svc.analyze('https://x.test/p', { itemId: 8, browser: 'edge' });
  assert.equal(out.ok, false);
  assert.equal(r.analyzeCalls.length, 0);
});

test('playback action reveals the live discovery tab before candidates have arrived', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  b.script.discover = (m) => [protocol.make('progress', { jobId: m.jobId, state: 'playback_required' })];
  const pending = r.svc.analyze('https://x.test/p', { itemId: 60, browser: 'edge' });
  const request = await b.waitFor((m) => m.type === 'discover');
  assert.equal(r.svc.revealPlayback(60), true);
  const reveal = await b.waitFor((m) => m.type === 'reveal-tab');
  assert.equal(reveal.jobId, request.jobId);
  r.svc.cancel(60);
  assert.equal((await pending).kind, 'cancelled');
  assert.equal(r.svc.revealPlayback(60), false);
});

test('a source rate limit stops at once without another source or session refresh', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  r.engine.result = () => ({ ok: false, kind: 'blocked', httpStatus: 429, error: 'HTTP 429' });
  const out = await r.svc.analyze('https://x.test/p', { itemId: 61, browser: 'edge' });
  assert.equal(out.kind, 'rateLimited');
  assert.equal(out.httpStatus, 429);
  assert.equal(r.analyzeCalls.length, 1);
  assert.equal(b.received.filter((m) => m.type === 'discover').length, 1);
});

test('video choices cannot be reused for another page, item or browser session', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  b.script.discover = (m) => [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/a/one.m3u8'), cand('https://cdn.test/b/two.m3u8')] })];
  const first = await r.svc.analyze('https://x.test/p', { itemId: 62, browser: 'edge' });
  const choice = { token: first.token, index: 0 };
  assert.equal((await r.svc.analyze('https://other.test/p', { itemId: 62, browser: 'edge', choice })).kind, 'videoChoiceExpired');
  assert.equal((await r.svc.analyze('https://x.test/p', { itemId: 63, browser: 'edge', choice })).kind, 'videoChoiceExpired');
  assert.equal((await r.svc.analyze('https://x.test/p', { itemId: 62, browser: 'chrome', choice })).kind, 'videoChoiceExpired');
  assert.equal((await r.svc.analyze('https://x.test/p', { itemId: 62, browser: 'edge', choice })).ok, true);
  assert.equal((await r.svc.analyze('https://x.test/p', { itemId: 62, browser: 'edge', choice })).kind, 'videoChoiceExpired');
});

test('several plausible videos produce a small choice that resolves without a second discovery', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  let discoveries = 0;
  b.script.discover = (m) => { discoveries++; return [protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/a/one.m3u8'), cand('https://cdn.test/b/two.m3u8')] })]; };
  const first = await r.svc.analyze('https://x.test/p', { itemId: 9, browser: 'edge' });
  assert.equal(first.kind, 'videoChoice');
  assert.equal(first.choices.length, 2);
  assert.ok(first.choices.every((c) => !c.label.includes('?')), 'labels carry no query strings');
  const second = await r.svc.analyze('https://x.test/p', { itemId: 9, browser: 'edge', choice: { token: first.token, index: 1 } });
  assert.equal(second.ok, true);
  assert.equal(second.mediaUrl, 'https://cdn.test/b/two.m3u8');
  assert.equal(discoveries, 1);
});

test('no video, protected media and extension failures become explicit kinds with the browser named', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  const reasons = ['no_video', 'protected', 'permission_denied'];
  let i = 0;
  b.script.discover = (m) => [protocol.make('job-failed', { jobId: m.jobId, reason: reasons[i++] })];
  const kinds = [];
  for (let n = 0; n < 3; n++) kinds.push(await r.svc.analyze('https://x.test/p', { itemId: 20 + n, browser: 'edge' }));
  assert.deepEqual(kinds.map((k) => k.kind), ['noVideoBrowser', 'protected', 'extensionPermission']);
  assert.ok(kinds.every((k) => k.browser.id === 'edge' && k.browser.name === 'Microsoft Edge'));
});

test('cancel settles the lookup, tells the browser, and a late answer cannot revive it', async (t) => {
  const r = await rig(t, { settings: { ...fast, discoveryMs: 10000 } });
  const b = await r.connect();
  b.script.discover = () => [];
  const pending = r.svc.analyze('https://x.test/p', { itemId: 30, browser: 'edge' });
  await b.waitFor((m) => m.type === 'discover');
  assert.equal(r.svc.cancel(30), true);
  const out = await pending;
  assert.equal(out.kind, 'cancelled');
  await b.waitFor((m) => m.type === 'cancel');
  b.write(protocol.make('candidates', { jobId: b.received.find((m) => m.type === 'discover').jobId, final: true, candidates: [cand('https://cdn.test/late.m3u8')] }));
  await sleep(150);
  assert.equal(r.analyzeCalls.length, 0, 'nothing was validated after the cancel');
  assert.equal(r.svc.cancel(30), false);
});

test('a missing browser is reported, never replaced by another installed one', async (t) => {
  const r = await rig(t, { settings: fast, detected: { browsers: [{ id: 'chrome', name: 'Chrome', exe: 'C:\\c.exe' }], systemDefault: 'chrome' } });
  await r.connect({ browser: 'chrome' });
  const out = await r.svc.analyze('https://www.mako.co.il/v/1', { itemId: 40 });
  assert.equal(out.kind, 'browserUnavailable');
  assert.equal(out.browser.id, 'edge');
  assert.equal(r.analyzeCalls.length, 0);
});

test('Send to GRAB: accepted is not completed; duplicates are acknowledged once; the real result comes later', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  const send = (url) => { const m = protocol.make('send-to-grab', { url, title: 'פרק' }); b.write(m); return m; };
  const m1 = send('https://www.mako.co.il/v/1#t=3');
  const ack = await b.waitFor((m) => m.type === 'ack' && m.replyTo === m1.id);
  assert.equal(ack.status, 'accepted');
  assert.ok(ack.ref);
  assert.equal(b.received.some((m) => m.type === 'job-status'), false, 'no completion claimed on acceptance');
  const m2 = send('https://www.mako.co.il/v/1');
  assert.equal((await b.waitFor((m) => m.type === 'ack' && m.replyTo === m2.id)).status, 'duplicate');
  r.svc.reportJob(ack.ref, { phase: 'downloading' });
  const progress = await b.waitFor((m) => m.type === 'job-status' && m.phase === 'downloading');
  assert.equal(progress.terminal, undefined);
  r.svc.reportJob(ack.ref, { phase: 'completed', terminal: 'completed' });
  assert.equal((await b.waitFor((m) => m.type === 'job-status' && m.terminal === 'completed')).ref, ack.ref);
  assert.equal(r.svc.reportJob(ack.ref, { terminal: 'failed' }), false, 'a finished job is not reopened');
});

test('Send to GRAB keeps the sending browser even when the global default is another one', async (t) => {
  const r = await rig(t, { settings: { ...fast, defaultBrowser: 'brave' } });
  const edgeBrowser = await r.connect({ browser: 'edge', instanceId: 'e1' });
  const sent = protocol.make('send-to-grab', { url: 'https://other.test/video', candidate: cand('https://cdn.test/sent.m3u8') });
  edgeBrowser.write(sent);
  const ack = await edgeBrowser.waitFor((m) => m.type === 'ack' && m.replyTo === sent.id);
  assert.equal(r.svc.resolve('https://other.test/video').browserId, 'brave', 'the default stays Brave for other jobs');
  edgeBrowser.script.cookies = () => [cookie('cdn.test', 'sid', 'EDGE-SESSION')];
  const out = await r.svc.analyze('https://other.test/video', { itemId: 50, ref: ack.ref });
  assert.equal(out.ok, true);
  assert.equal(out.browser.id, 'edge');
  assert.equal(out.instanceKey, 'edge:e1');
  assert.equal(out.mediaUrl, 'https://cdn.test/sent.m3u8', 'the video the user picked, without a new discovery');
  assert.equal(edgeBrowser.received.some((m) => m.type === 'discover'), false);
  assert.equal(edgeBrowser.cookieRequests[0].jobId, sent.id, 'cookie scope key is the send request');
  assert.ok(r.analyzeCalls[0].cookies.includes('EDGE-SESSION'));
});

test('Send to GRAB is rejected when the app window cannot take it', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  r.svc.answer = 'unavailable';
  const m = protocol.make('send-to-grab', { url: 'https://x.test/a' });
  b.write(m);
  const ack = await b.waitFor((x) => x.type === 'ack' && x.replyTo === m.id);
  assert.equal(ack.status, 'rejected');
  assert.equal(ack.reason, 'app_not_ready');
});

test('Send to GRAB reserves pending jobs and keeps same-page browser sessions independent', async (t) => {
  const r = await rig(t, { settings: fast });
  const edge = await r.connect({ browser: 'edge', instanceId: 'e-send' });
  const brave = await r.connect({ browser: 'brave', instanceId: 'b-send' });
  let release;
  const requests = [];
  r.svc.askRenderer = async (_channel, data) => {
    requests.push(data);
    assert.ok(r.svc.incoming.has(data.ref), 'session hint exists before the renderer can start analysis');
    if (requests.length === 1) await new Promise((resolve) => { release = resolve; });
    return 'accepted';
  };
  const url = 'https://site.test/two';
  const first = protocol.make('send-to-grab', { url });
  edge.write(first);
  while (!release) await sleep(10);
  const repeated = protocol.make('send-to-grab', { url });
  edge.write(repeated);
  await sleep(40);
  assert.equal(requests.length, 1);
  release();
  const a = await edge.waitFor((m) => m.type === 'ack' && m.replyTo === first.id);
  const duplicate = await edge.waitFor((m) => m.type === 'ack' && m.replyTo === repeated.id);
  assert.equal(a.status, 'accepted');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(a.ref, duplicate.ref);
  const other = protocol.make('send-to-grab', { url });
  brave.write(other);
  assert.equal((await brave.waitFor((m) => m.type === 'ack' && m.replyTo === other.id)).status, 'accepted');
  assert.notEqual(requests[0].sourceId, requests[1].sourceId, 'one page in another session is a distinct request');
});

test('deadlines default sensibly, accept valid saved values and ignore out-of-range ones', async (t) => {
  const r = await rig(t, { settings: {} });
  assert.deepEqual(r.svc.deadlines(), { connectMs: 10000, discoveryMs: 60000, probeMs: 45000, downloadIdleMs: 180000 });
  await r.svc.setSettings({ connectMs: 5000, discoveryMs: 99999999, downloadIdleMs: 10 });
  assert.equal(r.svc.deadlines().connectMs, 5000);
  assert.equal(r.svc.deadlines().discoveryMs, 60000);
  assert.equal(r.svc.deadlines().downloadIdleMs, 180000);
});

test('saved settings go through validation: unknown browsers and malformed hosts never persist', async (t) => {
  const r = await rig(t, { settings: {} });
  await r.svc.setSettings({ defaultBrowser: 'firefox', siteRules: [{ host: 'evil host', browser: 'edge' }, { host: 'example.org', browser: 'brave' }] });
  const s = r.svc.state().settings;
  assert.equal(s.defaultBrowser, null);
  assert.deepEqual(s.siteRules, [{ host: 'example.org', browser: 'brave' }]);
  assert.equal(r.svc.resolve('https://www.mako.co.il/x').source, 'suggested', 'the seeded mako rule was replaced by the saved list');
});

test('disconnect while acquiring cookies never calls the extractor without the session', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  const write = b.write.bind(b);
  b.write = (m) => { if (m.type === 'cookies') b.kill(); else write(m); };
  const out = await r.svc.analyze('https://www.mako.co.il/v/member', { itemId: 'cookie-disconnect' });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'browserDisconnected');
  assert.equal(r.analyzeCalls.length, 0, 'not one unauthenticated extractor request');
});

test('a connected profile losing its scope is an explicit session failure before any extractor request', async (t) => {
  const r = await rig(t, { settings: fast });
  await r.connect();
  const request = r.svc.hub.request.bind(r.svc.hub);
  r.svc.hub.request = (key, type, data, options) => type === 'cookies-request'
    ? Promise.resolve({ cookies: [], available: false }) : request(key, type, data, options);
  const out = await r.svc.analyze('https://www.mako.co.il/v/member', { itemId: 'lost-scope' });
  assert.equal(out.kind, 'sessionExpired');
  assert.equal(r.analyzeCalls.length, 0);
});

test('disconnect drops only that extension profile session; another connected profile stays usable', async (t) => {
  const r = await rig(t, { settings: fast });
  const a = await r.connect({ instanceId: 'profile-a' });
  await r.connect({ instanceId: 'profile-b' });
  const one = await r.svc.analyze('https://www.mako.co.il/v/one', { itemId: 'session-a', instance: 'edge:profile-a' });
  const two = await r.svc.analyze('https://www.mako.co.il/v/two', { itemId: 'session-b', instance: 'edge:profile-b' });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(session.hasCookies(one.cookieRef), true);
  assert.equal(session.hasCookies(two.cookieRef), true);
  await a.kill();
  for (let i = 0; i < 100 && session.hasCookies(one.cookieRef); i++) await sleep(10);
  assert.equal(session.hasCookies(one.cookieRef), false);
  assert.equal(session.hasCookies(two.cookieRef), true);
  await assert.rejects(session.withSessionCookies(one.cookieRef, () => assert.fail('expired context was used')), { kind: 'contextExpired' });
});

test('cancelling while waiting for cookies settles promptly and leaves no extractor request or pending reply', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  // Prevent only the cookie reply; the discovery still goes through the real host and hub.
  const write = b.write.bind(b);
  b.write = (m) => { if (m.type !== 'cookies') write(m); };
  const pending = r.svc.analyze('https://www.mako.co.il/v/member', { itemId: 'cancel-cookies' });
  await b.waitFor((m) => m.type === 'cookies-request');
  r.svc.cancel('cancel-cookies');
  assert.equal((await pending).kind, 'cancelled');
  assert.equal(r.analyzeCalls.length, 0);
  assert.equal(r.svc.hub.pending.size, 0);
});

test('concurrent browser preference changes serialize without losing the first change', async (t) => {
  const r = await rig(t);
  await Promise.all([r.svc.setSettings({ defaultBrowser: 'chrome' }), r.svc.setSettings({ instanceAliases: { 'chrome:personal': 'אישי' } })]);
  assert.equal(r.saved.browser.defaultBrowser, 'chrome');
  assert.equal(r.saved.browser.instanceAliases['chrome:personal'], 'אישי');
});

test('an old extension is rejected with repair instructions before the extractor uses its cookie protocol', async (t) => {
  const r = await rig(t, { settings: fast });
  const b = await r.connect();
  b.hello({ extVersion: '1.0.0' });
  await sleep(50);
  assert.equal((await r.svc.analyze('https://www.mako.co.il/v/member', { itemId: 'outdated' })).kind, 'hostSetupError');
  assert.equal(r.analyzeCalls.length, 0);
});
