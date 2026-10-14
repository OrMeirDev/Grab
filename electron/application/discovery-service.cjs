// Finds the downloadable video behind a link. Strategies, in order:
//   1. yt-dlp at the link itself;
//   2. when yt-dlp finds no video: a hidden, clean browser (no cookies or accounts) that plays the
//      page and collects its player's sources (works on public pages with no setup);
//   3. the user's own default browser, where they are signed in (its existing session; an exact
//      open tab is scanned as it is, otherwise a background tab is opened and closed again).
// Each candidate found by 2 or 3 is checked with yt-dlp, with the page's cookies and request
// headers. DRM-protected players are reported as such, never touched.
//
// Dependencies are injected (engine, probes, browser session) so this is testable without Electron.
const { budget } = require('../domain/candidate-policy.cjs');

// A lookup checks candidates until this much time has passed since it started (each check is
// also bounded by the engine's own deadline), so one page with many dead sources can't hold the
// queue for long.
const LOOKUP_BUDGET_MS = 6 * 60 * 1000;

function createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession, now = () => Date.now() }) {
  // Sites whose videos only the user's signed-in browser could see: later links from them skip
  // the hidden browser, so a batch of lessons from one course goes straight to the browser.
  const signedInSites = new Set();

  // onPhase(phase, browserName): 'page' (looking inside the player) or 'browser' (using the
  // user's browser). signal: AbortSignal that cancels the lookup.
  async function analyze(url, { forcePage = false, onPhase = () => {}, signal } = {}) {
    const deadline = now() + LOOKUP_BUDGET_MS;
    const outOfTime = () => signal?.aborted || now() > deadline;
    // forcePage: what yt-dlp found at the link didn't download, so go straight to the page's player.
    const first = forcePage ? { ok: false, kind: 'notfound', error: 'Unsupported URL' } : await engine.analyze(url, { signal });
    if (first.ok || !['notfound', 'private', 'blocked', 'other'].includes(first.kind)) return first;
    if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'cancelled' };

    // 1. A hidden, clean browser: only when yt-dlp found no video; a clean visit doesn't get past
    //    a login or a bot check.
    const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
    if (first.kind === 'notfound' && !signedInSites.has(host)) {
      onPhase('page');
      let hidden = { candidates: [] };
      try { hidden = await hiddenProbe.findMedia(url); } catch { /* fall through to the backup */ }
      const found = await tryCandidates(hidden, url, { signal, outOfTime });
      if (found) return found;
      browserSession.forgetCookies?.(hidden.cookieRef);
      if (hidden.protected) return { ok: false, kind: 'protected', error: 'DRM' };
    }
    if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'cancelled' };

    // 2. Backup: the user's default browser, when its remote debugging is on. If it isn't,
    //    report what the clean lookup found, with how to turn it on.
    const browser = browserSession.defaultBrowser();
    onPhase('browser', browser.name);
    const connect = () => browserSession.connectBrowser({ browser });
    let probe;
    try {
      probe = await pageprobe.findMedia(url, { refresh: forcePage, connect });
      // A blob player may have loaded its manifest before attachment and discarded resource entries.
      if (probe.reusedTab && !probe.candidates.length) probe = await pageprobe.findMedia(url, { refresh: true, connect });
    } catch (err) {
      if (err.kind === 'browserContext') return { ...first, kind: 'browserContext', browser: { name: browser.name } };
      // The browser can't be reached (closed, debugging off, or not supported): say how to fix it.
      const hint = ['browserSession', 'browserUnsupported'].includes(err.kind)
        ? { browser: { name: browser.name, scheme: browser.scheme, supported: browser.supported !== false } } : {};
      return first.kind === 'notfound' ? { ...first, kind: 'notfoundPage', ...hint } : { ...first, ...hint };
    }
    return browserSession.withSessionCookies(probe.cookieRef, async (cookieFile) => {
      // An authenticated extractor may understand the page better than its embedded sources.
      if (!forcePage && ['private', 'blocked'].includes(first.kind)) {
        const authenticated = await engine.analyze(url, { cookieFile, requestContext: probe.requestContext, signal });
        if (authenticated.ok) return { ...authenticated, cookieRef: probe.cookieRef, requestContext: probe.requestContext };
      }
      let last;
      for (const c of budget(probe.candidates)) {
        if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'cancelled' };
        if (outOfTime()) break;
        const requestContext = c.requestContext;
        const r = await engine.analyze(c.url, { cookieFile, requestContext, referer: url, title: c.kind === 'embed' ? undefined : probe.title, signal });
        if (r.ok) {
          if (first.kind === 'notfound') signedInSites.add(host);
          return { ...r, mediaUrl: c.url, referer: requestContext?.referer || url, requestContext, cookieRef: probe.cookieRef };
        }
        last = r;
      }
      if (probe.protected) return { ok: false, kind: 'protected', error: 'DRM' };
      if (last && ['private', 'blocked', 'network'].includes(last.kind)) return last;
      return { ...first, kind: 'notfoundPage' };
    });
  }

  // The hidden browser's candidates, checked in rank order (up to the candidate budget, not just
  // the first few), each with the request context and cookies its player used.
  async function tryCandidates(hidden, url, { signal, outOfTime }) {
    const candidates = budget(hidden.candidates || []);
    if (!candidates.length) return null;
    return browserSession.withSessionCookies(hidden.cookieRef, async (cookieFile) => {
      for (const c of candidates) {
        if (outOfTime()) return null;
        const requestContext = c.requestContext;
        const r = await engine.analyze(c.url, { cookieFile, requestContext, referer: url, title: c.kind === 'embed' ? undefined : hidden.title, signal });
        if (r.ok) return { ...r, mediaUrl: c.url, referer: requestContext?.referer || url, requestContext: requestContext || null, cookieRef: hidden.cookieRef || null };
      }
      return null;
    });
  }

  return { analyze };
}

module.exports = { createDiscoveryService };
