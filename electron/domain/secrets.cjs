// Recognizing links that carry a secret (a token, a signature, credentials) so they are never
// written to disk, and cutting links in free text down to scheme://host/path. Pure.

const { redactMediaSecrets } = require('./media-request-context.cjs');

// Query or fragment keys that carry access (signed URLs, session ids, API keys).
const SECRET_PARAM = /token|sig(nature)?$|^sig|signature|auth|key|secret|passw|session|^sid$|policy|expires|credential|jwt|hmac|^hash$|^x-amz-|^x-goog-|^hdnts$|^hdnea$|^acl$|^h$/i; // h: Vimeo private-link hash

function linkHasSecret(url) {
  let u;
  try { u = new URL(url); } catch { return true; } // unreadable: don't keep it
  if (u.username || u.password || /(?:hdntl|hdnea|hdnts)=/i.test(u.pathname)) return true;
  const params = [...u.searchParams.keys()];
  if (u.hash.includes('=')) params.push(...new URLSearchParams(u.hash.slice(1)).keys());
  return params.some((k) => SECRET_PARAM.test(k));
}

// "HTTP Error 403 for https://cdn/v.mp4?token=x" -> "HTTP Error 403 for https://cdn/v.mp4"
function stripLinksInText(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s"'<>]+/g, (m) => {
    try { const u = new URL(m); return redactMediaSecrets(`${u.protocol}//${u.host}${u.pathname}`); } catch { return '[link]'; }
  });
}

module.exports = { linkHasSecret, stripLinksInText, SECRET_PARAM };
