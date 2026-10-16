// Starts a real Chromium (the unbranded build that ships with Playwright, which still honours
// --load-extension) with a throwaway profile and drives it over the DevTools protocol, so the
// unpacked extension, Native Messaging and the host are exercised for real. It never touches the
// user's browsers or profiles.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { CdpClient } = require('../electron/browser-session.cjs');

function findChromium() {
  if (process.env.GRAB_TEST_CHROMIUM && fs.existsSync(process.env.GRAB_TEST_CHROMIUM)) return process.env.GRAB_TEST_CHROMIUM;
  try {
    const exe = require('playwright').chromium.executablePath();
    if (fs.existsSync(exe)) return exe;
  } catch { /* optional browser not downloaded yet */ }
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (!base || !fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Chromium {
  constructor({ extensionDir, autoplay = true, exe = findChromium() } = {}) {
    this.extensionDir = extensionDir;
    this.autoplay = autoplay;
    this.exe = exe;
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-chromium-profile-'));
    this.child = null;
    this.cdp = null;
  }

  async start() {
    if (!this.exe) throw new Error('No Chromium found (install Playwright Chromium or set GRAB_TEST_CHROMIUM)');
    const args = [
      `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--headless=new', '--disable-gpu', '--mute-audio',
      `--load-extension=${this.extensionDir}`, `--disable-extensions-except=${this.extensionDir}`,
      ...(this.autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
      'about:blank',
    ];
    this.child = spawn(this.exe, args, { stdio: 'ignore', windowsHide: true });
    this.exited = new Promise((resolve) => this.child.on('exit', resolve));
    const portFile = path.join(this.profile, 'DevToolsActivePort');
    const end = Date.now() + 20000;
    while (!fs.existsSync(portFile)) {
      if (Date.now() > end) throw new Error('Chromium did not start');
      await sleep(100);
    }
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, { perMessageDeflate: false });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    this.cdp = new CdpClient(socket);
    return this;
  }

  send(method, params, sessionId) { return this.cdp.send(method, params, sessionId); }

  async targets() { return (await this.send('Target.getTargets')).targetInfos; }
  async pages() { return (await this.targets()).filter((t) => t.type === 'page'); }

  async newTab(url) { return (await this.send('Target.createTarget', { url })).targetId; }
  async closeTab(targetId) { await this.send('Target.closeTarget', { targetId }).catch(() => {}); }

  async evaluate(targetId, expression) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    } finally { await this.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  async extensionWorker(extensionId, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const w = (await this.targets()).find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + extensionId + '/'));
      if (w) return w;
      await sleep(200);
    }
    throw new Error('Extension service worker not found');
  }

  async stop() {
    try { if (this.cdp) this.cdp.disconnect(); } catch { /* ignore */ }
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      await Promise.race([this.exited, sleep(5000)]);
      if (this.child.exitCode === null) spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    await sleep(300);
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch { /* files may linger briefly */ }
  }
}

module.exports = { Chromium, findChromium, sleep };
