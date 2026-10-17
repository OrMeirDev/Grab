// Signed extractor metadata must only be cached in a directory owned by this user.
// Do not follow a pre-existing symlink or reuse a directory controlled by another user.
const fs = require('node:fs');
const { protectWindowsDirectory } = require('./windows-private-directory.cjs');

function ensurePrivateDir(dir, { create = true, platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') return false; }
  }
  try {
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (platform !== 'win32') {
      if (uid !== null && info.uid !== uid) return false;
      fs.chmodSync(dir, 0o700);
      if (fs.statSync(dir).mode & 0o077) return false;
    } else if (!protectWindowsDirectory(dir)) {
      return false;
    }
    return true;
  } catch { return false; }
}

module.exports = { ensurePrivateDir };
