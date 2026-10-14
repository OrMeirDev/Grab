// Wraps yt-dlp: resolves the binaries, reads video info, runs downloads with live progress.
// Every run has a deadline, bounded output and a stop that ends its whole process tree
// (process-runner.cjs); all runs are tracked so the engine is never replaced while one is active.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { runProcess } = require('./infrastructure/process-runner.cjs');
const { ProcessRegistry } = require('./infrastructure/process-registry.cjs');
const { errorKind, cleanError } = require('./domain/engine-errors.cjs');
const { safeName } = require('./domain/output-names.cjs');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// An engine updated from inside the app lives in the user's data folder, so reinstalling or
// updating Grab never overwrites it with an older copy. It takes priority over the bundled one.
let userBinDir = null;
function setUserBinDir(dir) { userBinDir = dir; }
const userEnginePath = () => userBinDir && path.join(userBinDir, 'yt-dlp' + EXE);

function bundledDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin'));
  dirs.push(path.join(__dirname, '..', 'bin'));
  if (IS_WIN && process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  return dirs;
}

function candidateDirs() {
  return userBinDir ? [userBinDir, ...bundledDirs()] : bundledDirs();
}

function findIn(dirs, name) {
  for (const dir of dirs) {
    const p = path.join(dir, name + EXE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findBinary(name) {
  return findIn(candidateDirs(), name) || name; // fall back to PATH
}

// winget installs ffmpeg in its own package folder without a Links shortcut, so look there too.
let ffmpegDirCache;
function ffmpegDir() {
  if (ffmpegDirCache !== undefined) return ffmpegDirCache;
  ffmpegDirCache = null;
  for (const dir of candidateDirs()) {
    if (fs.existsSync(path.join(dir, 'ffmpeg' + EXE))) return (ffmpegDirCache = dir);
  }
  const pkgs = IS_WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  if (pkgs && fs.existsSync(pkgs)) {
    for (const pkg of fs.readdirSync(pkgs).filter((n) => /ffmpeg/i.test(n))) {
      const root = path.join(pkgs, pkg);
      for (const sub of ['', ...fs.readdirSync(root)]) {
        const bin = path.join(root, sub, 'bin');
        if (fs.existsSync(path.join(bin, 'ffmpeg' + EXE))) return (ffmpegDirCache = bin);
      }
    }
  }
  return ffmpegDirCache;
}

function spawnEnv() {
  const extra = candidateDirs().filter((d) => fs.existsSync(d));
  return {
    ...process.env,
    PATH: [...extra, process.env.PATH || ''].join(path.delimiter),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

// Deadlines per kind of run. A download has none overall (files can be hours long) but is stopped
// when yt-dlp and ffmpeg print nothing at all for DOWNLOAD_IDLE_MS.
const LIMITS = {
  version: { timeoutMs: 30 * 1000 },
  analyze: { timeoutMs: 3 * 60 * 1000 },
  extractors: { timeoutMs: 60 * 1000 },
  update: { timeoutMs: 5 * 60 * 1000 },
  download: { idleTimeoutMs: 30 * 60 * 1000 },
};

// All engine processes Grab has running. While the engine is being replaced no new run starts.
const registry = new ProcessRegistry();
let replacing = false;

// --ignore-config: a yt-dlp configuration file on the user's PC never changes how Grab runs it.
function run(args, { onLine, exe, kind = 'analyze', signal, internal = false } = {}) {
  if (replacing && !internal) {
    const result = { code: -1, out: '', err: 'ERROR: the download engine is being updated', engineUpdating: true };
    return { child: null, done: Promise.resolve(result), stop: () => {} };
  }
  return runProcess(exe || findBinary('yt-dlp'), ['--ignore-config', '--encoding', 'utf-8', ...args], {
    env: spawnEnv(), onLine, signal, registry, label: kind, ...LIMITS[kind],
  });
}

// A run that ended because of its deadline, its silence limit or a cancel, as a yt-dlp-like error.
function stopNote(r) {
  if (r.timedOut) return 'ERROR: timed out';
  if (r.idle) return 'ERROR: timed out (no progress for 30 minutes)';
  if (r.truncated) return 'ERROR: Unreadable response (too large)';
  if (r.aborted) return 'ERROR: cancelled';
  return '';
}

async function version(exe, { internal = false } = {}) {
  const { code, out } = await run(['--version'], { exe, kind: 'version', internal }).done;
  return code === 0 ? out.trim() : null;
}

// yt-dlp versions are dates ("2026.08.19", sometimes with a ".1" build suffix).
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// If a newer Grab shipped a newer bundled engine than the user's updated copy, drop the copy.
async function reconcileEngine() {
  const userExe = userEnginePath();
  if (!userExe || !fs.existsSync(userExe)) return;
  const bundled = findIn(bundledDirs(), 'yt-dlp');
  if (!bundled) return;
  const [vUser, vBundled] = await Promise.all([version(userExe, { internal: true }), version(bundled, { internal: true })]);
  if (!vUser || (vBundled && compareVersions(vBundled, vUser) >= 0)) {
    try { fs.unlinkSync(userExe); } catch { /* in use; try again next start */ }
  }
}

// Self-update via `yt-dlp -U` on the user's own copy (the install folder may be read-only
// and gets replaced on reinstall). Downloads the new release from yt-dlp's GitHub.
// Refused (busy) while any engine process runs: Windows can't replace yt-dlp.exe in use, and a
// lookup or download must never run half on the old engine and half on the new one.
async function updateEngine() {
  const userExe = userEnginePath();
  if (!userExe) return { ok: false, error: 'no user folder' };
  if (registry.size || replacing) return { ok: false, busy: true };
  replacing = true;
  try {
    const before = await version(undefined, { internal: true });
    try {
      if (!fs.existsSync(userExe)) {
        const bundled = findIn(bundledDirs(), 'yt-dlp');
        if (!bundled) return { ok: false, before, error: 'yt-dlp not found' };
        fs.mkdirSync(userBinDir, { recursive: true });
        fs.copyFileSync(bundled, userExe);
      }
    } catch (e) {
      return { ok: false, before, error: String(e.message || e) };
    }
    const { code, out, err } = await run(['-U'], { exe: userExe, kind: 'update', internal: true }).done;
    const after = await version(userExe, { internal: true });
    extractorsCache = null; // a new version may support different sites
    if (code !== 0 || !after) return { ok: false, before, after, error: cleanError(err || out) };
    return { ok: true, before, after, updated: compareVersions(after, before || '0') > 0 };
  } finally {
    replacing = false;
  }
}

// The lookup result is saved so the download can reuse it instead of asking the site again.
// Stream links inside it expire (YouTube: ~6h), so it's only trusted for INFO_MAX_AGE_MS.
const INFO_DIR = path.join(os.tmpdir(), 'grab-info');
const INFO_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function cleanInfoCache() {
  try {
    for (const f of fs.readdirSync(INFO_DIR)) {
      const p = path.join(INFO_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(p);
    }
  } catch { /* nothing cached yet */ }
}

// referer/title: set when the video was found inside another page's player (see pageprobe.cjs):
// the video is fetched the way that page's player fetches it, and named after the page.
function sessionArgs({ referer, requestContext = {}, cookieFile } = {}) {
  requestContext = requestContext || {};
  const args = [];
  if (cookieFile) args.push('--cookies', cookieFile);
  if (requestContext.userAgent) args.push('--user-agent', requestContext.userAgent);
  if (requestContext.referer || referer) args.push('--referer', requestContext.referer || referer);
  if (requestContext.origin) args.push('--add-headers', 'Origin:' + requestContext.origin);
  return args;
}

// signal: an AbortSignal that cancels the lookup.
async function analyze(url, { title: pageTitle, signal, ...context } = {}) {
  const extra = sessionArgs(context);
  const r = await run(['-J', '--no-playlist', '--no-warnings', '--skip-download', '--sleep-requests', '1', ...extra, '--', url], { kind: 'analyze', signal }).done;
  const { code, out } = r;
  const err = stopNote(r) || r.err;
  if (r.aborted) return { ok: false, error: 'cancelled', kind: 'cancelled' };
  if (r.engineUpdating) return { ok: false, error: 'engine updating', kind: 'engineUpdating' };
  if (code !== 0 || r.truncated || r.timedOut) return { ok: false, error: cleanError(err), kind: r.timedOut ? 'network' : errorKind(err) };
  try {
    const j = JSON.parse(out);
    let infoFile = null;
    try {
      fs.mkdirSync(INFO_DIR, { recursive: true });
      infoFile = path.join(INFO_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}-${Date.now()}.json`);
      fs.writeFileSync(infoFile, out);
    } catch { infoFile = null; }
    return {
      ok: true,
      infoFile,
      infoAt: Date.now(),
      title: pageTitle || j.title || j.id,
      duration: j.duration || null,
      height: j.height || null,
      thumbnail: j.thumbnail || null,
      site: j.extractor_key || j.extractor || null,
    };
  } catch {
    return { ok: false, error: 'Unreadable response' };
  }
}

function freshInfo(infoFile, infoAt) {
  return !!infoFile && Date.now() - (infoAt || 0) < INFO_MAX_AGE_MS && fs.existsSync(infoFile);
}

// outputBase: the job's file path without extension, chosen by the output allocator (unique and
// safe). folder/name are the older form, still accepted for callers that don't allocate.
function downloadArgs({ url, mediaUrl, referer, requestContext, cookieFile, outputBase, name, folder, format, quality, infoFile, infoAt }) {
  // A literal % in the name must not be read as part of yt-dlp's output template.
  const out = (outputBase || path.join(folder, safeName(name))).replace(/%/g, '%%') + '.%(ext)s';
  // Reuse the lookup result when it's still fresh; otherwise fetch the page again, slowly.
  // A video found inside a page's player is fetched from its own address, as that page does.
  const source = freshInfo(infoFile, infoAt) ? ['--load-info-json', infoFile] : ['--sleep-requests', '1', '--', mediaUrl || url];
  source.unshift(...sessionArgs({ referer, requestContext, cookieFile }));
  // --print implies quiet mode, so --progress is needed to keep the progress lines coming.
  const common = ['--newline', '--progress', '--no-playlist', '--no-warnings', '-R', '10', '--fragment-retries', '10',
    '--progress-template', 'download:GRAB|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:GRABFILE|%(filepath)s', '-o', out];
  if (ffmpegDir()) common.push('--ffmpeg-location', ffmpegDir());
  if (format === 'mp3') {
    return [...common, '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', ...source];
  }
  // Prefer H.264 + AAC so the file plays on every device; cap resolution if asked.
  const sort = [quality && quality !== 'best' ? `res:${quality}` : null, 'vcodec:h264', 'acodec:m4a', 'ext:mp4:m4a'].filter(Boolean).join(',');
  // Single-file sources (e.g. an .avi on archive.org) skip the merge step, so remux those to MP4 too.
  return [...common, '-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4', '--remux-video', 'mp4', ...source];
}

// Exit code 0 is not enough: the finished file must exist. When yt-dlp didn't print its path,
// findOutput(base) may still find it (see output-allocator.cjs).
function verifiedFile(reported, { outputBase, findOutput } = {}) {
  if (reported) return fs.existsSync(reported) ? reported : null;
  return outputBase && findOutput ? findOutput(outputBase) : null;
}

// -> { child, done, stop }. done resolves { ok, file } or { ok: false, error, kind } or
// { ok: false, stopped: true } when stop() (pause, remove, quit) ended it.
function download(opts, onProgress) {
  let file = null;
  const job = run(downloadArgs(opts), {
    kind: 'download',
    onLine: (line) => {
      if (line.startsWith('GRAB|')) {
        const [, pct, speed, eta] = line.split('|');
        onProgress({ percent: parseFloat(pct) || 0, speed: (speed || '').trim(), eta: (eta || '').trim() });
      } else if (line.startsWith('GRABFILE|')) {
        file = line.slice(9).trim();
      }
    },
  });
  const done = job.done.then((r) => {
    if (r.aborted) return { ok: false, stopped: true };
    if (r.engineUpdating) return { ok: false, error: 'engine updating', kind: 'engineUpdating' };
    const err = stopNote(r) || r.err;
    if (r.code !== 0 || r.idle) return { ok: false, error: cleanError(err), kind: r.idle ? 'network' : errorKind(err) };
    const verified = verifiedFile(file, opts);
    return verified ? { ok: true, file: verified } : { ok: false, error: 'Download finished without an output file', kind: 'other' };
  });
  return { child: job.child, done, stop: job.stop };
}

// Adult sites stay downloadable but are hidden from the browsable list; the UI only confirms
// them on an exact name or link search. Built from `--list-extractors --age-limit 17` (sites
// where every part is 18+), minus mainstream false positives, plus keyword matches it missed.
// Matched as a prefix so variants like "PornHubPlaylist" are covered too.
const ADULT = [
  '4tube', 'alphaporno', 'beeg', 'behindkink', 'bongacams', 'cam4', 'cammodels', 'camsoda', 'chaturbate',
  'drtuber', 'empflix', 'eporner', 'erocast', 'eroprofile', 'fux', 'hellporno', 'iwara', 'lovehomeporn',
  'manyvids', 'moviefap', 'murrtube', 'noodlemagazine', 'nonktube', 'nubilesporn', 'nuvid', 'peekvids',
  'playvids', 'pornbox', 'pornerbros', 'pornflip', 'pornhub', 'pornotube', 'pornovoisines', 'pornoxo',
  'porntop', 'porntube', 'redgifs', 'redtube', 'rule34video', 'sexu', 'slutload', 'spankbang', 'stripchat',
  'sunporno', 'thisvid', 'tnaflix', 'toypics', 'tube8', 'txxx', 'xhamster', 'xnxx', 'xvideos', 'xxxymovies',
  'youjizz', 'youporn', 'zenporn',
];
const isAdult = (name) => ADULT.some((a) => name.toLowerCase().startsWith(a));

// Supported sites, grouped by base name ("youtube:playlist" -> "youtube").
let extractorsCache;
async function extractors() {
  if (extractorsCache) return extractorsCache;
  const { code, out } = await run(['--list-extractors'], { kind: 'extractors' }).done;
  if (code !== 0) return [];
  const groups = new Map();
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const broken = /CURRENTLY BROKEN/i.test(raw);
    const base = raw.replace(/\(CURRENTLY BROKEN\)/i, '').split(':')[0].trim();
    if (!base || /^generic$/i.test(base)) continue;
    const key = base.toLowerCase();
    const g = groups.get(key) || { name: base, broken: true, adult: isAdult(base) };
    g.broken = g.broken && broken;
    groups.set(key, g);
  }
  extractorsCache = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return extractorsCache;
}

// True while any engine process runs (a lookup, a download, a version or site-list query).
const busy = () => registry.size > 0 || replacing;
// Stops every engine process and waits for the process trees to exit (app quit, app update).
const stopAll = (timeoutMs) => registry.stopAll(timeoutMs);
// A lookup result file Grab wrote itself (the only info file a download may load).
const isInfoFile = (p) => typeof p === 'string' && path.dirname(path.resolve(p)) === path.resolve(INFO_DIR) && /^[0-9a-f]{40}-\d+\.json$/.test(path.basename(p));

module.exports = { version, analyze, download, safeName, extractors, cleanInfoCache, setUserBinDir, reconcileEngine, updateEngine, busy, stopAll, isInfoFile };
