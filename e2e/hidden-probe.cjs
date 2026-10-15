// GRB-12: the hidden player probe, in real Electron, against a local fixture site (nothing online).
// The fixture's media answers only with the cookie its page sets and the page as Referer; its
// stream manifest is fetched cross-origin (Origin header). Passes when the probe returns those
// sources with the request context the player used and a cookie handle whose jar holds the
// page's cookie. Exit code 0/1.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-probe-')));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const site = await require(path.join(__dirname, '..', 'tests', 'fixtures', 'media-site.cjs')).start();
  const hiddenProbe = require(path.join(__dirname, '..', 'electron', 'hidden-probe.cjs'));
  const browserSession = require(path.join(__dirname, '..', 'electron', 'browser-session.cjs'));
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
  try {
    const page = site.base + '/watch';
    const r = await hiddenProbe.findMedia(page, { timeoutMs: 8000 });
    const clip = r.candidates.find((c) => c.url === site.base + '/media/clip');
    const port = new URL(site.base).port;
    const stream = r.candidates.find((c) => c.url === `http://localhost:${port}/live/stream.m3u8`);
    check('title from the page', r.title === 'Fixture lesson', r.title);
    check('extensionless player source found', !!clip, r.candidates.map((c) => c.url).join(' '));
    // Existing policy: the player's sources first (manifests before files), then other media by size.
    // The extensionless file the <video> points at counts as the player's own, so it ranks above a
    // larger file the page fetched separately.
    const order = r.candidates.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''));
    check('ranking: player manifest, player file, then other media', JSON.stringify(order.slice(0, 3)) === JSON.stringify(['/live/stream.m3u8', '/media/clip', '/media/big.mp4']), order.join(' '));
    check('player source keeps its Referer', clip?.requestContext?.referer === page, JSON.stringify(clip?.requestContext));
    check('cross-origin manifest keeps its Origin', stream?.requestContext?.origin === site.base, JSON.stringify(stream?.requestContext));
    check('cookie handle returned', !!r.cookieRef);
    await browserSession.withSessionCookies(r.cookieRef, async (file) => {
      const jar = file ? fs.readFileSync(file, 'utf8') : '';
      check('jar holds the cookie the page set', /#HttpOnly_127\.0\.0\.1\tFALSE\t\/\tFALSE\t0\tplay\tgranted/.test(jar), jar.split('\n').slice(1).join(' | '));
    });
    check('not reported as protected', r.protected === false);
    check('the player was served (it had the cookie and Referer)', site.log.some((l) => l.url === '/media/clip' && /play=granted/.test(l.cookie || '')));
  } catch (error) {
    check('probe ran', false, error.stack);
  } finally {
    await site.close();
  }
  const ok = checks.every(Boolean);
  console.log(ok ? 'PASS hidden probe' : 'FAIL hidden probe');
  app.exit(ok ? 0 : 1);
});
