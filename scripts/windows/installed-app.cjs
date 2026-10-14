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

// Download attempts running now. The official yt-dlp.exe is a one-file bundle: each run is a
// launcher plus its child, both named yt-dlp.exe, so an attempt is a yt-dlp.exe whose parent is not.
async function engineAttempts() {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='yt-dlp.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: 'utf8' });
  const procs = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/).map(Number));
  const pids = new Set(procs.map(([pid]) => pid));
  return { processes: procs.length, attempts: procs.filter(([, parent]) => !pids.has(parent)).map(([pid]) => pid) };
}

// What each running yt-dlp.exe was asked to do (a version check, a lookup, a download).
async function engineCommands() {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='yt-dlp.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' });
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/\s+/g, ' ').slice(0, 300));
}

// Samples the engine in the background: the most attempts ever alive at once, and every attempt seen.
function watchProcesses() {
  const w = { max: 0, maxProcesses: 0, samples: 0, attempts: new Set(), stop: false };
  (async () => {
    while (!w.stop) {
      const a = await engineAttempts().catch(() => null);
      if (a) { w.max = Math.max(w.max, a.attempts.length); w.maxProcesses = Math.max(w.maxProcesses, a.processes); a.attempts.forEach((pid) => w.attempts.add(pid)); w.samples++; }
      await wait(100);
    }
  })();
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
  cdp = { ws, send: (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }) };
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
const until = async (fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(250); } return null; };
const rowIn = (states, ms) => until(async () => { const r = await rows(); return r.length && states.includes(r[r.length - 1].state) ? r[r.length - 1] : null; }, ms);

async function paste(text) {
  await nav('הורדות');
  await wait(300);
  await js(`document.querySelector('textarea').focus()`);
  await cdp.send('Input.insertText', { text });
  await wait(300);
  await click('זהה סרטונים');
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
  const watch = watchProcesses();
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
  record('W-07b', 'after reopening, the interrupted download is shown paused and nothing started by itself', restored?.state === 'paused' && requested.length === 0 && !commands.some((c) => c.includes('quit.mp4')), { restored, requestsForTheFile: requested.length, ytdlpRunningAtStart: commands });
  await shot('07-restored-paused');
  await clickTitle('המשך');
  const done = await rowIn(['done', 'error'], 240000);
  record('W-07c', 'resuming the restored download completes it', done?.state === 'done', done);
  await clearQueue();
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
    await step('quit', scenarioQuitDuringDownload);
    await step('cancel', scenarioCancelCleanup);
    await step('kill', scenarioForcedKillCleanup);
    await step('session', scenarioSessionRequired);
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
