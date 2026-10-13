const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sessionError = (message, kind = 'browserSession') => Object.assign(new Error(message), { kind });

function activePortPath() {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw sessionError('Chrome profile folder is unavailable');
    return path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-chrome', 'DevToolsActivePort');
}

function readEndpoint(file = activePortPath()) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { throw sessionError('Open Chrome and enable remote debugging at chrome://inspect/#remote-debugging'); }
  const [rawPort, endpointPath] = content.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !endpointPath?.startsWith('/devtools/browser/')) {
    throw sessionError('Chrome debugging endpoint is invalid');
  }
  return `ws://127.0.0.1:${port}${endpointPath}`;
}

// Small CDP client; the WebSocket transport is the maintained ws package.
class CdpClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 0;
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'Browser command failed'));
        else pending.resolve(message.result || {});
      } else if (message.method) this.emit('event', message);
    });
    const disconnected = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(sessionError('Chrome disconnected')); }
      this.pending.clear();
      this.emit('disconnected');
    };
    socket.on('close', disconnected);
    socket.on('error', disconnected);
  }

  get connected() { return this.socket.readyState === 1; }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    if (!this.connected) return Promise.reject(sessionError('Chrome disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser command timed out: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  disconnect() { this.socket.close(); }
}

let client = null;
let connecting = null;
async function connectExistingChrome({ endpointFile } = {}) {
  if (client?.connected) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const WebSocket = require('ws');
    const socket = new WebSocket(readEndpoint(endpointFile), { handshakeTimeout: 60000, perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const done = (error) => {
        socket.removeListener('open', opened);
        socket.removeListener('error', failed);
        socket.removeListener('close', failed);
        if (error) reject(sessionError('Could not connect to Chrome; enable remote debugging and allow the connection'));
        else resolve();
      };
      const opened = () => done();
      const failed = () => done(true);
      socket.once('open', opened);
      socket.once('error', failed);
      socket.once('close', failed);
    });
    const connected = new CdpClient(socket);
    try { await connected.send('Browser.getVersion', {}, undefined, 60000); }
    catch (error) { connected.disconnect(); throw sessionError(error.message); }
    client = connected;
    connected.once('disconnected', () => { if (client === connected) client = null; });
    return connected;
  })();
  try { return await connecting; } finally { connecting = null; }
}

// Reuse the requested page if it is open. Otherwise create only a background tab
// in the matching existing context; never launch Chrome or create a fresh context.
async function chooseTarget(cdp, pageUrl, { refresh = false } = {}) {
  const wanted = new URL(pageUrl);
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page' && /^https?:/i.test(t.url));
  const exact = pages.filter((t) => { try { return new URL(t.url).href === wanted.href; } catch { return false; } });
  const sameOrigin = pages.filter((t) => { try { return new URL(t.url).origin === wanted.origin; } catch { return false; } });
  const matches = exact.length ? exact : sameOrigin;
  const contexts = new Set(matches.map((t) => t.browserContextId || ''));
  if (contexts.size > 1) throw sessionError('The page is open in multiple browser contexts; keep the intended page open in one context', 'browserContext');
  if (exact.length && !refresh) return { targetId: exact[0].targetId, created: false };
  const browserContextId = matches[0]?.browserContextId;
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank', background: true,
    ...(browserContextId ? { browserContextId } : {}),
  });
  return { targetId, created: true };
}

const cookieSnapshots = new Map();
const activeCookieDirs = new Set();
function rememberCookies(cookies) {
  const reference = crypto.randomUUID();
  cookieSnapshots.set(reference, { cookies, at: Date.now() });
  for (const [key, value] of cookieSnapshots) if (Date.now() - value.at > 24 * 60 * 60 * 1000) cookieSnapshots.delete(key);
  return reference;
}

async function withSessionCookies(reference, work) {
  const snapshot = cookieSnapshots.get(reference);
  if (!snapshot?.cookies.length) return work(undefined);
  const lines = snapshot.cookies.filter((c) => ![c.domain, c.path, c.name, c.value].some((v) => /[\t\r\n]/.test(v || ''))).map((c) => [
    (c.httpOnly ? '#HttpOnly_' : '') + c.domain,
    c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/',
    c.secure ? 'TRUE' : 'FALSE', c.session || c.expires < 0 ? 0 : Math.floor(c.expires || 0), c.name, c.value,
  ].join('\t'));
  if (!lines.length) return work(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-cookies-'));
  activeCookieDirs.add(dir);
  const file = path.join(dir, 'cookies.txt');
  try {
    fs.writeFileSync(file, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { mode: 0o600 });
    return await work(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    activeCookieDirs.delete(dir);
  }
}

function disconnectBrowser() {
  if (client) client.disconnect();
  // Called on app shutdown, including while a download is being cancelled.
  for (const dir of activeCookieDirs) fs.rmSync(dir, { recursive: true, force: true });
  activeCookieDirs.clear();
}
module.exports = { connectExistingChrome, chooseTarget, rememberCookies, withSessionCookies, disconnectBrowser, CdpClient, readEndpoint };
