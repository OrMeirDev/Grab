// Runs a command-line tool (yt-dlp, which runs ffmpeg) with a deadline, bounded output, line
// callbacks, cancellation, and a stop that ends the whole process tree and waits for it.
//
// done resolves (never rejects) with { code, out, err, timedOut, idle, aborted, truncated, spawnError }.
// out is the full stdout up to maxStdout bytes (then the run is stopped and truncated is set);
// err is the last maxStderr bytes of stderr.
const { spawn, execFile } = require('child_process');

const DEFAULTS = { maxStdout: 64 * 1024 * 1024, maxStderr: 64 * 1024, maxLine: 1024 * 1024 };
const KILL_GRACE_MS = 3000;

function alive(child) { return child.exitCode === null && child.signalCode === null; }

// Windows: taskkill /T ends yt-dlp and the ffmpeg it started. Elsewhere the child leads its own
// process group, so the group is signalled (SIGTERM, then SIGKILL if it lingers).
function killTree(child, platform = process.platform) {
  if (!child?.pid || !alive(child)) return;
  if (platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      if (alive(child)) try { child.kill(); } catch { /* already gone */ }
    });
    return;
  }
  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
  signal('SIGTERM');
  const t = setTimeout(() => { if (alive(child)) signal('SIGKILL'); }, KILL_GRACE_MS);
  t.unref?.();
}

// options: { env, timeoutMs, idleTimeoutMs, onLine, signal (AbortSignal), maxStdout, maxStderr,
//            registry (see process-registry.cjs), label, platform }
function runProcess(exe, args, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const platform = o.platform || process.platform;
  const result = { code: null, out: '', err: '', timedOut: false, idle: false, aborted: false, truncated: false, spawnError: null };
  let child;
  try {
    child = spawn(exe, args, { env: o.env, windowsHide: true, detached: platform !== 'win32' });
  } catch (error) {
    result.code = -1;
    result.spawnError = String(error.message || error);
    result.err = result.spawnError;
    return { child: null, done: Promise.resolve(result), stop: () => {} };
  }

  let outBytes = 0;
  const lineBufs = { out: '', err: '' };
  const feed = (key, chunk) => {
    if (!o.onLine) return;
    lineBufs[key] += chunk;
    const lines = lineBufs[key].split(/\r?\n/);
    lineBufs[key] = lines.pop();
    if (lineBufs[key].length > o.maxLine) lineBufs[key] = lineBufs[key].slice(-o.maxLine);
    for (const line of lines) { try { o.onLine(line); } catch { /* a callback error never breaks the run */ } }
  };

  let stopReason = null;
  const stop = (reason = 'aborted') => {
    if (!stopReason) stopReason = reason;
    killTree(child, platform);
  };

  let idleTimer = null;
  const touch = () => {
    if (!o.idleTimeoutMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), o.idleTimeoutMs);
  };
  touch();
  const deadline = o.timeoutMs ? setTimeout(() => stop('timedOut'), o.timeoutMs) : null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    touch();
    outBytes += Buffer.byteLength(d);
    if (outBytes > o.maxStdout) { if (!result.truncated) { result.truncated = true; stop('truncated'); } return; }
    result.out += d;
    feed('out', d);
  });
  child.stderr.on('data', (d) => {
    touch();
    result.err = (result.err + d).slice(-o.maxStderr);
    feed('err', d);
  });

  const onAbort = () => stop('aborted');
  if (o.signal) {
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
  }

  const handle = { child, label: o.label || 'process', stop };
  o.registry?.add(handle);

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      o.signal?.removeEventListener?.('abort', onAbort);
      for (const key of ['out', 'err']) if (lineBufs[key]) feed(key, '\n');
      result.code = code;
      if (stopReason === 'timedOut') result.timedOut = true;
      if (stopReason === 'idle') result.idle = true;
      if (stopReason === 'aborted') result.aborted = true;
      o.registry?.remove(handle);
      resolve(result);
    };
    child.on('error', (e) => {
      result.spawnError = String(e.message || e);
      result.err = (result.err + result.spawnError).slice(-o.maxStderr);
      finish(-1);
    });
    // 'close' waits for every holder of the output pipes, so descendants that inherited them
    // (ffmpeg started by yt-dlp) have exited too.
    child.on('close', (code) => finish(code === null ? -1 : code));
  });
  handle.done = done;
  return { child, done, stop };
}

module.exports = { runProcess, killTree };
