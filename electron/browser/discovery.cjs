// One browser-assisted discovery attempt, from "connect to the chosen browser" to "candidates in
// hand". Every path settles: success, or a BrowserError with a kind the UI can explain. The
// total discovery deadline is fixed when discovery starts and is NOT extended by events.
const protocol = require('../../extension/lib/protocol.js');

class BrowserError extends Error {
  constructor(kind, detail = {}) {
    super(detail.message || kind);
    this.kind = kind;
    Object.assign(this, detail);
  }
}

const DEFAULTS = { connectMs: 10000, launchGraceMs: 10000, discoveryMs: 60000 };

const REASON_TO_KIND = {
  no_video: 'noVideo', playback_required: 'playbackRequired', timeout: 'discoveryTimeout', cancelled: 'cancelled',
  tab_failed: 'tabFailed', protected: 'protectedMedia', extension_error: 'extensionError', permission_denied: 'extensionPermission',
  navigation_changed: 'noVideo',
};

// Resolves the one connected browser instance a job may use, starting the browser if it is closed.
// Never substitutes another profile or browser: a missing choice is an error the UI explains.
async function connectInstance({ hub, browser, getInstance, settings = {}, deps = {}, signal }) {
  const cfg = { ...DEFAULTS, ...settings };
  const throwIfAborted = () => { if (signal && signal.aborted) throw new BrowserError('cancelled'); };
  throwIfAborted();
    let pick = getInstance();
    if (pick.problem === 'choice_required') throw new BrowserError('choiceRequired', { options: pick.options });
    if (pick.problem === 'instance_disconnected') {
      // The profile the user chose is not connected. Wait briefly for it (extension reconnecting), never use another one.
      const wanted = pick.wanted;
      try { await hub.waitFor((i) => i.key === wanted, { timeoutMs: cfg.connectMs, signal: signal }); }
      catch (e) { throw e.code === 'cancelled' ? new BrowserError('cancelled') : new BrowserError('wrongProfile', { options: pick.options }); }
      pick = getInstance();
    }
    if (pick.problem === 'not_connected') {
      let launched = false;
      const running = deps.isRunning ? await deps.isRunning(browser.id) : false;
      throwIfAborted();
      if (!running) {
        if (!browser.exe) throw new BrowserError('browserUnavailable');
        try { deps.launch(browser.exe); launched = true; } catch (e) { throw new BrowserError('browserUnavailable', { message: String(e.message || e) }); }
      }
      try { await hub.waitFor((i) => i.browser === browser.id, { timeoutMs: cfg.connectMs + (launched ? cfg.launchGraceMs : 0), signal: signal }); }
      catch (e) {
        if (e.code === 'cancelled') throw new BrowserError('cancelled');
        const failure = hub.failures.find((f) => f.browser === browser.id && Date.now() - f.at < 120000);
        if (failure && ['origin_mismatch', 'protocol_version'].includes(failure.code)) throw new BrowserError('hostSetupError', { code: failure.code });
        throw new BrowserError('extensionNotConnected', { browserRunning: running || launched });
      }
      pick = getInstance();
      if (pick.problem === 'choice_required') throw new BrowserError('choiceRequired', { options: pick.options });
    }
    if (!pick.instance) throw new BrowserError('extensionNotConnected');
  return pick.instance;
}

// deps: { isRunning(browserId) -> Promise<bool>, launch(exe) -> void }
async function discover({ hub, browser, url, jobId = protocol.newId('job'), getInstance, settings = {}, deps = {}, signal, onPhase = () => {}, onSettle }) {
  const cfg = { ...DEFAULTS, ...settings };
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  if (signal) { if (signal.aborted) abort.abort(); else signal.addEventListener('abort', onOuterAbort, { once: true }); }
  const cleanup = [];
  let instance = null;
  let settled = false;
  const finish = () => { settled = true; for (const fn of cleanup.splice(0)) { try { fn(); } catch { /* best effort */ } } signal?.removeEventListener('abort', onOuterAbort); onSettle?.(); };
  const throwIfAborted = () => { if (abort.signal.aborted) throw new BrowserError('cancelled'); };

  try {
    throwIfAborted();
    onPhase('connecting');
    instance = await connectInstance({ hub, browser, getInstance, settings: cfg, deps, signal: abort.signal });
    throwIfAborted();

    // ---- discovery on that one instance
    const deadlineAt = Date.now() + cfg.discoveryMs;
    onPhase('discovering', { instance });
    const result = await new Promise((resolve, reject) => {
      const done = (fn, v) => { if (isDone) return; isDone = true; fn(v); };
      let isDone = false;
      const timer = setTimeout(() => done(reject, new BrowserError(lastState === 'playback_required' ? 'playbackRequired' : 'discoveryTimeout')), Math.max(0, deadlineAt - Date.now()));
      let lastState = 'discovering';
      cleanup.push(() => clearTimeout(timer));
      const onMessage = (inst, m) => {
        if (inst.key !== instance.key || m.jobId !== jobId) return; // another profile or another attempt: ignored
        if (m.type === 'progress') {
          lastState = m.state;
          onPhase(m.state === 'playback_required' ? 'playback_required' : 'discovering', { state: m.state });
        } else if (m.type === 'candidates' && m.final) done(resolve, { candidates: m.candidates, title: m.title || '' });
        else if (m.type === 'job-failed') done(reject, new BrowserError(REASON_TO_KIND[m.reason] || 'extensionError', { message: m.message }));
      };
      const onGone = (inst) => { if (inst.key === instance.key) done(reject, new BrowserError('browserDisconnected')); };
      hub.on('message', onMessage);
      hub.on('disconnected', onGone);
      cleanup.push(() => { hub.removeListener('message', onMessage); hub.removeListener('disconnected', onGone); });
      const onAbortNow = () => done(reject, new BrowserError('cancelled'));
      abort.signal.addEventListener('abort', onAbortNow, { once: true });
      cleanup.push(() => abort.signal.removeEventListener('abort', onAbortNow));
      if (!hub.sendTo(instance.key, 'discover', { jobId, url, deadlineMs: cfg.discoveryMs })) done(reject, new BrowserError('browserDisconnected'));
      if (abort.signal.aborted) onAbortNow();
    });
    return { ...result, instance, jobId };
  } catch (error) {
    // Tell the extension to stop and close its temporary tab; harmless if it already did.
    if (instance && !(error instanceof BrowserError && error.kind === 'browserDisconnected')) hub.sendTo(instance.key, 'cancel', { jobId });
    throw error;
  } finally {
    finish();
  }
}

// Ask the extension to bring the job's temporary tab to the front (playback needs the user's click).
function revealTab(hub, instance, jobId) { return hub.sendTo(instance.key, 'reveal-tab', { jobId }); }

module.exports = { discover, connectInstance, revealTab, BrowserError, DEFAULTS };
