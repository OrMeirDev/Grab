// Wraps yt-dlp: resolves the binaries, reads video info, runs downloads with live progress.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { normalizeContext, mediaExpiry, redactMediaSecrets } = require('./request-context.cjs');

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

// signal / timeoutMs bound a run that must not hang (lookups); onActivity reports any output so a
// caller can watch for a stalled download.
function run(args, { onLine, exe, signal, timeoutMs, onActivity } = {}) {
  const child = spawn(exe || findBinary('yt-dlp'), ['--encoding', 'utf-8', ...args], { env: spawnEnv(), windowsHide: true });
  let timedOut = false;
  let aborted = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
  const onAbort = () => { aborted = true; child.kill(); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
  let out = '';
  let err = '';
  const bufs = { out: '', err: '' };
  const feed = (key, d) => {
    if (!onLine) return;
    bufs[key] += d;
    const lines = bufs[key].split(/\r?\n/);
    bufs[key] = lines.pop();
    lines.forEach(onLine);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { if (onActivity) onActivity(); out += d; feed('out', d); });
  child.stderr.on('data', (d) => { if (onActivity) onActivity(); err += d; feed('err', d); });
  const done = new Promise((resolve) => {
    child.on('error', (e) => { cleanup(); resolve({ code: -1, out, err: String(e.message || e), timedOut, aborted }); });
    child.on('close', (code) => { cleanup(); resolve({ code, out, err, timedOut, aborted }); });
  });
  return { child, done };
}

async function version(exe) {
  const { code, out } = await run(['--version'], { exe }).done;
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
  const [vUser, vBundled] = await Promise.all([version(userExe), version(bundled)]);
  if (!vUser || (vBundled && compareVersions(vBundled, vUser) >= 0)) {
    try { fs.unlinkSync(userExe); } catch { /* in use; try again next start */ }
  }
}

// Self-update via `yt-dlp -U` on the user's own copy (the install folder may be read-only
// and gets replaced on reinstall). Downloads the new release from yt-dlp's GitHub.
async function updateEngine() {
  const userExe = userEnginePath();
  if (!userExe) return { ok: false, error: 'no user folder' };
  const before = await version();
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
  const { code, out, err } = await run(['-U'], { exe: userExe }).done;
  const after = await version(userExe);
  extractorsCache = null; // a new version may support different sites
  if (code !== 0 || !after) return { ok: false, before, after, error: cleanError(err || out) };
  return { ok: true, before, after, updated: compareVersions(after, before || '0') > 0 };
}

// Classify failures so the UI can say what actually happened.
function errorKind(err) {
  if (/not a bot|Sign in to confirm|HTTP Error 429|Too Many Requests/i.test(err)) return 'blocked';
  if (/Private video|members-only|Join this channel|login required|requires authentication|logged[- ]in/i.test(err)) return 'private';
  if (/HTTP(?:\s+Error)?\s*:?\s*403|403 Forbidden|returned 403/i.test(err)) return 'forbidden';
  if (/Unsupported URL|No video formats|is not a valid URL|Unable to extract/i.test(err)) return 'notfound';
  if (/Video unavailable|removed|does not exist|HTTP Error 404/i.test(err)) return 'unavailable';
  if (/getaddrinfo|Network is unreachable|timed out|Connection reset/i.test(err)) return 'network';
  return 'other';
}

function cleanError(err) {
  err = redactMediaSecrets(err);
  const line = err.split(/\r?\n/).reverse().find((l) => l.includes('ERROR')) || err.trim().split(/\r?\n/).pop() || '';
  return line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '').slice(0, 200);
}

function failure(err) {
  const status = String(err || '').match(/(?:HTTP(?:\s+Error)?\s*:?\s*|returned\s+)([45]\d\d)\b/i);
  return { ok: false, error: cleanError(err), kind: errorKind(err), ...(status ? { httpStatus: Number(status[1]) } : {}) };
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

const ANALYZE_TIMEOUT_MS = 120000;
async function analyze(url, { title: pageTitle, signal, timeoutMs = ANALYZE_TIMEOUT_MS, ...context } = {}) {
  const extra = sessionArgs(context);
  const { code, out, err, timedOut, aborted } = await run(['-J', '--no-playlist', '--no-warnings', '--skip-download', '--sleep-requests', '1', ...extra, url], { signal, timeoutMs }).done;
  if (aborted) return { ok: false, kind: 'cancelled', error: 'Cancelled' };
  if (timedOut) return { ok: false, kind: 'probeTimeout', error: 'The lookup took too long' };
  if (code !== 0) return failure(err);
  try {
    const j = JSON.parse(out);
    if (!hasMediaFormats(j)) return { ok: false, kind: 'notmedia', error: 'The response contains no recognized video or audio format' };
    let infoFile = null;
    try {
      fs.mkdirSync(INFO_DIR, { recursive: true });
      infoFile = path.join(INFO_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}-${crypto.randomUUID()}.json`);
      fs.writeFileSync(infoFile, out, { mode: 0o600 });
    } catch { infoFile = null; }
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

const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;
function safeName(name) {
  return (name || 'video').replace(INVALID, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 180) || 'video';
}

function freshInfo(infoFile, infoAt, expiresAt) {
  return !!infoFile && (!expiresAt || Date.now() < expiresAt - 5000) && Date.now() - (infoAt || 0) < INFO_MAX_AGE_MS && fs.existsSync(infoFile);
}

function downloadArgs({ url, mediaUrl, referer, requestContext, cookieFile, name, folder, format, quality, infoFile, infoAt, infoExpiresAt }) {
  const out = path.join(folder, safeName(name) + '.%(ext)s');
  // Reuse the lookup result when it's still fresh; otherwise fetch the page again, slowly.
  // A video found inside a page's player is fetched from its own address, as that page does.
  const expiry = [infoExpiresAt, mediaExpiry(mediaUrl || url)].filter((t) => Number.isFinite(t) && t > 0);
  const source = freshInfo(infoFile, infoAt, expiry.length ? Math.min(...expiry) : null) ? ['--load-info-json', infoFile] : ['--sleep-requests', '1', mediaUrl || url];
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

function verifyOutput(file, format, onChild) {
  const invalid = () => ({ ok: false, kind: 'notmedia', error: 'Downloaded file is not valid audio/video in the requested format' });
  try { if (!file || !fs.statSync(file).isFile() || !fs.statSync(file).size) return Promise.resolve(invalid()); }
  catch { return Promise.resolve(invalid()); }
  return new Promise((resolve) => {
    const exe = findIn([ffmpegDir()].filter(Boolean), 'ffprobe') || findBinary('ffprobe');
    const probe = spawn(exe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=format_name', '-of', 'json', file], { env: spawnEnv(), windowsHide: true });
    let out = '';
    let finished = false;
    const finish = (result) => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { probe.kill(); finish({ ok: false, kind: 'verification', error: 'Media verification timed out' }); }, 15000);
    probe.stdout.on('data', (data) => { out = (out + data).slice(0, 65536); });
    probe.stderr.resume();
    probe.on('error', () => finish({ ok: false, kind: 'verification', error: 'Could not run ffprobe to verify the downloaded file' }));
    probe.on('close', (code) => {
      if (code !== 0) return finish(invalid());
      try {
        const info = JSON.parse(out);
        const types = new Set((info.streams || []).map((s) => s.codec_type));
        const containers = String(info.format?.format_name || '').split(',');
        const valid = format === 'mp3' ? types.has('audio') && containers.includes('mp3')
          : (types.has('video') || types.has('audio')) && containers.includes('mp4');
        finish(valid ? { ok: true, file } : invalid());
      } catch { finish(invalid()); }
    });
    onChild(probe);
  });
}

// A download that prints nothing for this long is stalled. Any output (progress, fragment retries,
// merge messages) counts as activity, so a long download is never cut off for being long.
const DOWNLOAD_IDLE_MS = 180000;

function download(opts, onProgress, { runImpl = run } = {}) {
  let file = null;
  let stopped = false;
  let stalled = false;
  let verifying = null;
  let idle = null;
  let job = null;
  const idleMs = opts.idleMs ?? DOWNLOAD_IDLE_MS;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { stalled = true; job.child.kill(); }, idleMs);
  };
  job = runImpl(downloadArgs(opts), {
    onActivity: arm,
    onLine: (line) => {
      if (line.startsWith('GRAB|')) {
        const [, pct, speed, eta] = line.split('|');
        onProgress({ percent: parseFloat(pct) || 0, speed: (speed || '').trim(), eta: (eta || '').trim() });
      } else if (line.startsWith('GRABFILE|')) {
        file = line.slice(9).trim();
      }
    },
  });
  arm();
  const child = { kill: () => { stopped = true; clearTimeout(idle); job.child.kill(); if (verifying) verifying.kill(); } };
  const done = job.done.then(async ({ code, err }) => {
    clearTimeout(idle);
    if (stopped) return { ok: false, stopped: true };
    if (stalled) return { ok: false, kind: 'stalled', error: 'The download stopped making progress' };
    if (code !== 0) return failure(err);
    const result = await verifyOutput(file, opts.format, (probe) => { verifying = probe; if (stopped) probe.kill(); });
    return stopped ? { ok: false, stopped: true } : result;
  });
  return { child, done };
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
  const { code, out } = await run(['--list-extractors']).done;
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

module.exports = { run, version, analyze, download, safeName, extractors, cleanInfoCache, setUserBinDir, reconcileEngine, updateEngine, mediaExpiry };
