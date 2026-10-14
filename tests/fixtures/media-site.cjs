// A small local site with a video player, for probe integration checks, and a members-only area
// (/members/*) that answers only with the account cookie of a signed-in browser. The media answers only
// to requests that carry the cookie the page sets and the page as Referer, the way protected
// players behave; a second host (localhost vs 127.0.0.1) serves a stream manifest fetched
// cross-origin, so its request carries an Origin header.
//
// Options (for the Windows installed-app checks): mediaFile - serve this real media file for
// /media/*, /members/* and /public/* media instead of zero bytes; slowMs - send media in 16 KB
// pieces this far apart, so a download is still running while a check pauses, quits or kills.
// /public/* needs nothing (a plain public video). port: listen on this port (0 = any).
const http = require('http');
const fs = require('fs');

function start({ mediaFile, slowMs = 0, port = 0 } = {}) {
  const log = [];
  const media = mediaFile ? fs.readFileSync(mediaFile) : null;
  // Media body: the real file when given (else size zero bytes), slowly when asked.
  const sendMedia = (res, size) => {
    const body = media || Buffer.alloc(size);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length, 'accept-ranges': 'none' });
    if (!slowMs) { res.end(body); return; }
    let at = 0;
    const next = () => {
      if (res.destroyed) return;
      if (at >= body.length) { res.end(); return; }
      res.write(body.subarray(at, at + 16384));
      at += 16384;
      setTimeout(next, slowMs);
    };
    next();
  };
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
    // The same player, but its source is set by script: only a page that runs (a probe) finds it.
    if (req.url === '/player') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'play=granted; Path=/; HttpOnly' });
      res.end('<!doctype html><title>Script player</title><video id="v" muted></video><script>document.getElementById("v").src = "/media/clip";</script>');
      return;
    }
    if (req.url === '/other') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Other</title><video src="/media/other.mp4" muted></video>');
      return;
    }
    if (req.url.startsWith('/media/')) {
      const allowed = /play=granted/.test(req.headers.cookie || '') && /\/(watch|other|player)$/.test(req.headers.referer || '');
      if (!allowed) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('denied'); return; }
      sendMedia(res, req.url === '/media/big.mp4' ? 65536 : 1024);
      return;
    }
    if (req.url.startsWith('/public/')) {
      sendMedia(res, 65536);
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
      sendMedia(res, 65536);
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
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, base, log, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { start };

// Standalone: node tests/fixtures/media-site.cjs <port> [mediaFile] [slowMs] [logFile]
// keeps serving and appends every request to logFile (one JSON line each).
if (require.main === module) {
  const [port, mediaFile, slowMs, logFile] = process.argv.slice(2);
  start({ port: Number(port) || 0, mediaFile: mediaFile || undefined, slowMs: Number(slowMs) || 0 }).then((site) => {
    console.log(site.base);
    let written = 0;
    setInterval(() => {
      if (!logFile) return;
      const fresh = site.log.slice(written);
      written = site.log.length;
      if (fresh.length) fs.appendFileSync(logFile, fresh.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }, 200);
  });
}
