// PDF discovery rules shared by the HTTP adapter's bounded HTML scan.
const httpUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };
const decode = value => value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
  if (entity[0] === '#') { const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
  return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[entity.toLowerCase()];
});
function pdfTitle(url, disposition = '') {
  const match = /filename\*=UTF-8''([^;]+)|filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition || '');
  let name = match ? (match[1] || match[2] || match[3]) : new URL(url).pathname.split('/').pop();
  try { name = decodeURIComponent(name); } catch { /* preserve malformed names */ }
  return (name || 'document').replace(/\.pdf$/i, '').slice(0, 300);
}
function pdfLinks(html, pageUrl) {
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const out = new Map();
  let base = pageUrl;
  const baseMatch = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(clean);
  try { if (baseMatch) base = new URL(decode(baseMatch[1]), pageUrl).href; } catch { /* ignore */ }
  for (const tag of clean.matchAll(/<(a|iframe|embed|object)\b([^>]*)(?:>([^<]*))?/gi)) {
    const attrs = {};
    for (const a of tag[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4]);
    const source = attrs.href || attrs.src || attrs.data;
    if (!source) continue;
    try {
      const u = new URL(source, base);
      if (!httpUrl(u.href)) continue;
      if (!/\.pdf$/i.test(u.pathname) && !/application\/pdf/i.test(attrs.type || '') && !/\.pdf$/i.test(attrs.download || '')) continue;
      u.hash = '';
      const label = decode(tag[3] || attrs.title || '').trim().slice(0, 200) || pdfTitle(u.href);
      if (!out.has(u.href)) out.set(u.href, { url: u.href, label });
      if (out.size >= 20) break;
    } catch { /* unsupported link */ }
  }
  return [...out.values()];
}
module.exports = { httpUrl, pdfLinks, pdfTitle };
