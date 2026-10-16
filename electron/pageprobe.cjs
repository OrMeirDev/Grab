// Find embedded media in the user's default browser (its existing session). No new browser
// profile or Grab sign-in window is created.
const { RequestContexts } = require('./request-context.cjs');
const browserSession = require('./browser-session.cjs');
const { collectorScript, isNotPlayer } = require('./media-collector.cjs');
const { classify, unconfirmedPlayerSources, rankMedia, playerEmbeds, isLicenseRequest, isMediaType } = require('./domain/candidate-policy.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findMedia(pageUrl, { timeoutMs = 20000, refresh = false, connect = browserSession.connectBrowser, signal } = {}) {
  signal?.throwIfAborted();
  const page = new URL(pageUrl);
  if (!/^https?:$/.test(page.protocol)) throw new Error('Unsupported page URL');
  const cdp = await connect();
  signal?.throwIfAborted();
  const target = await browserSession.chooseTarget(cdp, pageUrl, { refresh });
  const sessions = new Set();
  const contexts = new Map();
  const found = new Map();
  const embeds = new Set();
  const failed = new Set();

  const initializations = new Set();
  const diagnostics = { framesScanned: 0, playersSeen: 0, scanErrors: 0, rejected: {} };
  let rootSessionId;
  let mainFrameId;
  let title = '';
  let drm = false;
  let userAgent = '';
  let lastNewSource = Date.now();

  // Addresses a player element points at (see hidden-probe.cjs): an extensionless one is only
  // recognized by its response type, and then still counts as the player's own source.
  const playerSources = new Set();
  const add = (url, { type = '', size = 0, fromPlayer = false, referer = pageUrl, requestContext } = {}) => {
    if (signal?.aborted || isNotPlayer(url)) return;
    if (fromPlayer && typeof url === 'string') playerSources.add(url);
    const verdict = classify(url, type);
    if (!verdict.kind) {
      if (verdict.reject !== 'not-media') diagnostics.rejected[verdict.reject] = (diagnostics.rejected[verdict.reject] || 0) + 1;
      return;
    }
    const { kind } = verdict;
    const previous = found.get(url);
    requestContext = requestContext || requests.get(url) || previous?.requestContext;
    if (!previous) lastNewSource = Date.now();
    found.set(url, {
      ...previous, url, kind, size: Math.max(size, previous?.size || 0),
      fromPlayer: fromPlayer || !!previous?.fromPlayer,
      referer: previous?.requestContext?.referer ?? referer ?? previous?.referer ?? pageUrl,
      requestContext,
    });
  };

  const requests = new RequestContexts(() => userAgent, (url, requestContext) => add(url, { requestContext }));

  const initialize = async (sessionId) => {
    signal?.throwIfAborted();
    sessions.add(sessionId);
    await Promise.all([
      cdp.send('Runtime.enable', {}, sessionId),
      cdp.send('Network.enable', {}, sessionId),
      cdp.send('Page.enable', {}, sessionId),
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId),
    ]);
  };

  const onEvent = (event) => {
    if (signal?.aborted) return;
    if (!sessions.has(event.sessionId)) return;
    const d = event.params || {};
    if (event.method === 'Target.attachedToTarget' && d.targetInfo?.type === 'iframe') {
      const task = initialize(d.sessionId).catch(() => { diagnostics.scanErrors++; });
      initializations.add(task);
      void task.finally(() => initializations.delete(task));
    } else if (event.method === 'Target.detachedFromTarget') {
      sessions.delete(d.sessionId);
      for (const [key, context] of contexts) if (context.sessionId === d.sessionId) contexts.delete(key);
    } else if (event.method === 'Runtime.executionContextCreated' && d.context?.auxData?.isDefault) {
      const context = d.context;
      contexts.set(event.sessionId + ':' + context.id, { sessionId: event.sessionId, id: context.id, frameId: context.auxData.frameId });
    } else if (event.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(event.sessionId + ':' + d.executionContextId);
    } else if (event.method === 'Runtime.executionContextsCleared') {
      for (const [key, context] of contexts) if (context.sessionId === event.sessionId) contexts.delete(key);
    } else if (event.method === 'Network.requestWillBeSent') {
      requests.request(event.sessionId, d);
      if (isLicenseRequest(d.request?.url) && ['XHR', 'Fetch'].includes(d.type)) drm = true;
      add(d.request?.url, { requestContext: requests.get(d.request?.url) });
    } else if (event.method === 'Network.requestWillBeSentExtraInfo') {
      requests.extra(event.sessionId, d);
    } else if (event.method === 'Network.responseReceived') {
      requests.response(event.sessionId, d);
      if (d.response?.status >= 400) { failed.add(d.response.url); return; }
      failed.delete(d.response?.url);
      if (isMediaType(d.response?.mimeType)) add(d.response.url, { type: d.response.mimeType, size: Number(d.response.headers?.['Content-Length']) || 0 });
    }
  };
  cdp.on('event', onEvent);
  const onAbort = () => { if (target.created && cdp.connected) cdp.send('Target.closeTarget', { targetId: target.targetId }, undefined, 1000).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    rootSessionId = attached.sessionId;
    const version = await cdp.send('Browser.getVersion');
    userAgent = version.userAgent || '';
    await initialize(rootSessionId);
    const frameTree = await cdp.send('Page.getFrameTree', {}, rootSessionId);
    mainFrameId = frameTree.frameTree.frame.id;
    signal?.throwIfAborted();
    if (target.created) await cdp.send('Page.navigate', { url: pageUrl }, rootSessionId);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      signal?.throwIfAborted();
      await Promise.all([...initializations]);
      await Promise.all([...contexts.values()].map(async (context) => {
        try {
          const response = await cdp.send('Runtime.evaluate', {
            expression: collectorScript({ startPlayback: target.created }),
            contextId: context.id, returnByValue: true,
          }, context.sessionId, 2500);
          const r = response.result?.value;
          if (!r) { diagnostics.scanErrors++; return; }
          diagnostics.framesScanned++;
          diagnostics.playersSeen = Math.max(diagnostics.playersSeen, r.players || 0);
          if (r.drm) drm = true;
          if (context.frameId === mainFrameId && r.title) title = r.title;
          r.media.forEach((url) => add(url, { fromPlayer: true, referer: r.pageUrl || pageUrl }));
          r.embeds.forEach((url) => embeds.add(url));
        } catch { diagnostics.scanErrors++; }
      }));
      // An unrelated iframe does not stop lookup. Allow newly loaded players to settle.
      if (Date.now() - start > (target.created ? 8000 : 1500) && Date.now() - lastNewSource > 2000 && found.size) break;
      await sleep(750);
    }

    const media = rankMedia([
      ...[...found.values()].filter((m) => !failed.has(m.url)).map((m) => ({ ...m, fromPlayer: m.fromPlayer || playerSources.has(m.url) })),
      ...unconfirmedPlayerSources(playerSources, found).filter((m) => !failed.has(m.url)).map((m) => ({ ...m, referer: pageUrl, requestContext: requests.get(m.url) })),
    ]);
    const candidates = [
      ...media.map((m) => ({ ...m, requestContext: { userAgent, referer: m.referer, ...m.requestContext } })),
      ...playerEmbeds(embeds, pageUrl, isNotPlayer).map((url) => ({ url, kind: 'embed', size: 0, requestContext: { userAgent, referer: pageUrl } })),
    ];
    signal?.throwIfAborted();
    const urls = [...new Set([pageUrl, ...candidates.map((c) => c.url)])];
    const { cookies = [] } = await cdp.send('Network.getCookies', { urls }, rootSessionId);
    signal?.throwIfAborted();
    return { candidates, title: title.trim(), reusedTab: !target.created, requestContext: { userAgent, referer: pageUrl }, protected: drm && !media.some((m) => m.kind === 'file'), cookieRef: browserSession.rememberCookies(cookies, { source: 'browser' }), diagnostics };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cdp.removeListener('event', onEvent);
    // Detach from existing tabs; only close the background tab created for this lookup.
    if (rootSessionId && cdp.connected) {
      await Promise.allSettled([...sessions].map((sessionId) => cdp.send('Target.detachFromTarget', { sessionId }, undefined, 1000)));
    }
    if (target.created && cdp.connected) await cdp.send('Target.closeTarget', { targetId: target.targetId }, undefined, 1000).catch(() => {});
  }
}

module.exports = { findMedia };
