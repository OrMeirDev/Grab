const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const browser = require('../electron/browser-session.cjs');
const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');

test('stopping during output verification kills the verifier and cleans up cookies without success', { timeout: 3000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-verification-stop-'));
  const file = path.join(dir, 'pending.mp4');
  fs.writeFileSync(file, 'fixture pending verification');
  const entry = path.join(__dirname, '../electron/engine.cjs');
  const nativeRequire = createRequire(entry);
  let ready;
  const verifying = new Promise((resolve) => { ready = resolve; });
  let probe;
  let jar;
  const spawn = (exe, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit('close', null); };
    if (path.basename(exe).startsWith('ffprobe')) { probe = child; ready(); }
    else {
      jar = args[args.indexOf('--cookies') + 1];
      process.nextTick(() => { child.stdout.end(`GRABFILE|${file}\n`); child.stderr.end(); child.emit('close', 0); });
    }
    return child;
  };
  const sandbox = {
    module: { exports: {} }, process, __dirname: path.dirname(entry), setTimeout, clearTimeout,
    require: (name) => name === 'child_process' ? { spawn } : nativeRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), sandbox, { filename: entry });
  const cookieRef = browser.rememberCookies([{ domain: '.fixture.example', path: '/', name: 'session', value: 'temporary', session: true }]);
  const handlers = mainHandlers(sandbox.module.exports, {});
  try {
    const pending = handlers.get('engine:start')({ sender }, { id: 'verify-stop', folder: dir, name: 'pending', format: 'mp4', url: 'https://fixture.example/video.mp4', cookieRef });
    await verifying;
    assert.equal(fs.existsSync(jar), true);
    handlers.get('engine:stop')({ sender }, 'verify-stop');
    const result = await pending;
    assert.equal(probe.killed, true);
    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(jar), false);
  } finally { probe?.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
