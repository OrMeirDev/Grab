const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../../extension/lib/protocol.js');
const { encodeFrame, FrameParser } = require('../../native-host/framing.cjs');
const { BrowserHub } = require('../../electron/browser/hub.cjs');
const { FakeBrowser } = require('../../test-support/fake-browser.cjs');

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grab-bridge-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('condition not reached');
}

async function setup(t, opts = {}) {
  const dir = tmp();
  const hub = new BrowserHub({ integrationDir: dir, allowedOrigins: [ORIGIN], appVersion: '9.9.9', ...opts });
  await hub.start();
  const browsers = [];
  const launch = (o = {}) => { const b = new FakeBrowser({ integrationDir: dir, origin: ORIGIN, ...o }); browsers.push(b); return b; };
  t.after(async () => { for (const b of browsers) b.kill(); hub.stop(); await sleep(50); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, hub, launch };
}

test('frame parser handles split frames, combined frames and byte-by-byte delivery', () => {
  const got = [];
  const parser = new FrameParser({ onMessage: (m) => got.push(m) });
  const a = encodeFrame({ n: 1, text: 'שלום' });
  const b = encodeFrame({ n: 2 });
  const all = Buffer.concat([a, b]);
  parser.push(all.subarray(0, 3)); // inside the length header
  parser.push(all.subarray(3, 9)); // inside the body
  parser.push(all.subarray(9));
  assert.deepEqual(got, [{ n: 1, text: 'שלום' }, { n: 2 }]);
  const again = [];
  const byByte = new FrameParser({ onMessage: (m) => again.push(m) });
  for (const byte of all) byByte.push(Buffer.from([byte]));
  assert.deepEqual(again, got);
  const together = [];
  new FrameParser({ onMessage: (m) => together.push(m) }).push(all);
  assert.equal(together.length, 2);
});

test('frame parser rejects malformed JSON, continues, and stops for good on an oversize length', () => {
  const messages = [];
  const errors = [];
  const parser = new FrameParser({ max: 64, onMessage: (m) => messages.push(m), onError: (e) => errors.push(e.code) });
  const bad = Buffer.from('not json');
  const header = Buffer.alloc(4); header.writeUInt32LE(bad.length, 0);
  parser.push(Buffer.concat([header, bad, encodeFrame({ ok: true })]));
  assert.deepEqual(messages, [{ ok: true }]);
  assert.deepEqual(errors, ['malformed']);
  const huge = Buffer.alloc(4); huge.writeUInt32LE(65, 0);
  parser.push(huge);
  parser.push(encodeFrame({ after: true }));
  assert.deepEqual(errors, ['malformed', 'oversize']);
  assert.equal(messages.length, 1);
  assert.throws(() => encodeFrame({ x: 'y'.repeat(100) }, 64), /too large/i);
  const arrays = [];
  new FrameParser({ onError: (e) => arrays.push(e.code) }).push(encodeFrame([1, 2]));
  assert.deepEqual(arrays, ['malformed']);
});

test('protocol validation checks version, ids, direction, types and URL schemes', () => {
  assert.equal(protocol.validate(protocol.make('page-session-request', { jobId: 'p1', url: 'https://www.youtube.com/watch?v=fixture123' }), 'app').ok, true);
  assert.equal(protocol.validate(protocol.make('page-session-request', { jobId: 'p1', url: 'file:///private' }), 'app').ok, false);
  assert.equal(protocol.validate(protocol.make('page-session-request', { jobId: 'p1', url: 'https://www.youtube.com/' }), 'ext').ok, false);
  const good = protocol.make('discover', { jobId: 'j1', url: 'https://example.test/p', deadlineMs: 60000 });
  assert.equal(protocol.validate(good, 'app').ok, true);
  assert.equal(protocol.validate(good, 'ext').error, 'wrong_direction');
  assert.equal(protocol.validate({ ...good, v: 2 }, 'app').error, 'version');
  assert.equal(protocol.validate({ ...good, id: '' }, 'app').error, 'bad_id');
  assert.equal(protocol.validate({ ...good, type: 'exec' }, 'app').error, 'unknown_type');
  assert.equal(protocol.validate({ ...good, url: 'file:///c:/x' }, 'app').ok, false);
  assert.equal(protocol.validate({ ...good, url: 'javascript:alert(1)' }, 'app').ok, false);
  assert.equal(protocol.validate({ ...good, deadlineMs: 1e9 }, 'app').ok, false);
  const many = Array.from({ length: 41 }, (_, i) => ({ url: 'https://c.test/' + i + '.mp4', kind: 'file' }));
  assert.equal(protocol.validate(protocol.make('candidates', { jobId: 'j', candidates: many, final: true }), 'ext').ok, false);
  assert.equal(protocol.validate(protocol.make('candidates', { jobId: 'j', candidates: many.slice(0, 2), final: true }), 'ext').ok, true);
  assert.equal(protocol.validate(protocol.make('send-to-grab', { url: 'blob:https://x/1' }), 'ext').ok, false);
});

test('a browser reaches the app through the real host: hello, welcome, messages both ways', async (t) => {
  const { hub, launch } = await setup(t);
  const seen = [];
  hub.on('message', (inst, m) => seen.push([inst, m]));
  const browser = launch({ alias: 'Work' });
  await browser.waitFor((m) => m.type === 'app-status' && m.online === true);
  browser.hello();
  const welcome = await browser.waitFor((m) => m.type === 'welcome');
  assert.equal(welcome.appVersion, '9.9.9');
  const [instance] = await until(() => hub.instances().length && hub.instances());
  assert.equal(instance.browser, 'edge');
  assert.equal(instance.alias, 'Work');
  assert.equal(instance.key, `edge:${browser.instanceId}`);
  browser.write(protocol.make('progress', { jobId: 'j1', state: 'opening' }));
  await until(() => seen.length);
  assert.equal(seen[0][1].type, 'progress');
  assert.equal(seen[0][0].key, instance.key);
  assert.equal(hub.sendTo(instance.key, 'cancel', { jobId: 'j1' }), true);
  assert.equal((await browser.waitFor((m) => m.type === 'cancel')).jobId, 'j1');
  assert.equal(browser.nonFrameStdout, false, 'host stdout carried only protocol frames');
});

test('host rejects an unknown extension origin and the app records the setup failure', async (t) => {
  const { hub } = await setup(t);
  const wrong = new FakeBrowser({ integrationDir: hub.integrationDir, origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/' });
  t.after(() => wrong.kill());
  const err = await wrong.waitFor((m) => m.type === 'error' && m.code === 'host_rejected');
  assert.ok(err);
  assert.equal(hub.instances().length, 0);
  assert.equal(hub.failures[0].code, 'origin_mismatch');
});

test('a pipe client without the token is dropped before it can say anything', async (t) => {
  const { hub, dir } = await setup(t);
  const net = require('node:net');
  const { pipePath } = require('../../native-host/ipc-paths.cjs');
  const sock = net.connect(pipePath(dir));
  await new Promise((r) => sock.once('connect', r));
  sock.resume();
  sock.write(encodeFrame({ type: 'host-hello', proof: 'x'.repeat(64), origin: ORIGIN, browserKind: 'edge' }));
  await new Promise((r) => sock.once('close', r));
  assert.equal(hub.instances().length, 0);
});

test('native host does not trust an unauthenticated desktop or forward queued browser data to it', async (t) => {
  const net = require('node:net');
  const { pipePath, ensureToken } = require('../../native-host/ipc-paths.cjs');
  const dir = tmp();
  ensureToken(dir);
  const received = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.write(encodeFrame({ type: 'challenge', nonce: 'a'.repeat(32) }));
    const parser = new FrameParser({ onMessage: (m) => {
      received.push(m);
      if (m.type === 'host-hello') {
        // Knowing the host's challenge response does not give this false desktop its own proof.
        sock.write(encodeFrame({ type: 'ready', proof: m.proof }));
        sock.write(encodeFrame({ type: 'relay', message: protocol.make('ping') }));
      }
    } });
    sock.on('data', (d) => parser.push(d));
  });
  await new Promise((resolve) => server.listen(pipePath(dir), resolve));
  const browser = new FakeBrowser({ integrationDir: dir, origin: ORIGIN });
  t.after(async () => {
    await browser.kill();
    for (const sock of sockets) sock.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  browser.write(protocol.make('send-to-grab', { url: 'https://private.test/video?session=fixture' }));
  await until(() => received.some((m) => m.type === 'host-hello'));
  await browser.waitFor((m) => m.type === 'app-status' && !m.online);
  assert.ok(!browser.received.some((m) => m.type === 'app-status' && m.online));
  assert.ok(!browser.received.some((m) => m.type === 'ping'), 'commands from the false desktop never reach the extension');
  assert.deepEqual(received.map((m) => m.type), ['host-hello'], 'queued browsing data is not disclosed');
});

test('invalid extension messages get an error reply; wrong protocol version is a recorded failure', async (t) => {
  const { hub, launch } = await setup(t);
  const browser = launch({});
  await browser.waitFor((m) => m.type === 'app-status' && m.online);
  browser.write({ v: 1, id: 'abc', type: 'progress', jobId: 'j1', state: 'opening' }); // before hello
  assert.equal((await browser.waitFor((m) => m.type === 'error' && m.code === 'hello_required')).replyTo, 'abc');
  browser.write({ ...protocol.make('hello', { instanceId: 'i1', extVersion: '1', protocol: 1 }), v: 7 });
  await browser.waitFor((m) => m.type === 'error' && m.code === 'protocol_version');
  browser.write(protocol.make('hello', { instanceId: 'i1', extVersion: '1', protocol: 2 }));
  await until(() => hub.failures.filter((f) => f.code === 'protocol_version').length >= 2);
  assert.equal(hub.instances().length, 0);
});

test('lifecycle: browser started first (GRAB not running), GRAB starts later, the host connects by itself', async (t) => {
  const dir = tmp();
  const browser = new FakeBrowser({ integrationDir: dir, origin: ORIGIN });
  t.after(async () => { browser.kill(); await sleep(50); fs.rmSync(dir, { recursive: true, force: true }); });
  const offline = await browser.waitFor((m) => m.type === 'app-status');
  assert.equal(offline.online, false);
  const hub = new BrowserHub({ integrationDir: dir, allowedOrigins: [ORIGIN] });
  t.after(() => hub.stop());
  await hub.start();
  await browser.waitFor((m) => m.type === 'app-status' && m.online === true, 15000);
  browser.hello();
  await browser.waitFor((m) => m.type === 'welcome');
  assert.equal(hub.instances().length, 1);
});

test('lifecycle: app restart reconnects, host crash and extension reload drop and replace the instance', async (t) => {
  const { dir, hub, launch } = await setup(t);
  const first = launch({ instanceId: 'same-profile' });
  await first.waitFor((m) => m.type === 'app-status' && m.online);
  first.hello();
  await first.waitFor((m) => m.type === 'welcome');

  // Extension reload: a new host process for the same profile replaces the old one.
  const reloaded = launch({ instanceId: 'same-profile' });
  await reloaded.waitFor((m) => m.type === 'app-status' && m.online);
  reloaded.hello();
  await reloaded.waitFor((m) => m.type === 'welcome');
  assert.equal(hub.instances().length, 1);

  // Host crash: the instance disappears and listeners are told.
  let dropped = null;
  hub.on('disconnected', (i) => { dropped = i; });
  await reloaded.kill();
  await until(() => dropped);
  assert.equal(hub.instances().length, 0);
  assert.equal(hub.sendTo('edge:same-profile', 'cancel', { jobId: 'j' }), false);

  // App restart: a host that outlives the app reconnects to the new app instance on its own.
  const survivor = launch({ instanceId: 'survivor' });
  await survivor.waitFor((m) => m.type === 'app-status' && m.online);
  survivor.hello();
  await survivor.waitFor((m) => m.type === 'welcome');
  hub.stop();
  await until(() => survivor.received.filter((m) => m.type === 'app-status' && m.online === false).length >= 1);
  const hub2 = new BrowserHub({ integrationDir: dir, allowedOrigins: [ORIGIN] });
  t.after(() => hub2.stop());
  await hub2.start();
  await until(() => survivor.received.filter((m) => m.type === 'app-status' && m.online).length >= 2, 15000);
  survivor.hello();
  await until(() => hub2.instances().length === 1);
});

test('two instances never exchange messages, replies or waiters', async (t) => {
  const { hub, launch } = await setup(t);
  const a = launch({ instanceId: 'profile-a', browser: 'edge' });
  const b = launch({ instanceId: 'profile-b', browser: 'edge' });
  const c = launch({ instanceId: 'profile-a', browser: 'chrome' }); // same id in another browser is another instance
  for (const x of [a, b, c]) { await x.waitFor((m) => m.type === 'app-status' && m.online); x.hello(); await x.waitFor((m) => m.type === 'welcome'); }
  assert.equal(hub.instances().length, 3);
  hub.sendTo('edge:profile-a', 'cancel', { jobId: 'only-a' });
  await a.waitFor((m) => m.type === 'cancel');
  await sleep(150);
  assert.equal(b.received.some((m) => m.type === 'cancel'), false);
  assert.equal(c.received.some((m) => m.type === 'cancel'), false);

  // A reply from the wrong instance cannot satisfy another instance's request.
  const pending = hub.request('edge:profile-a', 'cookies-request', { jobId: 'j1', urls: ['https://x.test/'] }, { timeoutMs: 500 });
  const req = await a.waitFor((m) => m.type === 'cookies-request');
  b.write(protocol.make('cookies', { jobId: 'j1', cookies: [{ name: 'n', value: 'stolen', domain: 'x.test' }] }, req.id));
  await assert.rejects(pending, { code: 'timeout' });
  const ok = hub.request('edge:profile-a', 'cookies-request', { jobId: 'j1', urls: ['https://x.test/'] }, { timeoutMs: 3000 });
  const req2 = await a.waitFor((m) => m.type === 'cookies-request' && m.id !== req.id);
  a.write(protocol.make('cookies', { jobId: 'j1', cookies: [{ name: 'n', value: 'mine', domain: 'x.test' }] }, req2.id));
  assert.equal((await ok).cookies[0].value, 'mine');
});

test('host exits cleanly when the browser closes the port, and on an oversize frame', async (t) => {
  const { launch } = await setup(t);
  const closed = launch({});
  await closed.waitFor((m) => m.type === 'app-status');
  assert.equal(await closed.close(), 0);
  const flooded = launch({});
  await flooded.waitFor((m) => m.type === 'app-status');
  const header = Buffer.alloc(4); header.writeUInt32LE(2 * 1024 * 1024, 0);
  flooded.writeRaw(header);
  assert.equal(await flooded.exited, 0);
});

test('waitFor resolves when the instance appears, and rejects on timeout and abort', async (t) => {
  const { hub, launch } = await setup(t);
  await assert.rejects(hub.waitFor((i) => i.browser === 'edge', { timeoutMs: 100 }), { code: 'timeout' });
  const controller = new AbortController();
  const aborted = hub.waitFor((i) => i.browser === 'edge', { timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { code: 'cancelled' });
  const waiting = hub.waitFor((i) => i.browser === 'brave', { timeoutMs: 5000 });
  const brave = launch({ browser: 'brave' });
  await brave.waitFor((m) => m.type === 'app-status' && m.online);
  brave.hello();
  assert.equal((await waiting).browser, 'brave');
});
