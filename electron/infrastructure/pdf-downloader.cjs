// Original PDF files only. Network and disk stay in main; no page printing or rendering.
const fs = require('node:fs');
const { cookieMatchesUrl } = require('../domain/cookie-scope.cjs');
const { pdfLinks, pdfTitle, httpUrl } = require('../domain/pdf.cjs');
const fail = (kind, error = kind, extra = {}) => ({ ok: false, kind, error, ...extra });
const MAX_HTML = 4 * 1024 * 1024;
const MAX_PDF = 1024 * 1024 * 1024;

function readCookies(file) {
  if (!file) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_'))).map(l => {
    const [domain, sub, path, secure, expires, name, value] = l.replace(/^#HttpOnly_/, '').split('\t');
    return { domain, hostOnly: sub !== 'TRUE', path, secure: secure === 'TRUE', expirationDate: Number(expires), name, value };
  });
}
function createPdfDownloader({ fetchImpl = fetch } = {}) {
  const choices = new Map();
  async function request(url, options) {
    const cookies = readCookies(options.cookieFile);
    for (let hop = 0; hop < 11; hop++) {
      options.signal?.throwIfAborted();
      if (!httpUrl(url)) throw new Error('Unsupported PDF address');
      const headers = { Accept: 'application/pdf,text/html;q=0.8', 'Accept-Encoding': 'identity' };
      const context = options.requestContext || {};
      if (context.userAgent) headers['User-Agent'] = context.userAgent;
      const referer = context.referer || options.referer;
      if (referer && httpUrl(referer)) headers.Referer = new URL(referer).origin === new URL(url).origin ? referer : new URL(referer).origin + '/';
      const applicable = cookies.filter(c => cookieMatchesUrl(c, url));
      if (applicable.length) headers.Cookie = applicable.map(c => `${c.name}=${c.value}`).join('; ');
      const response = await fetchImpl(url, { headers, signal: options.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing PDF redirect');
        const next = new URL(location, url).href;
        if (new URL(url).protocol === 'https:' && new URL(next).protocol !== 'https:') throw new Error('Insecure PDF redirect');
        url = next; continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error('PDF server refused the request'), { kind: response.status === 429 ? 'rateLimited' : [401, 403].includes(response.status) ? 'pdfSessionRequired' : 'pdfUnavailable', httpStatus: response.status });
      }
      return { response, url };
    }
    throw new Error('Too many PDF redirects');
  }
  async function inspect(url, options) {
    const { response, url: finalUrl } = await request(url, options);
    const reader = response.body.getReader();
    let chunks = [], length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value)); length += value.length;
        const prefix = Buffer.concat(chunks).subarray(0, 1024).toString('latin1');
        if (prefix.includes('%PDF-')) return { pdf: true, url: finalUrl, title: pdfTitle(finalUrl, response.headers.get('content-disposition')) };
        if (length > MAX_HTML) throw Object.assign(new Error('PDF page is too large'), { kind: 'pdfNotFound' });
      }
      const html = Buffer.concat(chunks).toString('utf8');
      return { pdf: false, url: finalUrl, links: pdfLinks(html, finalUrl) };
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function analyze(url, options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
    const pageUrl = url;
    try {
      for (const [key, v] of choices) if (Date.now() - v.at > 600000) choices.delete(key);
      if (options.choice) {
        const c = choices.get(options.choice.token);
        choices.delete(options.choice.token);
        if (!c || c.url !== url || c.itemId !== options.itemId || !c.links[options.choice.index]) return fail('pdfChoiceExpired');
        url = c.links[options.choice.index].url;
      }
      let found = await inspect(url, { ...options, signal, referer: options.referer || pageUrl });
      const directDocument = found.pdf;
      if (!found.pdf) {
        if (options.direct || !found.links.length) return fail('pdfNotFound');
        if (found.links.length > 1) {
          const token = globalThis.crypto.randomUUID();
          if (choices.size >= 100) choices.delete(choices.keys().next().value);
          choices.set(token, { links: found.links, url, itemId: options.itemId, at: Date.now() });
          return { ...fail('pdfChoice'), token, choices: found.links.map((c, index) => ({ index, label: c.label })) };
        }
        found = await inspect(found.links[0].url, { ...options, signal, referer: found.url });
      }
      if (!found.pdf) return fail('pdfNotFound');
      return { ok: true, contentType: 'pdf', directDocument, title: found.title, site: 'PDF', mediaUrl: found.url, referer: options.referer || pageUrl };
    } catch (e) { return fail(options.signal?.aborted ? 'cancelled' : signal.aborted ? 'pdfTimeout' : e.kind || 'network', 'PDF lookup failed', e.httpStatus ? { httpStatus: e.httpStatus } : {}); }
  }
  function download(plan, onProgress = () => {}) {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    const target = plan.outputBase + '.pdf';
    const partial = target + '.part';
    const done = (async () => {
      let file;
      try {
        const { response } = await request(plan.mediaUrl || plan.url, { ...plan, signal });
        // fetch exposes decoded bytes, whereas Content-Length describes the encoded transfer.
        const encoding = response.headers.get('content-encoding');
        const total = !encoding || encoding.toLowerCase() === 'identity' ? Number(response.headers.get('content-length')) || 0 : 0;
        if (total > MAX_PDF) { await response.body.cancel(); return fail('pdfTooLarge'); }
        file = await fs.promises.open(partial, 'w', 0o600);
        let received = 0, prefix = Buffer.alloc(0), tail = Buffer.alloc(0), verified = false;
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            received += chunk.length;
            if (received > MAX_PDF) throw Object.assign(new Error('PDF too large'), { kind: 'pdfTooLarge' });
            if (!verified) {
              prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, Math.max(0, 1024 - prefix.length))]);
              verified = prefix.toString('latin1').includes('%PDF-');
              if (!verified && prefix.length >= 1024) throw Object.assign(new Error('Invalid PDF'), { kind: 'pdfInvalid' });
            }
            tail = Buffer.concat([tail, Buffer.from(chunk)]).subarray(-65536);
            await file.writeFile(chunk);
            onProgress({ percent: total ? Math.min(99, received * 100 / total) : 0, speed: '', eta: '' });
          }
          if (!verified || !tail.toString('latin1').includes('%%EOF') || (total && received !== total)) throw Object.assign(new Error('Incomplete PDF'), { kind: 'pdfInvalid' });
        } finally { await file.close(); file = null; }
        signal.throwIfAborted();
        // Never replace a completed file, including after a restored queue or external write.
        await fs.promises.link(partial, target);
        await fs.promises.unlink(partial);
        return { ok: true, file: target };
      } catch (e) {
        await file?.close().catch(() => {});
        await fs.promises.unlink(partial).catch(() => {});
        return abort.signal.aborted ? { ok: false, stopped: true } : fail(signal.aborted ? 'pdfTimeout' : e.kind || 'network', 'PDF download failed');
      }
    })();
    return { done, stop: () => abort.abort() };
  }
  return { analyze, download };
}
module.exports = { createPdfDownloader, readCookies };
