// A small local site with a video player, for probe integration checks, and a members-only area
// (/members/*) that answers only with the account cookie of a signed-in browser. The media answers only
// to requests that carry the cookie the page sets and the page as Referer, the way protected
// players behave; a second host (localhost vs 127.0.0.1) serves a stream manifest fetched
// cross-origin, so its request carries an Origin header.
const http = require('http');

function start() {
  const log = [];
  const server = http.createServer((req, res) => {
    const host = req.headers.host || '';
    const port = server.address().port;
    log.push({ url: req.url, host, referer: req.headers.referer, origin: req.headers.origin, cookie: req.headers.cookie });
    if (req.url === '/watch') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'play=granted; Path=/; HttpOnly' });
      res.end(`<!doctype html><title>Fixture lesson</title>
        <video id="v" src="/media/clip" muted></video>
        <script>
          fetch('http://localhost:${port}/live/stream.m3u8').catch(() => {});
          fetch('/media/big.mp4').then((r) => r.arrayBuffer()).catch(() => {});
        </script>`);
      return;
    }
    if (req.url === '/other') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Other</title><video src="/media/other.mp4" muted></video>');
      return;
    }
    if (req.url.startsWith('/media/')) {
      const allowed = /play=granted/.test(req.headers.cookie || '') && /\/watch$|\/other$/.test(req.headers.referer || '');
      const body = Buffer.alloc(req.url === '/media/big.mp4' ? 65536 : 1024);
      res.writeHead(allowed ? 200 : 403, allowed ? { 'content-type': 'video/mp4', 'content-length': body.length } : { 'content-type': 'text/plain' });
      res.end(allowed ? body : 'denied');
      return;
    }
    // A members-only area: everything needs the account cookie a signed-in browser has
    // (/login sets it, for a real test browser profile). Without it: 401, nothing else.
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'account=member; Path=/; HttpOnly' });
      res.end('<!doctype html><title>Signed in</title>');
      return;
    }
    if (req.url.startsWith('/members/')) {
      if (!/account=member/.test(req.headers.cookie || '')) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('sign in'); return; }
      if (req.url === '/members/watch') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Members lesson</title><video src="/members/media" muted></video>');
        return;
      }
      const body = Buffer.alloc(65536);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.url.startsWith('/live/')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' });
      res.end('#EXTM3U\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, base, log, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { start };
