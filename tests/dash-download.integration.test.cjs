const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const engine = require('../electron/engine.cjs');
const { mediaToolsAvailable } = require('../test-support/media-fixture.cjs');

test('real engine downloads DASH on a .ism URL and merges separate audio/video into a decodable MP4', {
  skip: !mediaToolsAvailable() && 'requires yt-dlp, ffmpeg and ffprobe', timeout: 60000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-dash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:r=12',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '2.4', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-c:a', 'aac', '-f', 'dash', '-seg_duration', '1',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a', path.join(dir, 'Manifest.ism')], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    requests.push(name);
    if (!fs.readdirSync(dir).includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name === 'Manifest.ism' ? 'application/dash+xml' : 'video/mp4');
    fs.createReadStream(path.join(dir, name)).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/Manifest.ism`;
  const info = await engine.analyze(url);
  assert.equal(info.ok, true, JSON.stringify(info));
  t.after(() => { if (info.infoFile) engine.releaseInfo(info.infoFile); });
  const result = await engine.download({ ...info, url, outputBase: path.join(dir, 'result'), format: 'mp4', quality: 'best' }, () => {}).done;
  assert.equal(result.ok, true, JSON.stringify(result));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.file], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const streams = JSON.parse(probe.stdout).streams;
  assert.ok(streams.some(s => s.codec_type === 'video' && s.codec_name === 'h264'));
  assert.ok(streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
  assert.ok(requests.some(n => /^chunk-stream0/.test(n)));
  assert.ok(requests.some(n => /^chunk-stream1/.test(n)));
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', result.file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  assert.equal(decoded.status, 0, decoded.stderr);
});
