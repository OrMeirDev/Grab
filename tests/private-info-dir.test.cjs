const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensurePrivateDir } = require('../electron/infrastructure/private-info-dir.cjs');

test('signed metadata cache is created with restricted permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-info-safe-'));
  try {
    const dir = path.join(root, 'cache');
    assert.equal(ensurePrivateDir(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o077, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('signed metadata cache rejects ordinary files and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-info-unsafe-'));
  try {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'untrusted');
    assert.equal(ensurePrivateDir(file), false);
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link');
      fs.symlinkSync(root, link);
      assert.equal(ensurePrivateDir(link), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
