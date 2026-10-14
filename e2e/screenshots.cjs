// Screenshots of every screen of one app (Grab, Morph or Tune) for the media folder, in Hebrew, at
// 1347x852. Runs in its own throwaway profile seeded with a copy of the user's settings and
// history, so the real apps and their data are untouched. For Tune, only the two read-only
// service requests (version, sensors) may reach the background service; anything else is refused.
const net = require('net');
const { EventEmitter } = require('events');
const realConnect = net.connect;
const READ_ONLY_OPS = ['version', 'sensors'];
net.connect = (...a) => {
  if (!String(a[0]).includes('pipe')) return realConnect(...a);
  // A stand-in socket: the request is checked before anything is sent to the service.
  const fake = new EventEmitter();
  let real = null;
  Object.assign(fake, {
    setEncoding() {},
    destroy() { if (real) real.destroy(); },
    write(data) {
      let op = null;
      try { op = JSON.parse(String(data)).op; } catch { /* not a request */ }
      if (!READ_ONLY_OPS.includes(op)) {
        setImmediate(() => fake.emit('error', Object.assign(new Error(`refused in screenshots: ${op}`), { code: 'ECONNREFUSED' })));
        return true;
      }
      real = realConnect(...a);
      real.setEncoding('utf8');
      real.on('connect', () => real.write(data));
      for (const ev of ['data', 'error', 'close']) real.on(ev, (x) => fake.emit(ev, x));
      return true;
    },
  });
  setImmediate(() => fake.emit('connect'));
  return fake;
};

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const dir = APP_DIR;
const outDir = OUT_DIR;
// this app's name, and its real profile (settings and history are copied from it, never written)
const appName = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).build.productName;
const realProfile = path.join(process.env.APPDATA, appName.toLowerCase());
const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), `shots-${appName}-`));
for (const f of ['settings.json', 'history.json', 'cache.json']) {
  const src = path.join(realProfile, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(profile, f));
}
// Hebrew everywhere (Tune keeps the language in settings.json)
try { const s = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); s.lang = 'he'; fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(s)); } catch { /* no settings yet */ }
app.setPath('userData', profile);
// the app's own version (run from source, Electron would report its own)
const pkgVersion = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
app.getVersion = () => pkgVersion;
app.on('window-all-closed', () => {});

const STEPS = {
  Grab: [
    { nav: 'היסטוריה', file: '01 - היסטוריה' },
    { nav: 'ספרייה', file: '02 - ספרייה' },
    { nav: 'הגדרות', file: '03 - הגדרות' },
    { nav: 'הורדות', click: 'אתרים', waitFor: '.modal', settle: 2500, file: '04 - חלון אתרים נתמכים', close: true },
    { nav: 'הורדות', click: 'שצריך להתחבר אליו?', waitFor: '.modal', file: '05 - חלון הורדה מאתר שצריך להתחבר אליו', close: true },
  ],
  Morph: [
    { navIndex: 1, file: '01 - המרת יחידות' },
    { navIndex: 2, file: '02 - היסטוריה' },
    { navIndex: 3, file: '03 - הגדרות' },
  ],
  Tune: [
    { nav: 'החומרה שלי', file: '01 - החומרה שלי' },
    { nav: 'סקירה', file: '02 - סקירה', settle: 4000 },
    { nav: 'ניקוי', file: '03 - ניקוי' },
    { nav: 'הפעלה עם Windows', file: '04 - הפעלה עם Windows' },
    { nav: 'מעבד וזיכרון', file: '05 - מעבד וזיכרון', settle: 32000 },
    { nav: 'מרכז ביצועים', file: '06 - מרכז ביצועים', settle: 3000 },
    { nav: 'מרכז ביצועים', click: 'איך עושים', waitFor: '.modal', file: '07 - חלון מדריך הגבלת הספק', close: true },
    { nav: 'היסטוריה ושחזור', file: '08 - היסטוריה ושחזור' },
    { nav: 'הגדרות', file: '09 - הגדרות' },
  ],
};

app.whenReady().then(async () => {
  require(path.join(dir, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => app.exit(1), 300000);
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await wait(30);
  win.setContentSize(1347, 852);
  // on the second monitor (not the primary one), centered in its work area
  const other = screen.getAllDisplays().find((d) => d.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay();
  const [ww, wh] = win.getSize(); const wa = other.workArea;
  win.setPosition(Math.round(wa.x + (wa.width - ww) / 2), Math.round(wa.y + (wa.height - wh) / 2));
  win.show();
  const js = (c) => win.webContents.executeJavaScript(c).catch(() => null);
  while (!(await js(`document.querySelectorAll('.nav-item, nav button, .sidebar button').length`))) await wait(50);
  // Let the first scan finish so pages show fresh results (no "updating" label).
  for (let i = 0; i < 180 && (await js(`!!document.querySelector('.dot-off, .stale-chip')`)); i++) await wait(1000);
  await wait(1500);
  const navButtons = `[...document.querySelectorAll('.nav-item, .sidebar nav button')]`;
  const shot = async (name) => {
    // two captures: the first can still hold the previous frame after a long idle wait
    win.focus(); win.webContents.invalidate(); await wait(400);
    await win.webContents.capturePage(); await wait(250); win.webContents.invalidate(); await wait(250);
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log('saved', name);
  };
  // MAIN_TOO=1 also photographs each app's main screen first (for comparing against the design)
  const MAIN = { Grab: { nav: 'הורדות', file: '00 - הורדות' }, Morph: { navIndex: 0, file: '00 - המרה' }, Tune: { nav: 'עדכונים', file: '00 - עדכונים' } };
  const steps = process.env.MAIN_TOO ? [MAIN[appName], ...STEPS[appName]] : STEPS[appName];
  for (const s of steps) {
    if (s.nav) await js(`${navButtons}.find((b) => b.textContent.includes(${JSON.stringify(s.nav)}))?.click()`);
    if (s.navIndex != null) await js(`${navButtons}[${s.navIndex}]?.click()`);
    await wait(900);
    if (s.click) {
      const ok = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(s.click)})); if (b) b.click(); return !!b; })()`);
      if (!ok) { console.log('MISSING button', s.click); continue; }
      for (let i = 0; i < 40 && !(await js(`!!document.querySelector(${JSON.stringify(s.waitFor)})`)); i++) await wait(100);
    }
    await wait(s.settle || 800);
    await shot(s.file);
    if (s.close) { await js(`document.querySelector('.modal .icon-btn')?.click()`); await wait(400); }
  }
  app.exit(0);
});
