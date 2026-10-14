// The real yt-dlp (the version pinned in native-tools.lock.json, Linux build) with Grab's exact
// arguments, against the local fixture site: cookies and Referer reach the site (it refuses
// without them), the output template (with a % in the name), progress and the after-move prints
// work, and the finished file is verified. Skipped unless GRAB_TEST_YTDLP_DIR names a folder that
// holds a yt-dlp executable (CI downloads the pinned one; see .github/workflows/ci.yml).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.GRAB_TEST_YTDLP_DIR;
const skip = !(DIR && fs.existsSync(path.join(DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'))) && 'set GRAB_TEST_YTDLP_DIR to run';

test('real yt-dlp: session cookies and context, template escaping, progress, verified file', { skip, timeout: 120000 }, async () => {
  const site = await require('./fixtures/media-site.cjs').start();
  const engine = require('../electron/engine.cjs');
  const browser = require('../electron/browser-session.cjs');
  engine.setUserBinDir(DIR);
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'native-tools.lock.json'), 'utf8')).tools.find((t) => t.name === 'yt-dlp').version;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-real-engine-'));
  try {
    assert.equal(await engine.version(), pinned);
    const media = site.base + '/media/big.mp4';
    const refused = await engine.analyze(media);
    assert.equal(refused.ok, false, 'the fixture refuses a request without the session');
    const ref = browser.rememberCookies([{ domain: '127.0.0.1', path: '/', name: 'play', value: 'granted', session: true }]);
    const requestContext = { userAgent: 'Grab test', referer: site.base + '/watch', origin: site.base };
    await browser.withSessionCookies(ref, async (cookieFile) => {
      const info = await engine.analyze(media, { cookieFile, requestContext });
      assert.equal(info.ok, true, info.error);
      assert.equal(engine.isInfoFile(info.infoFile), true);
      const progress = [];
      const r = await engine.download({ url: site.base + '/watch', mediaUrl: media, outputBase: path.join(out, '100% Lesson'), cookieFile, requestContext, format: 'mp4', quality: 'best', infoFile: info.infoFile, infoAt: info.infoAt }, (p) => progress.push(p)).done;
      assert.equal(r.ok, true, r.error);
      assert.equal(r.file, path.join(out, '100% Lesson.mp4'));
      assert.equal(fs.statSync(r.file).size, 65536);
      assert.ok(progress.some((p) => p.percent === 100));
      assert.equal(r.delivered.ext, 'mp4');
      fs.rmSync(info.infoFile, { force: true });
    });
    const served = site.log.filter((l) => l.url === '/media/big.mp4' && /play=granted/.test(l.cookie || ''));
    assert.ok(served.length >= 2 && served.every((l) => l.referer === site.base + '/watch' && l.host.startsWith('127.0.0.1')));
  } finally {
    await site.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
