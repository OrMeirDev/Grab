// Which site a link belongs to (for per-site blocks), and when two links are the same link. Pure.
//
// A site is its exact host, except for known services whose several hosts are one site
// (youtube.com, youtu.be, m.youtube.com -> "youtube"). The old rule (second-to-last host label)
// put unrelated sites together: a.co.uk and b.co.uk both became "co" (GRB-14).

const ALIASES = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, 'youtube'],
  [/(^|\.)(tiktok\.com)$/, 'tiktok'],
  [/(^|\.)(instagram\.com)$/, 'instagram'],
  [/(^|\.)(vimeo\.com)$/, 'vimeo'],
  [/(^|\.)(facebook\.com|fb\.watch)$/, 'facebook'],
  [/(^|\.)(x\.com|twitter\.com)$/, 'x'],
];

function siteKey(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
  const alias = ALIASES.find(([re]) => re.test(host));
  if (alias) return alias[1];
  return host.replace(/^(www|m|mobile)\./, '') || 'unknown';
}

// Two pasted links are the same when they address the same page: the host's case and default
// port don't matter, everything else does (signed query strings are kept and compared as they are).
function sameLinkKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch { return String(url); }
}

module.exports = { siteKey, sameLinkKey };
