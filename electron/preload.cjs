// The renderer's only door into the main process: named commands and subscriptions. No file
// paths, processes or cookies are chosen by the page; the main process validates every call.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('grab', {
  version: () => ipcRenderer.invoke('engine:version'),
  extractors: () => ipcRenderer.invoke('engine:extractors'),
  defaultBrowser: (url) => ipcRenderer.invoke('browser:default', url),
  checkBrowser: (url) => ipcRenderer.invoke('browser:check', url),
  updateEngine: () => ipcRenderer.invoke('engine:update'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkAppUpdate: () => ipcRenderer.invoke('update:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('update:download'),
  installAppUpdate: () => ipcRenderer.invoke('update:install'),
  onAppUpdate: subscribe('update:status'),
  // The download queue lives in the main process; these are its commands and its snapshots.
  downloads: {
    snapshot: () => ipcRenderer.invoke('downloads:snapshot'),
    onChange: subscribe('downloads:changed'),
    add: (links, options) => ipcRenderer.invoke('downloads:add', links, options),
    rename: (id, name) => ipcRenderer.invoke('downloads:rename', id, name),
    start: (id) => ipcRenderer.invoke('downloads:start', id),
    startAll: () => ipcRenderer.invoke('downloads:startAll'),
    pause: (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    retry: (id) => ipcRenderer.invoke('downloads:retry', id),
    cancelLookup: (id) => ipcRenderer.invoke('downloads:cancelLookup', id),
    choose: (id, index) => ipcRenderer.invoke('downloads:choose', id, index),
    revealPlayback: (id) => ipcRenderer.invoke('downloads:revealPlayback', id),
    remove: (id) => ipcRenderer.invoke('downloads:remove', id),
    move: (fromId, toId) => ipcRenderer.invoke('downloads:move', fromId, toId),
    resumeSite: (key) => ipcRenderer.invoke('downloads:resumeSite', key),
    show: (id) => ipcRenderer.invoke('downloads:show', id),
  },
  browserState: () => ipcRenderer.invoke('browser:state'),
  browserRefresh: () => ipcRenderer.invoke('browser:refresh'),
  browserSet: (patch) => ipcRenderer.invoke('browser:set', patch),
  browserResolve: (url, explicit) => ipcRenderer.invoke('browser:resolve', url, explicit),
  browserSetup: (opts) => ipcRenderer.invoke('browser:setup', opts),
  browserUninstall: () => ipcRenderer.invoke('browser:uninstall'),
  browserTest: (id) => ipcRenderer.invoke('browser:test', id),
  openExtensionFolder: () => ipcRenderer.invoke('browser:open-extension-folder'),
  onBrowserChanged: subscribe('browser:changed'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  showFile: (file) => ipcRenderer.invoke('folder:show', file),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  openFile: (file) => ipcRenderer.invoke('file:open', file),
  fileExists: (file) => ipcRenderer.invoke('file:exists', file),
});
