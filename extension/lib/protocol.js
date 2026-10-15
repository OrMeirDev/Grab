// Message protocol between the Grab browser extension and the Grab desktop app.
// Plain UMD script: the extension service worker loads it with importScripts(), the desktop
// app (and its tests) loads it with require(). Only small control/metadata messages travel
// here; video bytes never do.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabProtocol = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const PROTOCOL_VERSION = 1;
  const HOST_NAME = 'com.grab.downloader.browser';
  const MAX_URL = 8192;
  const MAX_CANDIDATES = 40;
  // Hard ceiling for one JSON control message (the browser itself caps host -> browser at 1 MiB).
  const MAX_MESSAGE_BYTES = 1024 * 1024;

  const isStr = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const optStr = (v, max = 256) => v === undefined || (typeof v === 'string' && v.length <= max);
  const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v);
  const isHttpUrl = (v) => {
    if (!isStr(v, MAX_URL)) return false;
    try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  const REASONS = [
    'no_video', 'playback_required', 'timeout', 'cancelled', 'tab_failed', 'protected',
    'extension_error', 'permission_denied', 'navigation_changed',
  ];

  function validCandidate(c) {
    if (!isObj(c) || !isHttpUrl(c.url)) return false;
    if (!['hls', 'dash', 'file', 'opaque', 'embed'].includes(c.kind)) return false;
    if (c.size !== undefined && !(Number.isFinite(c.size) && c.size >= 0)) return false;
    if (c.at !== undefined && !Number.isFinite(c.at)) return false;
    if (c.context !== undefined) {
      if (!isObj(c.context)) return false;
      for (const k of ['userAgent', 'referer', 'origin']) if (!optStr(c.context[k], 8192)) return false;
    }
    if (c.redirects !== undefined && !(Array.isArray(c.redirects) && c.redirects.length <= 10 && c.redirects.every(isHttpUrl))) return false;
    if (c.hosts !== undefined && !(Array.isArray(c.hosts) && c.hosts.length <= 20 && c.hosts.every((h) => isStr(h, 255)))) return false;
    return true;
  }
  const validCandidates = (list) => Array.isArray(list) && list.length <= MAX_CANDIDATES && list.every(validCandidate);

  // type -> { dir: 'ext' (extension to app) | 'app' (app to extension) | 'both', check(msg) }
  const TYPES = {
    hello: { dir: 'ext', check: (m) => isId(m.instanceId) && optStr(m.alias, 60) && isStr(m.extVersion, 32) && Number.isInteger(m.protocol) && optStr(m.userAgent, 512) },
    welcome: { dir: 'app', check: (m) => isStr(m.appVersion, 32) && Number.isInteger(m.protocol) },
    ping: { dir: 'both', check: () => true },
    pong: { dir: 'both', check: () => true },
    error: { dir: 'both', check: (m) => isStr(m.code, 64) && optStr(m.message, 300) },
    discover: { dir: 'app', check: (m) => isId(m.jobId) && isHttpUrl(m.url) && Number.isInteger(m.deadlineMs) && m.deadlineMs > 0 && m.deadlineMs <= 600000 },
    cancel: { dir: 'app', check: (m) => isId(m.jobId) },
    'reveal-tab': { dir: 'app', check: (m) => isId(m.jobId) },
    progress: { dir: 'ext', check: (m) => isId(m.jobId) && ['locating', 'opening', 'discovering', 'playback_required', 'probing'].includes(m.state) },
    candidates: { dir: 'ext', check: (m) => isId(m.jobId) && validCandidates(m.candidates) && typeof m.final === 'boolean' && optStr(m.title, 300) },
    'job-failed': { dir: 'ext', check: (m) => isId(m.jobId) && REASONS.includes(m.reason) && optStr(m.message, 300) },
    'cookies-request': { dir: 'app', check: (m) => isId(m.jobId) && Array.isArray(m.urls) && m.urls.length >= 1 && m.urls.length <= 20 && m.urls.every(isHttpUrl) },
    cookies: { dir: 'ext', check: (m) => isId(m.jobId) && Array.isArray(m.cookies) && m.cookies.length <= 400 && m.cookies.every((c) => isObj(c) && isStr(c.name, 4096) && typeof c.value === 'string' && c.value.length <= 8192 && isStr(c.domain, 255)) },
    'send-to-grab': { dir: 'ext', check: (m) => isHttpUrl(m.url) && optStr(m.title, 300) && (m.candidate === undefined || validCandidate(m.candidate)) },
    ack: { dir: 'app', check: (m) => ['accepted', 'duplicate', 'rejected'].includes(m.status) && optStr(m.ref, 80) && optStr(m.reason, 120) },
    'job-status': { dir: 'app', check: (m) => isStr(m.ref, 80) && isStr(m.phase, 40) && (m.terminal === undefined || ['completed', 'failed', 'cancelled'].includes(m.terminal)) && optStr(m.reason, 120) },
    'app-status': { dir: 'app', check: (m) => typeof m.online === 'boolean' },
  };

  // Returns { ok: true } or { ok: false, error }. direction is the sender: 'ext' or 'app'.
  function validate(msg, direction) {
    if (!isObj(msg)) return { ok: false, error: 'not_object' };
    if (msg.v !== PROTOCOL_VERSION) return { ok: false, error: 'version' };
    if (!isId(msg.id)) return { ok: false, error: 'bad_id' };
    if (msg.replyTo !== undefined && !isId(msg.replyTo)) return { ok: false, error: 'bad_reply' };
    const spec = TYPES[msg.type];
    if (!spec) return { ok: false, error: 'unknown_type' };
    if (spec.dir !== 'both' && spec.dir !== direction) return { ok: false, error: 'wrong_direction' };
    let good = false;
    try { good = !!spec.check(msg); } catch { good = false; }
    return good ? { ok: true } : { ok: false, error: 'invalid_' + msg.type };
  }

  let counter = 0;
  const newId = (prefix = 'm') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const make = (type, payload = {}, replyTo) => ({ v: PROTOCOL_VERSION, id: newId(), type, ...(replyTo ? { replyTo } : {}), ...payload });

  return { PROTOCOL_VERSION, HOST_NAME, MAX_MESSAGE_BYTES, MAX_URL, MAX_CANDIDATES, REASONS, TYPES, validate, validCandidate, make, newId, isHttpUrl, isId };
}));
