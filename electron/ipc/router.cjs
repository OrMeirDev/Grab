// Registers IPC handlers behind two checks: the request comes from Grab's own window (its main
// frame, at the app's own address), and its arguments match the channel's contract.
const { validateArgs } = require('./contracts.cjs');

// isTrusted(event) -> boolean. ipcMain is injected so tests can capture the handlers.
function createRouter({ ipcMain, isTrusted, onRejected = () => {} }) {
  const channels = new Map();
  return {
    channels,
    handle(channel, schemas, fn) {
      const wrapped = (event, ...args) => {
        if (!isTrusted(event)) {
          onRejected(channel, 'untrusted sender');
          throw new Error(`${channel}: request from an untrusted sender`);
        }
        let valid;
        try { valid = validateArgs(channel, schemas, args); }
        catch (error) { onRejected(channel, error.message); throw error; }
        return fn(event, ...valid);
      };
      channels.set(channel, wrapped);
      ipcMain.handle(channel, wrapped);
    },
  };
}

// The window's main frame at the app's own page (the built file, or the Vite dev server).
function trustedFrame(getWindow, isAppUrl) {
  return (event) => {
    const win = getWindow();
    const frame = event?.senderFrame;
    if (!win || win.isDestroyed() || !frame) return false;
    return frame === win.webContents.mainFrame && isAppUrl(frame.url);
  };
}

module.exports = { createRouter, trustedFrame };
