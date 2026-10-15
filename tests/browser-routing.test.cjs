const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WebSocketServer } = require('ws');
const browser = require('../electron/browser-session.cjs');
const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');

// Exercise Windows profile/registry selection without using the user's real browser.
function windowsBrowser() {
  const sandbox = {
    module: { exports: {} }, URL, setTimeout, clearTimeout,
    process: { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' } },
    require: (name) => name === 'path' ? path.win32 : name === 'child_process'
      ? { execFileSync: () => 'ProgId    REG_SZ    BraveHTML' } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/browser-session.cjs'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

const mako = 'https://www.mako.co.il/mako-vod-keshet/example/VOD-episode.htm';

test('only Mako page hosts select Edge even when Windows defaults to Brave', () => {
  const session = windowsBrowser();
  for (const url of [mako, 'https://mako.co.il/', 'https://vod.mako.co.il/', 'https://WWW.MAKO.CO.IL.:443/']) {
    const selected = session.browserForPage(url);
    assert.equal(selected.name, 'Edge', url);
    assert.equal(selected.scheme, 'edge');
    assert.match(selected.endpointFile, /Microsoft\\Edge\\User Data\\DevToolsActivePort$/);
  }
  for (const url of [undefined, '', 'not a URL', 'https://lesson.example/', 'https://mako.co.il.evil.example/', 'https://notmako.co.il/', 'https://mako.co.il@lesson.example/', 'https://lesson.example/?url=https://www.mako.co.il/', 'ftp://mako.co.il/', 'https://mako-vod.akamaized.net/master.m3u8']) {
    assert.equal(session.browserForPage(url).name, 'Brave', String(url));
  }
});

test('Mako lookup, phase, guide metadata and connection check all select Edge', async () => {
  const session = windowsBrowser();
  const connected = [];
  session.connectBrowser = async ({ browser }) => { connected.push(browser.name); return { browser }; };
  const phases = [];
  const handlers = mainHandlers({ analyze: async () => ({ ok: false, kind: 'notfound' }) }, {
    findMedia: async (_url, { connect }) => {
      const cdp = await connect();
      assert.equal(cdp.browser.name, 'Edge');
      throw Object.assign(new Error('Edge needs permission'), { kind: 'browserSession' });
    },
  }, undefined, session);
  const result = await handlers.get('engine:analyze')({ sender: { ...sender, send: (_event, value) => phases.push(value) } }, mako);
  assert.equal(result.browser.name, 'Edge');
  assert.equal(result.browser.scheme, 'edge');
  assert.equal(phases.at(-1).browser, 'Edge');
  const guide = handlers.get('browser:default')({}, mako);
  assert.equal(guide.name, 'Edge');
  assert.equal(guide.scheme, 'edge');
  assert.equal(guide.endpointFile, undefined);
  assert.equal((await handlers.get('browser:check')({}, mako)).ok, true);
  assert.equal(handlers.get('browser:default')({}, 'https://lesson.example/').name, 'Brave');
  assert.equal((await handlers.get('browser:check')({})).ok, true);
  assert.deepEqual(connected, ['Edge', 'Edge', 'Brave']);
});

test('an unavailable Edge reports Edge without connecting to Brave', async () => {
  const session = windowsBrowser();
  const connected = [];
  session.connectBrowser = async ({ browser }) => {
    connected.push(browser.name);
    throw Object.assign(new Error('closed'), { kind: 'browserSession' });
  };
  const handlers = mainHandlers({ analyze: async () => ({ ok: false, kind: 'forbidden' }) }, {
    findMedia: async (_url, { connect }) => connect(),
  }, undefined, session);
  assert.equal((await handlers.get('engine:analyze')({ sender }, mako)).browser.name, 'Edge');
  assert.equal((await handlers.get('browser:check')({}, mako)).ok, false);
  assert.deepEqual(connected, ['Edge', 'Edge']);
});

test('a directly readable video from another site does not require a browser connection', async () => {
  const session = windowsBrowser();
  session.connectBrowser = async () => assert.fail('working extractor must not connect');
  const handlers = mainHandlers({ analyze: async () => ({ ok: true, title: 'Episode' }) }, {}, undefined, session);
  assert.equal((await handlers.get('engine:analyze')({ sender }, 'https://lesson.example/episode')).ok, true);
});

for (const first of [{ ok: true, title: 'dxc', site: 'Generic' }, { ok: false, kind: 'notfound' }, { ok: false, kind: 'forbidden' }]) {
  test(`Mako uses its Edge player before page extractors or clean probes (${first.title || first.kind})`, async () => {
    const session = windowsBrowser();
    const calls = [];
    const source = 'https://cdn.example/episode/master.m3u8?signature=fixture';
    const requestContext = { userAgent: 'Actual Edge UA', referer: 'https://www.mako.co.il/', origin: 'https://www.mako.co.il' };
    session.connectBrowser = async ({ browser }) => { calls.push(browser.name); return { browser }; };
    const handlers = mainHandlers({ analyze: async (url, options) => {
      calls.push(url);
      if (url === mako) return first;
      assert.equal(url, source);
      assert.deepEqual(options.requestContext, requestContext);
      return { ok: true, title: 'Episode' };
    } }, {
      findMedia: async (_url, { connect }) => {
        assert.equal((await connect()).browser.name, 'Edge');
        return { reusedTab: true, candidates: [{ url: source, kind: 'stream', requestContext }] };
      },
    }, { findMedia: async () => {
      calls.push('clean probe');
      return { candidates: [{ url: 'https://cdn.example/dxc.mp4', kind: 'file' }] };
    } }, session);
    const result = await handlers.get('engine:analyze')({ sender }, mako);
    assert.equal(result.ok, true);
    assert.equal(result.title, 'Episode');
    assert.equal(result.mediaUrl, source);
    assert.deepEqual(result.requestContext, requestContext);
    assert.deepEqual(calls, ['Edge', source]);
  });
}

test('preload forwards the page URL to both guide and connection check IPC', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (...args) => calls.push(args) },
    }),
  });
  await api.defaultBrowser(mako);
  await api.checkBrowser(mako);
  assert.deepEqual(calls, [['browser:default', mako], ['browser:check', mako]]);
});

test('concurrent Edge and Brave connections stay independent and reusable', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-browser-routing-'));
  const servers = [];
  const calls = [];
  try {
    const profiles = [];
    for (const name of ['Brave', 'Edge']) {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      servers.push(server);
      await new Promise((resolve) => server.once('listening', resolve));
      const endpointFile = path.join(dir, name);
      fs.writeFileSync(endpointFile, `${server.address().port}\n/devtools/browser/${name}\n`);
      profiles.push({ name, scheme: name.toLowerCase(), endpointFile });
      server.on('connection', (socket) => socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        calls.push([name, message.method]);
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: name } }));
      }));
    }
    const [brave, edge] = await Promise.all(profiles.map((profile) => browser.connectBrowser({ browser: profile })));
    assert.notEqual(brave, edge);
    assert.equal((await brave.send('Browser.getVersion')).userAgent, 'Brave');
    assert.equal((await edge.send('Browser.getVersion')).userAgent, 'Edge');
    assert.equal(await browser.connectBrowser({ browser: profiles[0] }), brave);
    assert.equal(await browser.connectBrowser({ browser: profiles[1] }), edge);
    assert.equal(brave.connected, true);
    assert.equal(edge.connected, true);
    assert.equal(servers.every((server) => server.clients.size === 1), true);
    const closed = [brave, edge].map((cdp) => new Promise((resolve) => cdp.once('disconnected', resolve)));
    browser.disconnectBrowser();
    await Promise.all(closed);
    assert.equal(calls.some(([, method]) => method === 'Browser.close'), false);
  } finally {
    browser.disconnectBrowser();
    for (const server of servers) {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
