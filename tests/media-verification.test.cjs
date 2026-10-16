const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const browser = require('../electron/browser-session.cjs');
const engine = require('../electron/engine.cjs');
const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');

test('stopping during output verification kills the verifier and cleans up cookies without success', { timeout: 3000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-verification-stop-'));
  const file = path.join(dir, 'pending.mp4');
  fs.writeFileSync(file, require('./fixtures/sample-media.cjs'));
  let ready;
  const verifying = new Promise((resolve) => { ready = resolve; });
  let jar;
  let killed = false;
  const verifier = {};
  const runImpl = (_args, options) => {
    jar = _args[_args.indexOf('--cookies') + 1];
    options.onLine('GRABFILE|' + file);
    return { stop() {}, done: Promise.resolve({ code: 0 }) };
  };
  const verifyImpl = () => {
    verifier.result = new Promise((resolve) => { verifier.stop = () => { killed = true; resolve({ ok: false, stopped: true }); }; });
    ready();
    return verifier;
  };
  const cookieRef = browser.rememberCookies([{ domain: '.fixture.example', path: '/', name: 'session', value: 'temporary', session: true }]);
  const handlers = mainHandlers({ download: (opts, progress) => engine.download(opts, progress, { runImpl, verifyImpl }) }, {});
  try {
    const pending = handlers.get('engine:start')({ sender }, { id: 'verify-stop', folder: dir, name: 'pending', format: 'mp4', url: 'https://fixture.example/video.mp4', cookieRef });
    await verifying;
    assert.equal(fs.existsSync(jar), true);
    handlers.get('engine:stop')({ sender }, 'verify-stop');
    const result = await pending;
    assert.equal(killed, true);
    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(jar), false);
  } finally { verifier.stop?.(); fs.rmSync(dir, { recursive: true, force: true }); }
});
