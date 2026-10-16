const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiscoveryService } = require('../electron/application/discovery-service.cjs');
const browserSession = require('../electron/browser-session.cjs');

test('a lookup whose adapter stops answering still reaches its total deadline and aborts the adapter', { timeout: 3000 }, async () => {
  let signal;
  const svc = createDiscoveryService({ browserSession, lookupBudgetMs: 50,
    engine: { analyze: (_url, opts) => { signal = opts.signal; return new Promise(() => {}); } }, hiddenProbe: {}, pageprobe: {} });
  assert.equal((await svc.analyze('https://public.example/video')).kind, 'discoveryTimeout');
  assert.equal(signal.aborted, true);
});

test('an explicit browser with no extension acquires that session first; a closed browser sends no anonymous request', async () => {
  let requests = 0;
  const svc = createDiscoveryService({ browserSession, engine: { analyze: async () => { requests++; return { ok: true }; } }, hiddenProbe: {},
    pageprobe: { findMedia: async () => { throw Object.assign(new Error('Browser is closed'), { kind: 'browserSession' }); } } });
  assert.equal((await svc.analyze('https://members.example/video', { browser: 'chrome' })).kind, 'sessionRequired');
  assert.equal(requests, 0);
});

test('a noisy page checks at most the shared source budget, then returns an explicit failure', async () => {
  let checks = 0;
  const candidates = Array.from({ length: 80 }, (_, i) => ({ url: `https://cdn.example/${i}.mp4`, kind: 'file' }));
  const svc = createDiscoveryService({ browserSession, engine: { analyze: async (url) => { if (url.startsWith('https://cdn.example/')) checks++; return { ok: false, kind: 'notfound' }; } },
    hiddenProbe: { findMedia: async () => ({ candidates }) }, pageprobe: { findMedia: async () => ({ candidates: [] }) } });
  assert.equal((await svc.analyze('https://public.example/player')).kind, 'notfoundPage');
  assert.equal(checks, require('../electron/domain/candidate-policy.cjs').CANDIDATE_BUDGET);
});
