// Exercise the application's real IPC handlers without starting its desktop UI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const browser = require('../electron/browser-session.cjs');

function mainHandlers(engine, pageprobe, hiddenProbe = { findMedia: async () => ({ candidates: [] }) }, session = browser, budgets) {
  const handlers = new Map();
  const entry = path.join(__dirname, '../electron/main.cjs');
  const nativeRequire = createRequire(entry);
  const app = { getPath: () => os.tmpdir(), whenReady: () => ({ then() {} }), on() {}, requestSingleInstanceLock: () => true };
  const sandbox = { require: (name) => {
    if (name === 'electron') return { app, ipcMain: { handle: (key, value) => handlers.set(key, value) } };
    if (name === 'electron-updater') return { autoUpdater: { on() {} } };
    if (name === './engine.cjs') return engine;
    if (name === './pageprobe.cjs') return pageprobe;
    if (name === './hidden-probe.cjs') return hiddenProbe;
    if (name === './browser-session.cjs') return session;
    if (name === './lookup-budget.cjs' && budgets) return budgets;
    return nativeRequire(name);
  }, process, console, setTimeout, setInterval, __dirname: path.dirname(entry) };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), sandbox, { filename: entry });
  return handlers;
}

module.exports = { mainHandlers, sender: { isDestroyed: () => false, send() {} } };
