// Liquid glass check: opens an app (throwaway profile, second monitor), switches the sidebar page and
// a segmented switch, and samples the drop's four edges every frame, plus a few screenshots mid-move.
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const dir = APP_DIR;
const out = OUT_DIR;
require('../test-support/electron-profile.cjs').isolateElectronProfile(app, fs.mkdtempSync(path.join(require('os').tmpdir(), 'lg-')));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  require(path.join(dir, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => app.exit(1), 90000);
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(30);
  win.webContents.setZoomFactor(1); win.setContentSize(1347, 852);
  const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) win.setPosition(d.workArea.x + 40, d.workArea.y + 40);
  win.show();
  const js = (c) => win.webContents.executeJavaScript(c);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  await wait(1500);
  const SAMPLE = (sel, click) => `new Promise((done) => {
    const box = document.querySelector(${JSON.stringify(sel)});
    const read = () => { const c = getComputedStyle(box, '::before'); return ['--lg-t','--lg-b','--lg-l','--lg-r'].map((k) => Math.round(parseFloat(c.getPropertyValue(k)))).join(','); };
    const rows = [read()]; const t0 = performance.now();
    (${click})();
    const tick = () => { rows.push(Math.round(performance.now() - t0) + 'ms ' + read()); if (performance.now() - t0 < 800) requestAnimationFrame(tick); else done({ ready: box.className, rows: rows.filter((_, i) => i % 4 === 0 || i === rows.length - 1) }); };
    requestAnimationFrame(tick);
  })`;
  const r1 = await js(SAMPLE('.sidebar nav', `() => [...document.querySelectorAll('.nav-item')].at(-1).click()`));
  console.log('NAV', r1.ready, '\n ' + r1.rows.join('\n '));
  // the main page again, then the format switch (Grab) or the first segmented switch found
  await js(`document.querySelector('.nav-item').click()`); await wait(900);
  if (await js(`!!document.querySelector('.segmented')`)) {
    const r2 = await js(SAMPLE('.segmented', `() => [...document.querySelectorAll('.segmented > button')].find((b) => !b.classList.contains('on')).click()`));
    console.log('SEG', r2.ready, '\n ' + r2.rows.join('\n '));
  }
  // screenshots mid-move on the sidebar
  for (const [i, ms] of [[0, 60], [1, 140], [2, 240], [3, 700]]) {
    await js(`[...document.querySelectorAll('.nav-item')][${i % 2 ? 0 : 2}].click()`);
    await wait(ms);
    fs.writeFileSync(path.join(out, `nav-${ms}.png`), (await win.webContents.capturePage({ x: 1060, y: 80, width: 287, height: 300 })).toPNG());
    await wait(800);
  }
  app.exit(0);
});
