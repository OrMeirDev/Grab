// T07 updater probe (docs/audits/). Electron main; run through run-updater-probe.cjs.
//
// Uses the checkout's own electron-updater, configured as electron/main.cjs configures it
// (autoDownload off), in a throwaway profile:
//   pass "generic": an update feed on the loopback audit endpoint -> exact request headers
//   pass "github":  Grab's real publish config (OrMeirDev/Grab), but every request goes to the
//                   audit endpoint via --proxy-server, which logs the host and refuses it
// Two checks per pass show whether an identifier repeats across checks and restarts.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = JSON.parse(process.env.GRAB_AUDIT_CONFIG);
const { app } = require('electron');
const { createEndpoint } = require('./diag-endpoint.cjs');

app.setPath('userData', path.join(cfg.out, 'profile'));
const pkg = JSON.parse(fs.readFileSync(path.join(cfg.app, 'package.json'), 'utf8'));
app.getVersion = () => pkg.version;
const out = path.join(cfg.out, `updater-${cfg.pass}.jsonl`);
const note = (o) => { fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), pass: cfg.pass, run: cfg.run, ...o }) + '\n'); console.log('[updater]', JSON.stringify(o).slice(0, 300)); };

app.whenReady().then(async () => {
  const endpoint = createEndpoint({ log: path.join(cfg.out, 'requests.jsonl'), updateVersion: '0.0.1',
    // equality check only: a short hash of the staging id, never the id itself
    onRecord: (r) => note({ request: { method: r.method, host: r.host, path: r.path, status: r.status, userAgent: r.userAgent, xUserStagingId: r.xUserStagingId, otherHeaders: r.otherHeaders } }) });
  const http = endpoint.server;
  http.prependListener('request', (req) => { if (req.headers['x-user-staging-id']) note({ stagingIdHash: crypto.createHash('sha256').update(req.headers['x-user-staging-id']).digest('hex').slice(0, 12) }); });
  const port = await endpoint.listen(cfg.port);
  const { autoUpdater } = require(path.join(cfg.app, 'node_modules', 'electron-updater'));
  autoUpdater.autoDownload = false; // as electron/main.cjs
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.forceDevUpdateConfig = true;
  const yml = path.join(cfg.out, `app-update-${cfg.pass}.yml`);
  fs.writeFileSync(yml, cfg.pass === 'generic'
    ? `provider: generic\nurl: http://127.0.0.1:${port}/update/\nupdaterCacheDirName: grab-updater\n`
    : `owner: OrMeirDev\nrepo: Grab\nprovider: github\nreleaseType: release\nupdaterCacheDirName: grab-updater\n`);
  autoUpdater.updateConfigPath = yml;
  for (let i = 1; i <= 2; i++) {
    try { const r = await autoUpdater.checkForUpdates(); note({ check: i, ok: true, version: r?.updateInfo?.version || null }); }
    catch (e) { note({ check: i, ok: false, error: String(e.message || e).split('\n')[0].slice(0, 160) }); }
  }
  const idFile = path.join(app.getPath('userData'), '.updaterId');
  note({ updaterIdFile: fs.existsSync(idFile), updaterIdHash: fs.existsSync(idFile) ? crypto.createHash('sha256').update(fs.readFileSync(idFile, 'utf8')).digest('hex').slice(0, 12) : null });
  endpoint.close();
  app.exit(0);
});
