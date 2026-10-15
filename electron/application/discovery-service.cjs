// Finds the downloadable video behind a link. Strategies, in order:
//   1. yt-dlp at the link itself;
//   2. when yt-dlp finds no video: a hidden, clean browser (no cookies or accounts) that plays the
//      page and collects its player's sources (works on public pages with no setup);
//   3. the user's own default browser, where they are signed in (its existing session; an exact
//      open tab is scanned as it is, otherwise a background tab is opened and closed again).
// Each candidate found by 2 or 3 is checked with yt-dlp, with the page's cookies and request
// headers. DRM-protected players are reported as such, never touched.
//
// requireSession: the job is known to need the user's signed-in browser session (it needed it
// before; see domain/job.cjs requiresBrowserSession). Then 1 and 2 are skipped: the session is
// acquired from the browser first, and every request of the lookup carries it. If the browser
// can't be reached or refuses the connection, the lookup ends with 'sessionRequired' before
// anything is sent to the site; there is no fallback to a lookup without the session.
//
// Results carry sessionSource: 'browser' (the cookies are the user's account session) or 'probe'
// (the hidden probe's throwaway public-page cookies).
//
// A rate limit (HTTP 429, kind 'rateLimited') ends the lookup at once, wherever it comes from (the
// link, the retry with the browser session, a source found in a page): no browser, no further
// request; the coordinator holds the site. A bot check ('blocked') goes on through the user's
// browser, which may get past it; if the site still asks with the session and the page shows no
// video, the result stays 'blocked' (held), not "no video".
//
// Dependencies are injected (engine, probes, browser session) so this is testable without Electron.
const { budget } = require('../domain/candidate-policy.cjs');

// A lookup checks candidates until this much time has passed since it started (each check is
// also bounded by the engine's own deadline), so one page with many dead sources can't hold the
// queue for long.
const LOOKUP_BUDGET_MS = 6 * 60 * 1000;

// record(event, details): optional diagnostics (redacted by infrastructure/diagnostics.cjs).
function createDiscoveryService({ engine, hiddenProbe, pageprobe, browserSession, now = () => Date.now(), record = () => {} }) {
  // Sites whose videos only the user's signed-in browser could see: later links from them skip
  // the hidden browser, so a batch of lessons from one course goes straight to the browser.
  const signedInSites = new Set();

  // onPhase(phase, browserName): 'page' (looking inside the player) or 'browser' (using the
  // user's browser). signal: AbortSignal that cancels the lookup.
  // The lookup, with a diagnostics record of how it ended and which strategy found the video.
  async function analyze(url, options = {}) {
    const started = now();
    let strategy = options.forcePage ? 'page' : 'yt-dlp';
    const r = await lookup(url, { ...options, onPhase: (phase, browser) => { strategy = phase === 'browser' ? 'browser' : 'hidden-browser'; (options.onPhase || (() => {}))(phase, browser); } })
      .catch((error) => ({ ok: false, kind: 'other', error: String(error.message || error) }));
    record('lookup', { url, ok: !!r.ok, kind: r.ok ? null : r.kind || null, strategy: r.ok ? (r.mediaUrl ? strategy : 'yt-dlp') : strategy, site: r.site || null, ms: now() - started, error: r.ok ? null : r.error || null });
    return r;
  }

  async function lookup(url, { forcePage = false, requireSession = false, onPhase = () => {}, signal } = {}) {
    const deadline = now() + LOOKUP_BUDGET_MS;
    const outOfTime = () => signal?.aborted || now() > deadline;
    const context = { forcePage, requireSession, onPhase, signal, outOfTime };
    if (requireSession) {
      // No request without the session: neither yt-dlp without cookies nor the clean browser.
      // forcePage (where the video came from) still decides between the site's own extractor
      // (tried first, with the session) and the page's player.
      const first = forcePage
        ? { ok: false, kind: 'notfound', error: 'Unsupported URL' }
        : { ok: false, kind: 'private', error: 'The site needs your browser session' };
      return browserLookup(url, first, context);
    }
    // forcePage: what yt-dlp found at the link didn't download, so go straight to the page's player.
    // Anything but these four (a rate limit among them) is the answer as it is.
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
      record('probe', { url, probe: 'hidden', candidates: hidden.candidates.length, protected: !!hidden.protected, diagnostics: hidden.diagnostics || null });
      const found = await tryCandidates(hidden, url, { signal, outOfTime });
      if (found?.ok) return found;
      browserSession.forgetCookies?.(hidden.cookieRef);
      if (found) return found; // rate limited: the site is held; the user's browser is not tried
      if (hidden.protected) return { ok: false, kind: 'protected', error: 'DRM' };
    }
    if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'cancelled' };
    return browserLookup(url, first, context);
  }

  // 2. The user's default browser, when its remote debugging is on. If it isn't, report what the
  //    clean lookup found, with how to turn it on (or, when the session is required, that it is).
  async function browserLookup(url, first, { forcePage, requireSession, onPhase, signal, outOfTime }) {
    const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
    const browser = browserSession.defaultBrowser();
    onPhase('browser', browser.name);
    const connect = () => browserSession.connectBrowser({ browser });
    let probe;
    try {
      probe = await pageprobe.findMedia(url, { refresh: forcePage, connect });
      // A blob player may have loaded its manifest before attachment and discarded resource entries.
      if (probe.reusedTab && !probe.candidates.length) probe = await pageprobe.findMedia(url, { refresh: true, connect });
      record('probe', { url, probe: 'browser', browser: browser.name, reusedTab: !!probe.reusedTab, candidates: probe.candidates.length, protected: !!probe.protected, diagnostics: probe.diagnostics || null });
    } catch (err) {
      record('probe', { url, probe: 'browser', browser: browser.name, failed: err.kind || 'error', requireSession });
      if (err.kind === 'browserContext') return { ...first, kind: 'browserContext', browser: { name: browser.name } };
      if (requireSession) {
        // Closed, debugging off, connection refused, or a browser that can't be used: the site
        // hasn't been contacted, and isn't without the session.
        return { ok: false, kind: 'sessionRequired', error: String(err.message || 'The browser session is not available'), browser: { name: browser.name, scheme: browser.scheme, supported: browser.supported !== false } };
      }
      // The browser can't be reached (closed, debugging off, or not supported): say how to fix it.
      const hint = ['browserSession', 'browserUnsupported'].includes(err.kind)
        ? { browser: { name: browser.name, scheme: browser.scheme, supported: browser.supported !== false } } : {};
      return first.kind === 'notfound' ? { ...first, kind: 'notfoundPage', ...hint } : { ...first, ...hint };
    }
    return browserSession.withSessionCookies(probe.cookieRef, async (cookieFile) => {
      // An authenticated extractor may understand the page better than its embedded sources.
      let botCheck = null; // the site still asks "are you a bot" with the session
      if (!forcePage && ['private', 'blocked'].includes(first.kind)) {
        const authenticated = await engine.analyze(url, { cookieFile, requestContext: probe.requestContext, signal });
        if (authenticated.ok) return { ...authenticated, cookieRef: probe.cookieRef, sessionSource: 'browser', requestContext: probe.requestContext };
        if (authenticated.kind === 'rateLimited') return authenticated;
        if (authenticated.kind === 'blocked') botCheck = authenticated;
      }
      let last;
      for (const c of budget(probe.candidates)) {
        if (signal?.aborted) return { ok: false, kind: 'cancelled', error: 'cancelled' };
        if (outOfTime()) break;
        const requestContext = c.requestContext;
        const r = await engine.analyze(c.url, { cookieFile, requestContext, referer: url, title: c.kind === 'embed' ? undefined : probe.title, signal });
        if (r.ok) {
          if (first.kind === 'notfound') signedInSites.add(host);
          return { ...r, mediaUrl: c.url, referer: requestContext?.referer || url, requestContext, cookieRef: probe.cookieRef, sessionSource: 'browser' };
        }
        if (r.kind === 'rateLimited') return r;
        last = r;
      }
      if (probe.protected) return { ok: false, kind: 'protected', error: 'DRM' };
      if (last && ['private', 'blocked', 'network'].includes(last.kind)) return last;
      if (botCheck) return botCheck;
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
        if (r.ok) return { ...r, mediaUrl: c.url, referer: requestContext?.referer || url, requestContext: requestContext || null, cookieRef: hidden.cookieRef || null, sessionSource: hidden.cookieRef ? 'probe' : null };
        if (r.kind === 'rateLimited') return r; // no further source is tried
      }
      return null;
    });
  }

  return { analyze };
}

module.exports = { createDiscoveryService };
