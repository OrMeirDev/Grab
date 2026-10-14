// Runs one download attempt: the job's own output name, the page's cookies (in a temporary,
// domain-scoped jar that exists only while yt-dlp runs) and the player's request headers.
//
// start(job, onProgress) -> { stop(), done } ; done resolves the engine's result.

function createDownloadRunner({ engine, browserSession, allocator }) {
  function start(job, onProgress) {
    let stopRequested = false;
    let active = null;
    const done = (async () => {
      const outputBase = allocator.allocate(job.id, job.folder, job.name);
      return browserSession.withSessionCookies(job.cookieRef, async (cookieFile) => {
        if (stopRequested) return { ok: false, stopped: true };
        active = engine.download({ ...job, outputBase, cookieFile, findOutput: (b) => allocator.findOutput(b) }, onProgress);
        return active.done;
      });
    })().catch((error) => ({ ok: false, error: String(error.message || error), kind: error.kind || 'other' }));
    return {
      done,
      stop: () => { stopRequested = true; active?.stop?.('aborted'); },
    };
  }
  return { start };
}

module.exports = { createDownloadRunner };
