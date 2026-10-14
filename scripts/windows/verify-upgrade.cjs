#!/usr/bin/env node
// Windows only. Installs the released Grab 1.6.7 (hash-checked), gives it settings and a history
// entry, upgrades it in place with a test build, checks what the upgrade kept and what it
// installed, then drives the upgraded app (installed-app.cjs) against the local fixture site.
// Used by .github/workflows/windows-verify.yml on a throwaway runner; on a person's machine it
// would replace their installed Grab and its data, so run it only on a test machine.
//
// node scripts/windows/verify-upgrade.cjs --installer <Grab-Setup-<test>.exe> --version <test version>
//   --out <results dir> [--bin <bin dir with ffmpeg.exe, default ./bin>]
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const ROOT = path.join(__dirname, '..', '..');
const INSTALLER = path.resolve(arg('installer'));
const VERSION = arg('version');
const OUT = path.resolve(arg('out'));
const BIN = path.resolve(arg('bin', path.join(ROOT, 'bin')));
const BASE = {
  version: '1.6.7',
  url: 'https://github.com/OrMeirDev/Grab/releases/download/v1.6.7/Grab-Setup-1.6.7.exe',
  sha256: 'c747ea63ebe062cc55feec7766de77b53b3bae0696f31909b75477f4d9b052d0',
};
const WORK = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), 'grab-verify');
const USER_DATA = path.join(process.env.APPDATA, 'Grab');
// A Hebrew folder name: the downloads, the seeded settings and the 1.6.7 history all use it.
const FOLDER = path.join(WORK, 'הורדות Grab');
// Real media for the fixture site: 30 s of 720p test pattern and tone (about 2.5 MB), so a slowly
// served download is still running while a check pauses, quits or kills.
const MEDIA = path.join(WORK, 'media.mp4');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(FOLDER, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const results = [];
const facts = {};
const record = (id, title, ok, evidence) => {
  results.push({ id, title, status: ok ? 'Pass' : 'Fail', evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title} :: ${JSON.stringify(evidence)}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ps = (command) => execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
const grabRunning = () => /grab\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Grab.exe', '/NH'], { encoding: 'utf8' }));

// The per-user install electron-builder's NSIS installer registers (HKCU uninstall key).
function installed() {
  const json = ps("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -like 'Grab*' } | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString | ConvertTo-Json -Compress");
  const entry = json ? [].concat(JSON.parse(json))[0] : null;
  if (!entry) return null;
  // InstallLocation is not always written; the uninstaller sits in the install folder.
  const dir = entry.InstallLocation || path.dirname((entry.UninstallString || '').match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) || '');
  const exe = path.join(dir, 'Grab.exe');
  return { name: entry.DisplayName, version: entry.DisplayVersion, dir, exe, uninstall: entry.UninstallString, fileVersion: fs.existsSync(exe) ? ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`) : null };
}

async function install(file) {
  const t0 = Date.now();
  const code = await new Promise((resolve) => spawn(file, ['/S', '/currentuser'], { stdio: 'ignore' }).on('exit', resolve));
  // The installer may hand over to the old version's uninstaller; wait until it has settled.
  for (let i = 0; i < 120 && ps("(Get-Process | Where-Object { $_.Name -like 'Grab-Setup*' -or $_.Name -like 'Un_A*' -or $_.Name -like 'Uninstall*' }).Count") !== '0'; i++) await wait(1000);
  return { exitCode: code, seconds: Math.round((Date.now() - t0) / 1000) };
}

// Opens the installed app as a person would, lets it start, then closes its window.
async function openAndClose(exe, seconds) {
  const app = spawn(exe, [], { stdio: 'ignore', detached: true });
  await wait(seconds * 1000);
  try { execFileSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore' }); } catch { /* already closed */ }
  for (let i = 0; i < 60 && grabRunning(); i++) await wait(500);
  if (grabRunning()) execFileSync('taskkill', ['/IM', 'Grab.exe', '/T', '/F'], { stdio: 'ignore' });
}

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

(async () => {
  facts.windows = ps('(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | ConvertTo-Json -Compress)');
  facts.node = process.version;
  facts.testInstaller = { file: path.basename(INSTALLER), bytes: fs.statSync(INSTALLER).size, sha256: sha256(INSTALLER) };
  execFileSync(path.join(BIN, 'ffmpeg.exe'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '2M', '-c:a', 'aac', '-movflags', '+faststart', MEDIA]);
  facts.media = { bytes: fs.statSync(MEDIA).size };

  // 1. The released 1.6.7, exactly the published file.
  const baseFile = path.join(WORK, path.basename(BASE.url));
  execFileSync('curl', ['-sSL', '--fail', '-o', baseFile, BASE.url]);
  const baseHash = sha256(baseFile);
  facts.baseInstaller = { url: BASE.url, bytes: fs.statSync(baseFile).size, sha256: baseHash };
  if (baseHash !== BASE.sha256) { record('W-01a', 'released 1.6.7 installer matches its published SHA-256', false, { baseHash, expected: BASE.sha256 }); return finish(); }
  facts.baseInstall = await install(baseFile);
  const base = installed();
  facts.baseInstalled = base;
  await openAndClose(base.exe, 15);
  const firstRun = fs.existsSync(USER_DATA) ? fs.readdirSync(USER_DATA) : [];

  // 2. What a person would have in 1.6.7: a chosen folder, MP4 at 720p, one finished download.
  const lessonFile = path.join(FOLDER, 'שיעור מ-1.6.7.mp4');
  fs.copyFileSync(MEDIA, lessonFile);
  const settings = { folder: FOLDER, format: 'mp4', quality: '720' };
  const history = [{ id: 'from-1-6-7', name: 'שיעור מ-1.6.7', url: 'https://example.com/lesson/1', file: lessonFile, site: 'Generic', format: 'mp4', completedAt: '2026-10-01T10:00:00.000Z' }];
  fs.mkdirSync(USER_DATA, { recursive: true });
  writeJson(path.join(USER_DATA, 'settings.json'), settings);
  writeJson(path.join(USER_DATA, 'history.json'), history);
  // 1.6.7 opens with them and keeps them (its own format, before the upgrade).
  await openAndClose(base.exe, 12);
  const keptBy167 = { settings: readJson(path.join(USER_DATA, 'settings.json')), history: readJson(path.join(USER_DATA, 'history.json')) };
  record('W-01a', 'released 1.6.7 installed silently from the hash-checked installer and started', base?.version === BASE.version && facts.baseInstall.exitCode === 0 && firstRun.length > 0 && keptBy167.settings?.folder === FOLDER, { installed: base, install: facts.baseInstall, userDataAfterFirstRun: firstRun });

  // 3. The upgrade, over the installed 1.6.7, without uninstalling it first.
  facts.upgradeInstall = await install(INSTALLER);
  const upgraded = installed();
  facts.upgraded = upgraded;
  const after = { settings: readJson(path.join(USER_DATA, 'settings.json')), history: readJson(path.join(USER_DATA, 'history.json')) };
  record('W-01d', 'test build installed over 1.6.7 in the same place', upgraded?.version === VERSION && upgraded.dir === base.dir && facts.upgradeInstall.exitCode === 0 && fs.existsSync(upgraded.exe), { before: base, after: upgraded, install: facts.upgradeInstall });
  record('W-01e', 'the upgrade kept settings.json and history.json as 1.6.7 left them', JSON.stringify(after) === JSON.stringify(keptBy167), { before: keptBy167, after });

  // 4. The installed native tools are exactly the pinned ones.
  const resources = path.join(upgraded.dir, 'resources');
  let verify;
  try { verify = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-native-tools.cjs'), path.join(resources, 'bin')], { encoding: 'utf8' }).trim(); } catch (e) { verify = 'FAILED: ' + (e.stderr || e.message); }
  const lockSame = fs.readFileSync(path.join(resources, 'native-tools.lock.json'), 'utf8') === fs.readFileSync(path.join(ROOT, 'native-tools.lock.json'), 'utf8');
  const versions = {};
  for (const [tool, args] of [['yt-dlp.exe', ['--version']], ['ffmpeg.exe', ['-version']], ['ffprobe.exe', ['-version']], ['deno.exe', ['--version']]]) {
    try { versions[tool] = execFileSync(path.join(resources, 'bin', tool), args, { encoding: 'utf8' }).split(/\r?\n/)[0]; } catch (e) { versions[tool] = 'FAILED: ' + e.message; }
  }
  facts.installedTools = versions;
  record('W-01f', 'installed resources/bin matches native-tools.lock.json and every tool runs', !verify.startsWith('FAILED') && lockSame && !Object.values(versions).some((v) => v.startsWith('FAILED')), { verify, lockSame, versions });

  // 5. The upgraded app, through its own window, against the fixture site.
  const log = path.join(OUT, 'fixture-requests.jsonl');
  const fixture = spawn(process.execPath, [path.join(ROOT, 'tests', 'fixtures', 'media-site.cjs'), '0', MEDIA, '40', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  const site = await new Promise((resolve) => fixture.stdout.once('data', (d) => resolve(String(d).trim())));
  facts.fixture = site;
  const code = await new Promise((resolve) => spawn(process.execPath, [path.join(__dirname, 'installed-app.cjs'),
    '--exe', upgraded.exe, '--user-data', USER_DATA, '--fixture', site, '--fixture-log', log, '--folder', FOLDER,
    '--out', OUT, '--version', VERSION, '--media', MEDIA], { stdio: 'inherit' }).on('exit', resolve));
  fixture.kill();
  facts.installedAppExit = code;
  finish();
})().catch((e) => { record('W-01', 'upgrade run crashed', false, String(e.stack || e)); finish(); });

function finish() {
  writeJson(path.join(OUT, 'upgrade-results.json'), results);
  writeJson(path.join(OUT, 'facts.json'), facts);
  const appResults = readJson(path.join(OUT, 'installed-app-results.json')) || [];
  const all = [...results, ...appResults];
  const failed = all.filter((r) => r.status !== 'Pass');
  console.log(`\n${all.length - failed.length}/${all.length} upgrade and installed-app checks passed`);
  process.exit(failed.length || facts.installedAppExit ? 1 : 0);
}
