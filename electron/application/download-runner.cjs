// Runs one download attempt: the job's own output name, the page's cookies (in a temporary,
// domain-scoped jar that exists only while yt-dlp runs) and the player's request headers.
//
// start(plan, onProgress) -> { outputBase, stop(), done } ; done resolves the engine's result.
// plan.outputBase: the name the job had before (a restart), kept so its partial files resume.

function createDownloadRunner({ engine, browserSession, allocator }) {
  function start(plan, onProgress) {
    let outputBase;
    try {
      if (plan.outputBase) allocator.restore(plan.id, plan.outputBase);
      outputBase = allocator.allocate(plan.id, plan.folder, plan.name);
    } catch (error) {
      return { outputBase: null, stop: () => {}, done: Promise.resolve({ ok: false, error: String(error.message || error), kind: error.kind || 'other' }) };
    }
    let stopRequested = false;
    let active = null;
    const done = browserSession.withSessionCookies(plan.cookieRef, async (cookieFile) => {
      if (stopRequested) return { ok: false, stopped: true };
      active = engine.download({ ...plan, outputBase, cookieFile, findOutput: (b) => allocator.findOutput(b) }, onProgress);
      return active.done;
    }).catch((error) => ({ ok: false, error: String(error.message || error), kind: error.kind || 'other' }));
    return {
      outputBase,
      done,
      stop: () => {
        stopRequested = true;
        if (active?.stop) active.stop('aborted');
        else active?.child?.kill?.();
      },
    };
  }
  return { start };
}

module.exports = { createDownloadRunner };
