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
//
// Queue and merge checks (all public, no cookies):
// - /paced/<ms>/<name>.mp4: the media sent in 16 KB pieces <ms> apart (this request only).
// - /rl/<n>/<name>.mp4: the n-th request for this exact path answers 429 Too Many Requests (a
//   site's rate limit), every other request gets the media at the normal pace. n=1 is the lookup.
// - /split/<name>.mpd: a DASH manifest with a video-only and an audio-only stream
//   (split.video / split.audio files, sent at full speed), so yt-dlp downloads both and merges
//   them with FFmpeg; /split/<name>.video.mp4 and /split/<name>.audio.m4a are those streams.
// The server also listens on [::1] when it can, so "localhost" is a second site (its own host).
const http = require('http');
const fs = require('fs');

function start({ mediaFile, slowMs = 0, port = 0, split = null } = {}) {
  const log = [];
  const media = mediaFile ? fs.readFileSync(mediaFile) : null;
  const counts = new Map();
  // Media body: the real file when given (else size zero bytes), slowly when asked.
  const sendMedia = (res, size, pace = slowMs) => {
    const body = media || Buffer.alloc(size);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length, 'accept-ranges': 'none' });
    if (!pace) { res.end(body); return; }
    let at = 0;
    const next = () => {
      if (res.destroyed) return;
      if (at >= body.length) { res.end(); return; }
      res.write(body.subarray(at, at + 16384));
      at += 16384;
      setTimeout(next, pace);
    };
    next();
  };
  // A large stream file, piped from disk at full speed.
  const sendFile = (res, file, type) => {
    const size = fs.statSync(file).size;
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'none' });
    fs.createReadStream(file).pipe(res);
  };
  const manifest = (name) => `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT2S" mediaPresentationDuration="PT${Math.round(split.duration || 60)}S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v720" bandwidth="${split.videoBandwidth || 8000000}" codecs="avc1.64001f" width="1280" height="720" frameRate="25">
        <BaseURL>/split/${name}.video.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="und">
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="44100">
        <BaseURL>/split/${name}.audio.m4a</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const server = http.createServer((req, res) => {
    const host = req.headers.host || '';
    const port = server.address().port;
    const h = req.headers;
    log.push({ url: req.url, host, referer: h.referer, origin: h.origin, cookie: h.cookie, at: Date.now(),
      // Who asked, for checks that a page was not reloaded: a prefetch, a reload, a navigation.
      fetch: [h['sec-fetch-mode'], h['sec-fetch-dest'], h['sec-purpose'] || h.purpose, h['cache-control']].filter(Boolean).join(' '), agent: h['user-agent'] });
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
    const paced = req.url.match(/^\/paced\/(\d+)\//);
    if (paced) {
      sendMedia(res, 65536, Number(paced[1]));
      return;
    }
    const limited = req.url.match(/^\/rl\/(\d+)\//);
    if (limited) {
      const n = (counts.get(req.url) || 0) + 1;
      counts.set(req.url, n);
      log[log.length - 1].n = n;
      if (n === Number(limited[1])) {
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '3600' });
        res.end('Too Many Requests');
        return;
      }
      sendMedia(res, 65536);
      return;
    }
    const dash = split && req.url.match(/^\/split\/([\w-]+)(\.mpd|\.video\.mp4|\.audio\.m4a)$/);
    if (dash) {
      if (dash[2] === '.mpd') {
        res.writeHead(200, { 'content-type': 'application/dash+xml' });
        res.end(manifest(dash[1]));
      } else if (dash[2] === '.video.mp4') {
        sendFile(res, split.video, 'video/mp4');
      } else {
        sendFile(res, split.audio, 'audio/mp4');
      }
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
    const actual = server.address().port;
    const base = `http://127.0.0.1:${actual}`;
    // The same site on [::1] ("localhost"), when IPv6 loopback is available.
    const v6 = http.createServer((req, res) => server.emit('request', req, res));
    v6.on('error', () => {});
    v6.listen(actual, '::1');
    const close = () => new Promise((r) => { v6.close(() => {}); server.close(r); });
    resolve({ server, base, log, close });
  }));
}

module.exports = { start };

// Standalone: node tests/fixtures/media-site.cjs <port> [mediaFile] [slowMs] [logFile]
//   [splitVideo splitAudio splitDuration]
// keeps serving and appends every request to logFile (one JSON line each).
if (require.main === module) {
  const [port, mediaFile, slowMs, logFile, splitVideo, splitAudio, splitDuration] = process.argv.slice(2);
  const split = splitVideo ? { video: splitVideo, audio: splitAudio, duration: Number(splitDuration) || 60 } : null;
  start({ port: Number(port) || 0, mediaFile: mediaFile || undefined, slowMs: Number(slowMs) || 0, split }).then((site) => {
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
