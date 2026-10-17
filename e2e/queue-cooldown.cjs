// GRB-01: after one YouTube download the queue rests 5–10 seconds, then must start the next one by
// itself. GRB-02: the queue belongs to the main process, so reloading the window during that rest
// neither loses nor repeats a job. Runs the real app with yt-dlp replaced by an instant fake
// (nothing is downloaded or looked up online): pastes two YouTube links, identifies them, presses
// "download all", reloads the window after the first download, and waits. Passes when both rows
// reach "done" within 25 seconds, each started exactly once. Throwaway profile; exit code 0/1.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cooldown-'));
require('../test-support/electron-profile.cjs').isolateElectronProfile(app, profile);
app.on('window-all-closed', () => {});

const engine = require(path.join(APP_DIR, 'electron', 'engine.cjs'));
const started = [];
engine.version = async () => '2026.01.01';
engine.extractors = async () => [];
engine.reconcileEngine = async () => {};
engine.analyze = async (url) => ({ ok: true, title: url.slice(-1), site: 'Youtube', duration: 60, height: 720, infoFile: null, infoAt: Date.now() });
engine.download = (job) => {
  started.push({ url: job.url, at: Date.now() });
  const file = path.join(profile, `${started.length}.mp4`);
  fs.writeFileSync(file, 'x');
  return { child: { kill() {}, pid: 0 }, done: new Promise((r) => setTimeout(() => r({ ok: true, file }), 50)) };
};

app.whenReady().then(async () => {
  require(path.join(APP_DIR, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (why) => { console.log('FAIL', why, JSON.stringify(started)); app.exit(1); };
  setTimeout(() => fail('timeout'), 90000);
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await wait(30);
  const js = (c) => win.webContents.executeJavaScript(c);
  while (!(await js(`!!document.querySelector('textarea')`).catch(() => false))) await wait(50);
  await js(`document.querySelector('textarea').focus()`);
  await win.webContents.insertText('https://www.youtube.com/watch?v=aaaaaaaaaa1\nhttps://www.youtube.com/watch?v=aaaaaaaaaa2\n');
  await wait(300);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('זהה סרטונים')).click()`);
  for (let i = 0; i < 100 && (await js(`document.querySelectorAll('.queue-item.is-ready').length`)) < 2; i++) await wait(100);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('הורד הכול')).click()`);
  const t0 = Date.now();
  let reloaded = false;
  while (Date.now() - t0 < 25000) {
    if (!reloaded && started.length === 1 && (await js(`document.querySelectorAll('.queue-item.is-done').length`).catch(() => 0)) === 1) {
      reloaded = true;
      win.webContents.reload();
      await wait(1500);
      while (!(await js(`document.querySelectorAll('.queue-item').length`).catch(() => 0))) await wait(100);
      console.log('reloaded during the rest; rows after reload:', await js(`document.querySelectorAll('.queue-item').length`));
    }
    if ((await js(`document.querySelectorAll('.queue-item.is-done').length`).catch(() => 0)) === 2) {
      const gap = started[1].at - started[0].at;
      const ok = gap >= 5000 && started.length === 2 && reloaded;
      console.log(`${ok ? 'PASS' : 'FAIL'} both downloads finished; second started ${gap} ms after the first; starts: ${started.length}; reloaded: ${reloaded}`);
      app.exit(ok ? 0 : 1);
      return;
    }
    await wait(250);
  }
  fail(`only ${started.length} download(s) started; rows: ${await js(`[...document.querySelectorAll('.queue-item')].map((x) => x.className).join(' | ')`)}`);
});
