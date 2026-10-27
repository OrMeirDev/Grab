// Real renderer → guarded IPC → coordinator → HTTP PDF adapter → file/history.
// Only the video engine and browser integration are unnecessary for this public PDF flow.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-pdf-ui-'));
require('../test-support/electron-profile.cjs').isolateElectronProfile(app, profile);
app.on('window-all-closed', () => {});
const engine = require('../electron/engine.cjs');
engine.version = async () => '2026.08.19';
engine.extractors = async () => [];
engine.reconcileEngine = async () => {};
engine.analyze = async () => { throw new Error('PDF invoked the video extractor'); };
engine.download = () => { throw new Error('PDF invoked the video downloader'); };
const bytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (!(await fn())) { assert.ok(Date.now() < deadline, 'PDF UI did not settle'); await wait(50); }
}
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/lesson') { res.setHeader('Content-Type', 'text/html'); res.end('<a href="/a.pdf">Document A</a><a href="/b.pdf">Document B</a>'); }
    else if (['/a.pdf', '/b.pdf'].includes(req.url)) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length }); res.end(bytes); }
    else { res.writeHead(404); res.end(); }
  });
  let exitCode = 1;
  const watchdog = setTimeout(() => app.exit(1), 60000);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    require('../electron/main.cjs');
    let win;
    await until(() => (win = BrowserWindow.getAllWindows()[0]));
    win.setContentSize(1347, 852);
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error('Renderer command failed: ' + code, { cause: error }); }
    };
    await until(() => js('!!document.querySelector("textarea")').catch(() => false));
    await js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "PDF").click()');
    await js('document.querySelector("textarea").focus()');
    await win.webContents.insertText(`http://127.0.0.1:${server.address().port}/lesson`);
    await js('[...document.querySelectorAll("button")].find(b => b.textContent.includes("זהה קובצי PDF")).click()');
    await until(() => js('document.querySelectorAll(".choice-row button").length === 2'));
    await js('document.querySelectorAll(".choice-row button")[1].click()');
    await until(() => js('!!document.querySelector(".queue-item.is-ready")'));
    await js(`[...document.querySelectorAll('button')].find(b => b.title === 'הורד רק את זה').click()`);
    await until(() => js('!!document.querySelector(".queue-item.is-done")'));
    const history = JSON.parse(fs.readFileSync(path.join(profile, 'history.json'), 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].format, 'pdf');
    assert.equal(path.basename(history[0].file), 'b.pdf');
    assert.deepEqual(fs.readFileSync(history[0].file), bytes);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    const output = path.join(root, 'e2e/output/pdf-download.png');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
    console.log('PASS PDF: select mode, identify page, choose document, download original bytes and record PDF history');
    exitCode = 0;
  } catch (error) { console.error('FAIL PDF UI', error); }
  finally { clearTimeout(watchdog); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.exit(exitCode); }
});
