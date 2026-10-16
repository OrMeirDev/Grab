const test = require('node:test');
const assert = require('node:assert/strict');
const { browserKind } = require('../../native-host/browser-kind.cjs');

for (const kind of ['chrome', 'brave', 'edge']) {
  test(`shared Chromium launcher attributes the real ancestor to ${kind}`, async () => {
    const out = await browserKind({ declared: 'chromium', platform: 'win32', parentPid: 123,
      exec: (exe, args, opts, done) => {
        assert.match(exe, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
        assert.match(args.at(-1), /\$ancestorId = 123/);
        assert.match(args.at(-1), /Get-CimInstance Win32_Process/);
        assert.ok(opts.timeout <= 4000 && opts.maxBuffer <= 1024);
        done(null, kind + '\r\n');
      } });
    assert.equal(out, kind);
  });
}
for (const response of ['unknown', 'Chrome UA', '', 'brave.exe']) {
  test(`an unidentified shared launcher never falls back to Chrome (${JSON.stringify(response)})`, async () => {
    assert.equal(await browserKind({ declared: 'chromium', platform: 'win32', parentPid: 123,
      exec: (_exe, _args, _opts, done) => done(null, response) }), 'unknown');
  });
}
test('failed ancestry lookup stays unknown; explicit dedicated launchers retain their identity', async () => {
  assert.equal(await browserKind({ declared: 'chromium', platform: 'win32', parentPid: 123,
    exec: (_exe, _args, _opts, done) => done(new Error('timeout')) }), 'unknown');
  for (const declared of ['edge', 'chrome', 'brave']) assert.equal(await browserKind({ declared, exec: () => assert.fail('dedicated/test launcher needs no ancestry lookup') }), declared);
});
