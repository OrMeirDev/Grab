// Stand-in for the browser side of Native Messaging: runs the REAL native host process and speaks
// the browser's framing over its stdin/stdout. Nothing about the host or the app is mocked.
const { spawn } = require('child_process');
const path = require('path');
const { encodeFrame, FrameParser } = require('../native-host/framing.cjs');
const protocol = require('../extension/lib/protocol.js');

const HOST = path.join(__dirname, '..', 'native-host', 'host.cjs');

class FakeBrowser {
  constructor({ integrationDir, origin, browser = 'edge', instanceId = 'inst-' + Math.random().toString(36).slice(2, 8), alias = '', hostScript = HOST } = {}) {
    this.instanceId = instanceId;
    this.alias = alias;
    this.received = [];
    this.waiters = [];
    this.exited = new Promise((resolve) => { this.onExit = resolve; });
    this.stderr = '';
    this.child = spawn(process.execPath, [hostScript, origin], {
      // The same fixture is also used by the real Electron UI check. Its native host must
      // run as Node, just like the installed launchers, instead of starting another GUI.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GRAB_INTEGRATION_DIR: integrationDir, GRAB_BROWSER: browser },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.nonFrameStdout = false;
    const parser = new FrameParser({
      onMessage: (m) => { this.received.push(m); this.waiters = this.waiters.filter((w) => !w(m)); },
      onError: () => { this.nonFrameStdout = true; },
    });
    this.child.stdout.on('data', (d) => parser.push(d));
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.on('exit', (code) => this.onExit(code));
    this.child.stdin.on('error', () => {});
  }

  write(message) { this.child.stdin.write(encodeFrame(message)); }
  writeRaw(buffer) { this.child.stdin.write(buffer); }

  // Resolves with the first (already received or future) message matching the predicate.
  waitFor(predicate, timeoutMs = 8000) {
    const hit = this.received.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a message; got: ' + JSON.stringify(this.received.map((m) => m.type)))), timeoutMs);
      this.waiters.push((m) => { if (predicate(m)) { clearTimeout(timer); resolve(m); return true; } return false; });
    });
  }

  hello(extra = {}) {
    const m = protocol.make('hello', { instanceId: this.instanceId, alias: this.alias || undefined, extVersion: '1.0.0', protocol: protocol.PROTOCOL_VERSION, ...extra });
    this.write(m);
    return m;
  }

  close() { try { this.child.stdin.end(); } catch { /* closed */ } return this.exited; }
  kill() { this.child.kill(); return this.exited; }
}

module.exports = { FakeBrowser, HOST };
