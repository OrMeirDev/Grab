// When yt-dlp finds no video at a link, the video often plays inside the page's own small player.
// This opens the page the way a browser would, hidden and muted, and collects the video addresses
// that player uses: the same ones DevTools shows (video tags, the requests the player makes,
// embedded players from other sites). Nothing here gets past a login or copy protection:
// the page opens with no cookies or accounts, and a DRM-protected player is reported, not touched.
const { BrowserWindow, session } = require('electron');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FILE = /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i;
const MANIFEST = /\.(m3u8|mpd)(\?|#|$)/i;
const MEDIA_TYPE = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
// Pieces of a stream (the manifest is what's wanted) and common ad servers.
const SEGMENT = /\.(ts|m4s|aac)(\?|#|$)|[/_-](seg|segment|chunk|frag)[-_]?\d|init[-_]?\d*\.mp4/i;
const ADS = /doubleclick|googlesyndication|googleads|imasdk|adnxs|adsystem|advert|\/ads?\//i;
const LICENSE = /widevine|playready|fairplay|\/license/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in every frame of the page: the player's own video elements (nudged to start, muted),
// share tags that name the video, and embedded players from other sites.
const COLLECT = `(() => {
  const out = { media: [], embeds: [], drm: false, title: document.title || '' };
  for (const v of document.querySelectorAll('video, audio')) {
    if (v.mediaKeys) out.drm = true;
    v.muted = true;
    try { const p = v.play && v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    for (const s of [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((x) => x.src)]) if (s) out.media.push(s);
  }
  for (const m of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')) if (m.content) out.media.push(m.content);
  for (const f of document.querySelectorAll('iframe[src]')) out.embeds.push(f.src);
  const og = document.querySelector('meta[property="og:title"]');
  if (og && og.content) out.title = og.content;
  return out;
})()`;

async function findMedia(pageUrl, { timeoutMs = 20000 } = {}) {
  // A fresh in-memory session: none of the user's cookies or logins, nothing saved afterwards.
  const ses = session.fromPartition(`grab-probe-${Date.now()}-${Math.random()}`, { cache: false });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.on('will-download', (e) => e.preventDefault());

  const found = new Map(); // url -> { url, kind, size, fromPlayer }
  let drm = false;
  let title = '';
  const add = (url, { type = '', size = 0, fromPlayer = false } = {}) => {
    if (!/^https?:/i.test(url) || ADS.test(url) || SEGMENT.test(url)) return;
    const kind = MANIFEST.test(url) || /mpegurl|dash/i.test(type) ? 'stream' : FILE.test(url) || /^video\//i.test(type) ? 'file' : null;
    if (!kind) return;
    const prev = found.get(url) || {};
    found.set(url, { url, kind, size: Math.max(size, prev.size || 0), fromPlayer: fromPlayer || !!prev.fromPlayer });
  };
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (LICENSE.test(d.url)) drm = true;
    add(d.url);
    cb({});
  });
  ses.webRequest.onHeadersReceived((d, cb) => {
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
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!/^https?:/i.test(url)) e.preventDefault(); });

  const embeds = new Set();
  const collect = async () => {
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try {
        const r = await frame.executeJavaScript(COLLECT);
        if (r.drm) drm = true;
        if (frame === win.webContents.mainFrame && r.title) title = r.title;
        r.media.forEach((u) => add(u, { fromPlayer: true }));
        r.embeds.forEach((u) => { if (/^https?:/i.test(u) && !ADS.test(u)) embeds.add(u); });
      } catch { /* frame went away */ }
    }
  };

  try {
    const start = Date.now();
    await Promise.race([win.loadURL(pageUrl, { userAgent: UA }).catch(() => {}), sleep(15000)]);
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
  const media = [...found.values()].sort((a, b) => (b.fromPlayer - a.fromPlayer) || ((b.kind === 'stream') - (a.kind === 'stream')) || (b.size - a.size));
  const host = new URL(pageUrl).host;
  const candidates = [
    ...media.map((m) => ({ url: m.url, kind: m.kind, size: m.size })),
    ...[...embeds].filter((u) => { try { return new URL(u).host !== host; } catch { return false; } }).map((u) => ({ url: u, kind: 'embed', size: 0 })),
  ];
  return { candidates, title: title.trim(), protected: drm && !media.some((m) => m.kind === 'file') };
}

module.exports = { findMedia };
