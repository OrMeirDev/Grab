#!/usr/bin/env node
// Local diagnostic endpoint for the network-privacy audit (docs/audits/). Loopback only.
//
// It is both an origin server and an HTTP forward proxy for synthetic hostnames (for example
// http://media.grab-audit.test/), so cookie-scope and redirect checks need no DNS or hosts-file
// change. It NEVER forwards anything to the internet: a request for a host it does not serve is
// answered locally. CONNECT (HTTPS) is accepted only when a test certificate is given, and is
// then terminated here; there is no interception of real sites.
//
// What is logged (JSON lines): method, host, path, query KEYS (never values), status, bytes,
// User-Agent, Origin, Range, Referer reduced to origin+path, cookie NAMES and count (never
// values), whether Authorization was present (scheme only), and the names of all other headers.
//
//   node scripts/audit/diag-endpoint.cjs --port 8765 --media <file.mp4> --log <out.jsonl>
//        [--tls-cert cert.pem --tls-key key.pem] [--update-version 0.0.1]
//
// Routes (any host): /media/<name>      the --media file, with Range support
//                    /flaky/<name>      2nd request per host+name (the download after the
//                                       lookup): 503; every other request like /media
//                    /cut/<name>        2nd request per host+name: body cut after 1 MiB
//                    /slow/<name>       like /media at 1 MiB/s (for cancel checks)
//                    /redirect?to=<url> 302 to <url>
//                    /jspage.html[?v=slow] page whose <video> is added by script (hidden probe)
//                    /page.html         HTML page with a <video> (+ Set-Cookie)
//                    /thumb.jpg         tiny image (+ Set-Cookie), for renderer thumbnail checks
//                    /set?name=value    responds 200 with Set-Cookie (synthetic)
//                    /update/latest.yml updater metadata (no newer version unless asked)
//                    /info.json         a minimal info page body for diagnostics
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function redactReferer(value) {
  if (!value) return undefined;
  try { const u = new URL(value); return `${u.origin}${u.pathname}${u.search ? '?<' + [...u.searchParams.keys()].join(',') + '>' : ''}`; }
  catch { return '<unparseable>'; }
}

function sanitize(req, url, via) {
  const h = req.headers;
  const cookieNames = String(h.cookie || '').split(';').map((p) => p.split('=')[0].trim()).filter(Boolean);
  const auth = h.authorization ? `present(${String(h.authorization).split(' ')[0]})` : undefined;
  const record = {
    via, method: req.method, host: url.host, path: url.pathname,
    queryKeys: [...url.searchParams.keys()],
    userAgent: h['user-agent'], referer: redactReferer(h.referer), origin: h.origin, range: h.range,
    acceptLanguage: h['accept-language'], secChUa: h['sec-ch-ua'],
    cookieNames, cookieCount: cookieNames.length, authorization: auth,
    // a persistent installation id must be visible as such, but its value is not needed
    xUserStagingId: h['x-user-staging-id'] ? `present(len=${String(h['x-user-staging-id']).length})` : undefined,
    otherHeaders: Object.keys(h).filter((n) => !['user-agent', 'referer', 'origin', 'range', 'accept-language', 'sec-ch-ua', 'cookie', 'authorization', 'host', 'x-user-staging-id', 'proxy-connection', 'connection'].includes(n)).sort(),
  };
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
}

function createEndpoint({ media, log, updateVersion = '0.0.1', onRecord } = {}) {
  const seen = new Map(); // host+path -> requests so far
  const write = (rec) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...rec });
    if (log) fs.appendFileSync(log, line + '\n');
    onRecord?.(JSON.parse(line));
  };

  // Streams with backpressure; `bytes` is what the socket accepted, `clientClosed` marks a
  // reader that stopped early (a lookup that only needed the response headers, a cancel).
  function serveMedia(req, res, rec, { cutAfter, bytesPerSecond } = {}) {
    const finish = (code, bytes, extra = {}) => write({ ...rec, status: code, bytes, ...extra });
    if (!media || !fs.existsSync(media)) { res.writeHead(404); res.end(); return finish(404, 0); }
    const size = fs.statSync(media).size;
    let start = 0; let end = size - 1; let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return finish(416, 0); }
      status = 206;
    }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return finish(status, 0); }
    let sent = 0; let logged = false;
    const once = (extra) => { if (!logged) { logged = true; finish(status, sent, extra); } };
    const stream = fs.createReadStream(media, { start, end, highWaterMark: 64 * 1024 });
    res.on('close', () => { stream.destroy(); once(res.writableFinished ? {} : { clientClosed: true }); });
    stream.on('data', (chunk) => {
      if (cutAfter && sent + chunk.length > cutAfter) {
        res.write(chunk.subarray(0, cutAfter - sent)); sent = cutAfter;
        stream.destroy(); once({ cut: true }); res.socket?.destroy(); return;
      }
      sent += chunk.length;
      const gates = [];
      if (!res.write(chunk)) gates.push(new Promise((r) => res.once('drain', r)));
      if (bytesPerSecond) gates.push(new Promise((r) => setTimeout(r, Math.ceil(chunk.length / bytesPerSecond * 1000))));
      if (gates.length) { stream.pause(); Promise.all(gates).then(() => { if (!stream.destroyed) stream.resume(); }); }
    });
    stream.on('end', () => res.end());
    return undefined;
  }

  function handler(via) {
    return (req, res) => {
      let url;
      try { url = req.url.startsWith('http://') || req.url.startsWith('https://') ? new URL(req.url) : new URL(req.url, `${via === 'tls' ? 'https' : 'http'}://${req.headers.host || 'localhost'}`); }
      catch { res.writeHead(400); res.end(); return; }
      const rec = sanitize(req, url, req.url.startsWith('http://') ? 'proxy' : via);
      const done = (status, headers = {}, body = '') => {
        res.writeHead(status, headers); res.end(body);
        write({ ...rec, status, bytes: Buffer.byteLength(body), ...(headers['Set-Cookie'] ? { setCookieNames: [].concat(headers['Set-Cookie']).map((c) => c.split('=')[0]) } : {}) });
      };
      const name = url.pathname.split('/').pop();
      const key = `${url.host}${url.pathname}`;
      if (url.pathname.startsWith('/media/')) return serveMedia(req, res, rec);
      const nth = (seen.get(key) || 0) + 1;
      seen.set(key, nth);
      if (url.pathname.startsWith('/flaky/')) {
        if (nth === 2) return done(503, { 'Retry-After': '0' }, 'try again');
        return serveMedia(req, res, rec);
      }
      if (url.pathname.startsWith('/cut/')) return serveMedia(req, res, rec, nth === 2 ? { cutAfter: 1024 * 1024 } : {});
      if (url.pathname.startsWith('/slow/')) return serveMedia(req, res, rec, { bytesPerSecond: 1024 * 1024 });
      if (url.pathname === '/jspage.html') {
        // the video address only appears after a script runs: yt-dlp's generic extractor cannot
        // see it, so Grab falls back to its hidden player probe
        return done(200, { 'Content-Type': 'text/html', 'Set-Cookie': `pagesid=${crypto.randomUUID()}; Path=/` },
          `<!doctype html><title>audit js page</title><div id=p></div><script>setTimeout(()=>{const v=document.createElement('video');v.muted=true;v.autoplay=true;v.src=${JSON.stringify(url.searchParams.get('v') === 'slow' ? '/slow/HSSMT.mp4' : '/media/HSSMT.mp4')};document.getElementById('p').append(v)},300)</script>`);
      }
      if (url.pathname === '/redirect') return done(302, { Location: url.searchParams.get('to') || '/' });
      if (url.pathname === '/set') {
        const cookies = [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}; Path=/`);
        return done(200, { 'Set-Cookie': cookies, 'Content-Type': 'text/plain' }, 'ok');
      }
      if (url.pathname === '/page.html') {
        return done(200, { 'Content-Type': 'text/html', 'Set-Cookie': `pagesid=${crypto.randomUUID()}; Path=/` },
          `<!doctype html><title>audit page</title><video src="/media/${encodeURIComponent(name === 'page.html' ? 'HSSMT.mp4' : name)}" controls muted></video>`);
      }
      if (url.pathname === '/thumb.jpg') {
        // 1x1 GIF body; the type does not matter for the request check
        const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.length, 'Set-Cookie': `thumbtrack=${crypto.randomUUID()}; Path=/; Max-Age=31536000` });
        res.end(gif);
        return write({ ...rec, status: 200, bytes: gif.length, setCookieNames: ['thumbtrack'] });
      }
      if (url.pathname.startsWith('/update/') && name.endsWith('.yml')) {
        return done(200, { 'Content-Type': 'text/yaml' },
          `version: ${updateVersion}\nfiles:\n  - url: Grab-Setup-${updateVersion}.exe\n    sha512: ${'A'.repeat(86)}==\n    size: 1\npath: Grab-Setup-${updateVersion}.exe\nsha512: ${'A'.repeat(86)}==\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);
      }
      return done(404, { 'Content-Type': 'text/plain' }, 'not served by the audit endpoint');
    };
  }

  const server = http.createServer(handler('direct'));
  let tlsServer = null;
  return {
    server,
    enableTls({ cert, key }) {
      tlsServer = https.createServer({ cert, key }, handler('tls'));
      server.on('connect', (req, socket, head) => {
        write({ via: 'connect', method: 'CONNECT', host: req.url, status: 200 });
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) socket.unshift(head);
        tlsServer.emit('connection', socket);
      });
    },
    listen(port = 0, host = '127.0.0.1') {
      if (!tlsServer) server.on('connect', (req, socket) => { write({ via: 'connect', method: 'CONNECT', host: req.url, status: 405 }); socket.end('HTTP/1.1 405 Not Allowed\r\n\r\n'); });
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() { server.close(); tlsServer?.close(); },
  };
}

// A throwaway CA + server certificate for synthetic *.grab-audit.test names (openssl on PATH;
// Git for Windows ships one). Used only by the audit harnesses; nothing is installed anywhere.
function makeTestCert(dir, hosts = ['media.grab-audit.test', 'cdn.grab-audit.test', 'thumbs.grab-audit.test']) {
  const { execFileSync } = require('node:child_process');
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=grab-audit test CA', '-keyout', 'ca.key', '-out', 'ca.pem');
    run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hosts[0]}`, '-keyout', 'srv.key', '-out', 'srv.csr');
    fs.writeFileSync(path.join(dir, 'ext.cnf'), `subjectAltName=${hosts.map((h) => 'DNS:' + h).join(',')}\n`);
    run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.cnf', '-out', 'srv.pem');
  } catch { return null; }
  return { ca: path.join(dir, 'ca.pem'), cert: fs.readFileSync(path.join(dir, 'srv.pem')), key: fs.readFileSync(path.join(dir, 'srv.key')) };
}

module.exports = { createEndpoint, sanitize, redactReferer, makeTestCert };

if (require.main === module) {
  const a = args(process.argv);
  const ep = createEndpoint({ media: a.media && path.resolve(a.media), log: a.log && path.resolve(a.log), updateVersion: a['update-version'] || '0.0.1',
    onRecord: (r) => process.stdout.write(`${r.method} ${r.host}${r.path || ''} -> ${r.status} ${r.cookieCount ? `cookies[${r.cookieNames.join(',')}] ` : ''}${r.range ? `range=${r.range} ` : ''}\n`) });
  if (a['tls-cert'] && a['tls-key']) ep.enableTls({ cert: fs.readFileSync(a['tls-cert']), key: fs.readFileSync(a['tls-key']) });
  ep.listen(Number(a.port || 8765)).then((port) => console.log(`audit endpoint on http://127.0.0.1:${port} (loopback only; log: ${a.log || 'stdout'})`));
}
