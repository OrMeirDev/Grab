// One deadline covers connection, page discovery, source checks and refresh.
function createLookupBudget(timeoutMs = 90000) {
  const controller = new AbortController();
  const started = Date.now();
  let phase = 'source';
  let rejectExpired;
  const expired = new Promise((_, reject) => { rejectExpired = reject; });
  expired.catch(() => {}); // The budget may finish before its first asynchronous operation.
  const abort = () => rejectExpired(controller.signal.reason);
  controller.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error('Video lookup timed out during ' + phase), { kind: 'timeout', phase }
  )), timeoutMs);
  const check = () => controller.signal.throwIfAborted();
  return {
    signal: controller.signal,
    remaining: () => Math.max(1, timeoutMs - (Date.now() - started)),
    setPhase: (next) => { check(); phase = next; },
    check,
    run: (work) => {
      check();
      return Promise.race([Promise.resolve().then(() => { check(); return work(); }), expired]);
    },
    dispose: () => {
      clearTimeout(timer);
      controller.abort(Object.assign(new Error('Lookup finished'), { kind: 'cancelled' }));
    },
  };
}
module.exports = { createLookupBudget };
