// Electron main for the network-privacy audit: runs a checkout's REAL electron/main.cjs (window,
// coordinator, discovery, hidden probe, yt-dlp, history, queue, diagnostics) in a throwaway
// profile and temp folder, drives scenarios through the e2e hook (main.cjs exports __e2e only
// when not packaged), and logs every request that reaches the loopback audit endpoint.
// Start it with run-real-app.cjs, not directly. Nothing here touches the real Grab profile.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = JSON.parse(process.env.GRAB_AUDIT_CONFIG);
const OUT = cfg.out;
// short: Chromium's singleton socket lives under the temp folder (Unix socket paths are short)
const TMP = cfg.tmp;
fs.mkdirSync(TMP, { recursive: true });
// before anything reads os.tmpdir(): cookie jars and lookup files land where they can be inspected
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

const { app, BrowserWindow, session } = require('electron');
const { createEndpoint, makeTestCert } = require('./diag-endpoint.cjs');

app.setPath('userData', path.join(OUT, 'profile'));
const pkg = JSON.parse(fs.readFileSync(path.join(cfg.app, 'package.json'), 'utf8'));
app.getVersion = () => pkg.version;

const phases = path.join(OUT, 'phases.jsonl');
const mark = (phase, data = {}) => {
  const line = { at: new Date().toISOString(), phase, ...data };
  fs.appendFileSync(phases, JSON.stringify(line) + '\n');
  console.log(`[audit] ${phase} ${JSON.stringify(data).slice(0, 300)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpEntries = () => fs.readdirSync(TMP).flatMap((n) => {
  const p = path.join(TMP, n);
  return fs.statSync(p).isDirectory() ? [n + '/', ...fs.readdirSync(p).map((m) => `${n}/${m}`)] : [n];
});

app.whenReady().then(async () => {
  const endpoint = createEndpoint({ media: cfg.media, log: path.join(OUT, 'requests.jsonl') });
  // Instrumentation for the thumbnail check only: Grab's CSP allows https: images, so the row's
  // thumbnail is served over TLS for one synthetic host. The test certificate is accepted for
  // *.grab-audit.test in this throwaway profile and nowhere else; real sites are never proxied.
  const tls = makeTestCert(path.join(OUT, 'tls'));
  if (tls) {
    endpoint.enableTls(tls);
    app.on('certificate-error', (event, _wc, url, _err, _cert, callback) => {
      if (new URL(url).hostname.endsWith('.grab-audit.test')) { event.preventDefault(); callback(true); } else callback(false);
    });
  }
  const port = await endpoint.listen(cfg.port || 0);
  if (tls && !cfg.chromiumProxy) await session.defaultSession.setProxy({ proxyRules: `127.0.0.1:${port}` });
  const local = (p) => `http://127.0.0.1:${port}${p}`;
  mark('start', { app: cfg.app, version: pkg.version, electron: process.versions.electron, userAgentFallback: app.userAgentFallback, port });

  const main = require(path.join(cfg.app, 'electron', 'main.cjs'));
  const { coordinator } = main.__e2e;
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(50);
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  mark('window-ready');

  const job = (url) => coordinator.jobs.find((j) => j.url === url);
  const waitFor = async (url, states, ms = 180000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const j = job(url); if (j && states.includes(j.status)) return j; await sleep(250); }
    return job(url);
  };
  const runDownload = async (name, url, { expectSize } = {}) => {
    mark(`${name}:add`, { url: name.includes('signed') ? '<signed synthetic url>' : url });
    coordinator.add([{ url, label: '' }]);
    let j = await waitFor(url, ['ready', 'error', 'done']);
    mark(`${name}:lookup`, { status: j?.status, kind: j?.error?.kind || null, sessionSource: j?.sessionSource || null, hasCookieRef: !!j?.cookieRef, hasInfoFile: !!j?.infoFile });
    if (j?.status !== 'ready') return j;
    coordinator.downloadOne(j.id);
    j = await waitFor(url, ['done', 'error'], 600000);
    const size = j?.file && fs.existsSync(j.file) ? fs.statSync(j.file).size : null;
    mark(`${name}:done`, { status: j?.status, kind: j?.error?.kind || null, size, sizeMatches: expectSize ? size === expectSize : undefined, tmpAfter: tmpEntries() });
    return j;
  };
  const expectSize = fs.statSync(cfg.media).size;

  // T01: idle, nothing pasted (packaged builds would also check for updates here; see T07)
  mark('T01:idle-begin', { seconds: cfg.idle });
  await sleep(cfg.idle * 1000);
  mark('T01:idle-end');

  // T02: an ordinary pasted direct link, no browser or extension
  await runDownload('T02-local', local('/media/HSSMT.mp4'), { expectSize });
  if (cfg.remoteUrl) await runDownload('T02-remote', cfg.remoteUrl, { expectSize: cfg.remoteSize || expectSize });

  // T06 input: a pasted link that carries a (synthetic) signed query string
  await runDownload('T06-signed', local('/media/HSSMT.mp4?token=SYNTHTOKEN0123456789&Expires=9999999999&sig=SYNTHSIG'), { expectSize });

  // Hidden-probe fallback: the video only appears after a script runs
  await runDownload('HP-hidden-probe', local('/jspage.html'), { expectSize });

  // Cancellation: a probe session (page cookie) + slow media; remove the job mid-download
  const slow = local('/jspage.html?v=slow');
  coordinator.add([{ url: slow, label: '' }]);
  let s = await waitFor(slow, ['ready', 'error']);
  mark('CANCEL:lookup', { status: s?.status, hasCookieRef: !!s?.cookieRef, hasInfoFile: !!s?.infoFile });
  if (s?.status === 'ready') {
    coordinator.downloadOne(s.id);
    await waitFor(slow, ['downloading']);
    await sleep(4000);
    mark('CANCEL:during', { tmp: tmpEntries() });
    coordinator.remove(s.id);
    await sleep(3000);
    mark('CANCEL:after-remove', { tmp: tmpEntries(), stillInQueue: !!job(slow) });
  }

  // Renderer thumbnail: what Grab's own window sends when a queue row shows a thumbnail
  main.__e2e.seedQueue([{ id: 'thumb1', url: 'https://example.invalid/v', name: 'thumb check', status: 'ready', progress: 0, thumbnail: tls ? 'https://thumbs.grab-audit.test/thumb.jpg' : local('/thumb.jpg') }]);
  await sleep(2500);
  win.webContents.reload();
  await sleep(3000);
  mark('THUMB:after-reload');

  mark('finish', { tmp: tmpEntries() });
  endpoint.close();
  app.quit(); // runs Grab's own before-quit shutdown (queue save, engine stop, jar cleanup)
  setTimeout(() => app.exit(0), 20000);
}).catch((e) => { mark('harness-error', { error: String(e && e.stack || e) }); app.exit(1); });
