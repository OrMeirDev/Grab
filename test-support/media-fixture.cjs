// Generated, public-domain test media only. The local server binds a signed HLS URL to
// the playback headers; manifests, variants AND segments all enforce the same context.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function mediaToolsAvailable() {
  return ['yt-dlp', 'ffmpeg', 'ffprobe'].every((name) => spawnSync(name, ['--version'], { windowsHide: true }).error?.code !== 'ENOENT');
}

async function createMediaFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-media-fixture-'));
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:r=12',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '2.4', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '12', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(dir, 'segment%d.ts'), path.join(dir, 'index.m3u8')], { encoding: 'utf8', windowsHide: true });
  if (generated.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Could not generate HLS fixture: ' + (generated.stderr || generated.error));
  }
  const remuxed = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, 'index.m3u8'), '-c', 'copy', path.join(dir, 'plain.mp4')], { encoding: 'utf8', windowsHide: true });
  if (remuxed.status !== 0) throw new Error('Could not generate MP4 fixture: ' + remuxed.stderr);
  const sources = new Map();
  const requests = [];
  let origin;
  let mediaOrigin;
  let serial = 0;
  const query = '?signature=opaque%2Fvalue%2B%3D';
  function source(id, userAgent) {
    if (!sources.has(id) || userAgent) {
      const prefix = `/media/${id}/hdntl=exp=${Math.floor(Date.now() / 1000) + 3600}~acl=%2f*~hmac=fixture-${++serial}/`;
      sources.set(id, { id, prefix, url: mediaOrigin + prefix + 'master.m3u8' + query, kind: 'stream',
        requestContext: { userAgent: userAgent || 'Fixture browser', referer: origin + '/lesson/' + id, origin } });
    }
    return sources.get(id);
  }
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, origin).pathname;
    if (pathname.startsWith('/lesson/')) {
      const id = pathname.split('/').pop();
      const item = source(id, req.headers['user-agent']);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'unsafe-url' });
      res.end(`<html><title>Fixture lesson ${id}</title><video id="player"></video><script>
        document.querySelector('video').src = URL.createObjectURL(new Blob([], {type:'video/mp4'}));
        fetch(${JSON.stringify(item.url)}).then(r => r.text()).then(() => fetch(${JSON.stringify(mediaOrigin + item.prefix + 'index.m3u8' + query)}));
      </script></html>`);
      return;
    }
    if (pathname === '/plain.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(path.join(dir, 'plain.mp4')).size });
      fs.createReadStream(path.join(dir, 'plain.mp4')).pipe(res);
      return;
    }
    const id = pathname.split('/')[2];
    const item = sources.get(id);
    const file = pathname.split('/').pop();
    const authorized = !!item && req.url === item.prefix + file + query && ['user-agent', 'referer', 'origin'].every((key) =>
      req.headers[key] === item.requestContext[({ 'user-agent': 'userAgent', referer: 'referer', origin: 'origin' })[key]]);
    requests.push({ id, file, authorized, headers: { ...req.headers } });
    if (!authorized) { res.writeHead(403); res.end('Playback request context does not match'); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (file === 'master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.42c00a,mp4a.40.2",RESOLUTION=128x72\nindex.m3u8' + query + '\n');
    } else if (file === 'index.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').replace(/^(segment\d+\.ts)$/gm, '$1' + query));
    } else if (/^segment\d+\.ts$/.test(file) && fs.existsSync(path.join(dir, file))) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.end(fs.readFileSync(path.join(dir, file)));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  mediaOrigin = `http://localhost:${server.address().port}`;
  return {
    dir, origin, requests, source, pageUrl: (id) => origin + '/lesson/' + id,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { createMediaFixture, mediaToolsAvailable };
