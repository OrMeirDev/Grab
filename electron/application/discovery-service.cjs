// Lookup strategies share one cancellable deadline. Browser-assisted jobs use the selected
// extension (when configured), otherwise the existing browser's CDP adapter. Session-required
// jobs acquire their context before any extractor request; no anonymous fallback is allowed.
const { budget } = require('../domain/candidate-policy.cjs');

const LOOKUP_BUDGET_MS = 6 * 60 * 1000;
const PROBE_MS = 45000;
const cancelled = () => ({ ok: false, kind: 'cancelled', error: 'cancelled' });

function createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession, getBrowserService = () => null,
  now = () => Date.now(), record = () => {}, lookupBudgetMs = LOOKUP_BUDGET_MS }) {
  const signedInSites = new Set();

  async function analyze(url, options = {}) {
    const started = now();
    const controller = new AbortController();
    let timedOut = false;
    let strategy = 'yt-dlp';
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, lookupBudgetMs);
    let unlisten;
    const stopped = new Promise((resolve) => {
      const stop = () => resolve(timedOut ? { ok: false, kind: 'discoveryTimeout', error: 'The lookup took too long' } : cancelled());
      unlisten = () => controller.signal.removeEventListener('abort', stop);
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    const onPhase = (phase, browser) => { strategy = phase === 'browser' ? 'browser' : 'hidden-browser'; options.onPhase?.(phase, browser); };
    let result;
    try {
      result = await Promise.race([lookup(url, { ...options, signal: controller.signal, deadline: started + lookupBudgetMs, onPhase }), stopped]);
      if (controller.signal.aborted) result = timedOut ? { ok: false, kind: 'discoveryTimeout', error: 'The lookup took too long' } : cancelled();
    } catch (error) {
      result = controller.signal.aborted ? (timedOut ? { ok: false, kind: 'discoveryTimeout', error: 'The lookup took too long' } : cancelled())
        : { ok: false, kind: error.kind || 'other', error: String(error.message || error) };
    } finally { clearTimeout(timer); unlisten(); options.signal?.removeEventListener('abort', onAbort); }
    record('lookup', { url, ok: !!result.ok, kind: result.ok ? null : result.kind, strategy, ms: now() - started, error: result.ok ? null : result.error });
    return result;
  }

  async function lookup(url, options) {
    const { signal, deadline, onPhase } = options;
    const check = () => { signal.throwIfAborted(); if (now() >= deadline) throw Object.assign(new Error('The lookup took too long'), { kind: 'discoveryTimeout' }); };
    const probe = (source, context = {}) => { check(); return engine.analyze(source, { ...context, signal, timeoutMs: Math.max(1, Math.min(PROBE_MS, deadline - now())) }); };
    check();
    const host = new URL(url).host;
    const svc = getBrowserService();
    const selected = svc?.resolve(url, { browser: options.browser });
    const configured = !!(selected?.browserId && (svc.isConfigured ? svc.isConfigured(selected.browserId) : svc.isSetUp(selected.browserId)));
    const edgeFirst = selected ? selected.source === 'site-rule' : !!browserSession.isMakoPage?.(url);
    const forcePage = !!options.forcePage || edgeFirst;
    const requireSession = !!options.requireSession || signedInSites.has(host) || !!options.browser || !!options.instance || !!options.ref;
    const extensionLookup = async () => {
      onPhase('browser', selected.name);
      const r = await svc.analyze(url, { ...options, itemId: options.itemId, refresh: !!options.forcePage });
      check();
      if (r.ok) signedInSites.add(host);
      return r;
    };
    if (configured && (requireSession || forcePage || options.browser || options.instance || options.ref || options.choice)) return extensionLookup();
    const first = forcePage ? { ok: false, kind: 'notfound', error: 'Unsupported URL' }
      : requireSession ? { ok: false, kind: 'private', error: 'The site needs your browser session' } : await probe(url);
    check();
    if (first.ok || !['notfound', 'notmedia', 'private', 'blocked', 'forbidden', 'other'].includes(first.kind) || first.httpStatus === 429) return first;
    if (configured) return extensionLookup();

    if (!requireSession && !edgeFirst && ['notfound', 'notmedia'].includes(first.kind)) {
      onPhase('page');
      let hidden = { candidates: [] };
      try { hidden = await hiddenProbe.findMedia(url, { signal }); } catch (e) { check(); }
      check();
      record('probe', { url, probe: 'hidden', candidates: hidden.candidates.length, protected: !!hidden.protected, diagnostics: hidden.diagnostics || null });
      const r = await candidates(hidden, 'probe');
      if (r?.ok) return r;
      if (r?.kind === 'rateLimited') { browserSession.forgetCookies?.(hidden.cookieRef); return r; }
      browserSession.forgetCookies?.(hidden.cookieRef);
      if (hidden.protected) return { ok: false, kind: 'protected', error: 'DRM' };
    }
    check();
    const requestedBrowser = selected?.browserId || options.browser;
    const browser = browserSession.browserForPage && (requestedBrowser || browserSession.isMakoPage?.(url))
      ? browserSession.browserForPage(url, requestedBrowser) : browserSession.defaultBrowser();
    onPhase('browser', browser.name);
    const connect = () => browserSession.connectBrowser({ browser });
    let page;
    try {
      page = await pageprobe.findMedia(url, { refresh: forcePage, connect, signal });
      check();
      if (page.reusedTab && !page.candidates.some((c) => c.kind !== 'embed')) {
        browserSession.forgetCookies?.(page.cookieRef);
        page = await pageprobe.findMedia(url, { refresh: true, connect, signal });
      }
    } catch (error) {
      check();
      const hint = { name: browser.name, scheme: browser.scheme, supported: browser.supported !== false };
      if (error.kind === 'browserContext') return { ...first, kind: 'browserContext', browser: hint };
      if (requireSession) return { ok: false, kind: 'sessionRequired', error: 'The browser session is not available', browser: hint };
      return { ...first, kind: ['notfound', 'notmedia'].includes(first.kind) ? 'notfoundPage' : first.kind, browser: hint };
    }
    check();
    if (requireSession && !page.cookieRef) return { ok: false, kind: 'sessionRequired', error: 'No browser session was acquired', browser: { name: browser.name } };
    record('probe', { url, probe: 'browser', browser: browser.name, reusedTab: !!page.reusedTab, candidates: page.candidates.length, diagnostics: page.diagnostics || null });
    let authenticatedFailure = null;
    if (!forcePage && ['private', 'blocked', 'forbidden'].includes(first.kind)) {
      const authenticated = await browserSession.withSessionCookies(page.cookieRef, (cookieFile) => probe(url, { cookieFile, requestContext: page.requestContext }));
      if (authenticated.ok) return { ...authenticated, cookieRef: page.cookieRef, sessionSource: 'browser', requestContext: page.requestContext };
      if (authenticated.kind === 'rateLimited' || authenticated.httpStatus === 429) { browserSession.forgetCookies?.(page.cookieRef); return authenticated; }
      if (['blocked', 'forbidden'].includes(authenticated.kind)) authenticatedFailure = authenticated;
    }
    let r = await candidates(page, 'browser');
    if (!r?.ok && r?.kind !== 'rateLimited' && page.reusedTab && !forcePage && ['forbidden', 'private', 'notfoundPage'].includes(r?.kind || 'notfoundPage')) {
      browserSession.forgetCookies?.(page.cookieRef);
      page = await pageprobe.findMedia(url, { refresh: true, connect, signal });
      r = await candidates(page, 'browser');
    }
    if (r?.ok) { signedInSites.add(host); return r; }
    browserSession.forgetCookies?.(page.cookieRef);
    if (r?.kind === 'rateLimited' || r?.httpStatus === 429) return r;
    if (page.protected) return { ok: false, kind: 'protected', error: 'DRM' };
    return r || authenticatedFailure || (first.kind === 'forbidden' ? first : { ...first, kind: 'notfoundPage' });

    async function candidates(found, source) {
      let last = null;
      return browserSession.withSessionCookies(found.cookieRef, async (cookieFile) => {
        for (const c of budget(found.candidates || [])) {
          check();
          const r = await probe(c.url, { cookieFile, requestContext: c.requestContext, referer: url, title: c.kind === 'embed' ? undefined : found.title });
          check();
          if (r.ok) return { ...r, mediaUrl: c.url, referer: c.requestContext?.referer ?? url, requestContext: c.requestContext || null, cookieRef: found.cookieRef || null, sessionSource: found.cookieRef ? source : null };
          if (r.kind === 'rateLimited' || r.httpStatus === 429) return { ...r, kind: 'rateLimited' };
          if (['private', 'blocked', 'forbidden', 'network'].includes(r.kind)) last = r;
        }
        return last;
      });
    }
  }
  return { analyze };
}
module.exports = { createDiscoveryService, LOOKUP_BUDGET_MS };
