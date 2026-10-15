// Finds the supported Chromium browsers installed on this PC (Edge, Chrome, Brave). Detection
// is Windows registration (App Paths, per-user then machine-wide) plus the browsers' standard
// install folders, and every path is verified to be an existing file before it is listed.
// Nothing scans the disk. A detected executable says nothing about whether the Grab extension
// is installed in it: that is the hub's job.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SUPPORTED = [
  { id: 'edge', name: 'Microsoft Edge', progId: /^MSEdge/i, exe: 'msedge.exe', rel: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
  { id: 'chrome', name: 'Google Chrome', progId: /^ChromeHTML/i, exe: 'chrome.exe', rel: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
  { id: 'brave', name: 'Brave', progId: /^Brave/i, exe: 'brave.exe', rel: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'] },
];
const BY_ID = Object.fromEntries(SUPPORTED.map((b) => [b.id, b]));

function regQuery(key, valueArgs) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, ...valueArgs], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Windows adapter: registry reads go through `reg query` (no shell, argument array).
const windowsAdapter = {
  async readDefaultValue(key) {
    const out = await regQuery(key, ['/ve']);
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
    return m ? m[1] : null;
  },
  async readValue(key, name) {
    const out = await regQuery(key, ['/v', name]);
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
    return m ? m[1] : null;
  },
};

const expandEnv = (value, env) => value.replace(/%([^%]+)%/g, (_, n) => env[n] ?? env[Object.keys(env).find((k) => k.toLowerCase() === n.toLowerCase())] ?? `%${n}%`);
const cleanPath = (value, env) => expandEnv(String(value || '').trim().replace(/^"(.*)"$/, '$1'), env);
const isFile = (fsImpl, p) => { try { return fsImpl.statSync(p).isFile(); } catch { return false; } };

async function detectWindows({ adapter = windowsAdapter, env = process.env, fsImpl = fs } = {}) {
  const found = new Map(); // id -> installs[]
  const seen = new Set();
  const add = (def, exe, scope) => {
    if (!exe || !/\.exe$/i.test(exe) || !path.isAbsolute(exe) || !isFile(fsImpl, exe)) return;
    const norm = path.normalize(exe).toLowerCase();
    if (seen.has(norm)) return;
    seen.add(norm);
    if (!found.has(def.id)) found.set(def.id, []);
    found.get(def.id).push({ exe: path.normalize(exe), scope });
  };
  for (const def of SUPPORTED) {
    const appPaths = (hive) => `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${def.exe}`;
    add(def, cleanPath(await adapter.readDefaultValue(appPaths('HKCU')), env), 'user');
    add(def, cleanPath(await adapter.readDefaultValue(appPaths('HKLM')), env), 'machine');
    add(def, cleanPath(await adapter.readDefaultValue(`HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${def.exe}`), env), 'machine');
    for (const [name, scope] of [['LOCALAPPDATA', 'user'], ['ProgramFiles', 'machine'], ['ProgramFiles(x86)', 'machine'], ['ProgramW6432', 'machine']]) {
      if (env[name]) add(def, path.join(env[name], ...def.rel), scope);
    }
  }
  return SUPPORTED.filter((d) => found.has(d.id)).map((d) => {
    const installs = found.get(d.id);
    return { id: d.id, name: d.name, exe: installs[0].exe, scope: installs[0].scope, installs };
  });
}

// ProgId of the https handler = the Windows default browser.
async function systemDefaultWindows({ adapter = windowsAdapter } = {}) {
  const progId = await adapter.readValue('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
  const def = SUPPORTED.find((d) => d.progId.test(progId || ''));
  return def ? def.id : null;
}

// Platform adapter: other systems list nothing yet; the app keeps working without browser help.
async function detectBrowsers(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { browsers: [], systemDefault: null, platform };
  const [browsers, systemDefault] = await Promise.all([detectWindows(options), systemDefaultWindows(options)]);
  return { browsers, systemDefault, platform };
}

const browserName = (id) => (BY_ID[id] ? BY_ID[id].name : id);
const isSupportedId = (id) => Object.prototype.hasOwnProperty.call(BY_ID, id);

module.exports = { SUPPORTED, detectBrowsers, detectWindows, systemDefaultWindows, browserName, isSupportedId };
