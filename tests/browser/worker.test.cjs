// Run the shipped worker and protocol in a worker-like VM. The native port is controlled;
// message handling is the real extension code, not FakeBrowser's automatic replies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../../extension/lib/protocol.js');

test('the actual worker answers a desktop connection check with a correlated pong', async () => {
  const sent = [];
  let receive;
  const event = () => ({ addListener() {} });
  const storage = { get: async () => ({ instanceId: 'personal' }), set: async () => {} };
  const context = vm.createContext({
    console, URL, crypto: require('node:crypto').webcrypto,
    navigator: { userAgent: 'Browser UA' },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    chrome: {
      runtime: { getManifest: () => ({ version: '1.1.2' }), onMessage: event(), onStartup: event(), onInstalled: event(),
        connectNative: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener: (fn) => { receive = fn; } }, onDisconnect: event() }) },
      storage: { local: storage, session: storage },
      alarms: { create() {}, onAlarm: event() }, tabs: { onRemoved: event() },
      webNavigation: { onCommitted: event() },
      webRequest: Object.fromEntries(['onBeforeRedirect', 'onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map((name) => [name, event()])),
    },
  });
  context.self = context;
  const dir = path.join(__dirname, '../../extension');
  context.importScripts = (...names) => { for (const name of names) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context); };
  vm.runInContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), context);
  await new Promise((r) => setImmediate(r));
  receive(P.make('welcome', { protocol: P.PROTOCOL_VERSION, appVersion: 'test' }));
  const ping = P.make('ping');
  receive(ping);
  const pong = sent.find((m) => m.replyTo === ping.id);
  assert.equal(pong?.type, 'pong', 'a live extension must answer the desktop test');
  assert.equal(P.validate(pong, 'ext').ok, true);
  const count = sent.length;
  receive({ ...P.make('ping'), v: 999 });
  assert.equal(sent.length, count, 'invalid protocol messages are still rejected');
});
