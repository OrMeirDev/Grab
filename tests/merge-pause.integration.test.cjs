// Pause while FFmpeg is merging a download's separate video and audio streams, then resume.
// The real coordinator, download runner, engine, yt-dlp (pinned) and FFmpeg, against the fixture's
// DASH source (a video-only and an audio-only stream, synthetic media made here with FFmpeg).
//
// Synchronization (test harness only, nothing in Grab changes): the harness finds the FFmpeg
// process that merges this job's streams (two inputs, `-c copy`, output <name>.temp.mp4), waits
// until it has written part of the merged file, and freezes it (SIGSTOP), so Pause always lands
// during the merge however fast the disk is. It checks the stop Grab sent reached FFmpeg (SIGTERM
// pending), then lets it go (SIGCONT) to receive it.
//
// POSIX only (/proc, signals); on Windows the installed-app check does the same with the app's own
// window (scripts/windows/installed-app.cjs, W-06b). Needs GRAB_TEST_YTDLP_DIR and ffmpeg/ffprobe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = process.env.GRAB_TEST_YTDLP_DIR;
const hasTool = (name) => { try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = process.platform === 'win32' ? 'POSIX only (Windows: installed-app W-06b)'
  : !(DIR && fs.existsSync(path.join(DIR, 'yt-dlp'))) ? 'set GRAB_TEST_YTDLP_DIR to run'
    : !(hasTool('ffmpeg') && hasTool('ffprobe')) ? 'needs ffmpeg and ffprobe' : false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 120000, step = 20) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await wait(step); } };

const procIds = new Map();
const procFile = (pid, name) => `/proc/${procIds.get(pid) || pid}/${name}`;

// Processes now running whose command line matches. /proc may expose outer PID numbers
// inside a test container; signals use the innermost NSpid while status reads use /proc's id.
function processes(match) {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length && match(argv)) {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const ownPid = Number(status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1) || pid);
        procIds.set(ownPid, Number(pid));
        found.push({ pid: ownPid, argv });
      }
    } catch { /* ended meanwhile */ }
  }
  return found;
}
const alive = (pid) => { try { return !/^State:\s+Z/m.test(fs.readFileSync(procFile(pid, 'status'), 'utf8')); } catch { return false; } };
// Signals waiting for a stopped process (thread-directed and process-directed).
const pendingSignals = (pid) => {
  try {
    const status = fs.readFileSync(procFile(pid, 'status'), 'utf8');
    return ['SigPnd', 'ShdPnd'].reduce((mask, key) => mask | BigInt('0x' + status.match(new RegExp(`^${key}:\\s+([0-9a-f]+)`, 'm'))[1]), 0n);
  } catch { return null; }
};
const SIGTERM_BIT = 1n << 14n; // signal 15

test('pause during the FFmpeg merge ends the attempt and publishes nothing; resume merges once, with audio and video', { skip, timeout: 300000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-merge-'));
  const folder = path.join(work, 'downloads');
  fs.mkdirSync(folder);
  // About 150 MB of video-only stream (constant bitrate, so the merge copies real data) and a
  // matching audio-only stream.
  const clip = path.join(work, 'clip.mp4');
  const video = path.join(work, 'video.mp4');
  const audio = path.join(work, 'audio.m4a');
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'nal-hrd=cbr', '-b:v', '40M', '-minrate', '40M', '-maxrate', '40M', '-bufsize', '8M', '-an', clip]);
  ff(['-stream_loop', '2', '-i', clip, '-c', 'copy', '-movflags', '+faststart', video]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '30', '-c:a', 'aac', '-b:a', '128k', audio]);

  const site = await require('./fixtures/media-site.cjs').start({ split: { video, audio, duration: 30 } });
  const engine = require('../electron/engine.cjs');
  engine.setUserBinDir(DIR);
  const { DownloadCoordinator } = require('../electron/application/download-coordinator.cjs');
  const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
  const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
  const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
  const browser = require('../electron/browser-session.cjs');
  const allocator = new OutputAllocator();
  const runner = createDownloadRunner({ engine, browserSession: browser, allocator });
  const discovery = createDiscoveryService({ engine, hiddenProbe: { findMedia: async () => ({ candidates: [] }) }, pageprobe: {}, browserSession: browser });
  const history = [];
  const starts = [];
  const c = new DownloadCoordinator({
    random: () => 0,
    getSettings: async () => ({ folder, format: 'mp4', quality: 'best' }),
    recordCompletion: async (e) => { history.push(e); },
    discover: (url, o) => discovery.analyze(url, o),
    startDownload: (plan, p) => { starts.push(Date.now()); return runner.start(plan, p); },
    releaseContext: (job, { finished }) => { if (finished) allocator.release(job.id); },
  });
  let frozen = null;
  try {
    c.add([{ url: site.base + '/split/merge.mpd' }]);
    const job = () => c.jobs[0];
    await until(() => ['ready', 'error'].includes(job().status));
    assert.equal(job().status, 'ready', JSON.stringify(job().error));

    c.downloadOne(job().id);
    const base = await until(() => job().outputBase, 30000);
    const temp = base + '.temp.mp4';
    // The merge: FFmpeg reading this job's two downloaded streams into <base>.temp.mp4.
    const isMerge = (argv) => /ffmpeg$/.test(argv[0]) && argv.includes('-c') && argv.includes('copy')
      && argv.filter((a) => a === '-i').length === 2 && argv.some((a) => a.endsWith(temp));
    // Inspect the output and stop the matching process in the same synchronous turn.
    // Awaiting between finding a PID and SIGSTOP can target a merge that already finished.
    const merge = await until(() => {
      const candidate = processes(isMerge)[0];
      if (!candidate) return null;
      try {
        if (!fs.existsSync(temp) || fs.statSync(temp).size <= 2 * 1024 * 1024) return null;
        process.kill(candidate.pid, 'SIGSTOP');
        frozen = candidate.pid;
        return candidate;
      } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return null; throw error; }
    }, 30000, 1);
    assert.ok(merge, 'FFmpeg was captured while writing the merge of the two streams');
    assert.ok(merge.argv.some((a) => /\.fv720\.mp4$/.test(a)) && merge.argv.some((a) => /\.fa128\.m4a$/.test(a)), merge.argv.join(' '));
    await wait(100); // a write already in progress completes
    const writtenAtPause = fs.statSync(temp).size;
    await wait(300);
    assert.equal(fs.statSync(temp).size, writtenAtPause, 'FFmpeg is held mid-merge');
    const streamRequests = site.log.filter((l) => l.url.startsWith('/split/merge.')).length;

    c.pause(job().id);
    assert.equal(job().status, 'paused');
    await until(() => !c.active, 30000);
    assert.equal(c.active, null);
    assert.ok((pendingSignals(frozen) & SIGTERM_BIT) !== 0n, 'Grab\'s stop reached the merging FFmpeg (SIGTERM pending)');
    process.kill(frozen, 'SIGCONT');
    assert.ok(await until(() => !alive(frozen), 15000), 'the merging FFmpeg ended');
    frozen = null;
    assert.deepEqual(processes((argv) => argv.some((a) => a.includes(base))), [], 'nothing of the attempt is left running');
    assert.equal(fs.existsSync(base + '.mp4'), false, 'no finished file was published');
    assert.equal(history.length, 0, 'nothing was recorded as downloaded');
    assert.equal(job().status, 'paused');
    // Kept for the resume (yt-dlp's own policy): both finished streams.
    const kept = fs.readdirSync(folder).sort();
    assert.ok(kept.includes('merge.fv720.mp4') && kept.includes('merge.fa128.m4a'), kept.join(', '));

    c.resume(job().id);
    await until(() => ['done', 'error'].includes(job().status), 120000);
    assert.equal(job().status, 'done', JSON.stringify(job().error));
    assert.equal(starts.length, 2, 'one attempt before the pause, one after');
    assert.deepEqual(fs.readdirSync(folder), ['merge.mp4'], 'exactly one final file; the streams and the partial merge are gone');
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(folder, 'merge.mp4')], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(streams, ['audio', 'video']);
    assert.equal(site.log.filter((l) => l.url.startsWith('/split/merge.')).length, streamRequests, 'the resumed attempt reused the downloaded streams');
    assert.equal(history.length, 1);
  } finally {
    if (frozen && alive(frozen)) { try { process.kill(frozen, 'SIGKILL'); process.kill(frozen, 'SIGCONT'); } catch { /* gone */ } }
    await c.shutdown();
    await engine.stopAll(10000);
    await site.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
