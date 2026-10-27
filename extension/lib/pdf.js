// Injected read-only into existing pages and frames. Never clicks links or starts a player.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabPdf = api;
}(typeof self !== 'undefined' ? self : this, function () {
  function collectInPage() {
    const links = new Map();
    const add = (raw, explicit, label) => {
      try {
        const url = new URL(raw, document.baseURI);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
        if (!explicit && !/\.pdf$/i.test(url.pathname)) return;
        url.hash = '';
        if (links.size < 20) links.set(url.href, { url: url.href, label: (label || '').trim().slice(0, 200) });
      } catch { /* ignore */ }
    };
    if (document.contentType === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(location.href)) add(location.href, true, document.title);
    for (const el of Array.from(document.querySelectorAll('a[href], iframe[src], embed[src], object[data]')).slice(0, 10000)) {
      const raw = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
      add(raw, /application\/pdf/i.test(el.getAttribute('type') || '') || /\.pdf$/i.test(el.getAttribute('download') || ''), el.textContent || el.title);
    }
    return { links: [...links.values()], title: document.title, pageUrl: location.href };
  }
  return { collectInPage };
}));
