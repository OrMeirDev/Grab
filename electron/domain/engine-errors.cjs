// yt-dlp output -> a failure kind the UI can explain. Pure.

function errorKind(err) {
  // HTTP 429: the site asked us to slow down. The site is held at once; nothing else is tried.
  if (/HTTP Error 429|Too Many Requests/i.test(err)) return 'rateLimited';
  // A bot check: the user's signed-in browser may get past it.
  if (/not a bot|Sign in to confirm/i.test(err)) return 'blocked';
  if (/Private video|members-only|Join this channel|login required|requires authentication|logged[- ]in/i.test(err)) return 'private';
  if (/Unsupported URL|No video formats|is not a valid URL|Unable to extract/i.test(err)) return 'notfound';
  if (/Video unavailable|removed|does not exist|HTTP Error 404/i.test(err)) return 'unavailable';
  if (/getaddrinfo|Network is unreachable|timed out|Connection reset/i.test(err)) return 'network';
  return 'other';
}

// The last ERROR line, without yt-dlp's prefixes.
function cleanError(err) {
  const line = String(err || '').split(/\r?\n/).reverse().find((l) => l.includes('ERROR')) || String(err || '').trim().split(/\r?\n/).pop() || '';
  return line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '').slice(0, 200);
}

module.exports = { errorKind, cleanError };
