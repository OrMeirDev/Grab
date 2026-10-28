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
        const typeHint = url.searchParams.get('response-content-type') || '';
        const disposition = url.searchParams.get('response-content-disposition') || '';
        if (!explicit && !/\.pdf$/i.test(url.pathname) &&
            !/^application\/pdf(?:\s*;|$)/i.test(typeHint) &&
            !/filename\*?\s*=.*\.pdf(?:[\s"';]|$)/i.test(disposition)) return;
        url.hash = '';
        if (links.size < 20) links.set(url.href, { url: url.href, label: (label || '').trim().slice(0, 200) });
      } catch { /* ignore */ }
    };
    if (document.contentType === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(location.href)) add(location.href, true, document.title);
    for (const el of Array.from(document.querySelectorAll('a[href], iframe[src], embed[src], object[data]')).slice(0, 10000)) {
      const raw = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
      add(raw, /application\/pdf/i.test(el.getAttribute('type') || '') || /\.pdf$/i.test(el.getAttribute('download') || ''), el.textContent || el.title);
    }
    // Fetch/XHR viewers may remove the original URL from the DOM after creating a blob.
    // Resource Timing still exposes URLs loaded before the extension started observing.
    // Use only positive PDF hints; never probe every resource or replay page requests.
    try {
      for (const entry of performance.getEntriesByType('resource').slice(-1000)) {
        add(entry.name, /^application\/pdf(?:\s*;|$)/i.test(entry.contentType || ''), '');
      }
    } catch { /* Resource Timing is optional and can be unavailable in viewers. */ }
    return { links: [...links.values()], title: document.title, pageUrl: location.href };
  }
  return { collectInPage };
}));
