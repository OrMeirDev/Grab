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
    assert.ok(raw.includes('https://media.example'));
    for (const secret of ['account-123','signed-token','auth=','token=secret','/private/']) assert.equal(raw.includes(secret), false, secret);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostic allowlist rejects arbitrary error strings and unknown fields', () => {
  const { safeEventDetails } = require('../electron/infrastructure/diagnostics.cjs');
  const data = safeEventDetails('lookup', { url: 'https://media.example/id-777', error: 'bearer secret', profile: 'alice', kind: 'blocked', strategy: 'yt-dlp', ms: 30, cookies: ['secret'] });
  assert.deepEqual(data, { url: 'https://media.example', kind: 'blocked', strategy: 'yt-dlp', ms: 30 });
});

test('persistent history excludes signed URLs, including older records', async () => {
  const { HistoryRepository } = require('../electron/infrastructure/repositories.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-history-private-'));
  const signed = 'https://media.example/watch?token=sensitive-private-token';
  try {
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([
      { url: signed, name: 'old sensitive' },
      { url: 'https://media.example/public', name: 'public' },
    ]));
    const h = new HistoryRepository(dir);
    const rows = await h.all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'public');
    assert.equal(await h.add({ url: signed, name: 'new sensitive' }), null);
    assert.equal((await h.all()).length, 1);
    const onDisk = fs.readFileSync(path.join(dir, 'history.json'), 'utf8');
    assert.equal(onDisk.includes('sensitive-private-token'), false);
    assert.equal(fs.existsSync(path.join(dir, 'history.json.bak')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('free-text URL redaction removes embedded path identifiers', () => {
  const { stripLinksInText } = require('../electron/domain/secrets.cjs');
  assert.equal(stripLinksInText('403 https://media.example/user-123/hdntl=abc/master.m3u8?signature=x'), '403 https://media.example');
});

test('JSON state files use restrictive permissions on POSIX', async () => {
  const { JsonStore } = require('../electron/infrastructure/json-store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-private-store-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = new JsonStore(file, { fallback: {} });
    await store.save({ a: 1 });
    await store.save({ a: 2 });
    if (process.platform !== 'win32') {
      for (const target of [file, file + '.bak']) {
        assert.equal(fs.statSync(target).mode & 0o077, 0, target + ' must not be accessible to group or other users');
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostics restrict existing directories and rotated logs and refuse a symlink directory', () => {
  const { Diagnostics } = require('../electron/infrastructure/diagnostics.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-log-migration-'));
  try {
    const dir = path.join(root, 'logs'); fs.mkdirSync(dir, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'diagnostics.log.1'), 'old', { mode: 0o644 });
    new Diagnostics({ dir }).record('start', {});
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dir).mode & 0o077, 0);
      assert.equal(fs.statSync(path.join(dir, 'diagnostics.log.1')).mode & 0o077, 0);
      const link = path.join(root, 'link'); fs.symlinkSync(dir, link);
      const before = fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8');
      new Diagnostics({ dir: link }).record('start', {});
      assert.equal(fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8'), before);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('startup sanitizes legacy and rotated diagnostics before the first new event, without raw backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-legacy-diagnostics-'));
  try {
    const at = '2026-10-16T12:34:56.000Z';
    const legacy = JSON.stringify({ at, event: 'lookup', url: 'https://alice:credential@media.test/private/account-73/clip?token=legacy-secret#frag',
      ok: true, ms: 12, kind: 'found', error: 'Bearer legacy-secret', headers: { Authorization: 'legacy-secret' }, profile: 'account-73' });
    for (const name of ['diagnostics.log', 'diagnostics.log.1', 'diagnostics.log.2']) {
      fs.writeFileSync(path.join(dir, name), legacy + '\nnot JSON: legacy-secret\n' + JSON.stringify({ event: 'constructor', at: 'legacy-secret' }) + '\n');
    }
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'untouched');
    const migrated = new Diagnostics({ dir });
    assert.equal(migrated.migrationComplete, true);
    const before = new Map();
    for (const name of ['diagnostics.log', 'diagnostics.log.1', 'diagnostics.log.2']) {
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, 'utf8');
      assert.deepEqual(text.trim().split('\n').map(JSON.parse), [
        { at, event: 'lookup', url: 'https://media.test', kind: 'found', ms: 12, ok: true }, { event: 'unknown' },
      ]);
      for (const value of ['legacy-secret', 'credential', 'account-73', 'token=', '#frag', 'Bearer', 'headers', 'profile']) assert.equal(text.includes(value), false, value);
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
      before.set(name, text);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['diagnostics.log', 'diagnostics.log.1', 'diagnostics.log.2', 'unrelated.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'untouched');
    assert.equal(new Diagnostics({ dir }).migrationComplete, true);
    for (const [name, text] of before) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text, 'migration is idempotent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('startup drops oversized legacy diagnostics and unlinks log symlinks without rewriting their targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-log-boundary-'));
  try {
    const dir = path.join(root, 'logs'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'diagnostics.log'), 'legacy-secret'.repeat(100000));
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'external-canary');
    if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(dir, 'diagnostics.log.1'));
    const d = new Diagnostics({ dir });
    assert.equal(d.migrationComplete, true);
    assert.equal(fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8'), '');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'external-canary');
    d.record('start', { app: '1.7.0' });
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8'), /legacy-secret/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an incomplete migration disables disk append and retries after the obstruction is removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-log-retry-'));
  try {
    const obstacle = path.join(dir, 'diagnostics.log.1'); fs.mkdirSync(obstacle);
    const d = new Diagnostics({ dir });
    assert.equal(d.migrationComplete, false);
    d.record('start', { app: '1.7.0' });
    assert.equal(fs.existsSync(path.join(dir, 'diagnostics.log')), false);
    assert.equal(d.recent().length, 1, 'memory diagnostics remain available');
    fs.rmdirSync(obstacle);
    d.record('start', { app: '1.7.0' });
    assert.equal(d.migrationComplete, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8')).app, '1.7.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
