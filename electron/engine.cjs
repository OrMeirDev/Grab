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
const { normalizeContext, mediaExpiry } = require('./domain/media-request-context.cjs');
const { safeName } = require('./domain/output-names.cjs');
const { ensurePrivateDir } = require('./infrastructure/private-info-dir.cjs');
const { sharedCookieVault: privateVault } = require('./infrastructure/cookie-vault.cjs');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const CONTEXT_KEY = crypto.randomBytes(32).toString('hex');

// An engine updated from inside the app lives in the user's data folder, so reinstalling or
// updating Grab never overwrites it with an older copy. It takes priority over the bundled one.
let userBinDir = null;
function setUserBinDir(dir) { userBinDir = dir; }

// Tools from the machine itself (WinGet, PATH) are a development convenience only: the installed
// app runs the tools it ships (pinned in native-tools.lock.json) or the user's updated yt-dlp, so
// what it runs never depends on what else is installed (GRB-06).
let allowSystemTools = true;
function configure(options = {}) {
  if ('allowSystemTools' in options) allowSystemTools = !!options.allowSystemTools;
}
const userEnginePath = () => userBinDir && path.join(userBinDir, 'yt-dlp' + EXE);

function bundledDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin'));
  dirs.push(path.join(__dirname, '..', 'bin'));
  if (allowSystemTools && IS_WIN && process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
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
  return findIn(candidateDirs(), name) || (allowSystemTools ? name : path.join(bundledDirs()[0], name + EXE)); // PATH only in development
}

// winget installs ffmpeg in its own package folder without a Links shortcut, so look there too.
let ffmpegDirCache;
function ffmpegDir() {
  if (ffmpegDirCache !== undefined) return ffmpegDirCache;
  ffmpegDirCache = null;
  for (const dir of candidateDirs()) {
    if (fs.existsSync(path.join(dir, 'ffmpeg' + EXE))) return (ffmpegDirCache = dir);
  }
  const pkgs = allowSystemTools && IS_WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
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
    PATH: [...extra, ...(allowSystemTools ? [process.env.PATH || ''] : [process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '']) ].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    YTDLP_NO_PLUGINS: '',
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
function run(args, { onLine, exe, kind = 'analyze', signal, internal = false, timeoutMs, idleTimeoutMs, input, requestUrls = [] } = {}) {
  if (replacing && !internal) {
    const result = { code: -1, out: '', err: 'ERROR: the download engine is being updated', engineUpdating: true };
    return { child: null, done: Promise.resolve(result), stop: () => {} };
  }
  const origins = [...new Set(requestUrls.flatMap((url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? [u.origin] : []; } catch { return []; } }))];
  const plugins = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'engine-plugins'))
    ? path.join(process.resourcesPath, 'engine-plugins') : path.join(__dirname, '..', 'engine-plugins');
  // Naming the mandatory PP makes a missing/failed guard fatal before any site request.
  // No plugins from the user's config, executable directory or PYTHONPATH are loaded.
  const guard = ['analyze', 'download'].includes(kind) ? ['--no-plugin-dirs', '--plugin-dirs', plugins, '--use-postprocessor', 'GrabPrivacy:when=pre_process'] : ['--no-plugin-dirs'];
  return runProcess(exe || findBinary('yt-dlp'), ['--ignore-config', '--encoding', 'utf-8', ...guard, ...args], {
    env: { ...spawnEnv(), GRAB_HEADER_ORIGINS: JSON.stringify(origins), GRAB_CONTEXT_KEY: CONTEXT_KEY }, onLine, signal, input, registry, label: kind, ...LIMITS[kind], ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
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
    const updated = compareVersions(after, before || '0') > 0;
    // A record of what the in-app updater changed, next to the updated engine.
    try { fs.writeFileSync(path.join(userBinDir, 'engine-update.json'), JSON.stringify({ before, after, at: new Date().toISOString() }, null, 2)); } catch { /* not essential */ }
    return { ok: true, before, after, updated };
  } finally {
    replacing = false;
  }
}

// Lookup results stay in memory so a download can reuse them without persisting secrets.
// Random disk markers retain the existing job lifecycle; legacy cache files are scavenged.
const INFO_DIR = path.join(os.tmpdir(), 'grab-info');
const INFO_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const privateInfo = new Map();

function releaseInfo(infoFile) {
  const entry = privateInfo.get(infoFile);
  if (entry) { privateVault.forgetMetadata(entry.reference); clearTimeout(entry.timer); }
  privateInfo.delete(infoFile);
  if (isInfoFile(infoFile)) { try { fs.rmSync(infoFile, { force: true }); } catch { /* startup cleans leftovers */ } }
}

function prunePrivateInfo() {
  for (const [file, entry] of privateInfo) {
    if (!privateVault.hasMetadata(entry.reference) || !fs.existsSync(file)) releaseInfo(file);
  }
}

// Start-up: old markers have no live context; older Grab versions also left signed metadata.
// A restored job looks up afresh, so none of those files may be reused.
function cleanInfoCache() {
  for (const entry of privateInfo.values()) clearTimeout(entry.timer);
  privateInfo.clear();
  privateVault.clearMetadata();
  try {
    for (const f of fs.readdirSync(INFO_DIR)) fs.rmSync(path.join(INFO_DIR, f), { force: true });
  } catch { /* nothing cached yet */ }
}

// referer/title: set when the video was found inside another page's player (see pageprobe.cjs):
// the video is fetched the way that page's player fetches it, and named after the page.
function sessionArgs({ referer, requestContext = {}, cookieFile } = {}) {
  requestContext = normalizeContext(requestContext);
  const ref = requestContext.referer ?? normalizeContext({ referer }).referer;
  const args = [];
  if (cookieFile) args.push('--cookies', cookieFile);
  if (requestContext.userAgent) args.push('--user-agent', requestContext.userAgent);
  if (ref) args.push('--referer', ref);
  if (requestContext.origin) args.push('--add-headers', 'Origin:' + requestContext.origin);
  return args;
}

// Generic extraction also reports images and arbitrary HTTP responses as unknown_video.
// Require a recognized media format, streaming protocol or actual audio/video codec.
const MEDIA_EXT = /^(?:3g2|3gp|aac|aiff?|alac|amr|ape|asf|avi|f4[av]|flac|flv|m2ts|m3u8|m4[av]|mka|mkv|mov|mp2|mp3|mp4|mpd|mpe?g|mts|ogg|oga|ogv|opus|ts|vob|wav|wave|webm|wma|wmv)$/i;
const IMAGE_EXT = /^(?:gif|png|jpe?g|webp|avif|heic|svg|bmp|ico|mhtml)$/i;
function hasMediaFormats(info) {
  const formats = info.formats?.length ? info.formats : [info];
  return formats.some((f) => {
    if (!f.url || IMAGE_EXT.test(f.ext || '') || (f.vcodec === 'none' && f.acodec === 'none')) return false;
    const codec = (value) => typeof value === 'string' && value.length > 0 && !/^(none|unknown|images)$/i.test(value);
    return MEDIA_EXT.test(f.ext || '') || /^(m3u8|http_dash_segments|dash|ism|mss|rtmp|rtsp)(_|$)/i.test(f.protocol || '') || codec(f.vcodec) || codec(f.acodec);
  });
}

// signal: an AbortSignal that cancels the lookup.
async function analyze(url, { title: pageTitle, signal, timeoutMs, ...context } = {}) {
  const extra = sessionArgs(context);
  const r = await run(['-J', '--no-playlist', '--no-warnings', '--skip-download', '--sleep-requests', '1', ...extra, '--', url], { kind: 'analyze', signal, timeoutMs, requestUrls: [url] }).done;
  const { code, out } = r;
  const err = stopNote(r) || r.err;
  if (r.aborted) return { ok: false, error: 'cancelled', kind: 'cancelled' };
  if (r.engineUpdating) return { ok: false, error: 'engine updating', kind: 'engineUpdating' };
  if (code !== 0 || r.truncated || r.timedOut) return failure(err, r.timedOut ? 'probeTimeout' : undefined);
  try {
    const j = JSON.parse(out);
    if (!hasMediaFormats(j)) return { ok: false, kind: 'notmedia', error: 'The response contains no recognized video or audio format' };
    let infoFile = null;
    let reference = null;
    try {
      prunePrivateInfo();
      if (!ensurePrivateDir(INFO_DIR)) throw new Error('Signed metadata cache is not private');
      reference = privateVault.rememberMetadata(out);
      infoFile = path.join(INFO_DIR, `${crypto.randomBytes(20).toString('hex')}-${crypto.randomUUID()}.json`);
      // The disk file is only a lifecycle marker. No extractor output, signed URLs,
      // browser cookies or lookup-time cookies are ever persisted here.
      fs.writeFileSync(infoFile, '{"__grab_private_context":true}', { mode: 0o600, flag: 'wx' });
      const timer = setTimeout(() => releaseInfo(infoFile), INFO_MAX_AGE_MS);
      timer.unref?.();
      privateInfo.set(infoFile, { reference, timer });
    } catch { if (reference) privateVault.forgetMetadata(reference); infoFile = null; }
    return {
      ok: true,
      infoFile,
      infoAt: Date.now(),
      infoExpiresAt: mediaExpiry(url, j.url, j.manifest_url, ...(j.formats || []).flatMap((f) => [f.url, f.manifest_url])),
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

function freshInfo(infoFile, infoAt, expiresAt) {
  prunePrivateInfo();
  if (!infoFile || (expiresAt && Date.now() >= expiresAt - 5000) || Date.now() - (infoAt || 0) >= INFO_MAX_AGE_MS) return false;
  try {
    const metadata = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    return !metadata.__grab_private_context || privateInfo.has(infoFile);
  } catch { return false; }
}

// outputBase: the job's file path without extension, chosen by the output allocator (unique and
// safe). folder/name are the older form, still accepted for callers that don't allocate.
function downloadArgs({ url, mediaUrl, referer, requestContext, cookieFile, outputBase, name, folder, format, quality, infoFile, infoAt, infoExpiresAt, privateInput }) {
  // A literal % in the name must not be read as part of yt-dlp's output template.
  const out = (outputBase || path.join(folder, safeName(name))).replace(/%/g, '%%') + '.%(ext)s';
  // Reuse the lookup result when it's still fresh; otherwise fetch the page again, slowly.
  // A video found inside a page's player is fetched from its own address, as that page does.
  const expiry = [infoExpiresAt, mediaExpiry(mediaUrl || url)].filter((v) => Number.isFinite(v) && v > 0);
  const source = freshInfo(infoFile, infoAt, expiry.length ? Math.min(...expiry) : null) ? ['--load-info-json', privateInput ? '-' : infoFile] : ['--sleep-requests', '1', '--', mediaUrl || url];
  source.unshift(...sessionArgs({ referer, requestContext, cookieFile }));
  // --print implies quiet mode, so --progress is needed to keep the progress lines coming.
  const common = ['--newline', '--progress', '--no-playlist', '--no-warnings', '-R', '10', '--fragment-retries', '10',
    '--progress-template', 'download:GRAB|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:GRABFILE|%(filepath)s',
    // What was actually delivered (the quality setting is a preference, not a guarantee): GRB-11.
    '--print', 'after_move:GRABMETA|%(height)s|%(vcodec)s|%(acodec)s|%(ext)s', '-o', out];
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

function failure(err, kind) {
  const status = String(err || '').match(/(?:HTTP(?:\s+Error)?\s*:?\s*|returned\s+)([45]\d\d)\b/i);
  return { ok: false, error: cleanError(err), kind: kind || errorKind(err), ...(status ? { httpStatus: Number(status[1]) } : {}) };
}

async function verifyOutput(file, format) {
  const invalid = () => ({ ok: false, kind: 'notmedia', error: 'Downloaded file is not valid audio/video in the requested format' });
  try { if (!file || !fs.statSync(file).isFile() || !fs.statSync(file).size) return invalid(); } catch { return invalid(); }
  const exe = findIn([ffmpegDir()].filter(Boolean), 'ffprobe') || findBinary('ffprobe');
  const run = runProcess(exe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=format_name', '-of', 'json', file],
    { env: spawnEnv(), timeoutMs: 15000, maxStdout: 65536, registry, label: 'verification' });
  return { ...run, result: run.done.then((r) => {
    if (r.aborted) return { ok: false, stopped: true };
    if (r.timedOut || r.spawnError) return { ok: false, kind: 'verification', error: 'Could not verify the downloaded media' };
    if (r.code !== 0) return invalid();
    try {
      const info = JSON.parse(r.out);
      const types = new Set((info.streams || []).map((v) => v.codec_type));
      const containers = String(info.format?.format_name || '').split(',');
      const valid = format === 'mp3' ? types.has('audio') && containers.includes('mp3')
        : (types.has('video') || types.has('audio')) && containers.includes('mp4');
      return valid ? { ok: true, file } : invalid();
    } catch { return invalid(); }
  }) };
}

function download(opts, onProgress, { runImpl = run, verifyImpl = verifyOutput } = {}) {
  let file = null;
  let delivered = null;
  let stopped = false;
  let verifier = null;
  prunePrivateInfo();
  const input = privateVault.readMetadata(privateInfo.get(opts.infoFile)?.reference);
  const args = downloadArgs({ ...opts, privateInput: !!input });
  const infoIndex = args.indexOf('--load-info-json');
  const job = runImpl(args, {
    input: infoIndex >= 0 && args[infoIndex + 1] === '-' ? input : undefined,
    requestUrls: [opts.mediaUrl || opts.url],
    kind: 'download', idleTimeoutMs: opts.idleMs,
    onLine: (line) => {
      if (line.startsWith('GRAB|')) {
        const [, pct, speed, eta] = line.split('|');
        onProgress({ percent: parseFloat(pct) || 0, speed: (speed || '').trim(), eta: (eta || '').trim() });
      } else if (line.startsWith('GRABFILE|')) file = line.slice(9).trim();
      else if (line.startsWith('GRABMETA|')) {
        const [, height, vcodec, acodec, ext] = line.split('|').map((v) => (v || '').trim());
        const val = (v) => v && v !== 'NA' && v !== 'none' ? v : null;
        delivered = { height: Number(val(height)) || null, vcodec: val(vcodec), acodec: val(acodec), ext: val(ext) };
      }
    },
  });
  const stop = (reason = 'aborted') => { stopped = true; job.stop ? job.stop(reason) : job.child?.kill(); verifier?.stop?.(reason); };
  const done = job.done.then(async (r) => {
    if (stopped || r.aborted) return { ok: false, stopped: true };
    if (r.engineUpdating) return { ok: false, error: 'engine updating', kind: 'engineUpdating' };
    if (r.code !== 0 || r.idle || r.truncated) return failure(stopNote(r) || r.err, r.idle ? 'stalled' : undefined);
    const verified = verifiedFile(file, opts);
    if (!verified) return { ok: false, error: 'Download finished without an output file', kind: 'other' };
    verifier = await verifyImpl(verified, opts.format);
    if (stopped) verifier.stop?.('aborted');
    const result = verifier.result ? await verifier.result : verifier;
    return stopped ? { ok: false, stopped: true } : { ...result, ...(result.ok ? { delivered } : {}) };
  });
  return { child: { kill: () => stop() }, done, stop };
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
const isInfoFile = (p) => typeof p === 'string' && path.dirname(path.resolve(p)) === path.resolve(INFO_DIR) && /^[0-9a-f]{40}-(?:\d+|[0-9a-f-]{36})\.json$/.test(path.basename(p));

module.exports = { configure, version, analyze, download, safeName, extractors, cleanInfoCache, releaseInfo, setUserBinDir, reconcileEngine, updateEngine, busy, stopAll, isInfoFile, mediaExpiry };
