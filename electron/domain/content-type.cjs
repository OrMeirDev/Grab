// Positive URL hints only. Unknown pages are inspected; ordinary video services retain their
// direct extractor route without requiring a browser or an extra PDF request.
const { siteKey } = require('./site-policy.cjs');
function urlContentType(value) {
  try {
    const u = new URL(value);
    if (/\.pdf$/i.test(u.pathname) || /^application\/pdf(?:\s*;|$)/i.test(u.searchParams.get('response-content-type') || '') ||
      /filename\*?\s*=.*\.pdf(?:[\s"';]|$)/i.test(u.searchParams.get('response-content-disposition') || '')) return 'pdf';
    if (/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac|ogg|wav|m3u8|mpd)$/i.test(u.pathname) ||
      ['youtube', 'vimeo', 'facebook', 'instagram', 'tiktok', 'x'].includes(siteKey(value))) return 'video';
  } catch { /* unrecognized */ }
  return null;
}
module.exports = { urlContentType };
