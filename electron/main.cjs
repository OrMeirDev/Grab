// Composition root of the main process: creates the window, builds the services and exposes them
// to the renderer through guarded IPC channels (each one checks the sender and its arguments; see
// ipc/router.cjs and ipc/contracts.cjs). Business logic lives in the modules required below.
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./engine.cjs');
const pageprobe = require('./pageprobe.cjs');
const hiddenProbe = require('./hidden-probe.cjs');
const browserSession = require('./browser-session.cjs');
const { autoUpdater } = require('electron-updater');
const { createRouter, trustedFrame } = require('./ipc/router.cjs');
const { t } = require('./ipc/contracts.cjs');
const { appUrlMatcher, hardenWindow, restrictPermissions } = require('./security/window-policy.cjs');
const { SettingsRepository, HistoryRepository } = require('./infrastructure/repositories.cjs');
const { OutputAllocator } = require('./infrastructure/output-allocator.cjs');
const { listLibrary, MEDIA } = require('./infrastructure/library-indexer.cjs');
const { createDiscoveryService } = require('./application/discovery-service.cjs');
const { createDownloadRunner } = require('./application/download-runner.cjs');
const { DownloadCoordinator } = require('./application/download-coordinator.cjs');
const { JsonStore } = require('./infrastructure/json-store.cjs');
const { FORMATS, QUALITIES } = require('./domain/records.cjs');
const { Diagnostics } = require('./infrastructure/diagnostics.cjs');
const { BrowserService } = require('./browser/service.cjs');
const { configureApplicationPrivacy, configureSessionPrivacy, configureUpdaterPrivacy } = require('./security/network-privacy.cjs');
configureApplicationPrivacy(app);
configureUpdaterPrivacy(autoUpdater);

const DEV_URL = process.env.VITE_DEV ? 'http://localhost:5173' : null;
const INDEX_FILE = path.join(__dirname, '..', 'dist', 'index.html');
const isAppUrl = appUrlMatcher({ indexFile: INDEX_FILE, devUrl: DEV_URL });

let mainWindow = null;
const router = createRouter({ ipcMain, isTrusted: trustedFrame(() => mainWindow, isAppUrl) });

// ---- services -------------------------------------------------------------------------------
const settingsRepo = new SettingsRepository(app.getPath('userData'), {
  folder: path.join(app.getPath('downloads'), 'Grab'), format: 'mp4', quality: 'best',
});
const historyRepo = new HistoryRepository(app.getPath('userData'));
const allocator = new OutputAllocator();
// Redacted facts about lookups and downloads for support (no cookies, headers or signed links).
const diagnostics = new Diagnostics({ dir: path.join(app.getPath('userData'), 'logs') });
let browserService = null;
let browserServiceError = '';
let coordinatorReady = false;
const { createPdfDownloader } = require('./infrastructure/pdf-downloader.cjs');
const pdf = createPdfDownloader();
const discovery = createDiscoveryService({ pdf, engine, hiddenProbe, pageprobe, browserSession, getBrowserService: () => browserService, record: (e, d) => diagnostics.record(e, d) });
const downloadRunner = createDownloadRunner({ pdf, engine, browserSession, allocator });

// The download queue's single owner. Its snapshots go to the window; it survives a renderer
// reload, and its non-sensitive state survives a restart (queue.json).
const coordinator = new DownloadCoordinator({
  discover: (url, options) => discovery.analyze(url, options),
  startDownload: (plan, onProgress) => {
    fs.mkdirSync(plan.folder, { recursive: true });
    const started = Date.now();
    const run = downloadRunner.start({ ...plan, idleMs: browserService?.deadlines().downloadIdleMs }, onProgress);
    run.done.then((r) => diagnostics.record('download', {
      url: plan.mediaUrl || plan.url, ok: !!r.ok, kind: r.ok ? null : r.kind || null, stopped: !!r.stopped,
      error: r.ok ? null : r.error || null, ms: Date.now() - started, delivered: r.delivered || null, format: plan.format, quality: plan.quality,
    }));
    return run;
  },
  getSettings: () => settingsRepo.get(),
  recordCompletion: (entry) => historyRepo.add(entry),
  // A job's private lookup data ends with it: its cookie snapshot, its lookup file, its file name.
  hasSession: (cookieRef) => browserSession.hasCookies(cookieRef),
  releaseContext: (job, { finished }) => {
    if (job.cookieRef) browserSession.forgetCookies(job.cookieRef);
    if (job.cookieRef) browserService?.releaseSession(job.cookieRef);
    if (job.infoFile) engine.releaseInfo(job.infoFile);
    if (finished && job.id) allocator.release(job.id);
  },
  store: new JsonStore(path.join(app.getPath('userData'), 'queue.json'), { fallback: [] }),
  reportJob: (ref, report) => browserService?.reportJob(ref, report),
  onChange: (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:changed', snapshot);
  },
});

// Folders the user picked in the folder dialog (plus the default): the only ones settings accept.
const approvedFolders = new Set([path.join(app.getPath('downloads'), 'Grab')]);

// A file the renderer may open or reveal: one Grab recorded in history, or a media file inside
// the download folder. Anything else (another path on the disk) is refused.
async function isApprovedFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  if (await historyRepo.has(file)) return true;
  const { folder } = await settingsRepo.get();
  if (!MEDIA.test(file)) return false;
  try {
    const real = fs.realpathSync.native(file);
    const root = fs.realpathSync.native(folder);
    const rel = path.relative(root, real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

// ---- app updates ----------------------------------------------------------------------------
// App updates come from GitHub releases (see build.publish in package.json). Nothing downloads
// until the user clicks "update"; the new version installs when they restart.
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

router.handle('update:check', [], () => (app.isPackaged ? autoUpdater.checkForUpdates().then(() => true).catch(() => false) : false));
router.handle('update:download', [], () => autoUpdater.downloadUpdate().catch(() => null));
router.handle('update:install', [], async () => {
  // Downloads are stopped (kept as paused) and their process trees have exited before the
  // installer replaces Grab.
  quitting = true;
  await coordinator.shutdown();
  await engine.stopAll(10000);
  browserService?.shutdown();
  browserSession.disconnectBrowser();
  // Silent install + relaunch: the user sees Grab close and reopen, not the installer wizard.
  autoUpdater.quitAndInstall(true, true);
});
router.handle('app:version', [], () => app.getVersion());

// ---- window ---------------------------------------------------------------------------------
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
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow = win;
  hardenWindow(win, isAppUrl);
  restrictPermissions(win.webContents.session, (contents) => !!contents && contents === mainWindow?.webContents);
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
    const checkAutomatically = async () => {
      if ((await settingsRepo.get()).automaticUpdateChecks) await autoUpdater.checkForUpdates().catch(() => {});
    };
    setTimeout(checkAutomatically, 3000);
    // Keep security updates discoverable, unless the user explicitly disabled background checks.
    const timer = setInterval(checkAutomatically, 4 * 60 * 60 * 1000);
    win.on('closed', () => clearInterval(timer));
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(INDEX_FILE);
}

// ---- engine and lookups ---------------------------------------------------------------------
const requestContextSchema = t.optional(t.object({
  userAgent: t.optional(t.string({ max: 1024 })),
  // what the player's request carried; not always an http(s) page (about:srcdoc frames)
  referer: t.optional(t.string({ max: 4096 })),
  origin: t.optional(t.string({ max: 1024 })),
}));
router.handle('engine:version', [], () => engine.version());
// The sign-in guide names the user's own browser and can check that Grab reaches it.
router.handle('browser:default', [t.optional(t.url())], (_e, pageUrl) => {
  const selected = browserService?.resolve(pageUrl);
  const b = browserSession.browserForPage(pageUrl, selected?.browserId);
  return { name: b.name, scheme: b.scheme, supported: b.supported !== false };
});
router.handle('browser:check', [t.optional(t.url())], async (_e, pageUrl) => {
  const selected = browserService?.resolve(pageUrl);
  if (selected && browserService.isConfigured(selected.browserId)) return browserService.test(selected.browserId);
  try { await browserSession.connectBrowser({ browser: browserSession.browserForPage(pageUrl, selected?.browserId) }); return { ok: true }; }
  catch (err) { return { ok: false, kind: err.kind }; }
});
router.handle('engine:extractors', [], () => engine.extractors());
router.handle('engine:update', [], () => {
  // Never while a download, lookup or engine query runs (see engine.updateEngine).
  if (coordinator.busy() || engine.busy()) return { ok: false, busy: true };
  return engine.updateEngine();
});

// ---- downloads ------------------------------------------------------------------------------
// Commands only: the renderer names a job by its id; the coordinator decides what happens.
const id = t.id();
const browserId = t.oneOf('edge', 'chrome', 'brave');
router.handle('downloads:snapshot', [], () => coordinator.snapshot());
router.handle('downloads:add', [
  t.array(t.object({ url: t.url(), label: t.optional(t.string({ max: 2000 })) }), { max: 500 }),
  t.optional(t.object({ contentType: t.optional(t.oneOf('video', 'pdf')), nameEdited: t.optional(t.bool()), useBrowser: t.optional(t.bool()), browser: t.optional(browserId) })),
], (_e, links, opts = {}) => coordinator.add(links.map((l) => ({ url: l.url, label: l.label || '' })), { contentType: opts.contentType, nameEdited: !!opts.nameEdited, useBrowser: !!opts.useBrowser, browser: opts.browser }));
router.handle('downloads:rename', [id, t.string({ max: 2000 })], (_e, jobId, name) => coordinator.rename(jobId, name));
router.handle('downloads:start', [id], (_e, jobId) => coordinator.downloadOne(jobId));
router.handle('downloads:startAll', [], () => coordinator.downloadAll());
router.handle('downloads:pause', [id], (_e, jobId) => coordinator.pause(jobId));
router.handle('downloads:resume', [id], (_e, jobId) => coordinator.resume(jobId));
router.handle('downloads:retry', [id], (_e, jobId) => coordinator.retry(jobId));
router.handle('downloads:cancelLookup', [id], (_e, jobId) => coordinator.cancelLookup(jobId));
router.handle('downloads:choose', [id, t.int({ max: 20 })], (_e, jobId, index) => coordinator.choose(jobId, index));
router.handle('downloads:revealPlayback', [id], (_e, jobId) => browserService?.revealPlayback(jobId));
router.handle('downloads:remove', [id], (_e, jobId) => coordinator.remove(jobId));
router.handle('downloads:move', [id, id], (_e, fromId, toId) => coordinator.move(fromId, toId));
router.handle('downloads:resumeSite', [t.string({ min: 1, max: 255 })], (_e, key) => coordinator.resumeSite(key));
// Reveals the job's file, or opens the download folder when there is none (any more).
router.handle('downloads:show', [id], async (_e, jobId) => {
  const file = coordinator.fileOf(jobId);
  if (file && fs.existsSync(file) && (await isApprovedFile(file))) return shell.showItemInFolder(file);
  const { folder } = await settingsRepo.get();
  fs.mkdirSync(folder, { recursive: true });
  return shell.openPath(folder);
});

// ---- settings, history, library, files -------------------------------------------------------
router.handle('settings:get', [], () => settingsRepo.get());
router.handle('settings:set', [t.object({
  folder: t.optional(t.string({ min: 1, max: 1024 })),
  format: t.optional(t.oneOf(...FORMATS)),
  quality: t.optional(t.oneOf(...QUALITIES)),
  automaticUpdateChecks: t.optional(t.bool()),
})], async (_e, patch) => {
  if (patch.folder && !approvedFolders.has(patch.folder) && patch.folder !== (await settingsRepo.get()).folder) {
    throw new Error('settings:set: the folder must be chosen in the folder dialog');
  }
  return settingsRepo.update(patch);
});

router.handle('history:get', [], () => historyRepo.all());
router.handle('history:clear', [], () => historyRepo.clear().then(() => undefined));

router.handle('library:list', [t.optional(t.string({ max: 1024 }))], async () => listLibrary((await settingsRepo.get()).folder));
router.handle('file:open', [t.string({ max: 1024 })], async (_e, file) => ((await isApprovedFile(file)) ? shell.openPath(file) : 'not allowed'));
router.handle('file:exists', [t.optional(t.string({ max: 1024 }))], async (_e, file) => !!file && (await isApprovedFile(file)) && fs.existsSync(file));

router.handle('folder:choose', [], async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return null;
  approvedFolders.add(r.filePaths[0]);
  return r.filePaths[0];
});
router.handle('folder:show', [t.string({ max: 1024 })], async (_e, file) => { if (await isApprovedFile(file)) shell.showItemInFolder(file); });
// Opens the download folder (whatever folder is passed, only the download folder is opened).
router.handle('folder:open', [t.optional(t.string({ max: 1024 }))], async () => {
  const { folder } = await settingsRepo.get();
  fs.mkdirSync(folder, { recursive: true });
  return shell.openPath(folder);
});

// Browser setup is independent of download scheduling; incoming sends enter the same main
// coordinator even when the renderer is reloading or displaying a different screen.
async function startBrowserService() {
  const svc = new BrowserService({
    appVersion: app.getVersion(),
    sourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    getSettings: () => settingsRepo.current || {},
    saveSettings: (patch) => settingsRepo.update(patch),
    pdf, engine, session: browserSession,
    notify: (channel, payload) => {
      if (channel === 'browser:phase') coordinator.browserPhase(payload);
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
    acceptIncoming: async (incoming) => {
      if (!coordinatorReady || coordinator.closed) return 'unavailable';
      const r = coordinator.add([{ url: incoming.url }], { browser: incoming.browserId, instance: incoming.instanceKey,
        contentType: incoming.contentType, ref: incoming.ref, sourceId: incoming.sourceId, autoQueue: true });
      return r.added ? 'accepted' : { status: 'duplicate', ref: coordinator.jobs.find((j) => j.sourceId === incoming.sourceId)?.browserRef };
    },
  });
  await svc.init();
  browserService = svc;
}
const unavailable = () => ({ unavailable: true, error: browserServiceError });
router.handle('browser:state', [], () => browserService?.state() || unavailable());
router.handle('browser:refresh', [], () => browserService?.refresh() || unavailable());
router.handle('browser:resolve', [t.optional(t.string({ max: 8192 })), t.optional(browserId)], (_e, url, explicit) => browserService?.resolve(url || '', { browser: explicit }) || unavailable());
router.handle('browser:set', [t.object({
  defaultBrowser: t.nullable(t.optional(browserId)),
  siteRules: t.optional(t.array(t.object({ host: t.string({ min: 1, max: 253 }), browser: browserId }), { max: 50 })),
  instanceChoice: t.optional(t.record(t.nullable(t.string({ max: 100 })), { max: 3, key: browserId })),
  instanceAliases: t.optional(t.record(t.nullable(t.string({ max: 40 })), { key: t.string({ max: 100 }) })),
  connectMs: t.nullable(t.optional(t.int({ min: 2000, max: 60000 }))),
  discoveryMs: t.nullable(t.optional(t.int({ min: 10000, max: 300000 }))),
  probeMs: t.nullable(t.optional(t.int({ min: 10000, max: 300000 }))),
  downloadIdleMs: t.nullable(t.optional(t.int({ min: 30000, max: 1800000 }))),
})], (_e, patch) => browserService?.setSettings(patch) || unavailable());
router.handle('browser:setup', [t.optional(t.object({ browsers: t.optional(t.array(browserId, { max: 3 })) }))], (_e, options) => browserService?.setup(options) || unavailable());
router.handle('browser:test', [browserId], (_e, browser) => browserService?.test(browser) || unavailable());
router.handle('browser:uninstall', [], () => {
  if (coordinator.busy()) return { busy: true };
  return browserService?.uninstall() || unavailable();
});
router.handle('browser:open-extension-folder', [], () => {
  const dir = browserService?.state().extensionDir;
  if (dir && fs.existsSync(dir)) return shell.openPath(dir);
  return false;
});

// ---- lifecycle ------------------------------------------------------------------------------
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
  configureSessionPrivacy(session.defaultSession);
  engine.setUserBinDir(path.join(app.getPath('userData'), 'bin'));
  engine.configure({ allowSystemTools: !app.isPackaged });
  await engine.reconcileEngine();
  // Left behind by a crash: lookup files (signed media addresses) and cookie jars.
  engine.cleanInfoCache();
  browserSession.scavengeCookieJars();
  approvedFolders.add((await settingsRepo.get()).folder);
  await startBrowserService().catch((error) => {
    browserServiceError = 'לא ניתן להפעיל את החיבור לדפדפן. בדוק את קבצי ההתקנה והפעל מחדש את Grab.';
    diagnostics.record('browser-start', { error: error.message });
  });
  diagnostics.record('start', { app: app.getVersion(), electron: process.versions.electron, engine: await engine.version().catch(() => null), packaged: app.isPackaged });
  await coordinator.init();
  for (const job of coordinator.jobs) browserService?.restoreJob(job.browserRef, job.instancePick, job.url);
  coordinatorReady = true;
  createWindow();
});
app.on('window-all-closed', () => app.quit());
// Quitting saves the queue and waits (briefly) until yt-dlp and ffmpeg have exited, so no
// download keeps running without Grab and no file stays locked.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  coordinator.shutdown()
    .then(() => engine.stopAll(8000))
    .finally(() => { browserService?.shutdown(); browserSession.disconnectBrowser(); app.quit(); });
});

// For the end-to-end checks (e2e/): rows shown as given, with nothing running. Main-process
// code only; the renderer can't reach it. Not in the installed app.
if (!app.isPackaged) module.exports.__e2e = { seedQueue: (items, options) => coordinator.seed(items, options), coordinator };
