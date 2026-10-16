// What happened during lookups and downloads, for support (GRB-18): which strategy found the
// video, how long it took, how many sources were checked or rejected, which engine version ran,
// how a download ended. Kept in memory and in <userData>/logs/diagnostics.log (rotated at 1 MB).
//
// Never recorded: cookies, cookie files, request headers, signed query strings, fragments,
// or URL paths (which can contain personal identifiers and signed path credentials).
// Diagnostics record only scheme://host[:port] for HTTP(S) URLs.
const fs = require('fs');
const path = require('path');

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
// No free-form strings and no arbitrary object trees are stored in diagnostics.
function safeEventDetails(event, details = {}) {
  const source = details && typeof details === 'object' ? details : {};
  const result = {};
  if (['lookup', 'download', 'probe'].includes(event) && typeof source.url === 'string') {
    result.url = redactUrl(source.url);
  }
  for (const key of SAFE_STRING_FIELDS[event] || []) {
    const value = source[key];
    if (typeof value === 'string' && /^[a-zA-Z0-9._ -]{1,64}$/.test(value)) result[key] = value;
  }
  for (const key of SAFE_NUMBER_FIELDS[event] || []) {
    const value = source[key];
    if (Number.isFinite(value) && value >= 0 && value <= 86400000) result[key] = value;
  }
  for (const key of SAFE_BOOL_FIELDS[event] || []) {
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

class Diagnostics {
  constructor({ dir, now = () => new Date() } = {}) {
    this.file = dir ? path.join(dir, 'diagnostics.log') : null;
    this.now = now;
    this.entries = [];
  }

  record(event, details = {}) {
    const safeEvent = /^[a-z][a-z-]{0,39}$/.test(event) ? event : 'unknown';
    const entry = { at: this.now().toISOString(), event: safeEvent, ...safeEventDetails(safeEvent, details) };
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

module.exports = { Diagnostics, redact, redactUrl, safeEventDetails };
