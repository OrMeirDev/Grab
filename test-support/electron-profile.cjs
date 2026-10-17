// Call before loading Grab's engine/main in a dedicated Electron fixture process.
// userData alone does not isolate native-host repair or startup cache scavenging.
const fs = require('node:fs');
const path = require('node:path');

function isolateElectronProfile(app, profile) {
  const paths = {
    userData: profile,
    appData: path.join(profile, 'roaming'),
    sessionData: path.join(profile, 'session'),
    temp: path.join(profile, 'temp'),
    downloads: path.join(profile, 'downloads'),
    logs: path.join(profile, 'logs'),
  };
  const local = path.join(profile, 'local');
  for (const dir of [...Object.values(paths), local]) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    APPDATA: paths.appData, LOCALAPPDATA: local,
    TEMP: paths.temp, TMP: paths.temp, TMPDIR: paths.temp,
  });
  for (const [name, dir] of Object.entries(paths)) app.setPath(name, dir);

  // UI fixtures can exercise setup/repair without touching the user's HKCU keys.
  const registry = new Map();
  Object.assign(require('../electron/browser/setup.cjs').windowsRegistry, {
    get: async (key) => registry.get(key) || null,
    set: async (key, value) => { registry.set(key, value); },
    remove: async (key) => { registry.delete(key); },
  });
  return { profile, paths, registry };
}

module.exports = { isolateElectronProfile };
