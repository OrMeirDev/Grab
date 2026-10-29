#!/usr/bin/env node
// Drives the INSTALLED Grab on Windows through its own UI (DevTools protocol on the app window),
// against the local fixture site, and records Pass/Fail with evidence for each scenario.
// Used by .github/workflows/windows-verify.yml after the 1.6.7 -> test-build upgrade; can also be
// run by hand on a Windows test machine. It never touches a person's browser profile: the only
// browser involved is the one Grab looks for, which is expected to be unreachable here.
//
// node scripts/windows/installed-app.cjs --exe <Grab.exe> --user-data <%APPDATA%\Grab>
//   --fixture <http://127.0.0.1:port> --fixture-log <file> --folder <download folder>
//   --out <results dir> --version <expected app version> --media <the fixture's media file>
//   [--split-video <file> --split-audio <file>]   the fixture's DASH streams (merge check)
//   [--feed-dir <dir> --feed-url <url> --next-version <v>]   the local update feed (update check)
const { spawn, execFile, execFileSync } = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const EXE = arg('exe');
const USER_DATA = arg('user-data');
const FIXTURE = arg('fixture');
const FIXTURE_LOG = arg('fixture-log');
const FOLDER = arg('folder');
const OUT = arg('out');
const VERSION = arg('version');
const MEDIA = arg('media');
const SPLIT_VIDEO = arg('split-video');
const SPLIT_AUDIO = arg('split-audio');
const FEED_DIR = arg('feed-dir');
const FEED_URL = arg('feed-url');
const NEXT_VERSION = arg('next-version');
const PORT = 9333;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const record = (id, title, ok, evidence) => {
  results.push({ id, title, status: ok ? 'Pass' : 'Fail', evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- processes, files, fixture log ---------------------------------------------------------
function processes() {
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const count = {};
  for (const line of out.split(/\r?\n/)) {
    const name = (line.split('","')[0] || '').replace(/^"/, '').toLowerCase();
    if (name) count[name] = (count[name] || 0) + 1;
  }
  return { ytdlp: count['yt-dlp.exe'] || 0, ffmpeg: count['ffmpeg.exe'] || 0, grab: count['grab.exe'] || 0 };
}
const fixtureLog = () => (fs.existsSync(FIXTURE_LOG) ? fs.readFileSync(FIXTURE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cookieJars = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('grab-cookies-'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const outputs = () => (fs.existsSync(FOLDER) ? fs.readdirSync(FOLDER) : []);
const diagnostics = () => {
  const file = path.join(USER_DATA, 'logs', 'diagnostics.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

// One PowerShell (procs.ps1) answers every question that needs a command line, and freezes or
// unfreezes a process; questions are sent one at a time.
let helper = null;
function procs(command) {
  if (!helper) {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'procs.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const waiting = [];
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let value;
        try { value = JSON.parse(line); } catch { value = { error: line }; }
        waiting.shift()?.(value);
      }
    });
    helper = { p, waiting, chain: Promise.resolve() };
  }
  const h = helper;
  const answer = h.chain.then(() => new Promise((resolve) => { h.waiting.push(resolve); h.p.stdin.write(command + '\n'); }));
  h.chain = answer.catch(() => {});
  return answer;
}
const list = async (image) => { const r = await procs(`list ${image}`); return Array.isArray(r) ? r : []; };

// Download attempts running now. The official yt-dlp.exe is a one-file bundle: each run is a
// launcher plus its child, both named yt-dlp.exe, so an attempt is a yt-dlp.exe whose parent is not.
// Windows reuses process ids, so an attempt is named by its id and its creation time.
async function engineAttempts() {
  const all = await list('yt-dlp.exe');
  const pids = new Set(all.map((p) => p.pid));
  return { processes: all.length, attempts: all.filter((p) => !pids.has(p.ppid)).map((p) => `${p.pid}@${p.created}`), all };
}

// What each running yt-dlp.exe was asked to do (a version check, a lookup, a download).
const engineCommands = async () => (await list('yt-dlp.exe')).map((p) => p.cmd.replace(/\s+/g, ' ').slice(0, 300));

// Samples the engine in the background: the most attempts ever alive at once, and every attempt
// seen. Resolves once the first sample is in, so nothing a scenario starts afterwards is missed
// (the helper's first answer can take seconds: PowerShell start, compiling, a cold WMI query).
async function watchProcesses() {
  const w = { max: 0, maxProcesses: 0, samples: 0, attempts: new Set(), stop: false };
  let first;
  const ready = new Promise((r) => { first = r; });
  (async () => {
    while (!w.stop) {
      const a = await engineAttempts().catch(() => null);
      if (a) { w.max = Math.max(w.max, a.attempts.length); w.maxProcesses = Math.max(w.maxProcesses, a.processes); a.attempts.forEach((pid) => w.attempts.add(pid)); w.samples++; }
      first();
      await wait(50);
    }
  })();
  await ready;
  return w;
}

// ---- the app ---------------------------------------------------------------------------------
let child = null;
let cdp = null;

function getJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } }); }).on('error', () => resolve(null));
  });
}

async function launch() {
  child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: false });
  let target;
  for (let i = 0; i < 300 && !target; i++) {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    target = (list || []).find((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (!target) await wait(200);
  }
  if (!target) throw new Error('the app window did not appear');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  // The app may close itself (installing an update): unanswered questions get an empty answer.
  ws.on('close', () => { for (const r of pending.values()) r({}); pending.clear(); });
  cdp = {
    ws,
    send: (method, params = {}) => new Promise((r) => {
      if (ws.readyState !== WebSocket.OPEN) return r({});
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
  };
  for (let i = 0; i < 100 && !(await js(`document.querySelectorAll('.nav-item').length`)); i++) await wait(200);
  await wait(800);
}

async function js(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
}

// Graceful close (WM_CLOSE, like the window's X) and wait for every Grab process to end.
async function quitApp({ force = false } = {}) {
  try { cdp?.ws.close(); } catch { /* gone */ }
  const args = force ? ['/PID', String(child.pid), '/T', '/F'] : ['/PID', String(child.pid)];
  try { execFileSync('taskkill', args, { stdio: 'ignore' }); } catch { /* already gone */ }
  for (let i = 0; i < 150 && processes().grab; i++) await wait(200);
  return processes();
}

const nav = (label) => js(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes(${JSON.stringify(label)}))?.click()`);
const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled); if (b) b.click(); return !!b; })()`);
const clickTitle = (title) => js(`(() => { const b = document.querySelector('.queue-item button[title=${JSON.stringify(title)}]'); if (b) b.click(); return !!b; })()`);
// The row's name is an editable field, so it is not part of the row's text.
const rows = () => js(`[...document.querySelectorAll('.queue-item')].map((r) => ({ state: r.className.match(/is-(\\w+)/)?.[1], name: r.querySelector('input.name-input')?.value || '', text: r.innerText.replace(/\\s+/g, ' ').slice(0, 160) }))`);
const until = async (fn, ms = 90000, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(step); } return null; };
const rowIn = (states, ms) => until(async () => { const r = await rows(); return r.length && states.includes(r[r.length - 1].state) ? r[r.length - 1] : null; }, ms);

async function paste(text) {
  await nav('הורדות');
  await wait(300);
  await js(`document.querySelector('textarea').focus()`);
  await cdp.send('Input.insertText', { text });
  await wait(300);
  await click('זהה קבצים');
}
// Removes every row; a row still being looked up has no remove button yet, so keep trying.
async function clearQueue() {
  for (let i = 0; i < 150 && (await rows()).length; i++) {
    await js(`document.querySelector('.queue-item button[title="הסר מהרשימה"]')?.click()`);
    await wait(200);
  }
}
async function setFormat(fmt) {
  await js(`[...document.querySelectorAll('.action-bar .segmented button')].find((b) => b.textContent.includes(${JSON.stringify(fmt)}))?.click()`);
  await wait(300);
}

// ---- scenarios -------------------------------------------------------------------------------
async function scenarioScreens() {
  const info = await js(`({ dir: document.documentElement.dir, lang: document.documentElement.lang, csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'), sidebar: document.querySelector('.sidebar-footer')?.innerText, nav: [...document.querySelectorAll('.nav-item')].map((b) => b.innerText.trim()) })`);
  await shot('01-downloads');
  record('W-10a', 'Hebrew RTL shell, CSP, test version shown', info.dir === 'rtl' && info.lang === 'he' && info.csp && (info.sidebar || '').includes(VERSION) && info.nav.join(',') === 'הורדות,היסטוריה,ספרייה,הגדרות', info);
  await nav('היסטוריה'); await wait(800); await shot('02-history');
  const history = await js(`[...document.querySelectorAll('.row-name')].map((x) => x.innerText)`);
  record('W-01b', 'history from 1.6.7 shown after upgrade', history.includes('שיעור מ-1.6.7'), history);
  await nav('ספרייה'); await wait(800); await shot('03-library');
  await nav('הגדרות'); await wait(800); await shot('04-settings');
  const settingsText = await js(`document.querySelector('.settings')?.innerText || ''`);
  record('W-01c', 'settings from 1.6.7 kept (folder, MP4, 720p)', settingsText.includes(FOLDER) && settingsText.includes('720p'), settingsText.replace(/\s+/g, ' ').slice(0, 300));
  await nav('הורדות'); await wait(300);
}

async function scenarioPublicDownloads() {
  await setFormat('MP4');
  await paste(`${FIXTURE}/public/lesson.mp4\n`);
  let r = await rowIn(['ready', 'error']);
  if (r?.state === 'ready') { await clickTitle('הורד רק את זה'); r = await rowIn(['done', 'error'], 180000); }
  const mp4 = outputs().find((f) => /^lesson.*\.mp4$/i.test(f));
  const size = mp4 ? fs.statSync(path.join(FOLDER, mp4)).size : 0;
  record('W-03a', 'public video found and downloaded as MP4', r?.state === 'done' && !!mp4 && size === fs.statSync(MEDIA).size, { row: r, file: mp4, size });
  await shot('05-public-mp4');
  await clearQueue();

  await setFormat('MP3');
  await paste(`${FIXTURE}/public/song.mp4\n`);
  r = await rowIn(['ready', 'error']);
  if (r?.state === 'ready') { await clickTitle('הורד רק את זה'); r = await rowIn(['done', 'error'], 180000); }
  const mp3 = outputs().find((f) => /^song.*\.mp3$/i.test(f));
  let codec = '';
  try { codec = execFileSync(path.join(path.dirname(EXE), 'resources', 'bin', 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(FOLDER, mp3)], { encoding: 'utf8' }).trim(); } catch (e) { codec = 'ffprobe failed: ' + e.message; }
  record('W-03b', 'public audio downloaded as MP3 (bundled ffmpeg)', r?.state === 'done' && !!mp3 && codec === 'mp3', { row: r, file: mp3, codec });
  await setFormat('MP4');
  await clearQueue();
}

// The page's player needs the cookie the page sets and the page as Referer. Only requests made
// after the lookup finished count: those are the download's, not the probe window's.
async function scenarioHiddenProbe() {
  await paste(`${FIXTURE}/player\n`);
  let r = await rowIn(['ready', 'error'], 120000);
  await wait(1500);
  const from = fixtureLog().length;
  if (r?.state === 'ready') { await clickTitle('הורד רק את זה'); r = await rowIn(['done', 'error'], 180000); }
  await wait(500);
  const media = fixtureLog().slice(from).filter((l) => l.url.startsWith('/media/'));
  const lookup = diagnostics().filter((e) => e.event === 'probe' || e.event === 'lookup').slice(-3);
  const ok = r?.state === 'done' && media.length > 0 && media.every((l) => /play=granted/.test(l.cookie || '') && /\/player$/.test(l.referer || ''));
  record('W-03c', 'player set up by the page script found by the hidden probe; the download carries the page cookie and Referer', ok, { row: r, downloadRequests: media.map((l) => ({ url: l.url, cookie: !!l.cookie, referer: l.referer })), lookup });
  record('W-08a', 'no cookie jar left after a normal completion', cookieJars().length === 0, cookieJars());
  await clearQueue();
}

async function scenarioDuplicates() {
  await paste(`${FIXTURE}/public/dup.mp4\n${FIXTURE}/public/dup.mp4\n`);
  await wait(1500);
  const first = (await rows()).length;
  await paste(`${FIXTURE}/public/dup.mp4\n`);
  await wait(1500);
  const notice = await js(`document.querySelector('.notice')?.innerText || ''`);
  const second = (await rows()).length;
  record('W-02a', 'duplicate links in one paste and against the queue become one row', first === 1 && second === 1 && /כבר היו בתור/.test(notice), { first, second, notice });
  await shot('06-duplicates');
  await clearQueue();
}

async function scenarioPauseResume() {
  await paste(`${FIXTURE}/public/pause.mp4\n`);
  let r = await rowIn(['ready', 'error']);
  const watch = await watchProcesses();
  await clickTitle('הורד רק את זה');
  await rowIn(['downloading']);
  await until(() => processes().ytdlp > 0, 30000);
  await wait(1500);
  await clickTitle('השהה');
  const gone = await until(() => { const p = processes(); return p.ytdlp === 0 && p.ffmpeg === 0 ? p : null; }, 20000);
  const paused = (await rows()).at(-1);
  await clickTitle('המשך');
  r = await rowIn(['done', 'error'], 240000);
  watch.stop = true;
  const files = outputs().filter((f) => /^pause/i.test(f));
  record('W-06a', 'pause ends yt-dlp/ffmpeg; resume completes; never two attempts at once', !!gone && paused?.state === 'paused' && r?.state === 'done' && watch.max === 1 && watch.attempts.size === 2 && files.length === 1 && !files.some((f) => /\.part$/.test(f)), { afterPause: gone, paused, final: r, maxConcurrentAttempts: watch.max, maxYtdlpProcesses: watch.maxProcesses, attempts: [...watch.attempts], samples: watch.samples, files });
  await clearQueue();
}

async function scenarioQuitDuringDownload() {
  await paste(`${FIXTURE}/public/quit.mp4\n`);
  await rowIn(['ready']);
  await clickTitle('הורד רק את זה');
  await rowIn(['downloading']);
  await until(() => processes().ytdlp > 0, 30000);
  await wait(1500);
  const left = await quitApp();
  const queue = readJson(path.join(USER_DATA, 'queue.json')) || [];
  const saved = queue.find((j) => /quit\.mp4/.test(j.url));
  await wait(1000);
  const after = processes();
  record('W-07a', 'quitting during a download ends yt-dlp/ffmpeg and saves the job as paused', after.ytdlp === 0 && after.ffmpeg === 0 && after.grab === 0 && saved?.status === 'paused', { processesAfterQuit: after, left, saved });
  const from = fixtureLog().length;
  await launch();
  const commands = await engineCommands();
  await wait(3000);
  const restored = (await rows()).find((x) => x.name === 'quit');
  const requested = fixtureLog().slice(from).filter((l) => l.url.includes('quit.mp4'));
  record('W-07b', 'after reopening, the interrupted download is shown paused and nothing started by itself', restored?.state === 'paused' && requested.length === 0 && !commands.some((c) => c.includes('quit.%(ext)s')), { restored, requestsForTheFile: requested.length, ytdlpRunningAtStart: commands });
  await shot('07-restored-paused');
  await clickTitle('המשך');
  const done = await rowIn(['done', 'error'], 240000);
  record('W-07c', 'resuming the restored download completes it', done?.state === 'done', done);
  await clearQueue();
}

// ---- pause during the FFmpeg merge (W-06b) ----------------------------------------------------
// The fixture's DASH source has a video-only and an audio-only stream (about 600 MB of synthetic
// video), so yt-dlp downloads both and the bundled FFmpeg merges them. The harness finds that
// FFmpeg (two inputs, `-c copy`, output <name>.temp.mp4), waits until it has written part of the
// merged file and freezes it (NtSuspendProcess, procs.ps1), so Pause lands during the merge however
// fast the runner's disk is. Grab and FFmpeg themselves are unchanged.
const ffprobe = (file) => {
  try {
    return execFileSync(path.join(path.dirname(EXE), 'resources', 'bin', 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  } catch (e) { return JSON.stringify({ error: e.message }); }
};
const historyNames = () => (readJson(path.join(USER_DATA, 'history.json')) || []).map((h) => h.name);
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };

async function scenarioMergePause() {
  if (!SPLIT_VIDEO) { record('W-06b', 'pause during the FFmpeg merge', false, 'no --split-video given'); return; }
  await setFormat('MP4');
  await paste(`${FIXTURE}/split/merge.mpd\n`);
  const found = await rowIn(['ready', 'error'], 120000);
  if (found?.state !== 'ready') { record('W-06b', 'pause during the FFmpeg merge', false, { lookup: found }); return; }
  const watch = await watchProcesses();
  const evidence = {};
  let frozen = null;
  try {
    await clickTitle('הורד רק את זה');
    // This job's merge: FFmpeg with two inputs (its downloaded .f<format> streams) and -c copy into
    // merge.temp.mp4. yt-dlp's other FFmpeg runs (its startup capability probe) don't match.
    const isMerge = (p) => / -c copy /.test(p.cmd) && (p.cmd.match(/ -i /g) || []).length === 2 && /merge\.temp\.mp4/.test(p.cmd);
    const merge = await until(async () => (await list('ffmpeg.exe')).find(isMerge), 300000, 50);
    if (!merge) { record('W-06b', 'pause during the FFmpeg merge', false, { error: 'no merging FFmpeg seen', rows: await rows() }); return; }
    const temp = path.join(FOLDER, 'merge.temp.mp4');
    evidence.merge = { pid: merge.pid, cmd: merge.cmd.slice(0, 600) };
    const writing = await until(() => sizeOf(temp) > 4 * 1024 * 1024, 60000, 5);
    evidence.mergeWritingBeforePause = !!writing;
    const suspended = await procs(`suspend ${merge.pid}`);
    frozen = merge.pid;
    await wait(200); // a write already in progress completes
    const sizeAtPause = sizeOf(temp);
    await wait(700);
    evidence.held = { suspend: suspended, tempBytes: sizeAtPause, tempBytesLater: sizeOf(temp) };
    evidence.ancestry = await procs(`tree ${merge.pid}`);
    evidence.streams = { video: sizeOf(path.join(FOLDER, 'merge.fv720.mp4')), audio: sizeOf(path.join(FOLDER, 'merge.fa128.m4a')), sourceVideo: sizeOf(SPLIT_VIDEO), sourceAudio: sizeOf(SPLIT_AUDIO) };
    evidence.rowAtPause = (await rows()).at(-1);
    const streamRequests = fixtureLog().filter((l) => l.url.startsWith('/split/merge.')).length;
    await shot('09-merge-held');

    await clickTitle('השהה');
    const ended = await until(async () => {
      const p = processes();
      const mergeAlive = (await procs(`alive ${merge.pid}`)).alive;
      return p.ytdlp === 0 && p.ffmpeg === 0 && !mergeAlive ? { ...p, mergeAlive } : null;
    }, 30000);
    if (ended) frozen = null;
    evidence.afterPause = { processes: ended, row: (await rows()).at(-1), files: outputs().filter((f) => /^merge/i.test(f)).sort(), finalExists: fs.existsSync(path.join(FOLDER, 'merge.mp4')), inHistory: historyNames().includes('merge') };
    await shot('10-merge-paused');

    await clickTitle('המשך');
    const done = await rowIn(['done', 'error'], 300000);
    watch.stop = true;
    await wait(500);
    const finalFile = path.join(FOLDER, 'merge.mp4');
    const probe = JSON.parse(ffprobe(finalFile));
    evidence.afterResume = {
      row: done, files: outputs().filter((f) => /^merge/i.test(f)).sort(),
      streamTypes: (probe.streams || []).map((x) => `${x.codec_type}:${x.codec_name}`).sort(), duration: probe.format?.duration,
      newStreamRequests: fixtureLog().filter((l) => l.url.startsWith('/split/merge.')).length - streamRequests,
      maxConcurrentAttempts: watch.max, attempts: [...watch.attempts], left: processes(), inHistory: historyNames().filter((n) => n === 'merge').length,
    };
    const p = evidence.afterPause;
    const r = evidence.afterResume;
    record('W-06b', 'pause during the real FFmpeg merge ends yt-dlp and FFmpeg, publishes nothing; resume merges once (audio + video)',
      evidence.mergeWritingBeforePause && evidence.held.suspend?.status === 0 && evidence.held.tempBytes === evidence.held.tempBytesLater && evidence.held.tempBytes > 0
      && evidence.streams.video === evidence.streams.sourceVideo && evidence.streams.audio === evidence.streams.sourceAudio
      && Array.isArray(evidence.ancestry) && evidence.ancestry.some((a) => /^grab\.exe$/i.test(a.name))
      && !!p.processes && p.row?.state === 'paused' && !p.finalExists && !p.inHistory
      && p.files.includes('merge.fv720.mp4') && p.files.includes('merge.fa128.m4a')
      && r.row?.state === 'done' && r.files.length === 1 && r.files[0] === 'merge.mp4' && r.streamTypes.some((t) => t.startsWith('audio:')) && r.streamTypes.some((t) => t.startsWith('video:'))
      && r.newStreamRequests === 0 && r.maxConcurrentAttempts === 1 && r.attempts.length === 2 && r.left.ytdlp === 0 && r.left.ffmpeg === 0 && r.inHistory === 1,
      evidence);
  } finally {
    watch.stop = true;
    if (frozen) await procs(`resume ${frozen}`);
    await clearQueue();
    try { fs.rmSync(path.join(FOLDER, 'merge.mp4'), { force: true }); } catch { /* disk space only */ }
  }
}

// ---- queue, rate limit and the site hold (W-02b..W-02e) ----------------------------------------
// Two sites on the fixture: 127.0.0.1 and localhost (Grab tells sites apart by host). /rl/<n>/...
// answers 429 Too Many Requests to the n-th request for that path. Grab's existing behaviour for a
// rate limit: the site is held (its lookups and downloads wait) until the user presses
// "resume <site>"; other sites carry on. The timed waits are the 2-4 s gap between lookups (measured
// here in real time) and the YouTube rest (YouTube only; see the e2e check).
const blockedBanner = () => js(`[...document.querySelectorAll('.blocked-banner')].map((b) => b.innerText.replace(/\\s+/g, ' '))`);
const resumeHeldSite = () => js(`(() => { const b = document.querySelector('.blocked-banner button'); if (b) b.click(); return !!b; })()`);
const fileOf = (name) => outputs().filter((f) => f.toLowerCase().startsWith(name + '.') || f.toLowerCase().startsWith(name + ' ('));

async function scenarioQueueRateLimit() {
  const X = FIXTURE;
  const Y = FIXTURE.replace('127.0.0.1', 'localhost');
  await setFormat('MP4');
  // A. Four jobs, two sites; the second job's first download is refused with 429.
  const links = [`${X}/paced/15/q1.mp4`, `${X}/rl/2/q2.mp4`, `${X}/paced/15/q3.mp4`, `${Y}/paced/15/q4.mp4`];
  const from = fixtureLog().length;
  await paste(links.join('\n') + '\n');
  const ready = await until(async () => { const r = await rows(); return r.length === 4 && r.every((x) => x.state === 'ready') ? r : null; }, 240000);
  const firstRequests = (log) => ['q1', 'q2', 'q3', 'q4'].map((q) => log.find((l) => l.url.endsWith(`/${q}.mp4`)));
  const lookupStarts = firstRequests(fixtureLog().slice(from)).map((l) => l?.at || null);
  const gaps = lookupStarts.slice(1).map((t, i) => (t && lookupStarts[i] ? t - lookupStarts[i] : null));
  record('W-02b', 'four links: looked up one at a time, at least 2 s apart (real time), all found', !!ready && gaps.every((g) => g >= 2000), { rows: ready, lookupGapsMs: gaps });

  const watch = await watchProcesses();
  const fromDl = fixtureLog().length;
  await click('הורד הכול');
  const held = await until(async () => { const b = await blockedBanner(); return b.length ? b : null; }, 120000);
  const limited = fixtureLog().find((l) => l.url.endsWith('/q2.mp4') && l.n === 2);
  // While 127.0.0.1 is held: the other site's job downloads, and 127.0.0.1 gets no request at all.
  const otherDone = await until(async () => (await rows()).find((x) => x.name === 'q4' && x.state === 'done'), 120000);
  await wait(8000);
  const heldUntil = Date.now();
  const duringHold = fixtureLog().filter((l) => limited && l.at > limited.at && l.host.startsWith('127.0.0.1'));
  const rowsDuringHold = await rows();
  await shot('11-site-held');
  record('W-02c', '429 on a download holds only that site: no request to it while held, the other site continues',
    !!held && !!limited && duringHold.length === 0 && !!otherDone && rowsDuringHold.filter((x) => x.state === 'queued').length === 2,
    { banner: held, rateLimitedAt: limited?.at, heldForMs: limited ? heldUntil - limited.at : null, requestsToHeldSite: duringHold.map((l) => l.url), rows: rowsDuringHold });

  await resumeHeldSite();
  const allDone = await until(async () => { const r = await rows(); return r.length === 4 && r.every((x) => x.state === 'done') ? r : null; }, 180000);
  watch.stop = true;
  const dl = fixtureLog().slice(fromDl).filter((l) => /\/q[1-4]\.mp4$/.test(l.url)).map((l) => `${l.url.split('/').pop()}${l.n === 2 && l.url.includes('/rl/') ? '(429)' : ''}`);
  const files = ['q1', 'q2', 'q3', 'q4'].map((q) => fileOf(q));
  const perPath = Object.fromEntries(['q1', 'q2', 'q3', 'q4'].map((q) => [q, fixtureLog().filter((l) => l.url.endsWith(`/${q}.mp4`)).length]));
  record('W-02d', 'after "resume", the held jobs download; one attempt at a time; no job lost or downloaded twice',
    !!allDone && files.every((f) => f.length === 1 && /^q\d\.mp4$/.test(f[0])) && files.every((f) => sizeOf(path.join(FOLDER, f[0])) === sizeOf(MEDIA))
    // After a 429 Grab drops the job's saved lookup, so its next attempt fetches the link's
    // information again before downloading: two requests, one attempt (5 attempts in all).
    && JSON.stringify(dl) === JSON.stringify(['q1.mp4', 'q2.mp4(429)', 'q4.mp4', 'q2.mp4', 'q2.mp4', 'q3.mp4']) && watch.max === 1 && watch.attempts.size === 5
    && JSON.stringify(perPath) === JSON.stringify({ q1: 2, q2: 4, q3: 2, q4: 2 }),
    { rows: allDone, downloadOrder: dl, requestsPerLink: perPath, files, maxConcurrentAttempts: watch.max, attempts: watch.attempts.size });
  await clearQueue();

  // B. A 429 during the lookup: the site's other lookups wait; the other site's are not held.
  const fromB = fixtureLog().length;
  await paste([`${X}/rl/1/q5.mp4`, `${X}/paced/15/q6.mp4`, `${Y}/paced/15/q7.mp4`].join('\n') + '\n');
  const heldB = await until(async () => { const b = await blockedBanner(); return b.length ? b : null; }, 120000);
  const q7 = await until(async () => (await rows()).find((x) => x.name === 'q7' && x.state === 'ready'), 120000);
  await wait(8000);
  const logB = fixtureLog().slice(fromB);
  const countB = (q) => logB.filter((l) => l.url.endsWith(`/${q}.mp4`)).length;
  const duringB = { q5: countB('q5'), q6: countB('q6'), q7: countB('q7') };
  await resumeHeldSite();
  const readyB = await until(async () => { const r = await rows(); return r.length === 3 && r.every((x) => x.state === 'ready') ? r : null; }, 120000);
  const logB2 = fixtureLog().slice(fromB);
  const afterCounts = { q5: logB2.filter((l) => l.url.endsWith('/q5.mp4')).length, q6: logB2.filter((l) => l.url.endsWith('/q6.mp4')).length, q7: logB2.filter((l) => l.url.endsWith('/q7.mp4')).length };
  record('W-02e', '429 during a lookup holds that site\'s lookups only; after "resume" they finish, each once',
    !!heldB && !!q7 && JSON.stringify(duringB) === JSON.stringify({ q5: 1, q6: 0, q7: 1 }) && !!readyB && JSON.stringify(afterCounts) === JSON.stringify({ q5: 2, q6: 1, q7: 1 }),
    { banner: heldB, requestsWhileHeld: duringB, requestsAfterResume: afterCounts, rows: readyB });
  await clearQueue();
  for (const q of ['q1', 'q2', 'q3', 'q4']) for (const f of fileOf(q)) fs.rmSync(path.join(FOLDER, f), { force: true });
}

// ---- installing an app update while a download runs (W-07d..W-07h) -----------------------------
// The test builds read updates from a feed on this machine (stamp-test-build.cjs); this serves the
// newer test build there. The app finds it, downloads it and installs it through its own banner
// ("update now", then "restart") while a fixture download is running. Order is measured with the
// attempt's own exit times (handles held before the click) and the installer's creation time;
// process-trace.ps1 adds a coarse timeline.
function startFeed() {
  const log = [];
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://feed').pathname));
    const file = path.join(FEED_DIR, name);
    const entry = { url: req.url, at: Date.now(), range: req.headers.range || null };
    log.push(entry);
    if (!name || !fs.existsSync(file)) { entry.status = 404; res.writeHead(404); res.end(); return; }
    entry.status = 200;
    entry.bytes = fs.statSync(file).size;
    res.writeHead(200, { 'content-length': entry.bytes, 'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  const u = new URL(FEED_URL);
  return new Promise((resolve) => server.listen(Number(u.port), u.hostname, () => resolve({ log, close: () => server.close() })));
}

async function startTrace() {
  const file = path.join(OUT, 'process-trace.jsonl');
  fs.rmSync(file, { force: true });
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'process-trace.ps1'), '-Out', file], { stdio: 'ignore' });
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^﻿/, ''))) : []);
  const ready = await until(() => read().find((e) => e.ev === 'ready' || e.ev === 'error'), 30000);
  return { read, ready, stop: () => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } };
}

const registryVersion = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -like 'Grab*' } | Select-Object -First 1).DisplayVersion"], { encoding: 'utf8' }).trim();
  } catch { return null; }
};
const fileVersion = () => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${EXE}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim(); } catch { return null; } };
const banner = () => js(`document.querySelector('.update-banner')?.innerText.replace(/\\s+/g, ' ') || ''`);

async function scenarioUpdateWhileDownloading() {
  const fail = (id, title, why) => record(id, title, false, why);
  if (!FEED_DIR || !FEED_URL || !NEXT_VERSION) { fail('W-07d', 'app update from the local test feed', 'no --feed-dir/--feed-url/--next-version'); return; }
  const settingsFile = path.join(USER_DATA, 'settings.json');
  const historyFile = path.join(USER_DATA, 'history.json');
  const before = { settings: fs.readFileSync(settingsFile, 'utf8'), history: fs.readFileSync(historyFile, 'utf8'), registry: registryVersion(), file: fileVersion() };
  const appUpdateYml = (() => { try { return fs.readFileSync(path.join(path.dirname(EXE), 'resources', 'app-update.yml'), 'utf8'); } catch { return null; } })();
  const trace = await startTrace();
  const feed = await startFeed();
  try {
    // A fresh start, so the app's own check (3 s after its window loads) finds the feed.
    await quitApp();
    await launch();
    const available = await until(async () => { const b = await banner(); return b.includes(NEXT_VERSION) ? b : null; }, 90000);
    await shot('12-update-available');
    await click('עדכן עכשיו');
    const ready = await until(async () => { const b = await banner(); return /מוכן/.test(b) ? b : null; }, 600000, 500);
    const installerServed = feed.log.filter((l) => l.status === 200 && /\.exe$/.test(new URL(l.url, 'http://feed').pathname));
    record('W-07d', 'the installed app finds the newer test version on the local feed and downloads it (its own banner)',
      !!available && !!ready && feed.log.some((l) => /\.yml(\?|$)/.test(l.url) && l.status === 200) && installerServed.length > 0 && /provider: generic/.test(appUpdateYml || '') && /127\.0\.0\.1/.test(appUpdateYml || ''),
      { appUpdateYml, available, ready, feedRequests: feed.log.map((l) => `${l.status} ${l.url.split('?')[0]}${l.range ? ' ' + l.range : ''}`) });
    if (!ready) return;

    // A download that is running when the update is installed (served slowly: ~25 s).
    await paste(`${FIXTURE}/paced/150/update.mp4\n`);
    await until(async () => (await rows()).find((x) => x.name === 'update' && x.state === 'ready'), 120000);
    await clickTitle('הורד רק את זה');
    // The download's yt-dlp (a launcher and its child): recognised by its output name (the link is
    // not on its command line when it loads the lookup's saved information).
    const attempt = await until(async () => { const a = (await list('yt-dlp.exe')).filter((p) => p.cmd.includes('update.%(ext)s')); return a.length ? a : null; }, 60000, 100);
    const flowing = await until(async () => { const r = (await rows()).find((x) => x.name === 'update'); return r?.state === 'downloading' && /[1-9]\d*(\.\d+)?%/.test(r.text) ? r : null; }, 60000);
    await shot('13-update-ready-while-downloading');
    // Now that bytes are flowing, the attempt's launcher and its child both exist: hold them all.
    const engineNow = await list('yt-dlp.exe');
    const roots = engineNow.filter((p) => p.cmd.includes('update.%(ext)s')).map((p) => p.pid);
    const attemptPids = engineNow.filter((p) => roots.includes(p.pid) || roots.includes(p.ppid)).map((p) => p.pid);
    // Handles to the attempt's processes, so their exact exit times can be read afterwards.
    const holds = [];
    for (const pid of attemptPids) holds.push(await procs(`hold ${pid}`));
    const beforeInstall = { settings: fs.readFileSync(settingsFile, 'utf8'), history: fs.readFileSync(historyFile, 'utf8') };
    // From the click until the new version is installed: which of the attempt's processes are
    // alive, and which installer runs (with its creation time), every 200 ms or so.
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const alive = (await list('yt-dlp.exe')).filter((p) => attemptPids.includes(p.pid)).map((p) => p.pid);
        const inst = await procs('installers');
        samples.push({ at: new Date().toISOString(), attemptAlive: alive, installers: Array.isArray(inst) ? inst : [] });
        await wait(150);
      }
    })();
    const clickedAt = new Date();
    const oldApp = child;
    const oldExit = new Promise((r) => { if (oldApp.exitCode !== null) r(); else oldApp.once('exit', r); });
    await click('הפעל מחדש');
    await Promise.race([oldExit, wait(60000)]);
    // Read what the old version left before anything else starts.
    const queueAtExit = readJson(path.join(USER_DATA, 'queue.json')) || [];
    const partials = outputs().filter((f) => /^update/i.test(f));
    // The installer runs and starts the new version by itself (--force-run).
    const installed = await until(() => (registryVersion() === NEXT_VERSION ? true : null), 300000, 1000);
    const relaunched = await until(async () => { const g = await list('Grab.exe'); return g.length ? g : null; }, 120000, 500);
    await wait(5000);
    sampling = false;
    await sampler;
    const events = trace.read().filter((e) => e.ev === 'start' || e.ev === 'stop');
    const t = (x) => Date.parse(x);
    // When the attempt's processes exited (their own exit times, from the handles held before the
    // click) and when the installer was created (its own creation time, read while it ran): both
    // kernel timestamps. The WMI trace is kept as a timeline only: its times come in ~1 s batches.
    const exits = [];
    for (const pid of attemptPids) exits.push(await procs(`exit ${pid}`));
    const installers = [...new Map(samples.flatMap((s) => s.installers).map((i) => [i.pid, i])).values()].sort((a, b) => t(a.created) - t(b.created));
    const firstInstaller = installers.find((i) => t(i.created) >= clickedAt.getTime() - 1000) || null;
    const allExited = exits.length > 0 && exits.every((e) => e.state === 'exited');
    const lastAttemptStop = allExited ? Math.max(...exits.map((e) => t(e.exitTime))) : null;
    const lastSeenAlive = samples.filter((s) => s.attemptAlive.length).at(-1)?.at || null;
    const overlap = samples.filter((s) => s.attemptAlive.length && s.installers.length);
    const oldStop = events.find((e) => e.ev === 'stop' && e.pid === oldApp.pid);
    const saved = queueAtExit.find((j) => /update\.mp4/.test(j.url));
    record('W-07e', 'installing while a download runs: the download\'s processes end before the installer starts; the job is saved paused',
      !!flowing && attemptPids.length > 0 && holds.every((h) => h.held) && allExited && !!firstInstaller && lastAttemptStop < t(firstInstaller.created) && overlap.length === 0
      && saved?.status === 'paused' && saved.progress > 0 && partials.some((f) => /\.part$/.test(f)),
      { trace: trace.ready, row: flowing, attempt: engineNow.filter((p) => attemptPids.includes(p.pid)).map((p) => ({ pid: p.pid, ppid: p.ppid, created: p.created, cmd: p.cmd.slice(0, 160) })), clickedAt: clickedAt.toISOString(),
        attemptExited: exits, installerCreated: firstInstaller, installersSeen: installers, oldAppStopped: oldStop?.t || null,
        msFromLastAttemptStopToInstaller: firstInstaller && lastAttemptStop ? t(firstInstaller.created) - lastAttemptStop : null,
        attemptLastSeenAlive: lastSeenAlive, samplesWithBoth: overlap.length, samples: samples.length, saved, partials,
        timeline: events.filter((e) => t(e.t) >= clickedAt.getTime() - 2000).map((e) => `${e.t} ${e.ev} ${e.name} ${e.pid}`) });

    // The fixture flushes its request log every 200 ms. Counting from a snapshot taken while
    // the old attempt is running can count that attempt's delayed log entry as a new request.
    // Use each request's receipt time and the old attempt's exact final exit time instead.
    // Keep the whole stopped interval (including the installer), so an automatic restart
    // cannot be hidden by choosing a baseline after the new app has already opened.
    const requestsSinceStop = () => fixtureLog().filter((l) => l.url.endsWith('/update.mp4') && l.at >= lastAttemptStop);
    const requestsAfterInstall = requestsSinceStop();
    // Close it the usual way and open it again where this script can see its window.
    try { execFileSync('taskkill', ['/IM', 'Grab.exe'], { stdio: 'ignore' }); } catch { /* not running */ }
    for (let i = 0; i < 150 && processes().grab; i++) await wait(200);
    if (processes().grab) try { execFileSync('taskkill', ['/IM', 'Grab.exe', '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    await launch();
    const after = { settings: fs.readFileSync(settingsFile, 'utf8'), history: fs.readFileSync(historyFile, 'utf8'), registry: registryVersion(), file: fileVersion() };
    const sidebar = await js(`document.querySelector('.sidebar-footer')?.innerText || ''`);
    record('W-07f', 'the installed version changed to the newer test version, in place; settings and history kept',
      !!installed && after.registry === NEXT_VERSION && before.registry !== NEXT_VERSION && sidebar.includes(NEXT_VERSION) && after.settings === beforeInstall.settings && after.history === beforeInstall.history && JSON.parse(after.history).length > 0,
      { before: { registry: before.registry, file: before.file }, after: { registry: after.registry, file: after.file }, sidebar, settingsSame: after.settings === beforeInstall.settings, historySame: after.history === beforeInstall.history, historyEntries: JSON.parse(after.history).length });
    await wait(3000);
    const restored = (await rows()).find((x) => x.name === 'update');
    const running = await engineCommands();
    const requestsBeforeResume = requestsSinceStop();
    await shot('14-after-update-restored-paused');
    record('W-07g', 'after the update, the interrupted download is restored paused and nothing started by itself',
      !!relaunched && Number.isFinite(lastAttemptStop) && restored?.state === 'paused' && requestsAfterInstall.length === 0 && requestsBeforeResume.length === 0 && !running.some((c) => c.includes('update.%(ext)s')),
      { startedByInstaller: (relaunched || []).map((p) => p.cmd.slice(0, 200)), restored, lastAttemptStop: allExited ? new Date(lastAttemptStop).toISOString() : null,
        requestsForTheFile: { whileInstallerStartedAppRan: requestsAfterInstall.length, untilResume: requestsBeforeResume.length }, requestsAfterStop: requestsBeforeResume, ytdlpRunning: running });

    const watch = await watchProcesses();
    await clickTitle('המשך');
    const done = await until(async () => { const r = (await rows()).find((x) => x.name === 'update'); return r && ['done', 'error'].includes(r.state) ? r : null; }, 300000);
    watch.stop = true;
    await wait(2000);
    const files = outputs().filter((f) => /^update/i.test(f));
    const left = processes();
    record('W-07h', 'resuming it after the update completes: one file, full size, no engine process left',
      done?.state === 'done' && files.length === 1 && files[0] === 'update.mp4' && sizeOf(path.join(FOLDER, 'update.mp4')) === sizeOf(MEDIA) && left.ytdlp === 0 && left.ffmpeg === 0 && watch.max === 1,
      { row: done, files, left, maxConcurrentAttempts: watch.max });
    await clearQueue();
  } finally {
    feed.close();
    trace.stop();
  }
}

// Removing a download while it runs (the row's remove button) ends yt-dlp and deletes its jar.
async function scenarioCancelCleanup() {
  await paste(`${FIXTURE}/player\n`);
  await rowIn(['ready', 'error'], 120000);
  await clickTitle('הורד רק את זה');
  await rowIn(['downloading']);
  const jarsDuring = await until(() => (cookieJars().length ? cookieJars() : null), 30000);
  await clickTitle('הסר מהרשימה');
  const cleared = await until(async () => { const p = processes(); return !cookieJars().length && p.ytdlp === 0 && !(await rows()).length ? p : null; }, 30000);
  record('W-08c', 'removing a running download ends yt-dlp and deletes its cookie jar', !!jarsDuring && !!cleared, { jarsDuring, cleared, jarsAfter: cookieJars(), partialFiles: outputs().filter((f) => /\.part$|\.ytdl$/.test(f)) });
  await clearQueue();
}

async function scenarioForcedKillCleanup() {
  await paste(`${FIXTURE}/player\n`);
  await rowIn(['ready', 'error'], 120000);
  await clickTitle('הורד רק את זה');
  await rowIn(['downloading']);
  const jarsDuring = await until(() => (cookieJars().length ? cookieJars() : null), 30000);
  await quitApp({ force: true });
  const jarsAfterKill = cookieJars();
  await launch();
  await wait(1500);
  const jarsAfterRestart = cookieJars();
  record('W-08b', 'cookie jar exists only while yt-dlp runs; a jar left by a forced kill is removed at the next start', !!jarsDuring && jarsAfterRestart.length === 0, { jarsDuring, jarsAfterKill, jarsAfterRestart });
  await clearQueue();
}

// A job known to need the user's browser session, while no browser can be reached: an explicit
// error, and the members area of the fixture sees no request at all.
async function scenarioSessionRequired() {
  await quitApp();
  const queueFile = path.join(USER_DATA, 'queue.json');
  const queue = readJson(queueFile) || [];
  queue.push({ id: 'win-session-1', url: `${FIXTURE}/members/clip.mp4`, label: '', name: 'members clip', status: 'ready', progress: 0, site: 'Generic', siteKey: '127.0.0.1', needsSession: true, sessionSource: 'browser', fromPage: false });
  fs.writeFileSync(queueFile, JSON.stringify(queue));
  const from = fixtureLog().length;
  await launch();
  await clickTitle('הורד רק את זה');
  const r = await rowIn(['error', 'done'], 60000);
  await wait(1000);
  const members = fixtureLog().slice(from).filter((l) => l.url.startsWith('/members/'));
  record('W-04a', 'browser unreachable: explicit session error, no request to the protected area', r?.state === 'error' && /דורש את/.test(r.text) && members.length === 0, { row: r, membersRequests: members.length });
  await shot('08-session-required');
  await clearQueue();
}

(async () => {
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { record(name, 'scenario crashed', false, String(e.stack || e)); try { await shot('crash-' + name); } catch { /* no window */ } }
  };
  try {
    await launch();
    await step('screens', scenarioScreens);
    await step('public', scenarioPublicDownloads);
    await step('hidden', scenarioHiddenProbe);
    await step('dup', scenarioDuplicates);
    await step('pause', scenarioPauseResume);
    await step('merge', scenarioMergePause);
    await step('quit', scenarioQuitDuringDownload);
    await step('cancel', scenarioCancelCleanup);
    await step('kill', scenarioForcedKillCleanup);
    await step('session', scenarioSessionRequired);
    await step('queue', scenarioQueueRateLimit);
    // Last: it replaces the installed app with the newer test version.
    await step('update', scenarioUpdateWhileDownloading);
  } catch (e) {
    record('launch', 'installed app started', false, String(e.stack || e));
  } finally {
    try { await quitApp(); } catch { /* done */ }
    const diag = path.join(USER_DATA, 'logs', 'diagnostics.log');
    if (fs.existsSync(diag)) fs.copyFileSync(diag, path.join(OUT, 'diagnostics.log'));
    fs.writeFileSync(path.join(OUT, 'installed-app-results.json'), JSON.stringify(results, null, 2));
    const failed = results.filter((r) => r.status !== 'Pass');
    console.log(`\n${results.length - failed.length}/${results.length} installed-app checks passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
