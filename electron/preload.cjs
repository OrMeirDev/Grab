const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grab', {
  version: () => ipcRenderer.invoke('engine:version'),
  analyze: (url, opts) => ipcRenderer.invoke('engine:analyze', url, opts),
  extractors: () => ipcRenderer.invoke('engine:extractors'),
  defaultBrowser: () => ipcRenderer.invoke('browser:default'),
  checkBrowser: () => ipcRenderer.invoke('browser:check'),
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
