const test = require('node:test');
const assert = require('node:assert/strict');
const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');

test('private metadata is bounded, expiring and never interchangeable with a cookie handle', async () => {
  let now = 0;
  const vault = new CookieVault({ now: () => now, ttlMs: 10, maxMetadataBytes: 16, maxMetadataEntries: 2 });
  const ref = vault.rememberMetadata('synthetic-secret');
  assert.notEqual(ref, 'synthetic-secret');
  assert.equal(vault.readMetadata(ref), 'synthetic-secret');
  assert.equal(vault.has(ref), false);
  await assert.rejects(vault.withJar(ref, () => assert.fail('metadata must not be accepted as a cookie session')), { kind: 'contextExpired' });
  assert.throws(() => vault.rememberMetadata('other'), /budget/);
  now = 11;
  assert.equal(vault.readMetadata(ref), undefined);
  const replacement = vault.rememberMetadata('new');
  vault.forgetMetadata(replacement);
  assert.equal(vault.metadataBytes, 0);
  vault.rememberMetadata('one'); vault.rememberMetadata('two');
  assert.throws(() => vault.rememberMetadata('three'), /budget/);
  vault.clear();
  assert.equal(vault.metadata.size, 0);
  assert.equal(vault.metadataBytes, 0);
});

test('empty cookie snapshots still bind metadata to the right concurrent browser/profile', async () => {
  const vault = new CookieVault();
  const first = vault.remember([], { source: 'extension:chrome:first' });
  const second = vault.remember([], { source: 'extension:brave:second' });
  const refs = await Promise.all([first, second].map((parent, i) => vault.withJar(parent, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return vault.rememberMetadata('private-profile-' + i);
  })));
  vault.forgetSource('extension:chrome:first');
  assert.equal(vault.readMetadata(refs[0]), undefined);
  assert.equal(vault.readMetadata(refs[1]), 'private-profile-1');
  vault.forget(second);
  assert.equal(vault.readMetadata(refs[1]), undefined);
  assert.equal(vault.metadataBytes, 0);
});

test('browser-session expiry invalidates younger metadata immediately', async () => {
  let now = 0;
  const vault = new CookieVault({ now: () => now, ttlMs: 10 });
  const session = vault.remember([]);
  now = 9;
  const ref = await vault.withJar(session, async () => vault.rememberMetadata('rotated-secret'));
  now = 11;
  assert.equal(vault.readMetadata(ref), undefined);
  assert.equal(vault.metadataBytes, 0);
});
