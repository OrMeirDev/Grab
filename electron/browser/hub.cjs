// The desktop end of the browser bridge. The browser starts the native host (because the
// extension connected); the host dials the per-user pipe served here. The app cannot call into
// an extension, so every message to a browser goes down a connection the extension opened.
//
// Each connected browser/profile is an "instance" keyed by browser + the extension's own random
// instance id. Messages are routed by connection, so two instances never see each other's data.
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const protocol = require('../../extension/lib/protocol.js');
const { encodeFrame, FrameParser } = require('../../native-host/framing.cjs');
const { pipePath, ensureToken, proofMatches } = require('../../native-host/ipc-paths.cjs');

const BROWSER_KINDS = ['edge', 'chrome', 'brave'];

const normalizeOrigin = (origin) => String(origin || '').replace(/\/+$/, '').toLowerCase();

class BrowserHub extends EventEmitter {
  constructor({ integrationDir, allowedOrigins, appVersion = '0', authTimeoutMs = 5000, helloTimeoutMs = 10000 } = {}) {
    super();
    this.integrationDir = integrationDir;
    this.allowedOrigins = new Set((allowedOrigins || []).map(normalizeOrigin));
    this.appVersion = appVersion;
    this.authTimeoutMs = authTimeoutMs;
    this.helloTimeoutMs = helloTimeoutMs;
    this.conns = new Set();
    this.byKey = new Map(); // instance key -> conn
    this.pending = new Map(); // request id -> { resolve, reject, timer, conn }
    this.waiters = new Set();
    this.failures = []; // recent setup/protocol failures, shown to the user in health checks
    this.server = null;
    this.token = null;
  }

  async start() {
    if (this.server) return;
    this.token = ensureToken(this.integrationDir);
    const path = pipePath(this.integrationDir);
    if (process.platform !== 'win32') { try { fs.unlinkSync(path); } catch { /* none */ } }
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(path, () => { this.server.removeListener('error', reject); resolve(); });
    });
    this.server.on('error', (e) => this.fail('pipe', e.message));
  }

  stop() {
    for (const conn of [...this.conns]) conn.sock.destroy();
    this.conns.clear();
    this.byKey.clear();
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Hub stopped'), { code: 'hub_stopped' })); this.pending.delete(id); }
    for (const w of [...this.waiters]) w.reject(Object.assign(new Error('Hub stopped'), { code: 'hub_stopped' }));
    if (this.server) { this.server.close(); this.server = null; }
  }

  fail(code, message, browser) {
    this.failures.unshift({ code, message: String(message || '').slice(0, 200), browser: browser || null, at: Date.now() });
    this.failures.length = Math.min(this.failures.length, 20);
    this.emit('failure', this.failures[0]);
  }

  accept(sock) {
    const conn = { sock, state: 'auth', nonce: crypto.randomBytes(16).toString('hex'), invalid: 0, instance: null, host: null };
    this.conns.add(conn);
    const raw = (m) => { try { sock.write(encodeFrame(m)); } catch { /* socket gone */ } };
    conn.raw = raw;
    raw({ type: 'challenge', nonce: conn.nonce });
    const authTimer = setTimeout(() => { if (conn.state === 'auth') sock.destroy(); }, this.authTimeoutMs);
    let helloTimer = null;
    const parser = new FrameParser({
      onError: (e) => { if (e.code === 'oversize') sock.destroy(); else if (++conn.invalid > 5) sock.destroy(); },
      onMessage: (m) => {
        if (conn.state === 'auth') {
          if (m.type !== 'host-hello' || !proofMatches(this.token, conn.nonce, m.proof)) { sock.destroy(); return; }
          const origin = normalizeOrigin(m.origin);
          if (!this.allowedOrigins.has(origin)) {
            this.fail('origin_mismatch', 'The browser extension ID does not match the one Grab trusts', m.browserKind);
            raw({ type: 'rejected', reason: 'origin_not_allowed' });
            sock.destroy();
            return;
          }
          clearTimeout(authTimer);
          conn.host = { browserKind: BROWSER_KINDS.includes(m.browserKind) ? m.browserKind : 'unknown', origin, hostVersion: m.hostVersion, pid: Number.isInteger(m.pid) ? m.pid : 0 };
          conn.state = 'hello';
          raw({ type: 'ready' });
          helloTimer = setTimeout(() => { if (!conn.instance) { this.fail('no_hello', 'The extension did not introduce itself', conn.host.browserKind); sock.destroy(); } }, this.helloTimeoutMs);
          return;
        }
        if (m.type === 'relay' && m.message && typeof m.message === 'object') this.fromExtension(conn, m.message);
      },
    });
    sock.on('data', (d) => parser.push(d));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      this.dropInstance(conn);
    });
  }

  send(conn, message) {
    const check = protocol.validate(message, 'app');
    if (!check.ok) throw new Error('Refusing to send invalid message: ' + check.error);
    try { conn.raw({ type: 'relay', message }); return true; } catch { return false; }
  }

  fromExtension(conn, m) {
    const check = protocol.validate(m, 'ext');
    if (!check.ok) {
      if (check.error === 'version') this.fail('protocol_version', 'The extension speaks a different protocol version', conn.host.browserKind);
      conn.invalid += 1;
      const error = protocol.make('error', { code: check.error === 'version' ? 'protocol_version' : 'invalid_message', message: check.error }, protocol.isId(m && m.id) ? m.id : undefined);
      this.send(conn, error);
      if (conn.invalid > 5) conn.sock.destroy();
      return;
    }
    if (m.type === 'hello') return this.register(conn, m);
    if (!conn.instance) { this.send(conn, protocol.make('error', { code: 'hello_required' }, m.id)); return; }
    if (m.type === 'ping') { this.send(conn, protocol.make('pong', {}, m.id)); return; }
    if (m.replyTo && this.pending.has(m.replyTo) && this.pending.get(m.replyTo).conn === conn) {
      const p = this.pending.get(m.replyTo);
      this.pending.delete(m.replyTo);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    this.emit('message', this.publicInstance(conn), m, conn);
  }

  register(conn, hello) {
    if (hello.protocol !== protocol.PROTOCOL_VERSION) {
      this.fail('protocol_version', `Extension protocol ${hello.protocol}, app ${protocol.PROTOCOL_VERSION}`, conn.host.browserKind);
      this.send(conn, protocol.make('error', { code: 'protocol_version', message: 'Update the Grab extension (repair the browser connection)' }, hello.id));
      return;
    }
    const browser = conn.host.browserKind;
    const key = `${browser}:${hello.instanceId}`;
    const previous = this.byKey.get(key);
    // The newest connection wins (extension reloaded or host restarted).
    if (previous && previous !== conn) { previous.instance = null; previous.sock.destroy(); }
    conn.state = 'ready';
    conn.instance = { key, browser, instanceId: hello.instanceId, alias: hello.alias || '', extVersion: hello.extVersion, userAgent: hello.userAgent || '', connectedAt: Date.now() };
    this.byKey.set(key, conn);
    this.send(conn, protocol.make('welcome', { appVersion: this.appVersion, protocol: protocol.PROTOCOL_VERSION }, hello.id));
    const info = this.publicInstance(conn);
    this.emit('instances', this.instances());
    for (const w of [...this.waiters]) if (w.match(info)) w.resolve(info);
  }

  dropInstance(conn) {
    const key = conn.instance && conn.instance.key;
    if (key && this.byKey.get(key) === conn) {
      this.byKey.delete(key);
      for (const [id, p] of this.pending) if (p.conn === conn) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Browser disconnected'), { code: 'disconnected' })); this.pending.delete(id); }
      this.emit('disconnected', conn.instance);
      this.emit('instances', this.instances());
    }
  }

  publicInstance(conn) {
    const i = conn.instance;
    return { key: i.key, browser: i.browser, instanceId: i.instanceId, alias: i.alias, extVersion: i.extVersion, connectedAt: i.connectedAt };
  }

  // Process id of the native host serving an instance (used by tests to simulate a host crash).
  hostPid(key) { const c = this.byKey.get(key); return c ? c.host.pid : 0; }

  instances() { return [...this.byKey.values()].map((c) => this.publicInstance(c)); }

  // Send to one instance. Returns false when that instance is not connected.
  sendTo(key, type, payload, replyTo) {
    const conn = this.byKey.get(key);
    if (!conn) return false;
    return this.send(conn, protocol.make(type, payload, replyTo));
  }

  // Request/response with a correlation id and a deadline. The reply must come from the same connection.
  request(key, type, payload, { timeoutMs = 10000 } = {}) {
    const conn = this.byKey.get(key);
    if (!conn) return Promise.reject(Object.assign(new Error('Browser instance not connected'), { code: 'not_connected' }));
    const message = protocol.make(type, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(message.id); reject(Object.assign(new Error('No reply from the browser'), { code: 'timeout' })); }, timeoutMs);
      this.pending.set(message.id, { resolve, reject, timer, conn });
      if (!this.send(conn, message)) { clearTimeout(timer); this.pending.delete(message.id); reject(Object.assign(new Error('Send failed'), { code: 'not_connected' })); }
    });
  }

  // Resolves when an instance matching `match` is (or becomes) connected. Rejects on timeout or abort.
  waitFor(match, { timeoutMs, signal } = {}) {
    const existing = this.instances().find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); this.waiters.delete(w); signal?.removeEventListener('abort', onAbort); fn(v); };
      const w = { match, resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) };
      const timer = setTimeout(() => w.reject(Object.assign(new Error('Timed out waiting for the browser extension'), { code: 'timeout' })), timeoutMs);
      const onAbort = () => w.reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(w);
    });
  }
}

module.exports = { BrowserHub, BROWSER_KINDS, normalizeOrigin };
