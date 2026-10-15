// Real Electron/React/IPC/settings/coordinator, isolated profile and registry. Network/media
// behavior is covered by the real-engine and real-extension tests; this proves the UI wiring.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-ui-'));
app.setPath('userData', profile);
process.env.LOCALAPPDATA = path.join(profile, 'local');
const output = path.join(root, 'e2e', 'output', 'browser-ui');
fs.mkdirSync(output, { recursive: true });
const engine = require('../electron/engine.cjs');
engine.version = async () => '2026.08.19';
engine.reconcileEngine = async () => {};
engine.extractors = async () => [{ name: 'Youtube' }, { name: 'Vimeo' }];
engine.analyze = async () => ({ ok: true, title: 'סרטון בדיקה', site: 'Generic', duration: 30 });
const browsers = require('../electron/browser/browsers.cjs');
browsers.detectBrowsers = async () => ({ systemDefault: 'chrome', browsers: [
  { id: 'chrome', name: 'Google Chrome', exe: process.execPath }, { id: 'edge', name: 'Microsoft Edge', exe: process.execPath },
] });
const setup = require('../electron/browser/setup.cjs');
const registry = new Map();
Object.assign(setup.windowsRegistry, { get: async (k) => registry.get(k) || null, set: async (k, v) => registry.set(k, v), remove: async (k) => registry.delete(k) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  require('../electron/main.cjs');
  const timeout = setTimeout(() => { console.error('FAIL browser UI timeout'); app.exit(1); }, 90000);
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows().find((w) => w.isVisible()))) await wait(30);
    win.setContentSize(1320, 900);
    const js = (code) => win.webContents.executeJavaScript(code);
    const until = async (code) => { for (let i = 0; i < 200; i++) { const r = await js(code).catch(() => false); if (r) return r; await wait(50); } throw new Error('UI did not reach: ' + code); };
    const click = (text) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('button absent'); b.click(); })()`);
    const shot = async (name) => { await wait(250); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    await until("!!document.querySelector('textarea') && document.body.innerText.includes('המנוע מוכן')");
    await shot('01-downloads');
    await click('הגדרות');
    await until("!!document.querySelector('.browser-settings') && document.querySelectorAll('.browser-card').length === 3");
    await js("[...document.querySelectorAll('.browser-card')].find((x) => x.textContent.includes('Google Chrome')).querySelector('button').click()");
    await until("document.body.innerText.includes('החיבור הותקן')");
    assert.equal(registry.size, 1);
    assert.ok(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Grab', 'browser-integration', 'extension', 'manifest.json')));
    await js("window.grab.browserSet({defaultBrowser:'chrome'})");
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'))).browser.defaultBrowser, 'chrome');
    assert.equal((await js("window.grab.browserResolve('https://www.mako.co.il/video')")).browserId, 'edge');
    assert.equal((await js("window.grab.browserResolve('https://course.example/video')")).browserId, 'chrome');
    await js("document.querySelector('.browser-settings').scrollIntoView({block:'start'})");
    assert.equal(await js("document.querySelector('.settings-scroll').scrollWidth <= document.querySelector('.settings-scroll').clientWidth + 1"), true, 'browser setup must not clip controls horizontally');
    await shot('02-settings');
    await js("document.querySelector('.setting.steps').scrollIntoView({block:'start'})");
    await shot('02b-extension-installation');
    win.setContentSize(1000, 660);
    assert.equal(await js("document.querySelector('.settings-scroll').scrollWidth <= document.querySelector('.settings-scroll').clientWidth + 1"), true, 'setup fits the smallest supported window');
    await shot('02c-settings-small');
    win.setContentSize(1320, 900);
    win.webContents.reload();
    await until("!!document.querySelector('textarea')");
    assert.equal((await js('window.grab.browserState()')).settings.defaultBrowser, 'chrome');
    await js("document.querySelector('textarea').focus()");
    await win.webContents.insertText('https://public.example/video');
    await until("!![...document.querySelectorAll('button')].find((b) => b.textContent.includes('זהה סרטונים') && !b.disabled)");
    await click('זהה סרטונים');
    await until("document.querySelectorAll('.queue-item.is-ready').length === 1");
    await shot('03-ready');
    for (const [label, filename] of [['היסטוריה', '04-history'], ['ספרייה', '05-library']]) {
      await click(label);
      await until("!!document.querySelector('h1')");
      assert.ok((await js('document.querySelector("h1").textContent')).includes(label));
      await shot(filename);
    }
    await click('הגדרות');
    await click('מדריך קצר');
    await until("!!document.querySelector('.modal.guide')");
    assert.ok((await js('document.querySelector(".modal.guide").innerText')).includes('Load unpacked'));
    await shot('06-browser-guide');
    clearTimeout(timeout);
    console.log('PASS browser UI: real setup files, guarded IPC, persisted selection, mako Edge rule, reload, queue and all screens');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
