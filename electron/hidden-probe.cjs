// First look inside a page's player: open the page the way a browser would, hidden and muted, in
// a fresh in-memory session (no cookies or accounts, nothing saved), and collect the video
// addresses its player uses: video elements, the stream requests it makes, embedded players.
// Works on public pages with no setup. The user's default browser (pageprobe.cjs) is only the backup.
// A DRM-protected player is reported, never touched.
//
// Each source keeps the context its player fetched it with (User-Agent, Referer, Origin), and
// the cookies the page set in this throwaway session are kept behind an opaque handle, so yt-dlp
// can fetch the source the way the player did (GRB-12).
const { BrowserWindow, session } = require('electron');
const { collectorScript, isNotPlayer } = require('./media-collector.cjs');
const { classify, unconfirmedPlayerSources, rankMedia, playerEmbeds, isLicenseRequest, isMediaType } = require('./domain/candidate-policy.cjs');
const { contextFromHeaders } = require('./request-context.cjs');
const browserSession = require('./browser-session.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const header = (headers, name) => {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return key ? [].concat(headers[key])[0] : undefined;
};

async function findMedia(pageUrl, { timeoutMs = 20000, signal } = {}) {
  signal?.throwIfAborted();
  const ses = session.fromPartition(`grab-probe-${Date.now()}-${Math.random()}`, { cache: false });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());

  const found = new Map(); // url -> { url, kind, size, fromPlayer }
  const requests = new Map(); // url -> { userAgent, referer, origin } as the player sent it
  const diagnostics = { framesScanned: 0, rejected: {} };
  const failed = new Set();
  let userAgent = '';
  let drm = false;
  let title = '';
  // Addresses a player element points at. One without a media extension is only recognized once
  // its response type is known; it still counts as the player's own source then.
  const playerSources = new Set();
  const add = (url, { type = '', size = 0, fromPlayer = false } = {}) => {
    if (signal?.aborted || isNotPlayer(url)) return;
    if (fromPlayer && typeof url === 'string') playerSources.add(url);
    const verdict = classify(url, type);
    if (!verdict.kind) {
      if (verdict.reject !== 'not-media') diagnostics.rejected[verdict.reject] = (diagnostics.rejected[verdict.reject] || 0) + 1;
      return;
    }
    const prev = found.get(url) || {};
    found.set(url, { url, kind: verdict.kind, size: Math.max(size, prev.size || 0), fromPlayer: fromPlayer || !!prev.fromPlayer || playerSources.has(url) });
  };
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (isLicenseRequest(d.url)) drm = true;
    add(d.url);
    cb({});
  });
  ses.webRequest.onSendHeaders((d) => {
    requests.set(d.url, contextFromHeaders(d.requestHeaders, userAgent));
  });
  ses.webRequest.onHeadersReceived((d, cb) => {
    if (d.statusCode >= 400) { failed.add(d.url); cb({}); return; }
    failed.delete(d.url);
    const type = header(d.responseHeaders, 'content-type') || '';
    if (d.statusCode < 400 && isMediaType(type)) add(d.url, { type, size: Number(header(d.responseHeaders, 'content-length')) || 0 });
    cb({});
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  userAgent = win.webContents.getUserAgent();
  const abort = () => { if (!win.isDestroyed()) win.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!/^https?:/i.test(url)) e.preventDefault(); });

  const embeds = new Set();
  const collect = async () => {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try {
        const r = await frame.executeJavaScript(collectorScript({ startPlayback: true }));
        diagnostics.framesScanned++;
        if (r.drm) drm = true;
        if (frame === win.webContents.mainFrame && r.title) title = r.title;
        r.media.forEach((u) => add(u, { fromPlayer: true }));
        r.embeds.forEach((u) => embeds.add(u));
      } catch { /* frame went away */ }
    }
  };

  let cookies = [];
  try {
    const start = Date.now();
    await Promise.race([win.loadURL(pageUrl).catch(() => {}), sleep(15000)]);
    // Players often start a moment after the page loads: look a few times, and stop early once
    // the player's own source, a stream manifest or an embedded player has shown up.
    while (Date.now() - start < timeoutMs) {
      signal?.throwIfAborted();
      await collect();
      if (Date.now() - start > 6000 && (embeds.size || [...found.values()].some((f) => f.fromPlayer || f.kind === 'stream'))) break;
      await sleep(1500);
    }
    // The cookies this page set while playing (this session started empty).
    signal?.throwIfAborted();
    const urls = [pageUrl, ...found.keys()];
    const seen = new Set();
    for (const url of urls) {
      for (const c of await ses.cookies.get({ url }).catch(() => [])) {
        const key = `${c.domain}|${c.path}|${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push({ domain: c.domain, path: c.path, name: c.name, value: c.value, secure: c.secure, httpOnly: c.httpOnly, session: c.session, expires: c.expirationDate });
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!win.isDestroyed()) win.destroy();
    ses.clearStorageData().catch(() => {});
  }

  const media = rankMedia([
    ...[...found.values()].filter((m) => !failed.has(m.url)).map((m) => ({ ...m, fromPlayer: m.fromPlayer || playerSources.has(m.url) })),
    ...unconfirmedPlayerSources(playerSources, found).filter((m) => !failed.has(m.url)),
  ]);
  const context = (url) => requests.get(url) || { userAgent, referer: pageUrl };
  const candidates = [
    ...media.map((m) => ({ url: m.url, kind: m.kind, size: m.size, requestContext: context(m.url) })),
    ...playerEmbeds(embeds, pageUrl, isNotPlayer).map((u) => ({ url: u, kind: 'embed', size: 0, requestContext: { userAgent, referer: pageUrl } })),
  ];
  signal?.throwIfAborted();
  const cookieRef = cookies.length ? browserSession.rememberCookies(cookies, { source: 'probe' }) : null;
  cookies = null;
  return { candidates, title: title.trim(), protected: drm && !media.some((m) => m.kind === 'file'), cookieRef, diagnostics };
}

module.exports = { findMedia };
