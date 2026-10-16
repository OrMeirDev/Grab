// Installs, repairs, checks and removes Grab's browser integration for the current Windows user
// (no administrator rights): the unpacked extension folder, the native host and its per-browser
// launcher, the host manifests, and the per-browser registry registration. Only Grab-owned
// names are ever touched.
//
// Layout under <integrationDir> (default %LOCALAPPDATA%\Grab\browser-integration):
//   extension\                       the folder to "Load unpacked" in the browser
//   native-host\host.cjs + deps      what the browser starts
//   native-host\grab-host-<b>.cmd    per-browser launcher (sets the runtime, browser and directory)
//   manifests\<b>\<name>.json        native messaging host manifest per browser
//   install.json                     what was installed, for health checks and auto-repair
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const protocol = require('../../extension/lib/protocol.js');

const HOST_NAME = protocol.HOST_NAME;
const INTEGRATION_VERSION = 4;
const HOST_FILES = ['host.cjs', 'framing.cjs', 'ipc-paths.cjs', 'browser-kind.cjs'];

const REGISTRY_KEYS = {
  edge: (name) => `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${name}`,
  chrome: (name) => `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`,
  // Brave inherits Chromium's Windows host lookup and falls back to the Chrome key.
  // Both launchers identify the actual caller instead of trusting this shared registry label.
  brave: (name) => `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`,
};
const BROWSER_IDS = Object.keys(REGISTRY_KEYS);
const legacyBraveKey = (name) => `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${name}`;

const defaultIntegrationDir = (env = process.env) => path.join(env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Grab', 'browser-integration');

// Chromium derives the extension ID from the manifest "key": first 128 bits of SHA-256 of the
// DER public key, each nibble mapped to a-p. A fixed key gives an ID that does not depend on the folder.
function extensionIdFromKey(keyBase64) {
  const digest = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest().subarray(0, 16);
  return [...digest].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
}
function readExtensionIdentity(extensionDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('The extension manifest has no "key"; its ID would change with the folder');
  const id = extensionIdFromKey(manifest.key);
  return { id, origin: `chrome-extension://${id}/`, version: manifest.version };
}

// ---- registry adapter (Windows; reg.exe with argument arrays, never a shell string) ----
function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}
const windowsRegistry = {
  async get(key) {
    const r = await reg(['query', key, '/ve']);
    const m = r.ok && r.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
    return m ? m[1] : null;
  },
  async set(key, value) {
    const r = await reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f']);
    if (!r.ok) throw new Error('Registry write failed: ' + r.stderr.trim().slice(0, 200));
  },
  async remove(key) {
    const r = await reg(['delete', key, '/f']);
    return r.ok;
  },
};

// ---- file helpers ----
function copyDirExact(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const wanted = new Set();
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      wanted.add(path.join(to, ent.name));
      if (ent.isDirectory()) walk(path.join(from, ent.name), path.join(to, ent.name));
      else fs.copyFileSync(path.join(from, ent.name), path.join(to, ent.name));
    }
  };
  walk(src, dest);
  // Drop files left over from an older version without deleting the folder the browser has loaded.
  const prune = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (!wanted.has(p)) fs.rmSync(p, { recursive: true, force: true });
      else if (ent.isDirectory()) prune(p);
    }
  };
  prune(dest);
}

// Inside double quotes cmd.exe only expands %VAR% (doubled below); a quote or line break cannot be quoted at all.
function assertBatchSafe(value, what) {
  if (/["\r\n\0]/.test(value)) throw new Error(`${what} contains characters that cannot be used in a launcher`);
}
const batchPath = (p) => p.replace(/%/g, '%%');

function launcherText({ runtime, hostScript, browser, integrationDir }) {
  for (const [value, what] of [[runtime, 'Runtime path'], [hostScript, 'Host path'], [integrationDir, 'Integration folder']]) assertBatchSafe(value, what);
  return [
    '@echo off',
    'chcp 65001 >nul',
    'set ELECTRON_RUN_AS_NODE=1',
    `set "GRAB_BROWSER=${browser}"`,
    `set "GRAB_INTEGRATION_DIR=${batchPath(integrationDir)}"`,
    `"${batchPath(runtime)}" "${batchPath(hostScript)}" %*`,
    '',
  ].join('\r\n');
}

// Standalone dev runtime: the Electron binary (it runs the host as plain Node with ELECTRON_RUN_AS_NODE).
function resolveRuntime() {
  if (process.versions.electron) return process.execPath;
  return process.execPath;
}

const installFile = (dir) => path.join(dir, 'install.json');
function readInstall(dir) { try { return JSON.parse(fs.readFileSync(installFile(dir), 'utf8')); } catch { return null; } }

// The browser keeps its native host alive after the UI closes. Run it from a versioned
// private copy of the shipped runtime, under a distinct executable name, so an active
// extension cannot lock Grab.exe/DLLs or look like the UI to the Windows installer.
async function prepareHostRuntime(runtime, sourceRoot, integrationDir, appVersion) {
  if (!fs.existsSync(path.join(sourceRoot, 'app.asar'))) return runtime;
  const stat = fs.statSync(runtime);
  const revision = crypto.createHash('sha256').update([runtime, appVersion, stat.size, stat.mtimeMs].join(':')).digest('hex').slice(0, 16);
  const root = path.dirname(runtime);
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const valid = (candidate) => {
    if (!candidate || !path.resolve(candidate).startsWith(path.resolve(integrationDir, 'runtimes') + path.sep)) return false;
    const folder = path.dirname(candidate);
    try {
      return fs.existsSync(path.join(folder, '.ready')) && entries.filter((e) => e.isFile()).every((e) =>
        fs.statSync(path.join(folder, e.name === path.basename(runtime) ? 'GrabBrowserHost.exe' : e.name)).size === fs.statSync(path.join(root, e.name)).size);
    } catch { return false; }
  };
  const previous = readInstall(integrationDir);
  if (previous?.runtime === runtime && previous.appVersion === appVersion && valid(previous.hostRuntime)) return previous.hostRuntime;
  let dir = path.join(integrationDir, 'runtimes', revision);
  if (valid(path.join(dir, 'GrabBrowserHost.exe'))) return path.join(dir, 'GrabBrowserHost.exe');
  // Never overwrite a loaded executable when repairing a damaged runtime; the repaired host
  // gets a new complete directory, and the existing port can finish safely.
  if (fs.existsSync(dir)) dir += '-' + crypto.randomUUID();
  const target = path.join(dir, 'GrabBrowserHost.exe');
  const stage = dir + '-' + crypto.randomUUID();
  await fs.promises.mkdir(stage, { recursive: true });
  try {
    for (const ent of entries) {
      if (ent.isFile()) await fs.promises.copyFile(path.join(root, ent.name), path.join(stage, ent.name === path.basename(runtime) ? 'GrabBrowserHost.exe' : ent.name));
      else if (ent.isDirectory() && ent.name === 'locales') await fs.promises.cp(path.join(root, ent.name), path.join(stage, ent.name), { recursive: true });
    }
    await fs.promises.writeFile(path.join(stage, '.ready'), appVersion);
    await fs.promises.rename(stage, dir);
  } catch (error) { await fs.promises.rm(stage, { recursive: true, force: true }); throw error; }
  return target;
}

// sourceRoot has extension\ and native-host\ (the repository in development, resources\ when packaged).
async function install({ sourceRoot, integrationDir = defaultIntegrationDir(), browsers = BROWSER_IDS, runtime = resolveRuntime(), appVersion = '0', registry = windowsRegistry, hostName = HOST_NAME } = {}) {
  if (!browsers.every((b) => BROWSER_IDS.includes(b))) throw new Error('Unsupported browser in install request');
  if (!fs.existsSync(runtime)) throw new Error('The Grab program file for the browser connection was not found');
  const hostRuntime = await prepareHostRuntime(runtime, sourceRoot, integrationDir, appVersion);
  const identity = readExtensionIdentity(path.join(sourceRoot, 'extension'));
  copyDirExact(path.join(sourceRoot, 'extension'), path.join(integrationDir, 'extension'));
  const hostDir = path.join(integrationDir, 'native-host');
  fs.mkdirSync(hostDir, { recursive: true });
  for (const f of HOST_FILES) fs.copyFileSync(path.join(sourceRoot, 'native-host', f), path.join(hostDir, f));
  // Adding Chrome after Edge must not erase Edge from the install record or auto-repair list.
  const previous = readInstall(integrationDir);
  const requested = [...new Set([...(previous?.browsers || []).filter((b) => BROWSER_IDS.includes(b)), ...browsers])];
  const registered = [];
  for (const browser of requested) {
    const launcher = path.join(hostDir, `grab-host-${browser}.cmd`);
    fs.writeFileSync(launcher, launcherText({ runtime: hostRuntime, hostScript: path.join(hostDir, 'host.cjs'), browser: browser === 'edge' ? 'edge' : 'chromium', integrationDir }));
    const manifestDir = path.join(integrationDir, 'manifests', browser);
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = path.join(manifestDir, `${hostName}.json`);
    fs.writeFileSync(manifest, JSON.stringify({
      name: hostName,
      description: 'Grab browser connection',
      path: launcher,
      type: 'stdio',
      allowed_origins: [identity.origin],
    }, null, 2));
    await registry.set(REGISTRY_KEYS[browser](hostName), manifest);
    registered.push(browser);
  }
  await registry.remove?.(legacyBraveKey(hostName));
  const record = { appVersion, integrationVersion: INTEGRATION_VERSION, runtime, hostRuntime, extensionId: identity.id, extensionVersion: identity.version, browsers: registered, hostName, at: new Date().toISOString() };
  fs.writeFileSync(installFile(integrationDir), JSON.stringify(record, null, 2));
  return { ...record, extensionDir: path.join(integrationDir, 'extension'), origin: identity.origin };
}

// Removes only Grab's registration, host, manifests and (optionally) the unpacked extension folder.
async function uninstall({ integrationDir = defaultIntegrationDir(), registry = windowsRegistry, hostName = HOST_NAME, removeExtension = true, beforeRemove = async () => {} } = {}) {
  const previous = readInstall(integrationDir);
  const removed = [];
  const keys = new Set([legacyBraveKey(hostName)]);
  for (const browser of BROWSER_IDS) {
    const key = REGISTRY_KEYS[browser](hostName);
    keys.add(key);
    if ((!previous || previous.browsers?.includes(browser)) && await registry.get(key)) removed.push(browser);
  }
  for (const key of keys) if (await registry.get(key)) await registry.remove(key);
  await beforeRemove(); // registrations are gone before any live host is stopped (no reconnect race)
  for (const part of ['native-host', 'manifests', 'runtimes', ...(removeExtension ? ['extension'] : [])]) fs.rmSync(path.join(integrationDir, part), { recursive: true, force: true });
  fs.rmSync(installFile(integrationDir), { force: true });
  return { removed };
}

// Per-browser setup diagnosis. `state`:
//   not_detected | unknown (nothing wrong found, no connection now) | connected | setup_problem
async function health({ integrationDir = defaultIntegrationDir(), registry = windowsRegistry, hostName = HOST_NAME, hub, detected = [], appVersion = '0', sourceRoot } = {}) {
  const record = readInstall(integrationDir);
  let expected = null;
  try { expected = readExtensionIdentity(sourceRoot ? path.join(sourceRoot, 'extension') : path.join(integrationDir, 'extension')); } catch { /* reported below */ }
  const instances = hub ? hub.instances() : [];
  const results = [];
  for (const browser of BROWSER_IDS) {
    const exe = detected.find((d) => d.id === browser);
    const problems = [];
    const key = REGISTRY_KEYS[browser](hostName);
    const manifestPath = await registry.get(key);
    if (!record || !(record.browsers || []).includes(browser) || !manifestPath) problems.push('not_registered');
    else if (!fs.existsSync(manifestPath)) problems.push('manifest_missing');
    else {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!fs.existsSync(manifest.path)) problems.push('host_missing');
        if (expected && !(manifest.allowed_origins || []).includes(expected.origin)) problems.push('id_mismatch');
        if ((manifest.allowed_origins || []).some((o) => /\*/.test(o) || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(o))) problems.push('bad_origin');
      } catch { problems.push('manifest_invalid'); }
      if (record.runtime && !fs.existsSync(record.runtime)) problems.push('runtime_missing');
      if (record.hostRuntime && !fs.existsSync(record.hostRuntime)) problems.push('runtime_missing');
      if (HOST_FILES.some((f) => !fs.existsSync(path.join(integrationDir, 'native-host', f)))) problems.push('host_script_missing');
      if (record.appVersion !== appVersion || record.integrationVersion !== INTEGRATION_VERSION || record.extensionVersion !== expected?.version) problems.push('stale_version');
    }
    if (record && !fs.existsSync(path.join(integrationDir, 'extension', 'manifest.json'))) problems.push('extension_folder_missing');
    const live = instances.filter((i) => i.browser === browser);
    const failure = hub ? hub.failures.find((f) => f.browser === browser || (!f.browser && ['pipe'].includes(f.code))) : null;
    let state = 'unknown';
    if (!exe && !live.length) state = 'not_detected';
    else if (live.length) state = 'connected';
    else if (problems.length && problems.some((p) => p !== 'not_registered')) state = 'setup_problem';
    else if (failure && ['protocol_version', 'origin_mismatch'].includes(failure.code)) state = 'setup_problem';
    results.push({ browser, detected: !!exe, state, problems, failure: failure ? failure.code : null, instances: live, registered: problems.indexOf('not_registered') < 0 });
  }
  return { extensionId: expected && expected.id, extensionDir: path.join(integrationDir, 'extension'), installed: !!record, results };
}

module.exports = {
  HOST_NAME, INTEGRATION_VERSION, REGISTRY_KEYS, BROWSER_IDS, defaultIntegrationDir, extensionIdFromKey, readExtensionIdentity,
  install, uninstall, health, windowsRegistry, resolveRuntime, launcherText, readInstall,
};
