// What happened during lookups and downloads, for support (GRB-18): which strategy found the
// video, how long it took, how many sources were checked or rejected, which engine version ran,
// how a download ended. Kept in memory and in <userData>/logs/diagnostics.log (rotated at 1 MB).
//
// Never recorded: cookies, cookie files, request headers, signed query strings, fragments,
// or URL paths (which can contain personal identifiers and signed path credentials).
// Diagnostics record only scheme://host[:port] for HTTP(S) URLs.
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { ensurePrivateDir } = require('./private-info-dir.cjs');

const MAX_BYTES = 1024 * 1024;
const MAX_MEMORY = 500;
const SECRET_KEYS = /cookie|token|sig|signature|auth|key|secret|password|session|policy|expires|jwt|credential/i;

// https://cdn.example/user/id/v.m3u8?token=abc -> https://cdn.example
// A URL path is not safe diagnostic metadata: it may itself be a user ID or signed secret.
function redactUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin; // drops credentials, path, query, and fragment
  } catch { return null; }
}

// A copy that keeps only plain facts: URL-like strings are reduced, secret-looking keys dropped.
function redact(value, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    const safe = value.replace(/https?:\/\/[^\s"']+/g, (m) => redactUrl(m) || '[link]');
    return safe.length > 300 ? safe.slice(0, 300) + '…' : safe;
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

// Explicit, fail-closed schema: diagnostic events never persist arbitrary extractor stderr,
// URLs, account identifiers or future fields that have not received a privacy review.
const SAFE_STRING_FIELDS = {
  lookup: ['kind', 'strategy'],
  download: ['kind', 'format', 'quality'],
  probe: ['probe', 'browser'],
  start: ['app', 'electron', 'engine'],
};
const SAFE_NUMBER_FIELDS = {
  lookup: ['ms'],
  download: ['ms'],
  probe: ['candidates'],
};
const SAFE_BOOL_FIELDS = {
  lookup: ['ok'],
  download: ['ok', 'stopped'],
  probe: ['protected', 'reusedTab'],
  start: ['packaged'],
};
const knownEvent = (event) => Object.hasOwn(SAFE_STRING_FIELDS, event) || event === 'browser-start';
// No free-form strings and no arbitrary object trees are stored in diagnostics.
function safeEventDetails(event, details = {}) {
  const source = details && typeof details === 'object' ? details : {};
  const result = {};
  if (['lookup', 'download', 'probe'].includes(event) && typeof source.url === 'string') {
    result.url = redactUrl(source.url);
  }
  for (const key of Object.hasOwn(SAFE_STRING_FIELDS, event) ? SAFE_STRING_FIELDS[event] : []) {
    const value = source[key];
    if (typeof value === 'string' && /^[a-zA-Z0-9._ -]{1,64}$/.test(value)) result[key] = value;
  }
  for (const key of Object.hasOwn(SAFE_NUMBER_FIELDS, event) ? SAFE_NUMBER_FIELDS[event] : []) {
    const value = source[key];
    if (Number.isFinite(value) && value >= 0 && value <= 86400000) result[key] = value;
  }
  for (const key of Object.hasOwn(SAFE_BOOL_FIELDS, event) ? SAFE_BOOL_FIELDS[event] : []) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  if (event === 'download' && source.delivered && typeof source.delivered === 'object') {
    const d = source.delivered;
    result.delivered = {
      ...(Number.isInteger(d.height) && d.height >= 0 && d.height <= 4320 ? { height: d.height } : {}),
      ...(['mp4', 'mkv', 'webm', 'mp3', 'm4a'].includes(d.ext) ? { ext: d.ext } : {}),
    };
  }
  if (event === 'probe' && source.diagnostics && typeof source.diagnostics === 'object') {
    const counters = {};
    for (const key of ['framesScanned', 'scanErrors', 'players', 'requestsObserved', 'resourcesScanned']) {
      const value = source.diagnostics[key];
      if (Number.isSafeInteger(value) && value >= 0 && value <= 100000) counters[key] = value;
    }
    if (Object.keys(counters).length) result.diagnostics = counters;
  }
  return result;
}

// Apply the current schema to every retained log on startup, including rotations.
// Never rotate/back up the raw legacy bytes. Oversized or malformed input is dropped.
function migrateLogs(dir) {
  if (!ensurePrivateDir(dir)) return false;
  try {
    for (const name of fs.readdirSync(dir).filter((n) => /^diagnostics\.log(?:\.\d+)?$/.test(n))) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { fs.unlinkSync(file); continue; }
      if (!stat.isFile()) return false;
      const raw = stat.size <= MAX_BYTES ? fs.readFileSync(file, 'utf8') : '';
      const safe = [];
      for (const line of raw.split(/\r?\n/)) {
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const event = knownEvent(value.event) ? value.event : 'unknown';
        const at = typeof value.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at)
          && Number.isFinite(Date.parse(value.at)) ? { at: value.at } : {};
        safe.push(JSON.stringify({ ...at, event, ...safeEventDetails(event, value) }));
      }
      const text = safe.length ? safe.join('\n') + '\n' : '';
      const temporary = file + '.privacy-' + crypto.randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    return true;
  } catch { return false; }
}

class Diagnostics {
  constructor({ dir, now = () => new Date() } = {}) {
    this.file = dir ? path.join(dir, 'diagnostics.log') : null;
    this.now = now;
    this.entries = [];
    this.migrationComplete = !this.file || migrateLogs(path.dirname(this.file));
  }

  record(event, details = {}) {
    const safeEvent = /^[a-z][a-z-]{0,39}$/.test(event) ? event : 'unknown';
    const entry = { at: this.now().toISOString(), event: safeEvent, ...safeEventDetails(safeEvent, details) };
    this.entries.push(entry);
    if (this.entries.length > MAX_MEMORY) this.entries.shift();
    if (!this.file) return entry;
    try {
      if (!this.migrationComplete) this.migrationComplete = migrateLogs(path.dirname(this.file));
      if (!this.migrationComplete) return entry; // retry next time; never append to an unmigrated log
      if (!ensurePrivateDir(path.dirname(this.file))) return entry;
      if (process.platform !== 'win32') {
        for (const file of [this.file, this.file + '.1']) {
          try { fs.chmodSync(file, 0o600); } catch { /* first entry */ }
        }
      }
      try { if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1'); } catch { /* first entry */ }
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
    } catch { /* diagnostics never break the app */ }
    return entry;
  }

  recent(n = 100) { return this.entries.slice(-n); }
}

module.exports = { Diagnostics, redact, redactUrl, safeEventDetails };
