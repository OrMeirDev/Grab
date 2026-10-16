// Validate an extension-provided cookie against the actual URLs the selected job requested.
// The extension queries chrome.cookies by URL; the desktop repeats scope validation at its
// own trust boundary rather than accepting a broad or malformed cookie snapshot.
function cookieMatchesUrl(cookie, target) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
      || typeof cookie.domain !== 'string' || typeof target !== 'string') return false;
  let url;
  try { url = new URL(target); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const domain = cookie.domain.toLowerCase().replace(/^\./, '');
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) return false;
  const host = url.hostname.toLowerCase();
  // A leading dot has domain scope in the Netscape jar, except when explicitly host-only.
  const hostOnly = cookie.hostOnly === true || (cookie.hostOnly === undefined && !cookie.domain.startsWith('.'));
  if (hostOnly ? host !== domain : host !== domain && !host.endsWith('.' + domain)) return false;
  if (cookie.secure && url.protocol !== 'https:') return false;
  const cpath = cookie.path || '/';
  if (typeof cpath !== 'string' || !cpath.startsWith('/') || /[\x00-\x1f\x7f]/.test(cpath)) return false;
  const pathname = url.pathname || '/';
  if (pathname !== cpath && !(pathname.startsWith(cpath)
    && (cpath.endsWith('/') || pathname.charAt(cpath.length) === '/'))) return false;
  if (!cookie.session && Number.isFinite(cookie.expirationDate)
      && cookie.expirationDate > 0 && cookie.expirationDate <= Date.now() / 1000) return false;
  return true;
}

function filterScopedCookies(urls, snapshot) {
  if (!Array.isArray(urls) || !Array.isArray(snapshot)) return [];
  return snapshot.filter((cookie) => urls.some((url) => cookieMatchesUrl(cookie, url)));
}

module.exports = { cookieMatchesUrl, filterScopedCookies };
