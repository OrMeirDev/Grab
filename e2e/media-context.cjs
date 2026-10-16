// Real Electron network capture -> app analyze/start IPC handlers -> yt-dlp -> playable MP4.
// Uses only generated media, a loopback server and a disposable Electron profile.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-context-e2e-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const engine = require('../electron/engine.cjs');
  const hiddenProbe = require('../electron/hidden-probe.cjs');
  const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');
  const { createMediaFixture, mediaToolsAvailable } = require('../test-support/media-fixture.cjs');
  let fixture;
  let info;
  try {
    assert.ok(mediaToolsAvailable(), 'yt-dlp, ffmpeg and ffprobe must be available');
    fixture = await createMediaFixture();
    let captured;
    const handlers = mainHandlers({ ...engine, analyze: (url, options) => url === fixture.pageUrl('electron')
      ? Promise.resolve({ ok: false, kind: 'notfound' }) : engine.analyze(url, options) }, {
      findMedia: async () => { throw new Error('A public fixture must not require the user browser'); },
    }, { findMedia: async (url) => { captured = await hiddenProbe.findMedia(url, { timeoutMs: 3000 }); return captured; } });
    info = await handlers.get('engine:analyze')({ sender }, fixture.pageUrl('electron'));
    assert.equal(info.ok, true, JSON.stringify(info));
    const actual = fixture.source('electron');
    assert.deepEqual(info.requestContext, actual.requestContext);
    assert.ok(captured.candidates.length >= 2, 'both network playlists must be discovered behind a blob player');
    assert.ok(captured.candidates.every((c) => !c.url.includes('/setuid')), 'identity-sync iframe must never become a video candidate');
    const result = await handlers.get('engine:start')({ sender }, { ...info, id: 'electron-context', url: fixture.pageUrl('electron'), name: 'episode', folder: fixture.dir, format: 'mp4', quality: 'best' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.file], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr);
    const media = JSON.parse(probe.stdout);
    assert.ok(media.streams.some((s) => s.codec_type === 'video'));
    assert.ok(media.streams.some((s) => s.codec_type === 'audio'));
    assert.ok(Number(media.format.duration) >= 2.3);
    assert.ok(fixture.requests.some((r) => r.authorized && r.file === 'segment2.ts'));
    console.log('PASS: Electron captured actual playback headers behind a blob player; analyze/start IPC downloaded all HLS segments and ffprobe verified video + audio.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (info?.infoFile) fs.rmSync(info.infoFile, { force: true });
    if (fixture) await fixture.close();
    app.exit(process.exitCode || 0);
  }
});
app.on('window-all-closed', () => {});
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
