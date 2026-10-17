// Immutable private copies of the shipped Electron runtime. Validate bytes, not
// version/size/mtime: two locally rebuilt installers can share all three.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function snapshot(runtime, sourceRoot, appVersion) {
  if (!fs.existsSync(path.join(sourceRoot, 'app.asar'))) return null;
  const root = path.dirname(runtime);
  const files = [];
  const collect = async (relative = '') => {
    for (const entry of await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isFile()) {
        const source = path.join(root, name);
        files.push({ source, name: !relative && entry.name === path.basename(runtime) ? 'GrabBrowserHost.exe' : name,
          bytes: (await fs.promises.stat(source)).size, sha256: await digest(source) });
      } else if (entry.isDirectory() && (relative || entry.name === 'locales')) await collect(name);
      else if (entry.isSymbolicLink()) throw new Error('Runtime source contains a symbolic link');
    }
  };
  await collect();
  if (!files.some((f) => f.source === runtime)) throw new Error('Runtime executable is missing');
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ runtime, appVersion,
    files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) })).digest('hex');
  return { files, fingerprint };
}

async function matches(candidate, integrationDir, expected) {
  if (!candidate || path.basename(candidate) !== 'GrabBrowserHost.exe') return false;
  const privateRoot = path.resolve(integrationDir, 'runtimes');
  const relative = path.relative(privateRoot, path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  const folder = path.dirname(candidate);
  try {
    const realRelative = path.relative(await fs.promises.realpath(privateRoot), await fs.promises.realpath(folder));
    if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) return false;
    const ready = path.join(folder, '.ready');
    const readyStat = await fs.promises.lstat(ready);
    if (!readyStat.isFile() || readyStat.isSymbolicLink() || await fs.promises.readFile(ready, 'utf8') !== expected.fingerprint) return false;
    const names = [];
    const collect = async (relative = '') => {
      for (const entry of await fs.promises.readdir(path.join(folder, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (!relative && name === '.ready') continue;
        if (entry.isSymbolicLink()) throw new Error('Runtime copy contains a symbolic link');
        if (entry.isDirectory()) await collect(name);
        else if (entry.isFile()) names.push(name);
        else throw new Error('Runtime copy contains a non-file');
      }
    };
    await collect();
    if (JSON.stringify(names.sort()) !== JSON.stringify(expected.files.map((f) => f.name).sort())) return false;
    for (const file of expected.files) {
      const target = path.join(folder, file.name);
      const info = await fs.promises.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await digest(target) !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}

async function hostRuntimeIsCurrent({ runtime, sourceRoot, integrationDir, appVersion, hostRuntime }) {
  const expected = await snapshot(runtime, sourceRoot, appVersion);
  return expected ? matches(hostRuntime, integrationDir, expected) : hostRuntime === runtime;
}

async function prepareHostRuntime(runtime, sourceRoot, integrationDir, appVersion, previous) {
  const expected = await snapshot(runtime, sourceRoot, appVersion);
  if (!expected) return runtime;
  if (await matches(previous?.hostRuntime, integrationDir, expected)) return previous.hostRuntime;
  let dir = path.join(integrationDir, 'runtimes', expected.fingerprint.slice(0, 16));
  if (await matches(path.join(dir, 'GrabBrowserHost.exe'), integrationDir, expected)) return path.join(dir, 'GrabBrowserHost.exe');
  // Preserve existing files, including a runtime held by an active native host.
  if (fs.existsSync(dir)) dir += '-' + crypto.randomUUID();
  const stage = dir + '-' + crypto.randomUUID();
  await fs.promises.mkdir(stage, { recursive: true });
  try {
    for (const file of expected.files) {
      const target = path.join(stage, file.name);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(file.source, target);
    }
    await fs.promises.writeFile(path.join(stage, '.ready'), expected.fingerprint);
    if (!await matches(path.join(stage, 'GrabBrowserHost.exe'), integrationDir, expected)) throw new Error('Runtime copy did not match its source');
    await fs.promises.rename(stage, dir);
    return path.join(dir, 'GrabBrowserHost.exe');
  } catch (error) { await fs.promises.rm(stage, { recursive: true, force: true }); throw error; }
}

module.exports = { prepareHostRuntime, hostRuntimeIsCurrent };
