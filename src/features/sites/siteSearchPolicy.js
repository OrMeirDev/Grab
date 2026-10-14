// Searching the supported-sites list by name or by a pasted link. Pure.

export const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9֐-׿]/g, '');
const SKIP_LABELS = new Set(['www', 'm', 'my', 'app', 'com', 'co', 'il', 'net', 'org', 'io', 'biz', 'info']);

// "https://www.dailymotion.com/video/x" -> ["dailymotion"]; plain text -> [text]
export function searchTerms(query) {
  const q = query.trim();
  const host = q.match(/^(?:https?:\/\/)?([^\s/]+\.[a-z]{2,})(?:[/?#]|$)/i);
  if (!host) return [norm(q)].filter(Boolean);
  return host[1].toLowerCase().split('.').filter((p) => p.length >= 3 && !SKIP_LABELS.has(p)).map(norm);
}

// Adult sites never appear in the list; an exact name or link search only gets the verdict.
export function searchSites(sites, query) {
  const terms = searchTerms(query);
  const listed = (sites || []).filter((s) => !s.adult);
  const shown = terms.length ? listed.filter((s) => terms.some((t) => norm(s.name).includes(t))) : listed;
  const exactHidden = (sites || []).filter((s) => s.adult && terms.some((t) => norm(s.name) === t));
  return { listed, shown, matches: [...shown, ...exactHidden], working: listed.filter((s) => !s.broken).length };
}

// What the search box says about the query: 'ok' (supported), 'broken' (listed, not working), 'no'.
export function verdictOf(matches) {
  if (matches.some((s) => !s.broken)) return 'ok';
  return matches.length ? 'broken' : 'no';
}
