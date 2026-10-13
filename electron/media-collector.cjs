// Kept as a function so the exact code injected into each frame is also testable.
function collectInPage({ startPlayback = true } = {}) {
  const out = { media: [], embeds: [], drm: false, title: document.title || '', pageUrl: document.URL || document.baseURI, players: 0 };
  const media = new Set();
  const embeds = new Set();
  const visited = new Set();
  const roots = [document];
  const base = document.baseURI;
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const url = new URL(value, base);
      if (url.protocol === 'https:' || url.protocol === 'http:') media.add(url.href);
    } catch {}
  };

  while (roots.length) {
    const root = roots.pop();
    if (visited.has(root)) continue;
    visited.add(root);
    for (const el of root.querySelectorAll('*')) {
      const tag = el.localName;
      const native = tag === 'video' || tag === 'audio';
      const player = native || tag === 'mux-video' || tag === 'mux-player' || typeof el.play === 'function';
      if (player) {
        out.players++;
        try { if (el.mediaKeys) out.drm = true; } catch {}
        // Custom elements need not reflect HTML attributes as JavaScript properties.
        add(el.getAttribute('src'));
        add(el.getAttribute('cast-src'));
        try { add(el.currentSrc); } catch {}
        try { add(el.src); } catch {}
        if (native && startPlayback) {
          el.muted = true;
          try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch {}
        }
      }
      if (tag === 'source' && el.parentElement?.matches('video, audio')) add(el.src || el.getAttribute('src'));
      // Also recognize unfamiliar wrappers without relying on a fixed list of tag names.
      for (const attr of ['src', 'cast-src', 'data-src']) {
        const value = el.getAttribute(attr);
        if (value && /\.(m3u8|mpd)([?#]|$)/i.test(value)) add(value);
      }
      if (el.matches('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')) add(el.content);
      if (tag === 'iframe' && el.getAttribute('src')) {
        try { embeds.add(new URL(el.getAttribute('src'), base).href); } catch {}
      }
      if (el.shadowRoot) roots.push(el.shadowRoot);
      // A copied/parsed page may still contain inert declarative-shadow templates.
      if (tag === 'template' && el.content) roots.push(el.content);
    }
  }
  const og = document.querySelector('meta[property="og:title"]');
  if (og?.content) out.title = og.content;
  // An existing tab may have loaded its manifest before Grab attached Network.
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      if (/\.(m3u8|mpd)([?#]|$)/i.test(entry.name)) add(entry.name);
    }
  } catch {}
  out.media = [...media];
  out.embeds = [...embeds];
  return out;
}

const collectorScript = (options = {}) => `(${collectInPage.toString()})(${JSON.stringify(options)})`;
// Frames that are never a video player: payments, captchas, fraud checks, sign-in buttons, chat
// widgets, analytics and cookie banners. Trying them only wastes the lookup's time.
const NOT_PLAYER_HOST = /(^|\.)(stripe\.com|stripe\.network|stripecdn\.com|hcaptcha\.com|recaptcha\.net|sardine\.ai|paypal\.com|braintreegateway\.com|adyen\.com|challenges\.cloudflare\.com|accounts\.google\.com|appleid\.apple\.com|googletagmanager\.com|google-analytics\.com|intercom\.io|intercomcdn\.com|crisp\.chat|zdassets\.com|zendesk\.com|hotjar\.com|onetrust\.com|cookielaw\.org|cookiebot\.com)$/i;
const isNotPlayer = (url) => {
  try {
    const u = new URL(url);
    return NOT_PLAYER_HOST.test(u.hostname) || (/(^|\.)google\.com$/i.test(u.hostname) && u.pathname.startsWith('/recaptcha'));
  } catch { return true; }
};

module.exports = { collectInPage, collectorScript, isNotPlayer };
