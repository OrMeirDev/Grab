// Page-side media collector. collectInPage() is injected into every frame with
// chrome.scripting.executeScript, so it must stay self-contained (no outer references).
// It reports player metadata as DATA: addresses found in players, open shadow roots, metadata
// tags and resource timing. A blob: source is a browser-local handle and is never reported as
// a downloadable URL (only counted), because its real source is the player's network requests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabCollector = api;
}(typeof self !== 'undefined' ? self : this, function () {
  function collectInPage(options) {
    const startPlayback = !!(options && options.startPlayback);
    const out = {
      media: [], embeds: [], drm: false, title: document.title || '', pageUrl: document.URL || document.baseURI,
      players: 0, playing: 0, blobPlayers: 0, playRejected: 0,
    };
    const media = new Set();
    const embeds = new Set();
    const visited = new Set();
    const roots = [document];
    const base = document.baseURI;
    const add = (value) => {
      if (typeof value !== 'string' || !value.trim()) return;
      if (/^blob:/i.test(value.trim())) { out.blobPlayers++; return; }
      try {
        const url = new URL(value, base);
        if (url.protocol === 'https:' || url.protocol === 'http:') media.add(url.href);
      } catch (e) { /* not a URL */ }
    };
    while (roots.length) {
      const r = roots.pop();
      if (visited.has(r)) continue;
      visited.add(r);
      for (const el of r.querySelectorAll('*')) {
        const tag = el.localName;
        const native = tag === 'video' || tag === 'audio';
        const player = native || tag === 'mux-video' || tag === 'mux-player' || typeof el.play === 'function';
        if (player) {
          out.players++;
          try { if (el.mediaKeys) out.drm = true; } catch (e) { /* ignore */ }
          add(el.getAttribute('src'));
          add(el.getAttribute('cast-src'));
          try { add(el.currentSrc); } catch (e) { /* ignore */ }
          try { add(el.src); } catch (e) { /* ignore */ }
          if (native) {
            try { if (!el.paused && el.readyState > 2) out.playing++; } catch (e) { /* ignore */ }
            if (el.__grabPlayRejected) out.playRejected++;
            if (startPlayback && el.paused) {
              // Ordinary, muted playback. A browser autoplay policy may refuse; that is reported.
              el.muted = true;
              try {
                const p = el.play();
                if (p && p.catch) p.catch(() => { el.__grabPlayRejected = true; });
              } catch (e) { el.__grabPlayRejected = true; }
            }
          }
        }
        if (tag === 'source' && el.parentElement && el.parentElement.matches('video, audio')) add(el.src || el.getAttribute('src'));
        for (const attr of ['src', 'cast-src', 'data-src']) {
          const value = el.getAttribute(attr);
          if (value && /\.(m3u8|mpd)([?#]|$)/i.test(value)) add(value);
        }
        if (el.matches('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')) add(el.content);
        if (tag === 'iframe' && el.getAttribute('src')) {
          try { embeds.add(new URL(el.getAttribute('src'), base).href); } catch (e) { /* ignore */ }
        }
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (tag === 'template' && el.content) roots.push(el.content);
      }
    }
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) out.title = og.content;
    // Manifests this page already loaded before the extension was watching.
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (/\.(m3u8|mpd)([?#]|$)/i.test(entry.name)) add(entry.name);
      }
    } catch (e) { /* ignore */ }
    out.media = Array.from(media).slice(0, 60);
    out.embeds = Array.from(embeds).slice(0, 30);
    return out;
  }
  return { collectInPage };
}));
