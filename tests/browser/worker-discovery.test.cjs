// Exercise the shipped worker through native messages, with a controlled browser and clock.
// No real profile, registration, network connection or application data is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../../extension/lib/protocol.js');

const pageUrl = 'https://fixture.test/episode';
const mediaUrl = 'https://media.fixture.test/master.m3u8';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const dom = (url = mediaUrl) => [{ frameId: 0, result: { media: [url], pageUrl, title: 'Fixture', players: 1, playing: 1, playRejected: 0, blobPlayers: 0, drm: false, embeds: [] } }];

async function worker({ existing = [], status = 'complete', execute = async () => dom() } = {}) {
  let now = 1700000000000;
  let nextTimer = 0;
  let receive;
  const timers = new Map();
  const sent = [], scans = [], created = [], removed = [], updated = [];
  const data = { instanceId: 'fixture' };
  const event = () => {
    const listeners = [];
    return { addListener: (fn) => listeners.push(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)) };
  };
  const onRemoved = event();
  const storage = {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])),
    set: async (values) => Object.assign(data, values), remove: async (key) => { delete data[key]; },
  };
  const context = vm.createContext({
    console, URL, crypto: require('node:crypto').webcrypto, navigator: { userAgent: 'Fixture UA' },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    chrome: {
      runtime: { getManifest: () => require('../../extension/manifest.json'), onMessage: event(), onStartup: event(), onInstalled: event(),
        connectNative: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener: (fn) => { receive = fn; } }, onDisconnect: event() }) },
      storage: { local: storage, session: storage }, alarms: { create() {}, onAlarm: event() },
      tabs: {
        onRemoved, query: async () => existing,
        create: async (options) => { const tab = { id: 100 + created.length, ...options, status }; created.push(tab); return tab; },
        get: async (id) => existing.find((tab) => tab.id === id) || created.find((tab) => tab.id === id),
        remove: async (id) => { removed.push(id); onRemoved.emit(id); },
        update: async (...args) => { updated.push(args); },
      },
      scripting: { executeScript: (options) => { scans.push(options); return execute(options); } },
      webNavigation: { onCommitted: event() },
      webRequest: Object.fromEntries(['onBeforeRedirect', 'onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map((name) => [name, event()])),
    },
  });
  context.self = context;
  const dir = path.join(__dirname, '../../extension');
  context.importScripts = (...names) => { for (const name of names) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), context);
  await flush();
  receive(P.make('welcome', { protocol: P.PROTOCOL_VERSION, appVersion: 'test' }));
  return {
    sent, scans, created, removed, updated, data,
    start: (deadlineMs = 60000) => receive(P.make('discover', { jobId: 'fixture-job', url: pageUrl, deadlineMs })),
    cancel: () => receive(P.make('cancel', { jobId: 'fixture-job' })),
    async advance(ms) {
      await flush();
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

const candidates = (w) => w.sent.filter((m) => m.type === 'candidates');
const failures = (w) => w.sent.filter((m) => m.type === 'job-failed');
const userTab = (extra = {}) => ({ id: 7, url: pageUrl, status: 'loading', ...extra });

test('a stalled existing-tab injection falls back to an owned tab; late results are ignored', async () => {
  let resolveExisting;
  const w = await worker({ existing: [userTab()], execute: (options) => options.target.tabId === 7
    ? new Promise((resolve) => { resolveExisting = resolve; }) : Promise.resolve(dom()) });
  w.start();
  await w.advance(10000);
  assert.equal(candidates(w).length, 1);
  assert.equal(candidates(w)[0].candidates[0].url, mediaUrl);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].active, false);
  assert.deepEqual(w.removed, [100]);
  assert.deepEqual(w.updated, [], 'the user tab is never navigated or activated');
  assert.equal(w.scans.find((s) => s.target.tabId === 7).args[0].startPlayback, false);
  assert.ok(w.scans.every((s) => s.injectImmediately === true));
  resolveExisting(dom('https://late.fixture.test/ignored.mp4'));
  await w.advance(60000);
  assert.equal(candidates(w).length, 1);
  assert.equal(failures(w).length, 0);
});

test('discarded user tabs are left dormant while an owned background tab discovers media', async () => {
  const w = await worker({ existing: [userTab({ discarded: true })] });
  w.start();
  await w.advance(5000);
  assert.equal(candidates(w).length, 1);
  assert.ok(w.scans.every((s) => s.target.tabId !== 7));
  assert.deepEqual(w.removed, [100]);
  assert.deepEqual(w.updated, []);
});

test('a page that never finishes loading still gets player scans within the discovery budget', async () => {
  const w = await worker({ status: 'loading' });
  w.start();
  await w.advance(15000);
  assert.equal(candidates(w).length, 1);
  assert.equal(failures(w).length, 0);
  assert.ok(w.scans.every((s) => s.injectImmediately && s.args[0].startPlayback));
  assert.deepEqual(w.removed, [100]);
});

test('network observations survive a hung DOM scan without opening another tab', async () => {
  const w = await worker({ existing: [userTab()], execute: () => new Promise(() => {}) });
  w.data['t:7'] = { url: pageUrl, nav: 1, hosts: [], items: [{ url: mediaUrl, kind: 'hls', at: 1700000000000, frameId: 0, size: 0 }] };
  w.start();
  await w.advance(2000);
  assert.equal(candidates(w).length, 1);
  assert.equal(w.created.length, 0);
  assert.deepEqual(w.removed, []);
});

test('cancellation during scanning or owned-tab loading prevents further work', async () => {
  for (const { existing, status } of [{ existing: [userTab()], status: 'loading' }, { existing: [], status: 'loading' }, { existing: [], status: 'complete' }]) {
    const w = await worker({ existing, status, execute: () => new Promise(() => {}) });
    w.start();
    await w.advance(100);
    w.cancel();
    await w.advance(70000);
    assert.equal(candidates(w).length, 0);
    assert.equal(failures(w).length, 0);
    assert.deepEqual(w.removed, existing.length ? [] : [100]);
    assert.equal(w.created.length, existing.length ? 0 : 1);
    assert.equal(w.scans.length, existing.length || status === 'complete' ? 1 : 0);
  }
});

test('unresponsive DOM scans do not accumulate injections or misreport no-video before timeout', async () => {
  const w = await worker({ execute: () => new Promise(() => {}) });
  w.start(30000);
  await w.advance(35000);
  assert.equal(w.scans.length, 1, 'one pending browser injection is reused');
  assert.equal(candidates(w).length, 0);
  assert.equal(failures(w).length, 1);
  assert.equal(failures(w)[0].reason, 'timeout');
  assert.deepEqual(w.removed, [100]);
});
