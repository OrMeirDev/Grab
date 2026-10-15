// First look inside a page's player: open the page the way a browser would, hidden and muted, in
// a fresh in-memory session (no cookies or accounts, nothing saved), and collect the video
// addresses its player uses: video elements, the stream requests it makes, embedded players.
// Works on public pages with no setup. The user's default browser (pageprobe.cjs) is only the backup.
// A DRM-protected player is reported, never touched.
const { BrowserWindow, session } = require('electron');
const { collectorScript, isNotPlayer } = require('./media-collector.cjs');
const browserSession = require('./browser-session.cjs');
const { contextFromHeaders } = require('./request-context.cjs');

const FILE = /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|ogg|opus|wav|flac|aac)(\?|#|$)/i;
const MANIFEST = /\.(m3u8|mpd)(\?|#|$)/i;
const MEDIA_TYPE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
// Pieces of a stream (the manifest is what's wanted) and common ad servers.
const SEGMENT = /\.(ts|m4s)(\?|#|$)|[/_-](seg|segment|chunk|frag)[-_]?\d|init[-_]?\d*\.mp4/i;
const ADS = /doubleclick|googlesyndication|googleads|imasdk|adnxs|adsystem|advert|\/ads?\/|:\/\/ads?\./i;
const LICENSE = /widevine|playready|fairplay|\/license/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMedia(pageUrl, { timeoutMs = 20000 } = {}) {
  const ses = session.fromPartition(`grab-probe-${Date.now()}-${Math.random()}`, { cache: false });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.on('will-download', (e) => e.preventDefault());

  const found = new Map(); // each URL keeps its own actual playback request context
  const requests = new Map();
  const failed = new Set();
  let userAgent = '';
  let drm = false;
  let title = '';
  const add = (url, { type = '', size = 0, fromPlayer = false, referer = pageUrl, requestContext } = {}) => {
    // Stream pieces are skipped by name and by type (some services give them odd names, e.g. ".dts").
    if (typeof url !== 'string' || !/^https?:/i.test(url) || ADS.test(url) || SEGMENT.test(url) || /mp2t|iso\.segment/i.test(type)) return;
    const kind = MANIFEST.test(url) || /mpegurl|dash/i.test(type) ? 'stream' : FILE.test(url) || /^(video|audio)\//i.test(type) ? 'file' : null;
    if (!kind) return;
    const prev = found.get(url) || {};
    found.set(url, { url, kind, size: Math.max(size, prev.size || 0), fromPlayer: fromPlayer || !!prev.fromPlayer,
      requestContext: requestContext || requests.get(url) || prev.requestContext || { userAgent, referer } });
  };
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (LICENSE.test(d.url)) drm = true;
    add(d.url);
    cb({});
  });
  ses.webRequest.onSendHeaders((d) => {
    const requestContext = contextFromHeaders(d.requestHeaders, userAgent);
    requests.set(d.url, requestContext);
    add(d.url, { requestContext });
  });
  ses.webRequest.onHeadersReceived((d, cb) => {
    if (d.statusCode >= 400) { failed.add(d.url); cb({}); return; }
    failed.delete(d.url);
    const h = Object.fromEntries(Object.entries(d.responseHeaders || {}).map(([k, v]) => [k.toLowerCase(), [].concat(v)[0]]));
    if (MEDIA_TYPE.test(h['content-type'] || '')) add(d.url, { type: h['content-type'], size: Number(h['content-length']) || 0 });
    cb({});
  });
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  userAgent = win.webContents.getUserAgent();
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!/^https?:/i.test(url)) e.preventDefault(); });

  const embeds = new Set();
  const collect = async () => {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try {
        const r = await frame.executeJavaScript(collectorScript({ startPlayback: true }));
        if (r.drm) drm = true;
        if (frame === win.webContents.mainFrame && r.title) title = r.title;
        r.media.forEach((u) => add(u, { fromPlayer: true, referer: r.pageUrl || pageUrl }));
        r.embeds.forEach((u) => { if (/^https?:/i.test(u) && !ADS.test(u) && !isNotPlayer(u)) embeds.add(u); });
      } catch { /* frame went away */ }
    }
  };

  try {
    const start = Date.now();
    await Promise.race([win.loadURL(pageUrl).catch(() => {}), sleep(15000)]);
    // Players often start a moment after the page loads: look a few times, and stop early once
    // the player's own source, a stream manifest or an embedded player has shown up.
    while (Date.now() - start < timeoutMs) {
      await collect();
      if (Date.now() - start > 6000 && (embeds.size || [...found.values()].some((f) => f.fromPlayer || f.kind === 'stream'))) break;
      await sleep(1500);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }

  // The player's own source first, then stream manifests, then the largest files, then embeds.
  const media = [...found.values()].filter((m) => !failed.has(m.url)).sort((a, b) => (b.fromPlayer - a.fromPlayer) || ((b.kind === 'stream') - (a.kind === 'stream')) || (b.size - a.size));
  const host = new URL(pageUrl).host;
  const candidates = [
    ...media.map((m) => ({ url: m.url, kind: m.kind, size: m.size, requestContext: m.requestContext })),
    ...[...embeds].filter((u) => { try { return new URL(u).host !== host; } catch { return false; } }).map((u) => ({ url: u, kind: 'embed', size: 0, requestContext: { userAgent, referer: pageUrl } })),
  ];
  const cookies = new Map();
  for (const url of new Set([pageUrl, ...candidates.map((c) => c.url)])) {
    for (const cookie of await ses.cookies.get({ url })) {
      cookies.set(JSON.stringify([cookie.domain, cookie.path, cookie.name]), { ...cookie, expires: cookie.expirationDate });
    }
  }
  return { candidates, title: title.trim(), cookieRef: browserSession.rememberCookies([...cookies.values()]), protected: drm && !media.some((m) => m.kind === 'file') };
}

module.exports = { findMedia };
