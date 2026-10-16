const browser = require('../electron/browser-session.cjs');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
const { createDownloadRunner } = require('../electron/application/download-runner.cjs');
const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');

function mainHandlers(engine, pageprobe, hiddenProbe = { findMedia: async () => ({ candidates: [] }) }, session = browser, service) {
  const handlers = new Map();
  const controllers = new Map();
  const jobs = new Map();
  const discovery = createDiscoveryService({ engine, pageprobe, hiddenProbe, browserSession: session, getBrowserService: () => service });
  const runner = createDownloadRunner({ engine, browserSession: session, allocator: new OutputAllocator() });
  handlers.set('engine:analyze', async (event, url, options = {}) => {
    const ctl = new AbortController();
    controllers.set(options.id, ctl);
    try {
      const r = await discovery.analyze(url, { ...options, itemId: options.id, signal: ctl.signal,
        onPhase: (phase, name) => event.sender?.send?.('engine:lookup-phase', { url, phase, browser: name }) });
      return ctl.signal.aborted ? { ok: false, kind: 'cancelled' } : r;
    } finally { if (controllers.get(options.id) === ctl) controllers.delete(options.id); }
  });
  handlers.set('engine:cancel-analyze', (_e, id) => { controllers.get(id)?.abort(); return !!controllers.get(id); });
  handlers.set('engine:start', async (_event, plan) => {
    const run = runner.start(plan, () => {});
    const job = { run, stopped: false }; jobs.set(plan.id, job);
    try { const r = await run.done; return job.stopped ? { ok: false, stopped: true } : r; }
    finally { jobs.delete(plan.id); }
  });
  handlers.set('engine:stop', (_e, id) => { const job = jobs.get(id); if (job) { job.stopped = true; job.run.stop(); } });
  handlers.set('browser:default', (_e, url) => { const b = session.browserForPage(url); return { name: b.name, scheme: b.scheme, supported: b.supported !== false }; });
  handlers.set('browser:check', async (_e, url) => { try { await session.connectBrowser({ browser: session.browserForPage(url) }); return { ok: true }; } catch (error) { return { ok: false, kind: error.kind }; } });
  return handlers;
}
module.exports = { mainHandlers, sender: { isDestroyed: () => false, send() {} } };
