const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The user's default browser (where they are signed in). Chromium-based browsers all have the same
// remote-debugging switch (<scheme>://inspect/#remote-debugging) and DevToolsActivePort file.
const CHROME = { name: 'Chrome', scheme: 'chrome', dir: ['LOCALAPPDATA', 'Google', 'Chrome', 'User Data'] };
const EDGE = { name: 'Edge', scheme: 'edge', dir: ['LOCALAPPDATA', 'Microsoft', 'Edge', 'User Data'] };
const BROWSERS = [
  [/^ChromeHTML/i, CHROME],
  [/^MSEdge/i, EDGE],
  [/^Brave/i, { name: 'Brave', scheme: 'brave', dir: ['LOCALAPPDATA', 'BraveSoftware', 'Brave-Browser', 'User Data'] }],
  [/^Vivaldi/i, { name: 'Vivaldi', scheme: 'vivaldi', dir: ['LOCALAPPDATA', 'Vivaldi', 'User Data'] }],
  [/^OperaGX/i, { name: 'Opera GX', scheme: 'opera', dir: ['APPDATA', 'Opera Software', 'Opera GX Stable'] }],
  [/^Opera/i, { name: 'Opera', scheme: 'opera', dir: ['APPDATA', 'Opera Software', 'Opera Stable'] }],
  [/^Chromium/i, { name: 'Chromium', scheme: 'chrome', dir: ['LOCALAPPDATA', 'Chromium', 'User Data'] }],
  // Firefox no longer speaks the protocol used here, so it can't be used for a signed-in lookup.
  [/^Firefox/i, { name: 'Firefox', supported: false }],
];

// Windows keeps the default browser as the ProgId of the https handler (e.g. "BraveHTML").
function defaultBrowserId() {
  if (process.platform !== 'win32') return '';
  try {
    const out = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return (out.match(/ProgId\s+REG_SZ\s+(\S+)/i) || [])[1] || '';
  } catch { return ''; }
}

// { name, scheme, endpointFile } of the default browser; Chrome when it isn't known.
function defaultBrowser(progId = defaultBrowserId()) {
  const b = (BROWSERS.find(([re]) => re.test(progId)) || [, CHROME])[1];
  if (b.supported === false) return { name: b.name, supported: false };
  const info = { name: b.name, scheme: b.scheme };
  if (process.platform === 'win32') {
    const [env, ...rest] = b.dir;
    if (process.env[env]) info.endpointFile = path.join(process.env[env], ...rest, 'DevToolsActivePort');
  } else if (process.platform === 'darwin') info.endpointFile = path.join(os.homedir(), 'Library', 'Application Support', ...(b === EDGE ? ['Microsoft Edge'] : ['Google', 'Chrome']), 'DevToolsActivePort');
  else info.endpointFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), b === EDGE ? 'microsoft-edge' : 'google-chrome', 'DevToolsActivePort');
  return info;
}

function isMakoPage(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return /^https?:$/.test(url.protocol) && /(^|\.)mako\.co\.il$/i.test(url.hostname.replace(/\.$/, ''));
  } catch { /* a general guide has no page URL */ }
  return false;
}

// A browser picked by the selection rules (or the user) wins. Without one, Mako playback is looked up
// in Edge and every other page keeps the default-browser policy.
const PROG_IDS = { edge: 'MSEdgeHTM', chrome: 'ChromeHTML', brave: 'BraveHTML' };
function browserForPage(pageUrl, browserId) {
  if (browserId && PROG_IDS[browserId]) return defaultBrowser(PROG_IDS[browserId]);
  return isMakoPage(pageUrl) ? defaultBrowser('MSEdgeHTM') : defaultBrowser();
}

const sessionError = (message, kind = 'browserSession', browser) => Object.assign(new Error(message), { kind, browser });

function readEndpoint(file, browser = { name: 'Chrome', scheme: 'chrome' }) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { throw sessionError(`Open ${browser.name} and enable remote debugging at ${browser.scheme}://inspect/#remote-debugging`, 'browserSession', browser); }
  const [rawPort, endpointPath] = content.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !endpointPath?.startsWith('/devtools/browser/')) {
    throw sessionError(`${browser.name} debugging endpoint is invalid`, 'browserSession', browser);
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
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(sessionError('Browser disconnected')); }
      this.pending.clear();
      this.emit('disconnected');
    };
    socket.on('close', disconnected);
    socket.on('error', disconnected);
  }

  get connected() { return this.socket.readyState === 1; }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    if (!this.connected) return Promise.reject(sessionError('Browser disconnected'));
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

// A Mako lookup in Edge must not reuse or disconnect a lookup in the default browser.
const connections = new Map();
// Connects to the selected browser. The file is left behind
// when the browser closes, so a refused connection means "open the browser", same as no file.
async function connectBrowser({ endpointFile, browser = endpointFile ? { name: 'Chrome', scheme: 'chrome', endpointFile } : defaultBrowser() } = {}) {
  if (browser.supported === false) throw sessionError(`${browser.name} is not supported for signed-in lookup`, 'browserUnsupported', browser);
  const key = browser.endpointFile || browser.name;
  const existing = connections.get(key);
  if (existing?.client?.connected) return existing.client;
  if (existing?.connecting) return existing.connecting;
  const connection = {};
  connections.set(key, connection);
  connection.connecting = (async () => {
    const WebSocket = require('ws');
    const socket = new WebSocket(readEndpoint(browser.endpointFile, browser), { handshakeTimeout: 60000, perMessageDeflate: false });
    connection.socket = socket;
    await new Promise((resolve, reject) => {
      const done = (error) => {
        socket.removeListener('open', opened);
        socket.removeListener('error', failed);
        socket.removeListener('close', failed);
        if (error) reject(sessionError(`Could not connect to ${browser.name}; open it, enable remote debugging and allow the connection`, 'browserSession', browser));
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
    catch (error) { connected.disconnect(); throw sessionError(error.message, 'browserSession', browser); }
    connected.browser = browser;
    connection.client = connected;
    connected.once('disconnected', () => { if (connections.get(key) === connection) connections.delete(key); });
    return connected;
  })();
  try { return await connection.connecting; }
  finally {
    connection.connecting = null;
    if (!connection.client?.connected && connections.get(key) === connection) connections.delete(key);
  }
}

// Reuse the requested page if it is open. Otherwise create only a background tab
// in the matching existing context; never launch the browser or create a fresh context.
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
  for (const connection of connections.values()) connection.socket?.close();
  connections.clear();
  // Called on app shutdown, including while a download is being cancelled.
  for (const dir of activeCookieDirs) fs.rmSync(dir, { recursive: true, force: true });
  activeCookieDirs.clear();
}
module.exports = { connectBrowser, defaultBrowser, browserForPage, isMakoPage, chooseTarget, rememberCookies, withSessionCookies, disconnectBrowser, CdpClient, readEndpoint };
