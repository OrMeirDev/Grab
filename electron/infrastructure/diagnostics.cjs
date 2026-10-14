// What happened during lookups and downloads, for support (GRB-18): which strategy found the
// video, how long it took, how many sources were checked or rejected, which engine version ran,
// how a download ended. Kept in memory and in <userData>/logs/diagnostics.log (rotated at 1 MB).
//
// Never recorded: cookies, cookie files, request headers, signed query strings or fragments.
// Every link is reduced to scheme://host/path before it is stored.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const MAX_MEMORY = 500;
const SECRET_KEYS = /cookie|token|sig|signature|auth|key|secret|password|session|policy|expires|jwt|credential/i;

// https://cdn.example/v.m3u8?token=abc#t=1 -> https://cdn.example/v.m3u8 ; anything else -> null
function redactUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return null; }
}

// A copy that keeps only plain facts: URL-like strings are reduced, secret-looking keys dropped.
function redact(value, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    return value.length > 300 ? value.slice(0, 300) + '…' : value.replace(/https?:\/\/[^\s"']+/g, (m) => redactUrl(m) || '[link]');
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k) || k === 'requestContext' || k === 'cookieRef' || k === 'cookieFile' || k === 'infoFile') continue;
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

class Diagnostics {
  constructor({ dir, now = () => new Date() } = {}) {
    this.file = dir ? path.join(dir, 'diagnostics.log') : null;
    this.now = now;
    this.entries = [];
  }

  record(event, details = {}) {
    const entry = { at: this.now().toISOString(), event, ...redact(details) };
    this.entries.push(entry);
    if (this.entries.length > MAX_MEMORY) this.entries.shift();
    if (!this.file) return entry;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1'); } catch { /* first entry */ }
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch { /* diagnostics never break the app */ }
    return entry;
  }

  recent(n = 100) { return this.entries.slice(-n); }
}

module.exports = { Diagnostics, redact, redactUrl };
