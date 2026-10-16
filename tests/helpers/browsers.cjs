// Chromium-family browsers installed on this machine, for integration tests that drive a real
// browser with a throwaway profile (never a person's profile). GRAB_TEST_CHROME overrides.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function testBrowsers() {
  if (process.env.GRAB_TEST_CHROME) return [{ name: 'Chrome', path: process.env.GRAB_TEST_CHROME }];
  const found = [];
  const add = (name, candidates) => {
    const hit = candidates.find((p) => p && fs.existsSync(p));
    if (hit) found.push({ name, path: hit });
  };
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    add('Chrome', roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    add('Edge', roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
    add('Brave', roots.map((r) => path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')));
  } else if (process.platform === 'linux') {
    const pw = [];
    try { for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) pw.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome')); } catch { /* not this machine */ }
    add('Chromium', [...pw, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']);
  }
  return found;
}

// Ends a browser and all its helper processes (Windows keeps the profile locked otherwise).
function killTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid) return resolve();
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
    else { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }
  });
}

// Removes a throwaway profile, retrying while the browser's last processes let go of it.
async function removeProfile(dir) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
}

module.exports = { testBrowsers, killTree, removeProfile };
