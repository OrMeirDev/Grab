// Real Electron sessions/updater against a refusing local proxy. No accounts or public sites.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  const privacy = require('../electron/security/network-privacy.cjs');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-network-e2e-'));
  app.setPath('userData', profile);
  app.getVersion = () => '1.7.0';
  app.on('window-all-closed', () => {});
  privacy.configureApplicationPrivacy(app);
  const idle = Math.min(300000, Math.max(0, Number(process.env.GRAB_PRIVACY_IDLE_MS) || 3000));
  app.whenReady().then(async () => {
    let window;
    try {
      privacy.configureSessionPrivacy(session.defaultSession);
      window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
      await window.loadURL('http://thumbnail.test/thumb.png');
      const probe = await require('../electron/hidden-probe.cjs').findMedia('http://probe.test/watch', { timeoutMs: 3500 });
      assert.ok(probe.candidates.some((r) => r.url === 'http://probe.test/clip.mp4'));
      const { autoUpdater } = require('electron-updater');
      privacy.configureUpdaterPrivacy(autoUpdater);
      autoUpdater.autoDownload = false;
      autoUpdater.forceDevUpdateConfig = true;
      const config = path.join(profile, 'test-update.yml');
      fs.writeFileSync(config, `provider: generic\nurl: ${process.env.GRAB_PRIVACY_PROXY}/update/\nupdaterCacheDirName: grab-test-only\n`);
      autoUpdater.updateConfigPath = config;
      await autoUpdater.checkForUpdates();
      await autoUpdater.checkForUpdates();
      await new Promise((resolve) => setTimeout(resolve, idle));
      console.log('PRIVACY_CHILD_PASS');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
} else {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const { spawn } = require('node:child_process');
  const MEDIA = require('../tests/fixtures/sample-media.cjs');
  const { STAGING_ID } = require('../electron/security/network-privacy.cjs');
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    seen.push({ host: url.hostname, path: url.pathname, ua: req.headers['user-agent'], staging: req.headers['x-user-staging-id'] });
    if (url.pathname.startsWith('/update/')) {
      const hash = crypto.createHash('sha512').update('fixture').digest('base64');
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end(`version: 0.0.1\nfiles:\n  - url: fixture.exe\n    sha512: ${hash}\n    size: 7\npath: fixture.exe\nsha512: ${hash}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);
    } else if (url.hostname === 'probe.test' && url.pathname === '/watch') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Privacy fixture</title><video preload="auto" src="http://probe.test/clip.mp4"></video>');
    } else if (url.hostname === 'probe.test' && url.pathname === '/clip.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MEDIA.length }); res.end(MEDIA);
    } else if (url.hostname === 'thumbnail.test') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTeQAAAAASUVORK5CYII=', 'base64'));
    } else { res.writeHead(502); res.end(); }
  });
  server.on('connect', (req, socket) => { seen.push({ host: req.url.split(':')[0], connect: true }); socket.end('HTTP/1.1 502 Refused\r\nConnection: close\r\n\r\n'); });
  server.listen(0, '127.0.0.1', () => {
    const proxy = `http://127.0.0.1:${server.address().port}`;
    const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...(process.env.GRAB_HEADLESS_E2E ? ['--ozone-platform=headless'] : []), `--proxy-server=${proxy}`, __filename];
    const child = spawn(require('electron'), args, { env: { ...process.env, GRAB_PRIVACY_PROXY: proxy }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => err = (err + d).slice(-16000));
    const timer = setTimeout(() => child.kill(), 350000);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, err);
        assert.match(out, /PRIVACY_CHILD_PASS/);
        for (const host of ['thumbnail.test', 'probe.test']) {
          const requests = seen.filter((r) => r.host === host);
          assert.ok(requests.length, host);
          for (const r of requests) assert.doesNotMatch(r.ua || '', /(?:Grab|Electron)\//);
        }
        const checks = seen.filter((r) => r.path?.startsWith('/update/'));
        assert.equal(checks.length, 2);
        for (const r of checks) assert.equal(r.staging, STAGING_ID);
        assert.deepEqual(seen.filter((r) => !['thumbnail.test', 'probe.test', '127.0.0.1'].includes(r.host)), []);
        console.log('PASS: actual Electron UA, two updater requests, fresh probe and idle capture contain no app version tokens, per-install staging ID or dictionary/third-party contact.');
      } catch (error) { console.error(error); process.exitCode = 1; }
      server.closeAllConnections(); server.close();
    });
  });
}
