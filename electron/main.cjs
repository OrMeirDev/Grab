// Composition root of the main process: creates the window, builds the services and exposes them
// to the renderer through guarded IPC channels (each one checks the sender and its arguments; see
// ipc/router.cjs and ipc/contracts.cjs). Business logic lives in the modules required below.
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
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
const { FORMATS, QUALITIES } = require('./domain/records.cjs');

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
const discovery = createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession });
const downloadRunner = createDownloadRunner({ engine, browserSession, allocator });

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
  // Downloads are stopped and their process trees have exited before the installer replaces Grab.
  stopAllJobs();
  await engine.stopAll(10000);
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
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
    // Grab often stays open for hours, so keep checking while it runs.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
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
const jobIdSchema = (v, where) => (Number.isInteger(v) && v > 0 ? v : t.id()(v, where));

router.handle('engine:version', [], () => engine.version());
router.handle('engine:analyze', [t.url(), t.optional(t.object({ forcePage: t.optional(t.bool()) }))], (e, url, opts = {}) => {
  const onPhase = (phase, browser) => { if (!e.sender.isDestroyed()) e.sender.send('engine:lookup-phase', { url, phase, browser }); };
  return discovery.analyze(url, { forcePage: !!opts.forcePage, onPhase });
});
// The sign-in guide names the user's own browser and can check that Grab reaches it.
router.handle('browser:default', [], () => {
  const b = browserSession.defaultBrowser();
  return { name: b.name, scheme: b.scheme, supported: b.supported !== false };
});
router.handle('browser:check', [], async () => {
  try { await browserSession.connectBrowser({ browser: browserSession.defaultBrowser() }); return { ok: true }; }
  catch (err) { return { ok: false, kind: err.kind }; }
});
router.handle('engine:extractors', [], () => engine.extractors());
router.handle('engine:update', [], () => {
  // Never while a download, lookup or engine query runs (see engine.updateEngine).
  if (jobs.size || engine.busy()) return { ok: false, busy: true };
  return engine.updateEngine();
});

// ---- downloads ------------------------------------------------------------------------------
const jobs = new Map(); // id -> { stop, stopped }

const jobSchema = t.object({
  id: jobIdSchema,
  url: t.url(),
  name: t.string({ max: 2000 }),
  folder: t.string({ min: 1, max: 1024 }),
  format: t.oneOf(...FORMATS),
  quality: t.oneOf(...QUALITIES),
  infoFile: t.optional(t.string({ max: 1024 })),
  infoAt: t.optional(t.int()),
  mediaUrl: t.optional(t.url()),
  referer: t.optional(t.string({ max: 4096 })),
  cookieRef: t.optional(t.string({ max: 64 })),
  requestContext: requestContextSchema,
});

router.handle('engine:start', [jobSchema], async (e, job) => {
  // One attempt per job at a time; a repeated start is refused instead of replacing the running one.
  if (jobs.has(job.id)) return { ok: false, error: 'This download is already running', kind: 'other' };
  const { folder } = await settingsRepo.get();
  if (path.resolve(job.folder) !== path.resolve(folder)) return { ok: false, error: 'Not the download folder', kind: 'other' };
  // Only a lookup result Grab wrote itself may be loaded.
  if (job.infoFile && !engine.isInfoFile(job.infoFile)) delete job.infoFile;
  fs.mkdirSync(folder, { recursive: true });
  const attempt = { stopped: false, stop: null };
  jobs.set(job.id, attempt);
  try {
    const run = downloadRunner.start(job, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('engine:progress', { id: job.id, ...p });
    });
    attempt.stop = run.stop;
    if (attempt.stopped) run.stop();
    const result = await run.done;
    if (result.ok || attempt.stopped) allocator.release(job.id);
    return attempt.stopped ? { ok: false, stopped: true } : result;
  } finally { jobs.delete(job.id); }
});

router.handle('engine:stop', [jobIdSchema], (_e, id) => {
  const attempt = jobs.get(id);
  if (attempt) {
    attempt.stopped = true;
    attempt.stop?.();
  }
});
const stopAllJobs = () => { for (const attempt of jobs.values()) { attempt.stopped = true; attempt.stop?.(); } };

// ---- settings, history, library, files -------------------------------------------------------
router.handle('settings:get', [], () => settingsRepo.get());
router.handle('settings:set', [t.object({
  folder: t.optional(t.string({ min: 1, max: 1024 })),
  format: t.optional(t.oneOf(...FORMATS)),
  quality: t.optional(t.oneOf(...QUALITIES)),
})], async (_e, patch) => {
  if (patch.folder && !approvedFolders.has(patch.folder) && patch.folder !== (await settingsRepo.get()).folder) {
    throw new Error('settings:set: the folder must be chosen in the folder dialog');
  }
  return settingsRepo.update(patch);
});

router.handle('history:get', [], () => historyRepo.all());
router.handle('history:add', [t.object({
  name: t.string({ max: 2000 }),
  url: t.url(),
  file: t.optional(t.string({ max: 1024 })),
  site: t.optional(t.string({ max: 100 })),
  format: t.oneOf(...FORMATS),
})], (_e, entry) => historyRepo.add(entry).then(() => undefined));
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
  engine.setUserBinDir(path.join(app.getPath('userData'), 'bin'));
  await engine.reconcileEngine();
  engine.cleanInfoCache();
  approvedFolders.add((await settingsRepo.get()).folder);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
// Quitting waits (briefly) until yt-dlp and ffmpeg have exited, so no download keeps running
// without Grab and no file stays locked.
let quitting = false;
app.on('before-quit', (event) => {
  browserSession.disconnectBrowser();
  if (quitting || !engine.busy()) return;
  event.preventDefault();
  quitting = true;
  stopAllJobs();
  engine.stopAll(8000).finally(() => app.quit());
});
