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
const { ensurePrivateDir } = require('./private-info-dir.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');

const TTL_MS = 4 * 60 * 60 * 1000;
const PREFIX = 'grab-cookies-';

const expired = (message = 'The page session expired; look the page up again') => Object.assign(new Error(message), { kind: 'contextExpired' });

class CookieVault {
  constructor({ tmpDir = os.tmpdir(), ttlMs = TTL_MS, now = () => Date.now(), maxMetadataBytes = 32 * 1024 * 1024, maxMetadataEntries = 256 } = {}) {
    this.tmpDir = tmpDir;
    this.ttlMs = ttlMs;
    this.now = now;
    this.snapshots = new Map();
    this.activeDirs = new Set();
    this.metadata = new Map();
    this.metadataBytes = 0;
    this.maxMetadataBytes = maxMetadataBytes;
    this.maxMetadataEntries = maxMetadataEntries;
    this.context = new AsyncLocalStorage();
  }

  // source: 'browser' (the user's signed-in browser; the default) or 'probe' (the hidden probe's
  // throwaway session). Browser snapshots are dropped when that connection is lost.
  remember(cookies, { source = 'browser' } = {}) {
    const reference = crypto.randomUUID();
    this.snapshots.set(reference, { cookies: Array.isArray(cookies) ? cookies : [], at: this.now(), source });
    this.prune();
    return reference;
  }

  prune() {
    for (const [key, value] of this.snapshots) if (this.now() - value.at > this.ttlMs) this.forget(key);
    for (const [key] of this.metadata) this.hasMetadata(key);
  }

  forget(reference) {
    this.snapshots.delete(reference);
    for (const [key, value] of this.metadata) if (value.parent === reference) this.forgetMetadata(key);
  }

  // Extractor JSON can itself contain session/rotated cookies. It belongs in this
  // same vault, under an opaque handle bound to the active browser-session handle.
  rememberMetadata(text) {
    if (typeof text !== 'string' || !text) throw new TypeError('Invalid private metadata');
    this.prune();
    const parent = this.context.getStore() || null;
    if (parent && !this.has(parent)) throw expired();
    const bytes = Buffer.byteLength(text);
    if (this.metadataBytes + bytes > this.maxMetadataBytes || this.metadata.size >= this.maxMetadataEntries) throw new Error('Private metadata memory budget reached');
    const reference = crypto.randomUUID();
    this.metadata.set(reference, { text, bytes, parent, at: this.now() });
    this.metadataBytes += bytes;
    return reference;
  }

  hasMetadata(reference) {
    const value = this.metadata.get(reference);
    if (!value) return false;
    if (this.now() - value.at >= this.ttlMs || (value.parent && !this.has(value.parent))) {
      this.forgetMetadata(reference);
      return false;
    }
    return true;
  }

  readMetadata(reference) { return this.hasMetadata(reference) ? this.metadata.get(reference).text : undefined; }

  forgetMetadata(reference) {
    const value = this.metadata.get(reference);
    if (value) this.metadataBytes -= value.bytes;
    this.metadata.delete(reference);
  }

  clearMetadata() { this.metadata.clear(); this.metadataBytes = 0; }

  // Drops every snapshot from one source. Jars already handed to a running yt-dlp stay until
  // that run ends (it reads and rewrites its jar); no new run can get one.
  forgetSource(source) {
    for (const [key, value] of this.snapshots) if (value.source === source) this.forget(key);
  }

  has(reference) {
    const s = this.snapshots.get(reference);
    return !!s && this.now() - s.at <= this.ttlMs;
  }

  // work(cookieFile | undefined). No handle: no cookies were captured, work runs without a jar.
  async withJar(reference, work) {
    if (!reference) return this.context.run(null, () => work(undefined));
    const snapshot = this.snapshots.get(reference);
    if (!snapshot || this.now() - snapshot.at > this.ttlMs) {
      this.forget(reference);
      throw expired();
    }
    const lines = snapshot.cookies.filter((c) => c && typeof c.domain === 'string' && ![c.domain, c.path, c.name, c.value].some((v) => /[\t\r\n]/.test(v || ''))).map((c) => [
      (c.httpOnly ? '#HttpOnly_' : '') + (c.hostOnly === true ? c.domain.replace(/^\./, '') : c.hostOnly === false && !c.domain.startsWith('.') ? '.' + c.domain : c.domain),
      c.hostOnly === false || (c.hostOnly === undefined && c.domain.startsWith('.')) ? 'TRUE' : 'FALSE', c.path || '/',
      c.secure ? 'TRUE' : 'FALSE', c.session || c.expires < 0 ? 0 : Math.floor(c.expires || 0), c.name, c.value,
    ].join('\t'));
    if (!lines.length) return this.context.run(reference, () => work(undefined));
    const dir = fs.mkdtempSync(path.join(this.tmpDir, PREFIX));
    if (!ensurePrivateDir(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* empty directory */ }
      throw expired('The temporary session directory could not be protected');
    }
    try { fs.chmodSync(dir, 0o700); } catch { /* Windows: the per-user temp folder's permissions apply */ }
    this.activeDirs.add(dir);
    const file = path.join(dir, 'cookies.txt');
    try {
      fs.writeFileSync(file, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { mode: 0o600 });
      return await this.context.run(reference, () => work(file));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      this.activeDirs.delete(dir);
    }
  }

  // Quit: every snapshot and every jar on disk, even while a download is being cancelled.
  clear() {
    this.snapshots.clear();
    this.clearMetadata();
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

const sharedCookieVault = new CookieVault();
module.exports = { CookieVault, TTL_MS, sharedCookieVault };
