// Grab native messaging host. The browser starts this process when the Grab extension calls
// runtime.connectNative(); it relays framed JSON between the browser (stdin/stdout) and the
// running Grab app (a per-user local pipe). stdout carries protocol frames ONLY: diagnostics
// go to stderr, which the browser writes to its own log.
//
// It is started as: <runtime> host.cjs <origin> [--parent-window=N]
// with GRAB_BROWSER=edge|chromium set by the launcher. Shared Chromium registration resolves
// Chrome/Brave from the actual parent process chain. When the app is not
// running it keeps retrying (bounded backoff) while the browser keeps the port open, so the app
// can start after the browser and still get connected without any user action.
const net = require('net');
const path = require('path');
const { encodeFrame, FrameParser, MAX_FRAME_BYTES } = require('./framing.cjs');
const { pipePath, readToken, proof, proofMatches } = require('./ipc-paths.cjs');

const HOST_VERSION = 3;
const integrationDir = process.env.GRAB_INTEGRATION_DIR || path.resolve(__dirname, '..');
const origin = process.argv.slice(2).find((a) => /^[a-z-]+-extension:\/\//.test(a)) || '';
let browserKind = 'unknown';
const log = (...a) => process.stderr.write('[grab-host] ' + a.join(' ') + '\n');

let socket = null;
let ready = false; // authenticated with the app
let closing = false;
let retryTimer = null;
let attempt = 0;
const queue = []; // browser -> app messages waiting for the pipe (bounded)
const identityAbort = new AbortController();

const toBrowser = (message) => {
  try { process.stdout.write(encodeFrame(message, MAX_FRAME_BYTES)); } catch (e) { log('stdout write failed', e.message); }
};
const toApp = (message) => {
  if (socket && ready) { try { socket.write(encodeFrame(message)); return true; } catch { return false; } }
  return false;
};
// The browser must learn when the app is unreachable so the extension can say so.
const appStatus = (online) => toBrowser({ v: 1, id: 'h' + Date.now().toString(36) + attempt, type: 'app-status', online });

function scheduleRetry() {
  if (closing || retryTimer) return;
  attempt += 1;
  const delay = Math.min(5000, 500 * 2 ** Math.min(attempt, 4));
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
}

function connect() {
  const token = readToken(integrationDir);
  if (!token) { appStatus(false); scheduleRetry(); return; }
  const sock = net.connect(pipePath(integrationDir));
  let challenge = null;
  socket = sock;
  ready = false;
  const parser = new FrameParser({
    onError: (e) => { log('bad frame from app', e.code); if (e.code === 'oversize') sock.destroy(); },
    onMessage: (message) => {
      if (message.type === 'challenge' && /^[0-9a-f]{32}$/.test(message.nonce)) {
        challenge = message.nonce;
        sock.write(encodeFrame({ type: 'host-hello', proof: proof(token, message.nonce), browserKind, origin, hostVersion: HOST_VERSION, pid: process.pid }));
      } else if (message.type === 'ready') {
        // Authenticate the desktop as well as the host. A process squatting on the pipe must
        // not receive queued browser messages or inject commands without knowing the token.
        if (!challenge || !proofMatches(token, 'app:' + challenge, message.proof)) {
          log('desktop authentication failed');
          sock.destroy();
          return;
        }
        ready = true;
        attempt = 0;
        appStatus(true);
        while (queue.length) toApp(queue.shift());
      } else if (message.type === 'rejected') {
        log('app rejected this host:', String(message.reason || '').slice(0, 80));
        toBrowser({ v: 1, id: 'hrej' + Date.now().toString(36), type: 'error', code: 'host_rejected', message: String(message.reason || '').slice(0, 200) });
      } else if (ready && message.type === 'relay' && message.message && typeof message.message === 'object') {
        toBrowser(message.message);
      }
    },
  });
  sock.on('data', (d) => parser.push(d));
  sock.on('error', () => {});
  sock.on('close', () => {
    if (socket === sock) { socket = null; ready = false; }
    if (closing) return;
    appStatus(false);
    scheduleRetry();
  });
}

const fromBrowser = new FrameParser({
  onError: (e) => { log('bad frame from browser', e.code); if (e.code === 'oversize') shutdown(); },
  onMessage: (message) => {
    if (toApp({ type: 'relay', message })) return;
    if (queue.length < 20) queue.push({ type: 'relay', message });
  },
});
process.stdin.on('data', (d) => fromBrowser.push(d));
// The browser closing the port (or exiting) closes stdin: leave, releasing the pipe.
process.stdin.on('end', () => shutdown());
process.stdin.on('close', () => shutdown());
process.stdin.on('error', () => shutdown());
process.stdout.on('error', () => shutdown());

function shutdown() {
  if (closing) return;
  closing = true;
  identityAbort.abort();
  clearTimeout(retryTimer);
  try { socket?.destroy(); } catch { /* already closed */ }
  setTimeout(() => process.exit(0), 20);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

require('./browser-kind.cjs').browserKind({ signal: identityAbort.signal }).then((kind) => {
  if (closing) return;
  browserKind = kind;
  connect();
});
