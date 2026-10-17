// Grab's layout at several window sizes: fills the queue with one row of every state (long names,
// long errors), then reports any visible text that overlaps other text or spills out of its box,
// on every page and in the two dialogs. Screenshots go to <out>/layout-*.png.
const { app, BrowserWindow, screen } = require('electron');
// windows open on the second monitor, out of the way
const toSecondScreen = (w) => { const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) w.setPosition(d.workArea.x + 40, d.workArea.y + 40); };
const path = require('path');
const fs = require('fs');
const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const grab = APP_DIR;
const out = OUT_DIR;
require('../test-support/electron-profile.cjs').isolateElectronProfile(app, fs.mkdtempSync(path.join(require('os').tmpdir(), 'e2e-')));
app.on('window-all-closed', () => {});

const LONG = '-הכשרת הפרימיום המקיפה של DarkCrypto- שיעור מספר 12: ניתוח טכני מתקדם ותבניות מסחר';
const ITEMS = [
  { status: 'downloading', name: 'שיעור 1', site: 'Generic', duration: 1181, height: 1080, progress: 6, speed: '3.21MiB/s', eta: '01:28' },
  { status: 'downloading', name: LONG, site: 'BunnyCdn', duration: 533, height: 720, progress: 64, speed: '12.40MiB/s', eta: '00:07' },
  { status: 'ready', name: LONG, site: 'Generic', duration: 797, height: 1080 },
  { status: 'error', name: '', url: 'https://whop.com/ob-trading/exp_BIcppVGOxRBmA3/app/courses/cors_D9rofCdo3B66B/lessons/lesn_yTOO6A0Juj8Uf/', errorKind: 'notfoundPage', signInHint: true },
  { status: 'analyzing', name: '', url: 'https://my.schooler.biz/s/48083/1627997226605-2/8DxboIo', phase: 'browser', phaseBrowser: 'Brave' },
  { status: 'paused', name: LONG, site: 'YouTube', duration: 3600, height: 2160, progress: 42 },
  { status: 'done', name: 'מה זה ביטקוין', site: 'Youtube', duration: 60, height: 1080 },
].map((x, i) => ({ id: 9000 + i, url: x.url || `https://example.com/v/${i}`, label: '', ...x }));

// Every visible text run, as rectangles clipped by ancestors that hide overflow; pairs from
// different elements that intersect are overlaps.
const CHECK = `(() => {
  const runs = [];
  // with a dialog open, the page behind it is covered: only the dialog counts
  const scope = document.querySelector('.modal') || document.body;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const rect of r.getClientRects()) {
      if (rect.width < 2 || rect.height < 2) continue;
      let box = { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom };
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY)) {
          const c = a.getBoundingClientRect();
          box = { l: Math.max(box.l, c.left), t: Math.max(box.t, c.top), r: Math.min(box.r, c.right), b: Math.min(box.b, c.bottom) };
        }
      }
      if (box.r - box.l < 2 || box.b - box.t < 2) continue;
      runs.push({ el, box, text: n.textContent.trim().slice(0, 30) });
    }
  }
  // Fields, bars, labels and buttons are drawn too, not only text.
  const clip = (el, b) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX + s.overflowY)) {
        const c = a.getBoundingClientRect();
        b = { l: Math.max(b.l, c.left), t: Math.max(b.t, c.top), r: Math.min(b.r, c.right), b: Math.min(b.b, c.bottom) };
      }
    }
    return b;
  };
  for (const el of scope.querySelectorAll('input[type=text], input:not([type]), textarea, select, .progress, .pill, .icon-btn, .thumb, .btn-primary, .btn-ghost, .link-btn')) {
    const c = el.getBoundingClientRect();
    if (c.width < 3 || c.height < 3 || getComputedStyle(el).visibility === 'hidden') continue;
    const inset = el.matches('input, textarea, select') ? 4 : 1;
    const box = clip(el, { l: c.left + inset, t: c.top + inset, r: c.right - inset, b: c.bottom - inset });
    if (box.r - box.l < 2 || box.b - box.t < 2) continue;
    runs.push({ el, box, text: '[' + (el.value || el.placeholder || el.className.split(' ')[0] || el.tagName).slice(0, 26) + ']' });
  }
  const overlaps = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.box.r, b.box.r) - Math.max(a.box.l, b.box.l);
    const h = Math.min(a.box.b, b.box.b) - Math.max(a.box.t, b.box.t);
    if (w > 3 && h > 3) overlaps.push(a.text + '  <>  ' + b.text);
  }
  const wide = document.documentElement.scrollWidth > window.innerWidth + 1;
  return { overlaps: [...new Set(overlaps)].slice(0, 12), wide };
})()`;

app.whenReady().then(async () => {
  require(path.join(grab, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => app.exit(1), 240000);
  await wait(3000);
  const win = BrowserWindow.getAllWindows()[0];
  win.show(); win.focus();
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { win.webContents.invalidate(); await wait(300); fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG()); };
  const nav = (label) => js(`[...document.querySelectorAll('.sidebar button, .sidebar a')].find((b) => b.textContent.includes(${JSON.stringify(label)}))?.click()`);

  // Show the rows through the download coordinator's test seam (in memory only; nothing runs or is saved).
  require(path.join(grab, 'electron', 'main.cjs')).__e2e.seedQueue(ITEMS);
  await wait(500);
  console.log('INJECTED rows', await js(`document.querySelectorAll('.queue-item').length`));

  for (const [w, h] of [[1000, 660], [1200, 760], [1347, 852], [1920, 1040]]) {
    win.setContentSize(w, h); toSecondScreen(win);
    await wait(600);
    const size = `${w}x${h}`;
    const report = async (label, file) => {
      const r = await js(CHECK);
      console.log(`${size} ${label}`, r.wide ? 'SIDEWAYS-SCROLL' : '', r.overlaps.length ? r.overlaps.join(' | ') : 'ok');
      await shot(`layout-${size}-${file}.png`);
    };
    await nav('הורדות'); await wait(300);
    await report('downloads', 'downloads');
    await js(`document.querySelector('.queue').scrollTop = 99999`); await wait(200);
    await report('downloads-end', 'downloads-end');
    await nav('היסטוריה'); await wait(500); await report('history', 'history');
    await nav('ספרייה'); await wait(500); await report('library', 'library');
    await nav('הגדרות'); await wait(500); await report('settings', 'settings');
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('מדריך קצר'))?.click()`); await wait(500);
    await report('guide', 'guide');
    await js(`document.querySelector('.modal .icon-btn')?.click()`); await wait(300);
    await nav('הורדות'); await wait(300);
    await js(`document.querySelector('.more-sites')?.click()`); await wait(1500);
    await report('sites', 'sites');
    await js(`document.querySelector('.modal .icon-btn')?.click()`); await wait(300);
  }
  app.exit(0);
});
