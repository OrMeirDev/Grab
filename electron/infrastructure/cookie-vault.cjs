// Cookies captured from a page's browser session, kept only as long as a job needs them (GRB-07).
//
// - A snapshot is held in memory under an opaque handle; the renderer never sees cookies or paths.
// - It expires (TTL_MS); using an expired or forgotten handle is an error (kind 'contextExpired'),
//   never a silent download without the user's session.
// - yt-dlp gets it as a temporary, domain-scoped Netscape cookie file in Grab's private temporary
//   folder (owner-only on POSIX; the per-user temporary folder on Windows), deleted when the run
//   ends, on quit, and, after a crash, the next time Grab starts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 4 * 60 * 60 * 1000;
const PREFIX = 'grab-cookies-';

const expired = (message = 'The page session expired; look the page up again') => Object.assign(new Error(message), { kind: 'contextExpired' });

class CookieVault {
  constructor({ tmpDir = os.tmpdir(), ttlMs = TTL_MS, now = () => Date.now() } = {}) {
    this.tmpDir = tmpDir;
    this.ttlMs = ttlMs;
    this.now = now;
    this.snapshots = new Map();
    this.activeDirs = new Set();
  }

  remember(cookies) {
    const reference = crypto.randomUUID();
    this.snapshots.set(reference, { cookies: Array.isArray(cookies) ? cookies : [], at: this.now() });
    this.prune();
    return reference;
  }

  prune() {
    for (const [key, value] of this.snapshots) if (this.now() - value.at > this.ttlMs) this.snapshots.delete(key);
  }

  forget(reference) { this.snapshots.delete(reference); }

  has(reference) {
    const s = this.snapshots.get(reference);
    return !!s && this.now() - s.at <= this.ttlMs;
  }

  // work(cookieFile | undefined). No handle: no cookies were captured, work runs without a jar.
  async withJar(reference, work) {
    if (!reference) return work(undefined);
    const snapshot = this.snapshots.get(reference);
    if (!snapshot || this.now() - snapshot.at > this.ttlMs) {
      this.snapshots.delete(reference);
      throw expired();
    }
    const lines = snapshot.cookies.filter((c) => c && typeof c.domain === 'string' && ![c.domain, c.path, c.name, c.value].some((v) => /[\t\r\n]/.test(v || ''))).map((c) => [
      (c.httpOnly ? '#HttpOnly_' : '') + c.domain,
      c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/',
      c.secure ? 'TRUE' : 'FALSE', c.session || c.expires < 0 ? 0 : Math.floor(c.expires || 0), c.name, c.value,
    ].join('\t'));
    if (!lines.length) return work(undefined);
    const dir = fs.mkdtempSync(path.join(this.tmpDir, PREFIX));
    try { fs.chmodSync(dir, 0o700); } catch { /* Windows: the per-user temp folder's permissions apply */ }
    this.activeDirs.add(dir);
    const file = path.join(dir, 'cookies.txt');
    try {
      fs.writeFileSync(file, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { mode: 0o600 });
      return await work(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      this.activeDirs.delete(dir);
    }
  }

  // Quit: every snapshot and every jar on disk, even while a download is being cancelled.
  clear() {
    this.snapshots.clear();
    for (const dir of this.activeDirs) fs.rmSync(dir, { recursive: true, force: true });
    this.activeDirs.clear();
  }

  // Start-up: jars left behind by a crash (only one Grab runs at a time, so none is in use).
  scavenge() {
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(this.tmpDir); } catch { return 0; }
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = path.join(this.tmpDir, name);
      if (this.activeDirs.has(dir)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch { /* in use or gone */ }
    }
    return removed;
  }
}

module.exports = { CookieVault, TTL_MS };
