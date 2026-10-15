const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const engine = require('../electron/engine.cjs');
const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');
const { createMediaFixture, mediaToolsAvailable } = require('../test-support/media-fixture.cjs');

const available = mediaToolsAvailable();
if (process.env.GRAB_REQUIRE_MEDIA_TOOLS && !available) throw new Error('yt-dlp, ffmpeg and ffprobe are required for this check');

test('real downloader rejects a missing UA, then IPC downloads separate header-bound HLS jobs including cached info', { skip: !available && 'requires yt-dlp, ffmpeg and ffprobe', timeout: 60000 }, async (t) => {
  const fixture = await createMediaFixture();
  t.after(() => fixture.close());
  const a = fixture.source('a', 'Browser A with a bound playback token');
  const b = fixture.source('b', 'A different browser version B');
  const denied = await engine.analyze(a.url, { requestContext: { referer: a.requestContext.referer, origin: a.requestContext.origin } });
  assert.equal(denied.ok, false);
  assert.equal(denied.kind, 'forbidden');
  assert.equal(denied.httpStatus, 403);
  assert.doesNotMatch(denied.error, /fixture-\d|opaque%2F/);

  const handlers = mainHandlers({ ...engine, analyze: (url, options) => url.startsWith(fixture.origin + '/lesson/')
    ? Promise.resolve({ ok: false, kind: 'notfound' }) : engine.analyze(url, options) }, {}, {
    findMedia: async (url) => ({ title: 'Local HLS', candidates: [url.endsWith('/a') ? a : b] }),
  });
  const infos = await Promise.all(['a', 'b'].map((id) => handlers.get('engine:analyze')({ sender }, fixture.pageUrl(id))));
  t.after(() => { for (const info of infos) if (info.infoFile) fs.rmSync(info.infoFile, { force: true }); });
  assert.equal(infos.every((info) => info.ok), true, JSON.stringify(infos));
  assert.notEqual(infos[0].infoFile, infos[1].infoFile);
  assert.equal(infos[0].mediaUrl, a.url);
  assert.equal(infos[1].requestContext.userAgent, b.requestContext.userAgent);
  const results = await Promise.all(infos.map((info, i) => handlers.get('engine:start')({ sender }, {
    ...info, id: 'job-' + i, url: fixture.pageUrl(i ? 'b' : 'a'), name: 'episode-' + i, folder: fixture.dir, format: 'mp4', quality: 'best',
  })));
  for (const result of results) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(result.file), true);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.file], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr);
    const media = JSON.parse(probe.stdout);
    assert.ok(media.streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264'));
    assert.ok(media.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));
    assert.ok(Number(media.format.duration) >= 2.3);
  }
  for (const id of ['a', 'b']) {
    for (const file of ['master.m3u8', 'index.m3u8', 'segment0.ts', 'segment1.ts', 'segment2.ts']) {
      assert.ok(fixture.requests.some((r) => r.id === id && r.file === file && r.authorized), id + '/' + file);
    }
  }
  // An ordinary direct MP4 remains downloadable without any browser context.
  const plain = engine.download({ url: fixture.origin + '/plain.mp4', name: 'ordinary', folder: fixture.dir, format: 'mp4', quality: 'best' }, () => {});
  const plainResult = await plain.done;
  assert.equal(plainResult.ok, true, JSON.stringify(plainResult));
  assert.equal(path.extname(plainResult.file), '.mp4');
});
