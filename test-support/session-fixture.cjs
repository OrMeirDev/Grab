// Local site that behaves like a members-only video site, for the extension and handoff tests.
//   page host   http://127.0.0.1:PORT   (the site's pages)
//   media host  http://localhost:PORT   (its CDN; a different host, so cookies are scoped to it)
// Media on the CDN needs the HttpOnly session cookie (set by visiting /login on the CDN host)
// AND the playback headers (User-Agent, Referer, Origin) of the page that loaded it. Everything
// is generated; nothing contacts the internet.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function ffmpegAvailable(env = process.env) {
  return spawnSync('ffmpeg', ['-version'], { windowsHide: true, env }).status === 0;
}

function generateMedia(dir, env) {
  const run = (args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true, env });
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || r.error));
  };
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=12', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-g', '12', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 'seg%d.ts'), path.join(dir, 'index.m3u8')]);
  run(['-i', path.join(dir, 'index.m3u8'), '-c', 'copy', '-movflags', '+faststart', path.join(dir, 'clip.mp4')]);
}

async function createSessionFixture({ env = process.env } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-session-fixture-'));
  generateMedia(dir, env);
  const secret = crypto.randomBytes(12).toString('hex');
  const requests = [];
  let pageOrigin;
  let cdnOrigin;
  const sig = '?sig=opaque%2Fvalue%2B%3D&exp=' + (Math.floor(Date.now() / 1000) + 3600);
  const mp4 = fs.readFileSync(path.join(dir, 'clip.mp4'));
  const seg = (n) => fs.readFileSync(path.join(dir, `seg${n}.ts`));
  const m3u8 = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
  const master = (rel) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\n${rel}\n`;

  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const hlsLoader = (id) => `<video id="v" muted playsinline></video><script>
    const v = document.getElementById('v');
    v.src = URL.createObjectURL(new Blob([new Uint8Array(8)], { type: 'video/mp4' }));  // blob-backed handle, not a URL
    fetch(${JSON.stringify(cdnOrigin + '/media/' + id + '/master.m3u8' + sig)}, { credentials: 'include' })
      .then((r) => r.text()).then(() => fetch(${JSON.stringify(cdnOrigin + '/media/' + id + '/index.m3u8' + sig)}, { credentials: 'include' }))
      .then((r) => r.text()).then(() => fetch(${JSON.stringify(cdnOrigin + '/media/' + id + '/seg0.ts' + sig)}, { credentials: 'include' }));
  </script>`;

  const pages = {
    '/direct': () => page('Direct video', '<video src="/files/clip.mp4" muted autoplay loop playsinline></video>'),
    '/hls': () => page('HLS via fetch', hlsLoader('episode1')),
    '/xhr-hls': () => page('HLS via XHR', `<video id="v" muted></video><script>
      const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(cdnOrigin + '/media/episode1/master.m3u8' + sig)}); x.withCredentials = true; x.send();
    </script>`),
    '/dash': () => page('DASH', `<video muted></video><script>fetch('/dash/manifest.mpd?token=t1').then((r) => r.text());</script>`),
    '/opaque': () => page('Opaque media URL', `<video muted></video><script>fetch('/stream/9001?sess=abc').then((r) => r.blob());</script>`),
    '/iframe': () => page('Player in an iframe', `<iframe src="${cdnOrigin}/hls" width="320" height="180"></iframe>`),
    '/ads': () => page('Ads and a main video', `<video id="v" muted></video><script>
      fetch('/ads/preroll.mp4?adid=7').then((r) => r.blob());
      fetch('/track/pixel.gif').then((r) => r.blob());
      fetch(${JSON.stringify(cdnOrigin + '/media/episode1/master.m3u8' + sig)}, { credentials: 'include' }).then((r) => r.text());
    </script>`),
    '/two': () => page('Two videos', `<video muted></video><script>
      fetch('/files/clip.mp4?id=a').then((r) => r.blob()); fetch('/files/clip2.mp4?id=b').then((r) => r.blob());
    </script>`),
    '/play': () => page('Redirecting player', `<video muted></video><script>fetch('/go/episode1/master.m3u8', { credentials: 'include' }).then((r) => r.text());</script>`),
    '/needs-click': () => page('Needs a click', `<video id="v" muted></video><button id="start">Play</button><script>
      document.getElementById('start').addEventListener('click', () => fetch(${JSON.stringify(cdnOrigin + '/media/episode1/master.m3u8' + sig)}, { credentials: 'include' }).then((r) => r.text()));
    </script>`),
    '/none': () => page('No video here', '<p>Just text</p>'),
    '/ssr-expired': () => page('Expired signed URL', `<video muted></video><script>fetch(${JSON.stringify(cdnOrigin + '/media/expired/master.m3u8' + sig)}, { credentials: 'include' }).then((r) => r.text());</script>`),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, pageOrigin);
    const host = (req.headers.host || '').split(':')[0];
    const onCdn = host === 'localhost';
    const record = { host, path: url.pathname, search: url.search, cookie: /grabsid=/.test(req.headers.cookie || ''), cookieNames: (req.headers.cookie || '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean), ua: req.headers['user-agent'] || '', referer: req.headers.referer || '', origin: req.headers.origin || '', range: req.headers.range || '' };
    requests.push(record);
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(body); };
    const cors = onCdn ? { 'Access-Control-Allow-Origin': req.headers.origin || pageOrigin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' } : {};
    if (req.method === 'OPTIONS') return send(204, 'text/plain', '', { ...cors, 'Access-Control-Allow-Headers': 'range' });

    if (url.pathname === '/login') {
      return send(200, 'text/html', page('Signed in', 'ok'), { 'Set-Cookie': `grabsid=${secret}; Path=/; HttpOnly; Secure; SameSite=None` });
    }
    if (pages[url.pathname]) return send(200, 'text/html; charset=utf-8', pages[url.pathname](), { 'Referrer-Policy': 'unsafe-url' });
    if (url.pathname.startsWith('/files/')) return send(200, 'video/mp4', mp4, { 'Accept-Ranges': 'none' });
    if (url.pathname === '/stream/9001') return send(200, 'video/mp4', mp4);
    if (url.pathname === '/ads/preroll.mp4') return send(200, 'video/mp4', mp4.subarray(0, 4000));
    if (url.pathname === '/track/pixel.gif') return send(200, 'image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    if (url.pathname === '/dash/manifest.mpd') return send(200, 'application/dash+xml', '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT3S"><Period/></MPD>');
    if (url.pathname.startsWith('/go/')) {
      // The page host redirects to the CDN: the redirect target host must be in the cookie scope.
      const [, , id, file] = url.pathname.split('/');
      return send(302, 'text/plain', '', { Location: `${cdnOrigin}/media/${id}/${file}${sig}` });
    }
    const m = url.pathname.match(/^\/media\/([^/]+)\/(.+)$/);
    if (m && onCdn) {
      const [, id, file] = m;
      // A fetch that followed a cross-origin redirect carries 'Origin: null' by specification.
      const headersOk = !!record.ua && record.referer.startsWith(pageOrigin) && (record.origin === pageOrigin || record.origin === 'null')
        || (record.referer.startsWith(cdnOrigin) && record.origin === cdnOrigin); // an iframe player on the CDN host
      const signedOk = url.search === sig;
      // A plain <video> element sends no Origin header, so direct files only need the session and the signature.
      const authorized = record.cookie && (headersOk || /.mp4$/.test(file)) && signedOk && id !== 'expired';
      record.authorized = authorized;
      if (!authorized) return send(id === 'expired' || !signedOk ? 410 : 403, 'text/plain', 'not authorized', cors);
      if (file === 'clip.mp4') return send(200, 'video/mp4', mp4, cors);
      if (file === 'master.m3u8') return send(200, 'application/vnd.apple.mpegurl', master('index.m3u8' + sig), cors);
      if (file === 'index.m3u8') return send(200, 'application/vnd.apple.mpegurl', m3u8.replace(/^(seg\d+\.ts)$/gm, '$1' + sig), cors);
      const s = file.match(/^seg(\d+)\.ts$/);
      if (s && fs.existsSync(path.join(dir, file))) return send(200, 'video/mp2t', seg(s[1]), cors);
    }
    if (url.pathname === '/hls' && onCdn) return send(200, 'text/html; charset=utf-8', page('HLS in a frame', hlsLoader('episode1')), { 'Referrer-Policy': 'unsafe-url' });
    send(404, 'text/plain', 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  pageOrigin = `http://127.0.0.1:${port}`;
  cdnOrigin = `http://localhost:${port}`;
  return {
    dir, pageOrigin, cdnOrigin, requests, secret, sig,
    url: (p) => pageOrigin + p,
    mediaUrl: (id = 'episode1', file = 'master.m3u8') => `${cdnOrigin}/media/${id}/${file}${sig}`,
    clearRequests: () => { requests.length = 0; },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { createSessionFixture, ffmpegAvailable };
