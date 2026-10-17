// The shipped worker's discovery job on a fake clock: no browser call may hold a job until its
// deadline without saying where it was. Tabs, scripting and storage are scripted per test; the job
// logic (findExistingTab, gather, waitTabComplete, runJob, startJob) is the real extension code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../../extension/lib/protocol.js');

const PAGE = 'https://www.example.test/vod/episode-1';
const MEDIA = 'https://cdn.example.test/vod/master.m3u8';
const TEMP_TAB = 900;
const never = () => new Promise(() => {});
// What collectInPage returns for one frame of a page with a player exposing MEDIA.
const playerFrame = () => [{ frameId: 0, result: { pageUrl: PAGE, media: [MEDIA], players: 1, playing: 1, playRejected: 0, blobPlayers: 0, drm: false, title: 'Episode', embeds: [] } }];

function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  class FakeDate extends Date { static now() { return now; } }
  return {
    Date: FakeDate,
    now: () => now,
    setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    flush,
    // Runs due timers in time order, letting the worker's promise chains settle between them.
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
      await flush();
    },
  };
}

// browser: { tabs: [...existing], query(), create(), tabStatus(tabId), executeScript(tabId) }
async function loadWorker(browser) {
  const clock = fakeClock();
  const sent = [];
  const calls = { executeScript: [], removed: [], updated: [], created: [] };
  let receive;
  const event = () => ({ addListener() {} });
  const memory = () => {
    const data = new Map();
    return {
      get: async (keys) => {
        const list = keys == null ? [...data.keys()] : [].concat(keys);
        return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      },
      set: async (items) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); },
      remove: async (keys) => { for (const k of [].concat(keys)) data.delete(k); },
    };
  };
  const context = vm.createContext({
    console, URL, crypto: require('node:crypto').webcrypto, structuredClone,
    Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: () => 0, clearInterval() {},
    navigator: { userAgent: 'Browser UA' },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }), onMessage: event(), onStartup: event(), onInstalled: event(),
        connectNative: () => ({ postMessage: (m) => sent.push({ at: clock.now(), ...m }), onMessage: { addListener: (fn) => { receive = fn; } }, onDisconnect: event() }) },
      storage: { local: memory(), session: memory() },
      alarms: { create() {}, onAlarm: event() },
      tabs: {
        onRemoved: event(),
        query: async () => (browser.query ? browser.query() : structuredClone(browser.tabs || [])),
        create: async (opts) => { calls.created.push(opts); return browser.create ? browser.create(opts) : { id: TEMP_TAB, status: 'loading' }; },
        get: async (tabId) => ({ id: tabId, status: browser.tabStatus ? browser.tabStatus(tabId) : 'complete' }),
        update: async (tabId, patch) => { calls.updated.push([tabId, patch]); return { id: tabId }; },
        remove: async (tabId) => { calls.removed.push(tabId); },
      },
      windows: { update: async () => ({}) },
      scripting: { executeScript: (opts) => { calls.executeScript.push(opts.target.tabId); return browser.executeScript(opts.target.tabId); } },
      cookies: { getAll: async () => [] },
      webNavigation: { onCommitted: event() },
      webRequest: Object.fromEntries(['onBeforeRedirect', 'onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map((name) => [name, event()])),
    },
  });
  context.self = context;
  const dir = path.join(__dirname, '../../extension');
  context.importScripts = (...names) => { for (const name of names) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), context);
  await clock.flush();
  receive(P.make('welcome', { protocol: P.PROTOCOL_VERSION, appVersion: 'test' }));
  const started = clock.now();
  const discover = (deadlineMs = 60000) => {
    const m = P.make('discover', { jobId: 'job1', url: PAGE, deadlineMs });
    assert.equal(P.validate(m, 'app').ok, true);
    receive(m);
  };
  const outcome = () => sent.find((m) => m.jobId === 'job1' && (m.type === 'candidates' || m.type === 'job-failed'));
  return { clock, sent, calls, discover, outcome, elapsed: (m) => m.at - started };
}

const existingTab = (extra) => ({ id: 5, url: PAGE, status: 'complete', discarded: false, lastAccessed: 10, ...extra });

for (const [label, tab] of [
  ['discarded (sleeping) tab', existingTab({ discarded: true })],
  ['session-restored tab that is still loading', existingTab({ status: 'unloaded' })],
  ['frozen tab', existingTab({ frozen: true })],
]) {
  test(`an existing ${label} of the page is not scripted; the job uses its own temporary tab`, async () => {
    const w = await loadWorker({ tabs: [tab], executeScript: async (tabId) => (tabId === TEMP_TAB ? playerFrame() : never()) });
    w.discover();
    await w.clock.advance(10000);
    const out = w.outcome();
    assert.equal(out?.type, 'candidates', JSON.stringify(w.sent.map((m) => m.type)));
    assert.equal(out.candidates[0].url, MEDIA);
    assert.equal(w.calls.executeScript.includes(5), false, 'the restored/sleeping tab is never scripted');
    assert.deepEqual(w.calls.removed, [TEMP_TAB], 'only the temporary tab is closed');
    assert.deepEqual(w.calls.updated, [], 'the user tab is never navigated or activated');
    assert.ok(w.elapsed(out) < 10000);
  });
}

test('a live existing tab that does not answer the scan falls through to the temporary tab within seconds', async () => {
  const w = await loadWorker({ tabs: [existingTab()], executeScript: async (tabId) => (tabId === TEMP_TAB ? playerFrame() : never()) });
  w.discover();
  await w.clock.advance(3900);
  assert.equal(w.calls.created.length, 0, 'still giving the existing tab its short chance');
  await w.clock.advance(200);
  assert.equal(w.calls.created.length, 1, 'the bounded scan expired and the temporary tab opened');
  assert.equal(w.calls.created[0].active, false);
  await w.clock.advance(6000);
  const out = w.outcome();
  assert.equal(out?.type, 'candidates');
  assert.ok(w.elapsed(out) < 11000, 'took ' + w.elapsed(out));
  assert.deepEqual(w.calls.executeScript.filter((id) => id === 5).length, 1, 'the user tab is scanned once, never reloaded');
  assert.deepEqual(w.calls.removed, [TEMP_TAB]);
});

test('a live existing tab that answers is still used without opening a temporary tab', async () => {
  const w = await loadWorker({ tabs: [existingTab()], executeScript: async () => playerFrame() });
  w.discover();
  await w.clock.advance(1000);
  assert.equal(w.outcome()?.type, 'candidates');
  assert.equal(w.calls.created.length, 0);
  assert.deepEqual(w.calls.removed, [], 'the existing tab is left alone');
});

test('a temporary tab whose load event never comes is scanned after the load cap, well before the deadline', async () => {
  const w = await loadWorker({ tabs: [], tabStatus: () => 'loading', executeScript: async () => playerFrame() });
  w.discover();
  await w.clock.advance(14000);
  assert.equal(w.calls.executeScript.length, 0, 'waits for load first');
  assert.equal(w.outcome(), undefined);
  await w.clock.advance(6000);
  const out = w.outcome();
  assert.equal(out?.type, 'candidates', JSON.stringify(w.sent.map((m) => m.type)));
  assert.ok(w.elapsed(out) >= 15000 && w.elapsed(out) < 20000, 'took ' + w.elapsed(out));
});

test('a job that runs out of time reports the stage it was stuck in', async (t) => {
  const stuck = (stage, deadlineMs, browser) => t.test(stage, async () => {
    const w = await loadWorker(browser);
    w.discover(deadlineMs);
    await w.clock.advance(deadlineMs);
    const failed = w.outcome();
    assert.equal(failed?.type, 'job-failed', JSON.stringify(w.sent.map((m) => m.type)));
    assert.equal(failed.reason, 'timeout');
    assert.equal(failed.stage, stage);
    assert.equal(w.elapsed(failed), deadlineMs - 1500, 'the job timer, not a step, ends it');
    const { at, ...message } = failed;
    assert.equal(P.validate(message, 'ext').ok, true);
    void at;
  });
  await stuck('locating', 10000, { query: never, executeScript: never });
  await stuck('opening', 10000, { tabs: [], create: never, executeScript: never });
  await stuck('waiting_load', 10000, { tabs: [], tabStatus: () => 'loading', executeScript: never });
  // Scans that never answer are not mistaken for "no video": the job keeps trying until its deadline.
  await stuck('discovering', 60000, { tabs: [], executeScript: never });
});

test('job-failed accepts only the known stages', () => {
  const base = { jobId: 'job1', reason: 'timeout' };
  assert.equal(P.validate(P.make('job-failed', base), 'ext').ok, true, 'older extensions send no stage');
  for (const stage of P.JOB_STAGES) assert.equal(P.validate(P.make('job-failed', { ...base, stage }), 'ext').ok, true);
  for (const stage of ['playing', 'https://x.test/', '', 3]) assert.equal(P.validate(P.make('job-failed', { ...base, stage }), 'ext').ok, false);
});
