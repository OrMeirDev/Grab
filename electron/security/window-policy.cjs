// What Grab's own window may do. It shows only the app's page: no navigation away (a link or a
// file dropped on the window can't replace the app), no new windows, no <webview>, and of the
// browser permissions only clipboard access (for the paste button). The hidden player probe has
// its own, separate policy (hidden-probe.cjs).
const { pathToFileURL } = require('url');

const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

// The addresses the app page is served from: the built index.html, or the Vite dev server.
function appUrlMatcher({ indexFile, devUrl }) {
  const file = indexFile ? pathToFileURL(indexFile).href : null;
  return (url) => {
    if (typeof url !== 'string') return false;
    const clean = url.split('#')[0].split('?')[0];
    if (file && clean === file) return true;
    if (devUrl) {
      try { return new URL(url).origin === new URL(devUrl).origin; } catch { return false; }
    }
    return false;
  };
}

function hardenWindow(win, isAppUrl) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stay = (event, url) => { if (!isAppUrl(url)) event.preventDefault(); };
  contents.on('will-navigate', stay);
  contents.on('will-redirect', stay);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function restrictPermissions(ses, isAppContents) {
  ses.setPermissionRequestHandler((contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission) && isAppContents(contents)));
  ses.setPermissionCheckHandler((contents, permission) => ALLOWED_PERMISSIONS.has(permission) && isAppContents(contents));
}

module.exports = { appUrlMatcher, hardenWindow, restrictPermissions, ALLOWED_PERMISSIONS };
