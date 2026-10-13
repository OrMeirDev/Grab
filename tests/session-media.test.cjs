const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const browser = require('../electron/browser-session.cjs');
const { collectorScript, isNotPlayer } = require('../electron/media-collector.cjs');
const { findMedia } = require('../electron/pageprobe.cjs');

const pageUrl = 'https://courses.example/lesson';
const manifest = 'https://stream.mux.com/playback.m3u8?token=header.payload.signature';

function element(tag, attributes = {}, extras = {}) {
  return {
    localName: tag,
    getAttribute: (name) => attributes[name] ?? null,
    matches(selector) {
      if (selector === 'video, audio') return ['video', 'audio'].includes(tag);
      return tag === 'meta' && (/^og:video/.test(attributes.property || '') || attributes.name === 'twitter:player:stream');
    },
    ...extras,
  };
}
const root = (...elements) => ({ querySelectorAll: () => elements });
function collect(document, resources = [], options = {}) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(collectorScript(options), {
    URL, document: { URL: pageUrl, baseURI: pageUrl, title: 'Lesson', querySelector: () => null, ...document },
    performance: { getEntriesByType: () => resources },
  })));
}

test('finds signed Mux source through nested open roots and ignores the inner blob', () => {
  let plays = 0;
  const video = element('video', { src: 'blob:https://courses.example/internal' }, { src: 'blob:https://courses.example/internal', play: () => { plays++; } });
  const mux = element('mux-video', { src: manifest, 'cast-src': manifest }, { shadowRoot: root(video) });
  const wrapper = element('mux-player', {}, { shadowRoot: root(mux) });
  const result = collect(root(element('div', {}, { shadowRoot: root(wrapper) })), [], { startPlayback: false });
  assert.deepEqual(result.media, [manifest]);
  assert.equal(result.players, 3);
  assert.equal(plays, 0);
  assert.equal(video.muted, undefined);
  collect(root(wrapper), [], { startPlayback: true });
  assert.equal(plays, 1);
  assert.equal(video.muted, true);
});

test('finds inert shadow templates, audio sources, unfamiliar wrappers and past manifests', () => {
  const audio = element('audio', {}, { mediaKeys: {} });
  const source = element('source', { src: '/sound.mp3' }, { parentElement: audio });
  const result = collect(root(
    element('template', {}, { content: root(element('custom-player', { 'data-src': manifest })) }),
    audio, source, element('iframe', { src: 'https://embed.example/player' }),
    element('meta', { property: 'og:video' }, { content: '/clip.mp4' }),
  ), [{ name: 'https://cdn.example/past.mpd?sig=abc' }]);
  assert.deepEqual(new Set(result.media), new Set([manifest, 'https://courses.example/sound.mp3', 'https://courses.example/clip.mp4', 'https://cdn.example/past.mpd?sig=abc']));
  assert.equal(result.drm, true);
  assert.deepEqual(result.embeds, ['https://embed.example/player']);
});

test('selects an exact open tab, refreshes in its context and rejects ambiguity', async () => {
  const calls = [];
  const cdp = { send: async (method, params) => {
    calls.push({ method, params });
    return method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', url: pageUrl, targetId: 'existing', browserContextId: 'signed-in' }] } : { targetId: 'background' };
  } };
  assert.deepEqual(await browser.chooseTarget(cdp, pageUrl), { targetId: 'existing', created: false });
  assert.equal(calls.some((c) => c.method === 'Target.createTarget'), false);
  assert.deepEqual(await browser.chooseTarget(cdp, pageUrl, { refresh: true }), { targetId: 'background', created: true });
  assert.deepEqual(calls.at(-1).params, { url: 'about:blank', background: true, browserContextId: 'signed-in' });
  await assert.rejects(browser.chooseTarget({ send: async () => ({ targetInfos: [
    { type: 'page', url: pageUrl, browserContextId: 'one' },
    { type: 'page', url: pageUrl, browserContextId: 'two' },
  ] }) }, pageUrl), { kind: 'browserContext' });
});

test('validates the Chrome endpoint file and keeps connections on loopback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-endpoint-test-'));
  const file = path.join(dir, 'DevToolsActivePort');
  try {
    assert.throws(() => browser.readEndpoint(file), { kind: 'browserSession' });
    fs.writeFileSync(file, '9222\n/devtools/browser/approved-session\n');
    assert.equal(browser.readEndpoint(file), 'ws://127.0.0.1:9222/devtools/browser/approved-session');
    fs.writeFileSync(file, '0\nhttps://outside.example/\n');
    assert.throws(() => browser.readEndpoint(file), { kind: 'browserSession' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CDP client routes replies/events and rejects commands on timeout/disconnection', async () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  const messages = [];
  socket.send = (raw) => messages.push(JSON.parse(raw));
  socket.close = () => { socket.readyState = 3; socket.emit('close'); };
  const cdp = new browser.CdpClient(socket);
  const command = cdp.send('Runtime.evaluate', { expression: '1' }, 'frame');
  assert.equal(messages[0].sessionId, 'frame');
  socket.emit('message', JSON.stringify({ id: messages[0].id, result: { value: 1 } }));
  assert.deepEqual(await command, { value: 1 });
  const observed = [];
  cdp.on('event', (event) => observed.push(event));
  socket.emit('message', JSON.stringify({ method: 'Network.responseReceived', sessionId: 'frame' }));
  assert.equal(observed[0].sessionId, 'frame');
  await assert.rejects(cdp.send('Page.enable', {}, 'frame', 5), /timed out/);
  const pending = cdp.send('Network.enable');
  cdp.disconnect();
  await assert.rejects(pending, { kind: 'browserSession' });
  assert.equal(cdp.pending.size, 0);
});

test('cookie jars preserve domain/HttpOnly scope and disappear after success or failure', async () => {
  const reference = browser.rememberCookies([
    { domain: '.courses.example', path: '/', name: 'session', value: 'secret', httpOnly: true, secure: true, session: true },
    { domain: 'stream.mux.com', path: '/', name: 'invalid', value: 'line\ninjection' },
  ]);
  let file;
  await browser.withSessionCookies(reference, async (cookieFile) => {
    file = cookieFile;
    const jar = fs.readFileSync(file, 'utf8');
    assert.match(jar, /#HttpOnly_\.courses\.example\tTRUE\t\/\tTRUE\t0\tsession\tsecret/);
    assert.doesNotMatch(jar, /invalid/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(file), true);
  });
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(browser.withSessionCookies(reference, async (cookieFile) => {
    file = cookieFile;
    throw new Error('download failed');
  }), /download failed/);
  assert.equal(fs.existsSync(file), false);
});

class FakeChrome extends EventEmitter {
  constructor({ existing = false, failEvaluation = false } = {}) {
    super();
    this.connected = true;
    this.calls = [];
    this.existing = existing;
    this.failEvaluation = failEvaluation;
  }
  event(method, params, sessionId = 'main') { this.emit('event', { method, params, sessionId }); }
  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: this.existing ? [{ type: 'page', targetId: 'existing', url: pageUrl }] : [] };
    if (method === 'Target.createTarget') return { targetId: 'background' };
    if (method === 'Target.attachToTarget') return { sessionId: 'main' };
    if (method === 'Browser.getVersion') return { userAgent: 'Active Chrome UA' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
    if (method === 'Runtime.enable') {
      this.event('Runtime.executionContextCreated', { context: { id: sessionId === 'child' ? 3 : 1, auxData: { isDefault: true, frameId: sessionId === 'child' ? 'cross-origin' : 'root' } } }, sessionId);
      if (sessionId === 'main') this.event('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: true, frameId: 'same-process-frame' } } });
    }
    if (method === 'Target.setAutoAttach' && sessionId === 'main') {
      this.event('Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
      const headers = { Referer: 'https://embed.example/player', Origin: 'https://embed.example', 'User-Agent': 'Player UA', Cookie: 'never-forward-this' };
      for (const [url, mimeType, status] of [
        [manifest, 'application/vnd.apple.mpegurl', 200],
        ['https://cdn.example/audio.mp3', 'audio/mpeg', 200],
        ['https://cdn.example/extensionless', 'video/mp4', 200],
        ['https://cdn.example/expired.m3u8?token=old', 'application/vnd.apple.mpegurl', 403],
        ['https://cdn.example/segment-001.ts', 'video/mp2t', 200],
      ]) {
        this.event('Network.requestWillBeSent', { request: { url, headers }, type: 'Fetch' }, 'child');
        this.event('Network.responseReceived', { response: { url, mimeType, status } }, 'child');
      }
      // Another tab's traffic must not be collected.
      this.event('Network.responseReceived', { response: { url: 'https://outside.example/unrelated.mp4', mimeType: 'video/mp4', status: 200 } }, 'unrelated');
    }
    if (method === 'Runtime.evaluate') {
      if (this.failEvaluation) throw new Error('Frame navigated');
      return { result: { value: { title: 'Authenticated lesson', pageUrl: sessionId === 'child' ? 'https://embed.example/player' : pageUrl, players: 1, drm: false, media: sessionId === 'child' ? [manifest] : [], embeds: [] } } };
    }
    if (method === 'Network.getCookies') return { cookies: [{ domain: '.courses.example', path: '/', name: 'session', value: 'secret', secure: true, session: true }] };
    return {};
  }
}

test('probe covers frame contexts/network audio, preserves token and request headers, cleans only its own tab', async () => {
  const cdp = new FakeChrome();
  const result = await findMedia(pageUrl, { timeoutMs: 1, connect: async () => cdp });
  assert.equal(result.title, 'Authenticated lesson');
  assert.equal(result.diagnostics.framesScanned, 3);
  assert.deepEqual(new Set(result.candidates.map((c) => c.url)), new Set([manifest, 'https://cdn.example/audio.mp3', 'https://cdn.example/extensionless']));
  assert.equal(result.candidates[0].url, manifest);
  assert.deepEqual(result.candidates[0].requestContext, { userAgent: 'Player UA', referer: 'https://embed.example/player', origin: 'https://embed.example' });
  assert.equal(result.candidates.find((c) => c.url.endsWith('extensionless')).requestContext.origin, 'https://embed.example');
  assert.equal(cdp.listenerCount('event'), 0);
  assert.equal(cdp.calls.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'background'), true);
  assert.equal(cdp.calls.some((c) => c.method === 'Browser.close'), false);
  await browser.withSessionCookies(result.cookieRef, (file) => assert.match(fs.readFileSync(file, 'utf8'), /session\tsecret/));
});

test('existing tab is not navigated, played or closed and network fallback survives frame errors', async () => {
  const cdp = new FakeChrome({ existing: true, failEvaluation: true });
  const result = await findMedia(pageUrl, { timeoutMs: 1, connect: async () => cdp });
  assert.equal(result.reusedTab, true);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.diagnostics.scanErrors, 3);
  assert.equal(cdp.calls.some((c) => ['Target.closeTarget', 'Page.navigate', 'Target.createTarget'].includes(c.method)), false);
  const evaluate = cdp.calls.find((c) => c.method === 'Runtime.evaluate');
  assert.match(evaluate.params.expression, /"startPlayback":false/);
  assert.equal(cdp.listenerCount('event'), 0);
});

function mainHandlers(engine, pageprobe, hiddenProbe = { findMedia: async () => ({ candidates: [] }) }) {
  const handlers = new Map();
  const app = { getPath: () => os.tmpdir(), whenReady: () => ({ then() {} }), on() {} };
  const updater = { on() {} };
  const sandbox = { require: (name) => {
    if (name === 'electron') return { app, ipcMain: { handle: (key, value) => handlers.set(key, value) } };
    if (name === 'electron-updater') return { autoUpdater: updater };
    if (name === './engine.cjs') return engine;
    if (name === './pageprobe.cjs') return pageprobe;
    if (name === './hidden-probe.cjs') return hiddenProbe;
    if (name === './browser-session.cjs') return browser;
    return require(name);
  }, process, console, setTimeout, setInterval, __dirname: path.join(__dirname, '../electron') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'), sandbox);
  return handlers;
}
const sender = { isDestroyed: () => false, send() {} };

test('analyze tries beyond four candidates and forwards the cookie jar and player context', async () => {
  let calls = 0;
  let jar;
  const context = { userAgent: 'Chrome', referer: pageUrl, origin: 'https://courses.example' };
  const cookieRef = browser.rememberCookies([{ domain: '.courses.example', path: '/', name: 'session', value: 'secret', session: true }]);
  const handlers = mainHandlers({ analyze: async (url, options) => {
    calls++;
    if (calls === 1) return { ok: false, kind: 'notfound' };
    jar = options.cookieFile;
    assert.equal(fs.existsSync(jar), true);
    assert.deepEqual(options.requestContext, context);
    return { ok: calls === 6, title: 'Lesson' };
  } }, { findMedia: async () => ({ title: 'Lesson', cookieRef, candidates: Array.from({ length: 5 }, (_, i) => ({ url: manifest + '&n=' + i, kind: 'stream', requestContext: context })) }) });
  const result = await handlers.get('engine:analyze')({ sender }, pageUrl);
  assert.equal(result.ok, true);
  assert.equal(calls, 6);
  assert.equal(result.cookieRef, cookieRef);
  assert.equal(fs.existsSync(jar), false);
});

test('download IPC keeps cookies available until the child finishes, then deletes the jar', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-job-test-'));
  const cookieRef = browser.rememberCookies([{ domain: '.courses.example', path: '/', name: 'session', value: 'secret', session: true }]);
  let file;
  let finish;
  const handlers = mainHandlers({ download: (job) => {
    file = job.cookieFile;
    assert.equal(fs.existsSync(file), true);
    return { child: { kill() {} }, done: new Promise((resolve) => { finish = resolve; }) };
  } }, {});
  try {
    const pending = handlers.get('engine:start')({ sender }, { id: 'job', folder, cookieRef });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(file), true);
    finish({ ok: true });
    assert.equal((await pending).ok, true);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a tab with only an old blob is rescanned in a background tab, without reloading the user tab', async () => {
  const options = [];
  const handlers = mainHandlers({ analyze: async (url) => ({ ok: url === manifest, kind: 'notfound' }) }, {
    findMedia: async (url, option) => {
      options.push(option);
      return option.refresh ? { candidates: [{ url: manifest, kind: 'stream' }] } : { reusedTab: true, candidates: [] };
    },
  });
  assert.equal((await handlers.get('engine:analyze')({ sender }, pageUrl)).ok, true);
  assert.deepEqual(options.map((o) => o.refresh), [false, true]);
});

test('the hidden clean browser is tried first; Chrome is not touched when it finds the video', async () => {
  let chrome = 0;
  const handlers = mainHandlers({ analyze: async (url, options) => (url === manifest ? { ok: true, title: 'Lesson', referer: options.referer } : { ok: false, kind: 'notfound' }) },
    { findMedia: async () => { chrome++; return { candidates: [] }; } },
    { findMedia: async () => ({ title: 'Lesson', candidates: [{ url: manifest, kind: 'stream' }] }) });
  const result = await handlers.get('engine:analyze')({ sender }, pageUrl);
  assert.equal(result.ok, true);
  assert.equal(result.mediaUrl, manifest);
  assert.equal(chrome, 0);
});

test('the signed-in lookup uses the default browser: Chromium browsers by their own profile, Firefox is reported', { skip: process.platform !== 'win32' }, () => {
  const brave = browser.defaultBrowser('BraveHTML');
  assert.equal(brave.name, 'Brave');
  assert.equal(brave.scheme, 'brave');
  assert.match(brave.endpointFile, /BraveSoftware[\\/]Brave-Browser[\\/]User Data[\\/]DevToolsActivePort$/);
  assert.match(browser.defaultBrowser('MSEdgeHTM').endpointFile, /Microsoft[\\/]Edge[\\/]User Data/);
  assert.equal(browser.defaultBrowser('OperaGXStable').name, 'Opera GX');
  assert.deepEqual(browser.defaultBrowser('FirefoxURL-308046B0AF4A39CB'), { name: 'Firefox', supported: false });
  assert.equal(browser.defaultBrowser('SomethingElse').name, 'Chrome');
});

test('payment, captcha and tracking frames are not tried as players; video embeds are', () => {
  for (const u of ['https://js.stripe.com/v3/m-outer.html', 'https://newassets.hcaptcha.com/captcha/v1/x/hcaptcha.html', 'https://api.sardine.ai/assets/collector.html', 'https://www.google.com/recaptcha/api2/anchor', 'https://challenges.cloudflare.com/turnstile/v0/x']) assert.equal(isNotPlayer(u), true, u);
  for (const u of ['https://player.vimeo.com/video/1', 'https://www.youtube.com/embed/x', 'https://iframe.mediadelivery.net/embed/1/2', 'https://www.facebook.com/plugins/video.php?href=x', 'https://www.google.com/maps/embed']) assert.equal(isNotPlayer(u), false, u);
});

test('when the default browser can\'t be reached, the error says which browser and how to turn it on', async () => {
  const handlers = mainHandlers({ analyze: async () => ({ ok: false, kind: 'notfound' }) },
    { findMedia: async () => { throw Object.assign(new Error('closed'), { kind: 'browserSession' }); } });
  const result = await handlers.get('engine:analyze')({ sender }, pageUrl);
  assert.equal(result.kind, 'notfoundPage');
  assert.equal(typeof result.browser.name, 'string');
  assert.equal(result.browser.supported, true);
});

test('without browser remote debugging, a page with no video reports notfoundPage', async () => {
  const handlers = mainHandlers({ analyze: async () => ({ ok: false, kind: 'notfound' }) },
    { findMedia: async () => { throw new Error('DevToolsActivePort missing'); } });
  assert.equal((await handlers.get('engine:analyze')({ sender }, pageUrl)).kind, 'notfoundPage');
});

test('authentication errors retry the original extractor with active-session cookies', async () => {
  const cookieRef = browser.rememberCookies([{ domain: '.courses.example', path: '/', name: 'session', value: 'secret', session: true }]);
  let calls = 0;
  const handlers = mainHandlers({ analyze: async (url, options) => {
    calls++;
    assert.equal(url, pageUrl);
    if (calls === 1) return { ok: false, kind: 'private' };
    assert.match(fs.readFileSync(options.cookieFile, 'utf8'), /session\tsecret/);
    assert.equal(options.requestContext.userAgent, 'Active Chrome UA');
    return { ok: true, title: 'Authenticated lesson' };
  } }, { findMedia: async () => ({ cookieRef, candidates: [], requestContext: { userAgent: 'Active Chrome UA' } }) });
  const result = await handlers.get('engine:analyze')({ sender }, pageUrl);
  assert.equal(result.ok, true);
  assert.equal(result.cookieRef, cookieRef);
  assert.equal(calls, 2);
});

test('app shutdown removes cookie jars even while a download is pending', async () => {
  const cookieRef = browser.rememberCookies([{ domain: '.courses.example', path: '/', name: 'session', value: 'secret', session: true }]);
  await browser.withSessionCookies(cookieRef, async (file) => {
    assert.equal(fs.existsSync(file), true);
    browser.disconnectBrowser();
    assert.equal(fs.existsSync(file), false);
  });
});

test('connects through the live endpoint WebSocket, shares the connection and never closes Chrome', async () => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-websocket-test-'));
  const endpointFile = path.join(dir, 'DevToolsActivePort');
  const methods = [];
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      methods.push(message.method);
      socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'Existing Chrome' } }));
    });
  });
  try {
    fs.writeFileSync(endpointFile, server.address().port + '\n/devtools/browser/session\n');
    const [first, second] = await Promise.all([
      browser.connectBrowser({ endpointFile }), browser.connectBrowser({ endpointFile }),
    ]);
    assert.equal(first, second);
    assert.equal(connections, 1);
    assert.equal((await first.send('Browser.getVersion')).userAgent, 'Existing Chrome');
    const disconnected = new Promise((resolve) => first.once('disconnected', resolve));
    browser.disconnectBrowser();
    await disconnected;
    assert.equal(methods.includes('Browser.close'), false);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yt-dlp analyze/download options retain domain-scoped cookies and browser request context', () => {
  const sandbox = { module: { exports: {} }, require, process, __dirname: path.join(__dirname, '../electron') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/engine.cjs'), 'utf8') + '\nmodule.exports.testArgs = { sessionArgs, downloadArgs };', sandbox);
  const { sessionArgs, downloadArgs } = sandbox.module.exports.testArgs;
  const context = { cookieFile: '/tmp/domain-cookies', requestContext: { userAgent: 'Chrome', referer: pageUrl, origin: 'https://courses.example', Cookie: 'must-not-be-forwarded' } };
  const args = Array.from(downloadArgs({ url: pageUrl, mediaUrl: manifest, name: 'Lesson', folder: '/tmp', format: 'mp4', ...context }));
  for (const expected of sessionArgs(context)) assert.equal(args.includes(expected), true);
  assert.equal(args.includes(manifest), true);
  assert.equal(args.some((value) => value.includes('must-not-be-forwarded')), false);
  assert.doesNotThrow(() => downloadArgs({ url: pageUrl, name: 'Lesson', folder: '/tmp', requestContext: null }));
});
