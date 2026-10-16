const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Diagnostics, redact, redactUrl } = require('../electron/infrastructure/diagnostics.cjs');

test('diagnostics redact path identifiers, credentials, query strings and fragments', () => {
  assert.equal(redactUrl('https://alice:password@media.example/private/user-123/stream.m3u8?token=sensitive#fragment'), 'https://media.example');
  assert.equal(redactUrl('https://media.example:8443/hdntl=secret/movie.m3u8'), 'https://media.example:8443');
  assert.equal(redactUrl('file:///C:/sensitive'), null);
  assert.deepEqual(redact({ url: 'https://media.example/u/123?id=private', cookie: 'secret', requestContext: { userAgent: 'x' } }), { url: 'https://media.example' });
  assert.equal(redact('Failed on https://media.example/path/account-123?token=secret'), 'Failed on https://media.example');
});

test('diagnostic files never contain sensitive URL paths or tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-diagnostics-'));
  try {
    const d = new Diagnostics({ dir });
    d.record('lookup', { url: 'https://media.example/private/account-123?token=secret', error: 'Error at https://media.example/hdntl=signed-token/index.m3u8?auth=secret' });
    const raw = fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8');
    assert.match(raw, /https:\\/\\/media\\.example/);
    for (const secret of ['account-123','signed-token','auth=','token=secret','/private/']) assert.equal(raw.includes(secret), false, secret);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
