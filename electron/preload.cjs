const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grab', {
  version: () => ipcRenderer.invoke('engine:version'),
  analyze: (url, opts) => ipcRenderer.invoke('engine:analyze', url, opts),
  extractors: () => ipcRenderer.invoke('engine:extractors'),
  defaultBrowser: (pageUrl) => ipcRenderer.invoke('browser:default', pageUrl),
  checkBrowser: (pageUrl) => ipcRenderer.invoke('browser:check', pageUrl),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkAppUpdate: () => ipcRenderer.invoke('update:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('update:download'),
  installAppUpdate: () => ipcRenderer.invoke('update:install'),
  onAppUpdate: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  onLookupPhase: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('engine:lookup-phase', handler);
    return () => ipcRenderer.removeListener('engine:lookup-phase', handler);
  },
  // Browser integration: selection, extension setup, per-job phases and "Send to GRAB".
  browserState: () => ipcRenderer.invoke('browser:state'),
  browserRefresh: () => ipcRenderer.invoke('browser:refresh'),
  browserSet: (patch) => ipcRenderer.invoke('browser:set', patch),
  browserResolve: (url, explicit) => ipcRenderer.invoke('browser:resolve', url, explicit),
  browserSetup: (opts) => ipcRenderer.invoke('browser:setup', opts),
  browserUninstall: () => ipcRenderer.invoke('browser:uninstall'),
  browserTest: (id) => ipcRenderer.invoke('browser:test', id),
  openExtensionFolder: () => ipcRenderer.invoke('browser:open-extension-folder'),
  revealPlayback: (id) => ipcRenderer.invoke('browser:reveal-playback', id),
  reportBrowserJob: (ref, report) => ipcRenderer.invoke('browser:job-report', ref, report),
  cancelAnalyze: (id) => ipcRenderer.invoke('engine:cancel-analyze', id),
  onBrowserChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('browser:changed', handler);
    return () => ipcRenderer.removeListener('browser:changed', handler);
  },
  onBrowserPhase: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('browser:phase', handler);
    return () => ipcRenderer.removeListener('browser:phase', handler);
  },
  onBrowserIncoming: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('browser:incoming', handler);
    return () => ipcRenderer.removeListener('browser:incoming', handler);
  },
  replyBrowserIncoming: (ref, status) => {
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(String(ref)) && ['accepted', 'duplicate'].includes(status)) ipcRenderer.send('browser:incoming-reply:' + ref, status);
  },
  start: (job) => ipcRenderer.invoke('engine:start', job),
  stop: (id) => ipcRenderer.invoke('engine:stop', id),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('engine:progress', handler);
    return () => ipcRenderer.removeListener('engine:progress', handler);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  showFile: (file) => ipcRenderer.invoke('folder:show', file),
  openFolder: (dir) => ipcRenderer.invoke('folder:open', dir),
  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listLibrary: (dir) => ipcRenderer.invoke('library:list', dir),
  openFile: (file) => ipcRenderer.invoke('file:open', file),
  fileExists: (file) => ipcRenderer.invoke('file:exists', file),
});
