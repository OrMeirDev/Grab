const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSettings } = require('../electron/domain/records.cjs');
const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');

test('automatic security update checks are on by default and can be disabled explicitly', () => {
  const defaults = { folder: '/test', format: 'mp4', quality: 'best' };
  assert.equal(normalizeSettings({}, defaults).automaticUpdateChecks, true);
  assert.equal(normalizeSettings({ automaticUpdateChecks: false }, defaults).automaticUpdateChecks, false);
  assert.equal(normalizeSettings({ automaticUpdateChecks: 'false' }, defaults).automaticUpdateChecks, true);
});

test('host-only cookies remain host-only when passed to yt-dlp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-host-cookie-'));
  try {
    const vault = new CookieVault({ tmpDir: dir });
    const ref = vault.remember([
      { domain: '.example.test', hostOnly: true, path: '/', name: 'HOST', value: 'secret', secure: true, session: true },
      { domain: 'example.test', hostOnly: false, path: '/', name: 'DOMAIN', value: 'secret', secure: true, session: true },
    ]);
    await vault.withJar(ref, (file) => {
      const rows = fs.readFileSync(file, 'utf8');
      assert.match(rows, /example\.test\tFALSE\t\/\tTRUE\t0\tHOST\tsecret/);
      assert.match(rows, /\.example\.test\tTRUE\t\/\tTRUE\t0\tDOMAIN\tsecret/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
