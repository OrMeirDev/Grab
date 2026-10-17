const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../../extension/lib/protocol.js');
const { BrowserHub } = require('../../electron/browser/hub.cjs');
const { discover, BrowserError } = require('../../electron/browser/discovery.cjs');
const { pickInstance } = require('../../electron/browser/selection.cjs');
const { FakeBrowser } = require('../../test-support/fake-browser.cjs');

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cand = (url, extra = {}) => ({ url, kind: 'hls', size: 0, at: Date.now(), ...extra });
const settings = { connectMs: 600, launchGraceMs: 600, discoveryMs: 1500 };

async function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-disc-'));
  const hub = new BrowserHub({ integrationDir: dir, allowedOrigins: [ORIGIN] });
  await hub.start();
  const made = [];
  const connect = async (o = {}) => {
    const b = new FakeBrowser({ integrationDir: dir, origin: ORIGIN, ...o });
    made.push(b);
    await b.waitFor((m) => m.type === 'app-status' && m.online);
    b.hello();
    await b.waitFor((m) => m.type === 'welcome');
    return b;
  };
  t.after(async () => { for (const b of made) b.kill(); hub.stop(); await sleep(50); fs.rmSync(dir, { recursive: true, force: true }); });
  const getInstance = (browserId = 'edge', st = {}) => () => pickInstance({ browserId, instances: hub.instances(), settings: st });
  return { hub, connect, getInstance };
}
const edge = { id: 'edge', name: 'Microsoft Edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' };

// Scripted extension behaviour on top of the real host and hub.
const respond = (b, handler) => { b.child.stdout.on('data', () => {}); const seen = new Set(); const tick = setInterval(() => { for (const m of b.received) if (m.type === 'discover' && !seen.has(m.id)) { seen.add(m.id); handler(m); } }, 10); b.exited.then(() => clearInterval(tick)); return () => clearInterval(tick); };

test('discovery returns the extension candidates for the chosen instance', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  respond(b, (m) => {
    b.write(protocol.make('progress', { jobId: m.jobId, state: 'opening' }));
    b.write(protocol.make('candidates', { jobId: m.jobId, final: true, title: 'פרק 1', candidates: [cand('https://cdn.test/master.m3u8?sig=a%2Bb&exp=1')] }));
  });
  const phases = [];
  const r = await discover({ hub, browser: edge, url: 'https://www.mako.co.il/x', getInstance: getInstance(), settings, onPhase: (p) => phases.push(p) });
  assert.equal(r.candidates[0].url, 'https://cdn.test/master.m3u8?sig=a%2Bb&exp=1', 'signed URL untouched');
  assert.equal(r.title, 'פרק 1');
  assert.deepEqual(phases.slice(0, 2), ['connecting', 'discovering']);
  assert.equal(hub.listenerCount('message'), 0, 'listeners released after settle');
});

test('browser initially closed: Grab launches it once, then connects when the extension appears', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  let launched = [];
  const deps = {
    isRunning: async () => false,
    launch: (exe) => { launched.push(exe); setTimeout(async () => { const b = await connect(); respond(b, (m) => b.write(protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/a.m3u8')] }))); }, 150); },
  };
  const r = await discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings, deps });
  assert.deepEqual(launched, [edge.exe]);
  assert.equal(r.candidates.length, 1);
});

test('browser running but extension never connects: settles as extensionNotConnected, never launches a second browser', async (t) => {
  const { hub, getInstance } = await rig(t);
  const launched = [];
  const started = Date.now();
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings, deps: { isRunning: async () => true, launch: (e) => launched.push(e) } }),
    (e) => e instanceof BrowserError && e.kind === 'extensionNotConnected' && e.browserRunning === true);
  assert.deepEqual(launched, []);
  assert.ok(Date.now() - started < 3000);
});

test('browser not installed (no executable): browserUnavailable', async (t) => {
  const { hub, getInstance } = await rig(t);
  await assert.rejects(discover({ hub, browser: { id: 'edge', name: 'Edge', exe: null }, url: 'https://x.test/p', getInstance: getInstance(), settings, deps: { isRunning: async () => false, launch() {} } }), { kind: 'browserUnavailable' });
});

test('setup failure recorded by the hub is reported instead of a vague timeout', async (t) => {
  const { hub, getInstance } = await rig(t);
  hub.fail('origin_mismatch', 'wrong id', 'edge');
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings, deps: { isRunning: async () => true } }), { kind: 'hostSetupError', code: 'origin_mismatch' });
});

test('total discovery deadline is not extended by progress events', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  respond(b, (m) => {
    const t0 = setInterval(() => b.write(protocol.make('progress', { jobId: m.jobId, state: 'discovering' })), 100);
    b.exited.then(() => clearInterval(t0));
    setTimeout(() => clearInterval(t0), 5000);
  });
  const started = Date.now();
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings: { ...settings, discoveryMs: 700 } }), { kind: 'discoveryTimeout' });
  const took = Date.now() - started;
  assert.ok(took >= 600 && took < 1800, 'took ' + took);
  assert.equal((await b.waitFor((m) => m.type === 'cancel')).jobId.length > 0, true, 'extension told to stop and clean up');
});

test('playback required is surfaced and, at the deadline, reported as playbackRequired', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  respond(b, (m) => b.write(protocol.make('progress', { jobId: m.jobId, state: 'playback_required' })));
  const phases = [];
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings: { ...settings, discoveryMs: 500 }, onPhase: (p) => phases.push(p) }), { kind: 'playbackRequired' });
  assert.ok(phases.includes('playback_required'));
});

test('extension-reported failures map to explicit kinds', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  const reasons = ['no_video', 'protected', 'tab_failed'];
  let n = 0;
  respond(b, (m) => b.write(protocol.make('job-failed', { jobId: m.jobId, reason: reasons[n++] })));
  for (const kind of ['noVideo', 'protectedMedia', 'tabFailed']) {
    await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings }), { kind });
  }
});

test('cancel before connecting, while connecting and during discovery all settle with cancelled', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings, signal: pre.signal }), { kind: 'cancelled' });

  const mid = new AbortController();
  const waiting = discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings: { ...settings, connectMs: 5000 }, deps: { isRunning: async () => true }, signal: mid.signal });
  setTimeout(() => mid.abort(), 100);
  await assert.rejects(waiting, { kind: 'cancelled' });

  const b = await connect();
  respond(b, () => {});
  const late = new AbortController();
  const running = discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings: { ...settings, discoveryMs: 5000 }, signal: late.signal });
  await b.waitFor((m) => m.type === 'discover');
  late.abort();
  await assert.rejects(running, { kind: 'cancelled' });
  await b.waitFor((m) => m.type === 'cancel');
  assert.equal(hub.listenerCount('message'), 0);
});

test('a late result from a cancelled or old attempt is ignored', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  let first = null;
  respond(b, (m) => { if (!first) first = m; else b.write(protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/second.m3u8')] })); });
  const c1 = new AbortController();
  const one = discover({ hub, browser: edge, url: 'https://x.test/p', jobId: 'job-one', getInstance: getInstance(), settings: { ...settings, discoveryMs: 5000 }, signal: c1.signal });
  await b.waitFor((m) => m.type === 'discover');
  c1.abort();
  await assert.rejects(one, { kind: 'cancelled' });
  b.write(protocol.make('candidates', { jobId: 'job-one', final: true, candidates: [cand('https://cdn.test/stale.m3u8')] })); // late answer to the cancelled attempt
  const r = await discover({ hub, browser: edge, url: 'https://x.test/p', jobId: 'job-two', getInstance: getInstance(), settings });
  assert.equal(r.candidates[0].url, 'https://cdn.test/second.m3u8');
});

test('disconnect during discovery settles as browserDisconnected', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  respond(b, () => setTimeout(() => b.kill(), 50));
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings: { ...settings, discoveryMs: 5000 } }), { kind: 'browserDisconnected' });
});

test('two profiles: the chosen one is used, a missing remembered one is never replaced by another, several need a choice', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const a = await connect({ instanceId: 'prof-a' });
  const b = await connect({ instanceId: 'prof-b' });
  respond(a, (m) => a.write(protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/from-a.m3u8')] })));
  respond(b, (m) => b.write(protocol.make('candidates', { jobId: m.jobId, final: true, candidates: [cand('https://cdn.test/from-b.m3u8')] })));
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings }), { kind: 'choiceRequired' });
  const chosen = await discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance('edge', { browser: { instanceChoice: { edge: 'edge:prof-b' } } }), settings });
  assert.equal(chosen.candidates[0].url, 'https://cdn.test/from-b.m3u8');
  assert.equal(a.received.filter((m) => m.type === 'discover').length, 0, 'profile A never saw the job');
  const ghost = () => ({ problem: 'instance_disconnected', wanted: 'edge:prof-ghost', options: hub.instances() });
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: ghost, settings }), { kind: 'wrongProfile' });
  assert.equal(a.received.filter((m) => m.type === 'discover').length, 0);
});

test('a timeout names the extension job stage: from job-failed, or the last progress when the app timer ends it', async (t) => {
  const { hub, connect, getInstance } = await rig(t);
  const b = await connect();
  let mode = 'failed';
  respond(b, (m) => {
    if (mode === 'failed') b.write(protocol.make('job-failed', { jobId: m.jobId, reason: 'timeout', stage: 'waiting_load' }));
    else b.write(protocol.make('progress', { jobId: m.jobId, state: 'opening' }));
  });
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings }), { kind: 'discoveryTimeout', jobStage: 'waiting_load' });
  mode = 'silent';
  await assert.rejects(discover({ hub, browser: edge, url: 'https://x.test/p', getInstance: getInstance(), settings: { ...settings, discoveryMs: 500 } }), { kind: 'discoveryTimeout', jobStage: 'opening' });
});
