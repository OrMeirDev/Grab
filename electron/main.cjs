const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./engine.cjs');
const pageprobe = require('./pageprobe.cjs');
const hiddenProbe = require('./hidden-probe.cjs');
const browserSession = require('./browser-session.cjs');
const { autoUpdater } = require('electron-updater');

// App updates come from GitHub releases (see build.publish in package.json). Nothing downloads
// until the user clicks "update"; the new version installs when they restart.
let mainWindow = null;
const sendUpdate = (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
};
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', (info) => sendUpdate({ state: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'ready', version: info.version }));
autoUpdater.on('error', (e) => sendUpdate({ state: 'error', message: String(e?.message || e).slice(0, 200) }));

ipcMain.handle('update:check', () => (app.isPackaged ? autoUpdater.checkForUpdates().then(() => true).catch(() => false) : false));
ipcMain.handle('update:download', () => autoUpdater.downloadUpdate().catch(() => null));
ipcMain.handle('update:install', () => {
  for (const child of jobs.values()) child && child.kill();
  // Silent install + relaunch: the user sees Grab close and reopen, not the installer wizard.
  autoUpdater.quitAndInstall(true, true);
});
ipcMain.handle('app:version', () => app.getVersion());

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({ folder: path.join(app.getPath('downloads'), 'Grab'), format: 'mp4', quality: 'best' });

function readSettings() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return defaults(); }
}

const jobs = new Map(); // id -> child process

function createWindow() {
  // Open at a size that fits the screen; the layout is built so nothing needs page scrolling
  // down to the minimum size (only the queue list scrolls inside itself).
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1320, area.width - 40),
    height: Math.min(900, area.height - 40),
    minWidth: Math.min(1000, area.width),
    minHeight: Math.min(660, area.height),
    center: true,
    title: 'Grab',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow = win;
  // Electron windows have no right-click menu of their own: give text fields the usual one
  // (so a link can be pasted with the mouse), and offer "copy" for text selected elsewhere.
  win.webContents.on('context-menu', (_e, p) => {
    const f = p.editFlags;
    const items = p.isEditable
      ? [
        { label: 'גזור', role: 'cut', enabled: f.canCut },
        { label: 'העתק', role: 'copy', enabled: f.canCopy },
        { label: 'הדבק', role: 'paste', enabled: f.canPaste },
        { type: 'separator' },
        { label: 'בחר הכול', role: 'selectAll', enabled: f.canSelectAll },
      ]
      : p.selectionText.trim() ? [{ label: 'העתק', role: 'copy' }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // Check for an app update shortly after start, once the page is listening.
  win.webContents.once('did-finish-load', () => {
    if (!app.isPackaged) return;
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
    // Grab often stays open for hours, so keep checking while it runs.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  });

  if (process.env.VITE_DEV) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('engine:version', () => engine.version());
// When yt-dlp finds no video at the link, the link is often a page with its own small player:
// look inside it the way DevTools would, and try the video addresses found there.
const signedInSites = new Set(); // sites whose videos only the user's signed-in browser can see
ipcMain.handle('engine:analyze', async (e, url, { forcePage = false } = {}) => {
  // forcePage: what yt-dlp found at the link didn't download, so go straight to the page's player.
  const first = forcePage ? { ok: false, kind: 'notfound', error: 'Unsupported URL' } : await engine.analyze(url);
  if (first.ok || !['notfound', 'private', 'blocked', 'other'].includes(first.kind)) return first;
  const phase = (p, browserName) => { if (!e.sender.isDestroyed()) e.sender.send('engine:lookup-phase', { url, phase: p, browser: browserName }); };

  // 1. A hidden, clean browser (no cookies or accounts): works on public pages with no setup.
  //    Only when yt-dlp found no video; a clean visit doesn't get past a login or a bot check.
  //    Skipped for a site where it already failed and the user's browser found the video, so a
  //    batch of lessons from one course goes straight to the browser.
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  if (first.kind === 'notfound' && !signedInSites.has(host)) {
    phase('page');
    let hidden = { candidates: [] };
    try { hidden = await hiddenProbe.findMedia(url); } catch { /* fall through to the backup */ }
    for (const c of hidden.candidates.slice(0, 4)) {
      const r = await engine.analyze(c.url, { referer: url, title: c.kind === 'embed' ? undefined : hidden.title });
      if (r.ok) return { ...r, mediaUrl: c.url, referer: url };
    }
    if (hidden.protected) return { ok: false, kind: 'protected', error: 'DRM' };
  }

  // 2. Backup: the user's default browser, where they are signed in, when its remote debugging is
  //    on. If it isn't, report what the clean lookup found, with how to turn it on.
  const browser = browserSession.defaultBrowser();
  phase('browser', browser.name);
  const connect = () => browserSession.connectBrowser({ browser });
  let probe;
  try {
    probe = await pageprobe.findMedia(url, { refresh: forcePage, connect });
    // A blob player may have loaded its manifest before attachment and discarded resource entries.
    if (probe.reusedTab && !probe.candidates.length) probe = await pageprobe.findMedia(url, { refresh: true, connect });
  }
  catch (err) {
    if (err.kind === 'browserContext') return { ...first, kind: 'browserContext', browser: { name: browser.name } };
    // The browser can't be reached (closed, debugging off, or not supported): say how to fix it.
    const hint = ['browserSession', 'browserUnsupported'].includes(err.kind)
      ? { browser: { name: browser.name, scheme: browser.scheme, supported: browser.supported !== false } } : {};
    return first.kind === 'notfound' ? { ...first, kind: 'notfoundPage', ...hint } : { ...first, ...hint };
  }
  return browserSession.withSessionCookies(probe.cookieRef, async (cookieFile) => {
    // An authenticated extractor may understand the page better than its embedded sources.
    if (!forcePage && ['private', 'blocked'].includes(first.kind)) {
      const authenticated = await engine.analyze(url, { cookieFile, requestContext: probe.requestContext });
      if (authenticated.ok) return { ...authenticated, cookieRef: probe.cookieRef, requestContext: probe.requestContext };
    }
    let last;
    for (const c of probe.candidates) {
      const requestContext = c.requestContext;
      const r = await engine.analyze(c.url, { cookieFile, requestContext, referer: url, title: c.kind === 'embed' ? undefined : probe.title });
      if (r.ok) {
        if (first.kind === 'notfound') signedInSites.add(host);
        return { ...r, mediaUrl: c.url, referer: requestContext?.referer || url, requestContext, cookieRef: probe.cookieRef };
      }
      last = r;
    }
    if (probe.protected) return { ok: false, kind: 'protected', error: 'DRM' };
    if (last && ['private', 'blocked', 'network'].includes(last.kind)) return last;
    return { ...first, kind: 'notfoundPage' };
  });
});
// The sign-in guide names the user's own browser and can check that Grab reaches it.
ipcMain.handle('browser:default', () => {
  const b = browserSession.defaultBrowser();
  return { name: b.name, scheme: b.scheme, supported: b.supported !== false };
});
ipcMain.handle('browser:check', async () => {
  try { await browserSession.connectBrowser({ browser: browserSession.defaultBrowser() }); return { ok: true }; }
  catch (err) { return { ok: false, kind: err.kind }; }
});
ipcMain.handle('engine:extractors', () => engine.extractors());
ipcMain.handle('engine:update', () => {
  // Windows can't replace yt-dlp.exe while a download is using it.
  if (jobs.size) return { ok: false, busy: true };
  return engine.updateEngine();
});

ipcMain.handle('engine:start', async (e, job) => {
  fs.mkdirSync(job.folder, { recursive: true });
  return browserSession.withSessionCookies(job.cookieRef, async (cookieFile) => {
    const { child, done } = engine.download({ ...job, cookieFile }, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('engine:progress', { id: job.id, ...p });
    });
    jobs.set(job.id, child);
    try {
      const result = await done;
      return jobs.get(job.id) === null ? { ok: false, stopped: true } : result;
    } finally { jobs.delete(job.id); }
  });
});

ipcMain.handle('engine:stop', (_e, id) => {
  const child = jobs.get(id);
  if (child) {
    jobs.set(id, null);
    child.kill();
  }
});

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, s) => {
  const next = { ...readSettings(), ...s };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
});

const historyFile = () => path.join(app.getPath('userData'), 'history.json');
function readHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch { return []; }
}
function writeHistory(list) {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify(list.slice(0, 1000), null, 2));
}
ipcMain.handle('history:get', () => readHistory());
ipcMain.handle('history:add', (_e, entry) => writeHistory([{ ...entry, completedAt: new Date().toISOString() }, ...readHistory()]));
ipcMain.handle('history:clear', () => writeHistory([]));

const MEDIA = /\.(mp4|mkv|webm|mov|m4a|mp3|opus|wav|flac)$/i;
ipcMain.handle('library:list', (_e, dir) => {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (ent.isFile() && MEDIA.test(ent.name)) {
        const st = fs.statSync(p);
        out.push({ file: p, name: ent.name, folder: path.relative(dir, d), size: st.size, modified: st.mtime.toISOString() });
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
});
ipcMain.handle('file:open', (_e, file) => shell.openPath(file));
ipcMain.handle('file:exists', (_e, file) => !!file && fs.existsSync(file));

ipcMain.handle('folder:choose', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('folder:show', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('folder:open', (_e, dir) => { fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir); });

app.whenReady().then(async () => {
  engine.setUserBinDir(path.join(app.getPath('userData'), 'bin'));
  await engine.reconcileEngine();
  engine.cleanInfoCache();
  createWindow();
});
app.on('window-all-closed', () => {
  for (const child of jobs.values()) child && child.kill();
  app.quit();
});
app.on('before-quit', browserSession.disconnectBrowser);
