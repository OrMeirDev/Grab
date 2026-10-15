const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./engine.cjs');
const pageprobe = require('./pageprobe.cjs');
const hiddenProbe = require('./hidden-probe.cjs');
const browserSession = require('./browser-session.cjs');
const { BrowserService } = require('./browser/service.cjs');
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
    backgroundColor: '#f4f8fe',
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
const analyzeControllers = new Map(); // queue item id -> AbortController for the whole lookup
ipcMain.handle('engine:analyze', async (e, url, opts = {}) => {
  const ctl = new AbortController();
  if (opts.id != null) analyzeControllers.set(opts.id, ctl);
  try {
    const result = await analyzeImpl(e, url, opts, ctl.signal);
    return ctl.signal.aborted ? { ok: false, kind: 'cancelled', error: 'Cancelled' } : result;
  } finally { if (analyzeControllers.get(opts.id) === ctl) analyzeControllers.delete(opts.id); }
});
ipcMain.handle('engine:cancel-analyze', (_e, id) => {
  const ctl = analyzeControllers.get(id);
  if (ctl) ctl.abort();
  if (browserService) browserService.cancel(id);
  return !!ctl;
});

async function analyzeImpl(e, url, { forcePage = false, id, browser: pickedBrowser, instance: pickedInstance, ref, choice } = {}, signal) {
  // forcePage: what yt-dlp found at the link didn't download, so go straight to the page's player.
  const svc = browserService;
  const resolved = svc ? svc.resolve(url, { browser: pickedBrowser }) : null;
  const extSetUp = !!(svc && resolved && resolved.browserId && svc.isSetUp(resolved.browserId));
  const extensionAnalyze = () => svc.analyze(url, { itemId: id, browser: pickedBrowser, instance: pickedInstance, ref, choice, refresh: forcePage, signal });
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  // A browser that has the Grab extension set up is used first for sites with a browser rule (Mako -> Edge)
  // and for explicit choices / Send to GRAB. Without the extension the remote-debugging lookup below is unchanged.
  if (extSetUp && (resolved.source === 'site-rule' || signedInSites.has(host) || forcePage || ref || pickedBrowser || pickedInstance || choice)) return extensionAnalyze();
  // A site with a browser rule must reach that browser before a page extractor or anonymous probe can accept another source.
  const edgeFirst = resolved ? resolved.source === 'site-rule' : browserSession.isMakoPage(url);
  const first = forcePage || edgeFirst ? { ok: false, kind: 'notfound', error: 'Unsupported URL' } : await engine.analyze(url, { signal });
  if (signal.aborted) return { ok: false, kind: 'cancelled', error: 'Cancelled' };
  if (first.httpStatus === 429) return first;
  if (first.ok || !['notfound', 'notmedia', 'private', 'blocked', 'forbidden', 'other'].includes(first.kind)) return first;
  const missingMedia = ['notfound', 'notmedia'].includes(first.kind);
  const phase = (p, browserName) => { if (!e.sender.isDestroyed()) e.sender.send('engine:lookup-phase', { url, phase: p, browser: browserName }); };
  // A configured extension owns browser-assisted lookup even if its browser is currently closed.
  // Do not divert that job through a clean browser or silently require legacy remote debugging.
  if (extSetUp) return extensionAnalyze();

  // 1. A hidden, clean browser (no cookies or accounts): works on public pages with no setup.
  //    Only when yt-dlp found no video; a clean visit doesn't get past a login or a bot check.
  //    Skipped for a site where it already failed and the user's browser found the video, so a
  //    batch of lessons from one course goes straight to the browser.
  if (!edgeFirst && missingMedia && !signedInSites.has(host)) {
    phase('page');
    let hidden = { candidates: [] };
    try { hidden = await hiddenProbe.findMedia(url); } catch { /* fall through to the backup */ }
    const resolved = await browserSession.withSessionCookies(hidden.cookieRef, async (cookieFile) => {
      for (const c of hidden.candidates.slice(0, 4)) {
        const requestContext = c.requestContext;
        const r = await engine.analyze(c.url, { cookieFile, requestContext, referer: url, title: c.kind === 'embed' ? undefined : hidden.title });
        if (r.ok) return { ...r, mediaUrl: c.url, referer: requestContext?.referer ?? url, requestContext, cookieRef: hidden.cookieRef };
      }
    });
    if (resolved) return resolved;
    if (hidden.protected) return { ok: false, kind: 'protected', error: 'DRM' };
  }

  // 2. Backup: Edge for Mako, otherwise the user's default browser, when remote debugging is
  //    on. If it isn't, report what the clean lookup found, with how to turn it on.
  const browser = browserSession.browserForPage(url, resolved && resolved.browserId);
  phase('browser', browser.name);
  const connect = () => browserSession.connectBrowser({ browser });
  let probe;
  let refreshed = forcePage;
  try {
    probe = await pageprobe.findMedia(url, { refresh: forcePage, connect });
    // A tracking iframe is not evidence that the existing blob player's source was found.
    if (probe.reusedTab && !probe.candidates.some((c) => c.kind !== 'embed')) {
      probe = await pageprobe.findMedia(url, { refresh: true, connect });
      refreshed = true;
    }
  }
  catch (err) {
    if (err.kind === 'browserContext') return { ...first, kind: 'browserContext', browser: { name: browser.name } };
    // The browser can't be reached (closed, debugging off, or not supported): say how to fix it.
    const hint = ['browserSession', 'browserUnsupported'].includes(err.kind)
      ? { browser: { name: browser.name, scheme: browser.scheme, supported: browser.supported !== false } } : {};
    return missingMedia ? { ...first, kind: 'notfoundPage', ...hint } : { ...first, ...hint };
  }
  const analyzeProbe = (probe) => browserSession.withSessionCookies(probe.cookieRef, async (cookieFile) => {
    // An authenticated extractor may understand the page better than its embedded sources.
    if (!forcePage && ['private', 'blocked', 'forbidden'].includes(first.kind)) {
      const authenticated = await engine.analyze(url, { cookieFile, requestContext: probe.requestContext });
      if (authenticated.ok) return { ...authenticated, cookieRef: probe.cookieRef, requestContext: probe.requestContext };
    }
    let last;
    for (const c of probe.candidates) {
      const requestContext = c.requestContext;
      const r = await engine.analyze(c.url, { cookieFile, requestContext, referer: url, title: c.kind === 'embed' ? undefined : probe.title });
      if (r.ok) {
        if (missingMedia) signedInSites.add(host);
        return { ...r, mediaUrl: c.url, referer: requestContext?.referer ?? url, requestContext, cookieRef: probe.cookieRef };
      }
      if (!last || ['private', 'blocked', 'forbidden', 'network'].includes(r.kind)) last = r;
    }
    if (probe.protected) return { ok: false, kind: 'protected', error: 'DRM' };
    if (last && ['private', 'blocked', 'forbidden', 'network'].includes(last.kind)) return last;
    return first.kind === 'forbidden' ? first : { ...first, kind: 'notfoundPage' };
  });
  const result = await analyzeProbe(probe);
  // An already-open blob player can expose an old manifest via performance entries but no
  // longer expose the headers that authenticated it. Refresh only in our own background tab,
  // in the same authorized browser context, once; leave the user's tab untouched.
  if (!result.ok && ['forbidden', 'notfoundPage'].includes(result.kind) && probe.reusedTab && !refreshed) {
    try { return await analyzeProbe(await pageprobe.findMedia(url, { refresh: true, connect })); }
    catch { return result; }
  }
  return result;
}
// The guide and its connection check use the same per-page browser as lookup.
ipcMain.handle('browser:default', (_e, pageUrl) => {
  const sel = browserService ? browserService.resolve(pageUrl) : null;
  const b = browserSession.browserForPage(pageUrl, sel && sel.browserId);
  return { name: b.name, scheme: b.scheme, supported: b.supported !== false };
});
ipcMain.handle('browser:check', async (_e, pageUrl) => {
  try {
    const sel = browserService ? browserService.resolve(pageUrl) : null;
    await browserSession.connectBrowser({ browser: browserSession.browserForPage(pageUrl, sel && sel.browserId) });
    return { ok: true };
  }
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
    if (job.browserRef && browserService) browserService.reportJob(job.browserRef, { phase: 'downloading' });
    const { child, done } = engine.download({ ...job, cookieFile, ...(browserService ? { idleMs: browserService.deadlines().downloadIdleMs } : {}) }, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('engine:progress', { id: job.id, ...p });
    });
    jobs.set(job.id, child);
    try {
      const result = await done;
      const outcome = jobs.get(job.id) === null ? { ok: false, stopped: true } : result;
      // "Completed" is reported to the browser only for a file that was really produced and verified.
      if (outcome.ok && job.browserRef && browserService) browserService.reportJob(job.browserRef, { phase: 'completed', terminal: 'completed' });
      return outcome;
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

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
ipcMain.handle('settings:get', () => readSettings());
// Browser integration settings are validated and saved only through browser:set.
ipcMain.handle('settings:set', (_e, s) => {
  const { browser: _browser, ...allowed } = s || {};
  return writeSettings(allowed);
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

// ---- browser integration (extension bridge, browser selection) ----
let browserService = null;
let browserServiceError = '';
const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
// Asks the window whether an incoming "Send to GRAB" is new; resolves with its answer or 'unavailable'.
const askRenderer = (channel, payload, timeoutMs) => new Promise((resolve) => {
  if (!mainWindow || mainWindow.isDestroyed()) return resolve('unavailable');
  const reply = channel + '-reply:' + payload.ref;
  const timer = setTimeout(() => { ipcMain.removeAllListeners(reply); resolve('unavailable'); }, timeoutMs);
  ipcMain.once(reply, (_e, status) => { clearTimeout(timer); resolve(status); });
  mainWindow.webContents.send(channel, payload);
});
async function startBrowserService() {
  const svc = new BrowserService({
    appVersion: app.getVersion(),
    sourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    getSettings: readSettings,
    saveSettings: writeSettings,
    notify: sendToWindow,
    askRenderer,
    engine,
    session: browserSession,
  });
  await svc.init();
  browserService = svc;
  sendToWindow('browser:changed', null);
}
const unavailable = { unavailable: true };
ipcMain.handle('browser:state', () => (browserService ? browserService.state() : { ...unavailable, error: browserServiceError }));
ipcMain.handle('browser:refresh', () => (browserService ? browserService.refresh() : unavailable));
ipcMain.handle('browser:set', (_e, patch) => (browserService ? browserService.setSettings(patch) : unavailable));
ipcMain.handle('browser:resolve', (_e, url, explicit) => (browserService ? browserService.resolve(String(url || ''), { browser: explicit }) : unavailable));
ipcMain.handle('browser:setup', (_e, opts) => (browserService ? browserService.setup(opts) : unavailable));
ipcMain.handle('browser:uninstall', () => (browserService ? browserService.uninstall() : unavailable));
ipcMain.handle('browser:test', (_e, browserId) => (browserService ? browserService.test(browserId) : unavailable));
ipcMain.handle('browser:reveal-playback', (_e, id) => (browserService ? browserService.revealPlayback(id) : false));
ipcMain.handle('browser:job-report', (_e, ref, report) => (browserService ? browserService.reportJob(String(ref), report || {}) : false));
ipcMain.handle('browser:open-extension-folder', () => {
  if (!browserService) return false;
  const dir = browserService.state().extensionDir;
  if (!dir || !fs.existsSync(dir)) return false;
  shell.openPath(dir);
  return true;
});

// One Grab at a time: opening it again brings the open window to the front instead.
const focusMain = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', focusMain);

app.whenReady().then(async () => {
  engine.setUserBinDir(path.join(app.getPath('userData'), 'bin'));
  await engine.reconcileEngine();
  engine.cleanInfoCache();
  createWindow();
  startBrowserService().catch((err) => {
    browserServiceError = 'לא ניתן להפעיל את החיבור לדפדפן. הפעל מחדש את Grab ובדוק שקבצי ההתקנה קיימים.';
    console.error('Browser integration failed to start:', err && err.message);
    sendToWindow('browser:changed', null);
  });
});
app.on('window-all-closed', () => {
  for (const child of jobs.values()) child && child.kill();
  app.quit();
});
app.on('before-quit', () => { browserSession.disconnectBrowser(); if (browserService) browserService.shutdown(); });
