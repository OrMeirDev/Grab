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

// The session-restart path end to end: the real discovery service, the real page probe and browser
// session talking to a real Chromium signed in to the fixture's members area, and the real yt-dlp.
// The hidden probe needs Electron, so a cookieless visitor stands in for it (it would show up in the
// site's log, and its calls are counted). Needs GRAB_TEST_YTDLP_DIR and a Chromium (as above).
function findChrome() {
  const candidates = [process.env.GRAB_TEST_CHROME];
  try { for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome')); } catch { /* not this machine */ }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}
const CHROME = process.platform === 'linux' ? findChrome() : null;

test('real yt-dlp + real discovery + real Chromium: after a restart, a members-only job is looked up and downloaded only with the session', { skip: skip || (!CHROME && 'no Chromium found'), timeout: 240000 }, async () => {
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const site = await require('./fixtures/media-site.cjs').start();
  const engine = require('../electron/engine.cjs');
  const browser = require('../electron/browser-session.cjs');
  const pageprobe = require('../electron/pageprobe.cjs');
  const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
  const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
  const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
  const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
  engine.setUserBinDir(DIR);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-real-session-chrome-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-real-session-'));
  // The user's browser, signed in to the members area (/login sets the account cookie).
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, site.base + '/login'], { stdio: 'ignore' });
  const endpointFile = path.join(profile, 'DevToolsActivePort');
  const until = async (fn, ms = 120000) => { const t0 = Date.now(); while (!(await fn()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); };
  let hiddenCalls = 0;
  const hiddenProbe = { findMedia: async (url) => { hiddenCalls++; await new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', r); }).on('error', r)); return { candidates: [] }; } };
  const run = (saved, browserInfo) => {
    const browserSession = { ...browser, defaultBrowser: () => browserInfo };
    const discovery = createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession });
    const runner = createDownloadRunner({ engine, browserSession, allocator: new OutputAllocator() });
    return new DownloadCoordinator({
      random: () => 0,
      store: { load: async () => saved.list || [], save: async (l) => { saved.list = JSON.parse(JSON.stringify(l)); } },
      getSettings: async () => ({ folder: out, format: 'mp4', quality: 'best' }),
      recordCompletion: async () => {},
      releaseContext: (job) => { if (job.cookieRef) browser.forgetCookies(job.cookieRef); },
      hasSession: (ref) => browser.hasCookies(ref),
      discover: (url, o) => discovery.analyze(url, o),
      startDownload: (plan, p) => runner.start(plan, p),
    });
  };
  const chromeInfo = { name: 'Chrome', scheme: 'chrome', endpointFile };
  const members = (from) => site.log.slice(from).filter((l) => l.url.startsWith('/members/'));
  const cookieless = (from) => members(from).filter((l) => !/account=member/.test(l.cookie || '')).map((l) => l.url);
  try {
    await until(() => fs.existsSync(endpointFile) && site.log.some((l) => l.url === '/login'));
    assert.ok(fs.existsSync(endpointFile), 'Chromium is up');

    // A. Embedded player: found in one run (Grab learns it needs the session), Grab restarts.
    const savedA = {};
    const one = run(savedA, chromeInfo);
    one.add([{ url: site.base + '/members/watch' }]);
    await until(() => ['ready', 'error'].includes(one.jobs[0]?.status));
    assert.equal(one.jobs[0].status, 'ready', JSON.stringify(one.jobs[0].error));
    assert.equal(one.jobs[0].sessionSource, 'browser');
    await one.shutdown();
    browser.disconnectBrowser(); // quitting Grab
    let from = site.log.length;
    let hiddenBefore = hiddenCalls;
    const two = run(savedA, chromeInfo);
    await two.init();
    two.downloadOne(two.jobs[0].id);
    await until(() => ['done', 'error'].includes(two.jobs[0].status));
    assert.equal(two.jobs[0].status, 'done', JSON.stringify(two.jobs[0].error));
    assert.deepEqual(cookieless(from), [], 'A: every members-area request after the restart carried the session');
    assert.ok(members(from).some((l) => l.url === '/members/media'));
    assert.equal(hiddenCalls, hiddenBefore, 'A: the clean hidden probe was not used');
    assert.ok(!two.jobs[0].autoRetried);
    browser.disconnectBrowser();

    // B. Direct authenticated extractor (a restored job: the site's own link, not a page player).
    const savedB = { list: [{ id: 'direct-1', url: site.base + '/members/clip.mp4', label: '', name: 'clip', status: 'paused', progress: 30, site: 'Generic', siteKey: '127.0.0.1', needsSession: true, sessionSource: 'browser', fromPage: false }] };
    from = site.log.length;
    hiddenBefore = hiddenCalls;
    const three = run(savedB, chromeInfo);
    await three.init();
    three.resume('direct-1');
    await until(() => ['done', 'error'].includes(three.jobs[0].status));
    assert.equal(three.jobs[0].status, 'done', JSON.stringify(three.jobs[0].error));
    assert.deepEqual(cookieless(from), [], 'B: every members-area request carried the session');
    assert.equal(hiddenCalls, hiddenBefore);
    browser.disconnectBrowser();

    // C. The browser isn't reachable: an explicit error, and the site sees nothing.
    const savedC = { list: [{ ...savedB.list[0], id: 'direct-2', status: 'ready' }] };
    from = site.log.length;
    const four = run(savedC, { name: 'Chrome', scheme: 'chrome', endpointFile: path.join(profile, 'missing', 'DevToolsActivePort') });
    await four.init();
    four.downloadOne('direct-2');
    await until(() => ['done', 'error'].includes(four.jobs[0].status));
    assert.equal(four.jobs[0].status, 'error');
    assert.equal(four.jobs[0].error.kind, 'sessionRequired');
    assert.deepEqual(members(from).map((l) => l.url), [], 'C: no request at all to the members area');
  } finally {
    browser.disconnectBrowser();
    chrome.kill('SIGKILL');
    await site.close();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
