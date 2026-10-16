#!/usr/bin/env node
// Network-privacy scenarios against the REAL Grab engine code of a checkout (docs/audits/).
//
// Runs the checkout's own electron/engine.cjs (yt-dlp arguments, lookup cache, download),
// BrowserService.rememberSession (extension cookie filtering) and CookieVault (temporary jar)
// against the loopback audit endpoint (diag-endpoint.cjs). Synthetic hostnames under .test are
// reached through the endpoint acting as an HTTP proxy, so nothing leaves the machine and no
// DNS or hosts-file change is needed. All cookies are synthetic; values are never printed.
//
//   node scripts/audit/engine-scenarios.cjs --app <checkout> --media <HSSMT.mp4> --out <dir>
//        [--only T02,T04] [--tls]   (--tls needs openssl on PATH; terminates TLS for *.grab-audit.test only)
//
// Output: <out>/requests.jsonl (sanitized endpoint log) and <out>/summary.json.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createEndpoint, makeTestCert } = require('./diag-endpoint.cjs');

const a = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) a[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
const APP = path.resolve(a.app || path.join(__dirname, '..', '..'));
const MEDIA = path.resolve(a.media || '');
const OUT = path.resolve(a.out || fs.mkdtempSync(path.join(os.tmpdir(), 'grab-audit-')));
const ONLY = a.only ? String(a.only).split(',') : null;
const EXPECTED_SIZE = fs.statSync(MEDIA).size;
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'requests.jsonl');
fs.rmSync(LOG, { force: true });

const engine = require(path.join(APP, 'electron', 'engine.cjs'));
const { CookieVault } = require(path.join(APP, 'electron', 'infrastructure', 'cookie-vault.cjs'));
const { BrowserService } = require(path.join(APP, 'electron', 'browser', 'service.cjs'));
let hasScopeModule = true;
try { require.resolve(path.join(APP, 'electron', 'domain', 'cookie-scope.cjs')); } catch { hasScopeModule = false; }

const records = [];
let marker = 0;
const endpoint = createEndpoint({ media: MEDIA, log: LOG, onRecord: (r) => records.push({ ...r, scenario: current }) });
let current = 'setup';
const summary = { app: APP, revision: gitRev(APP), cookieScopeModule: hasScopeModule, ytdlp: null, scenarios: {} };

function gitRev(dir) { try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } }
const FAKE_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const now = Math.floor(Date.now() / 1000);
const value = () => `SYNTH${++marker}${Math.random().toString(36).slice(2, 8)}`; // synthetic, recognizable in files

// the extension's cookie shape (chrome.cookies.Cookie, see extension/background.js answerCookies)
const ext = (name, domain, extra = {}) => ({ name, value: value(), domain, path: '/', secure: false, httpOnly: false, hostOnly: !domain.startsWith('.'), session: false, expirationDate: now + 3600, ...extra });

function sessionFrom(urls, snapshot) {
  // The real BrowserService.rememberSession, bound to a real CookieVault.
  const vault = new CookieVault({ tmpDir: path.join(OUT, 'jar-tmp') });
  fs.mkdirSync(vault.tmpDir, { recursive: true });
  const fake = { session: { rememberCookies: (c, o) => vault.remember(c, o) }, cookieRefs: new Map() };
  const ref = BrowserService.prototype.rememberSession.call(fake, { key: 'audit-instance' }, urls, snapshot);
  return { vault, ref, kept: vault.snapshots.get(ref).cookies.map((c) => c.name) };
}

function jarShape(file) {
  if (!file) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_'))).map((l) => {
    const [domain, flag, p, secure, expires, name] = l.split('\t');
    return { name, domain, includeSubdomains: flag, path: p, secure, expires: Number(expires) > 0 ? 'set' : 'session' };
  });
}

const proxied = () => { process.env.http_proxy = process.env.HTTP_PROXY = `http://127.0.0.1:${PORT}`; };
let PORT;
const requestsOf = (name) => records.filter((r) => r.scenario === name && r.method !== 'CONNECT');
const brief = (r) => ({ method: r.method, host: r.host, path: r.path, status: r.status, range: r.range, bytes: r.bytes, acceptLanguage: r.acceptLanguage, cookies: r.cookieNames || [], ua: r.userAgent, referer: r.referer, origin: r.origin, auth: r.authorization, cut: r.cut, other: r.otherHeaders });

async function scenario(name, fn) {
  if (ONLY && !ONLY.some((p) => name.startsWith(p))) return;
  current = name;
  const started = Date.now();
  let result;
  try { result = await fn(); } catch (e) { result = { error: String(e.message || e) }; }
  summary.scenarios[name] = { ms: Date.now() - started, ...result, requests: requestsOf(name).map(brief) };
  console.log(`${name}: ${JSON.stringify({ ...result, requests: requestsOf(name).length }).slice(0, 400)}`);
}

async function downloadVia(url, context = {}, label = 'dl') {
  const lookup = await engine.analyze(url, { ...context, timeoutMs: 120000 });
  if (!lookup.ok) return { lookup: { ok: false, kind: lookup.kind, error: String(lookup.error).slice(0, 200) } };
  const outDir = path.join(OUT, 'downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const outputBase = path.join(outDir, `${label}-${Date.now()}`);
  const run = engine.download({ url, ...context, outputBase, format: 'mp4', quality: 'best', infoFile: lookup.infoFile, infoAt: lookup.infoAt, infoExpiresAt: lookup.infoExpiresAt }, () => {});
  const r = await run.done;
  const file = r.file;
  const size = file && fs.existsSync(file) ? fs.statSync(file).size : null;
  const infoFileHadCookieValues = lookup.infoFile && fs.existsSync(lookup.infoFile) ? /SYNTH\d+/.test(fs.readFileSync(lookup.infoFile, 'utf8')) : null;
  if (lookup.infoFile) fs.rmSync(lookup.infoFile, { force: true });
  if (file) fs.rmSync(file, { force: true });
  return { lookup: { ok: true, site: lookup.site }, download: { ok: !!r.ok, kind: r.kind, error: r.error && String(r.error).slice(0, 200) }, size, sizeMatches: size === EXPECTED_SIZE, infoFileHadCookieValues };
}

// The lookup only (yt-dlp -J), for cookie-scope checks that need the request, not the bytes.
async function lookupWith(vault, ref, url, context = {}) {
  let shape = [];
  let infoHadValues = null;
  const r = await vault.withJar(ref, async (cookieFile) => {
    shape = jarShape(cookieFile);
    const out = await engine.analyze(url, { ...context, cookieFile, timeoutMs: 60000 });
    if (out.infoFile && fs.existsSync(out.infoFile)) {
      const text = fs.readFileSync(out.infoFile, 'utf8');
      infoHadValues = /SYNTH\d+/.test(text);
      fs.rmSync(out.infoFile, { force: true });
    }
    return out;
  });
  const leftover = fs.readdirSync(vault.tmpDir).filter((n) => n.startsWith('grab-cookies-'));
  return { ok: !!r.ok, kind: r.kind, jar: shape, jarDirsLeftAfterRun: leftover.length, infoFileContainsCookieValues: infoHadValues };
}

(async () => {
  PORT = await endpointListen();
  summary.ytdlp = await engine.version();
  const local = (p) => `http://127.0.0.1:${PORT}${p}`;

  // ---- T02: pasted direct link (no browser, no cookies, no context) --------------------------
  await scenario('T02a direct MP4 (local copy, full download)', () => downloadVia(local('/media/HSSMT.mp4')));
  await scenario('T02b 503 once, then OK (retry behaviour)', () => downloadVia(local('/flaky/HSSMT.mp4')));
  await scenario('T02c connection cut after 1 MiB (Range resume)', () => downloadVia(local('/cut/HSSMT.mp4')));

  // ---- T03-equivalent: extension-delivered context (UA/Referer/Origin + scoped cookies) ------
  proxied();
  await scenario('T03 extension context + scoped cookies (full download)', async () => {
    const page = 'http://www.grab-audit.test/watch/42';
    const media = 'http://media.grab-audit.test/media/HSSMT.mp4';
    const { vault, ref, kept } = sessionFrom([page, media], [ext('mediasession', 'media.grab-audit.test'), ext('sitewide', '.grab-audit.test', { hostOnly: false })]);
    const context = { requestContext: { userAgent: FAKE_BROWSER_UA, referer: page, origin: 'http://www.grab-audit.test' } };
    const r = await vault.withJar(ref, (cookieFile) => downloadVia(media, { ...context, cookieFile }, 'ext'));
    return { keptByDesktopFilter: kept, ...r };
  });

  // ---- T04: cookie scope isolation ---------------------------------------------------------
  const target = 'http://media.grab-audit.test/media/HSSMT.mp4';
  await scenario('T04a desktop filter: which extension cookies survive for the job URL', async () => {
    const snapshot = [
      ext('hostonly_ok', 'media.grab-audit.test'),
      ext('hostonly_other_host', 'cdn.grab-audit.test'),
      ext('domain_ok', '.grab-audit.test', { hostOnly: false }),
      ext('domain_unrelated', '.unrelated.test', { hostOnly: false }),
      ext('lookalike_suffix', '.audit.test', { hostOnly: false }),
      ext('path_ok', 'media.grab-audit.test', { path: '/media' }),
      ext('path_other', 'media.grab-audit.test', { path: '/account' }),
      ext('path_prefix_trap', 'media.grab-audit.test', { path: '/med' }),
      ext('secure_on_http', 'media.grab-audit.test', { secure: true }),
      ext('expired', 'media.grab-audit.test', { expirationDate: now - 60 }),
      ext('session_cookie', 'media.grab-audit.test', { session: true, expirationDate: 0 }),
      ext('inconsistent_hostonly_dot', '.grab-audit.test', { hostOnly: true }),
    ];
    const { vault, ref, kept } = sessionFrom([target], snapshot);
    const sent = await lookupWith(vault, ref, target);
    const req = requestsOf('T04a desktop filter: which extension cookies survive for the job URL');
    return { offered: snapshot.map((c) => c.name), keptByDesktopFilter: kept, ...sent, sentToTarget: [...new Set(req.flatMap((r) => r.cookieNames || []))] };
  });

  await scenario('T04b same jar, request to a sibling host and to the parent domain', async () => {
    const { vault, ref } = sessionFrom(['http://media.grab-audit.test/', 'http://cdn.grab-audit.test/', 'http://grab-audit.test/'],
      [ext('hostonly_media', 'media.grab-audit.test'), ext('domain_wide', '.grab-audit.test', { hostOnly: false }), ext('inconsistent_hostonly_dot', '.grab-audit.test', { hostOnly: true })]);
    const out = {};
    for (const host of ['cdn.grab-audit.test', 'grab-audit.test', 'evilgrab-audit.test']) {
      const before = records.length;
      out[host] = await lookupWith(vault, ref, `http://${host}/media/HSSMT.mp4`);
      out[host].sent = [...new Set(records.slice(before).filter((r) => r.host === host).flatMap((r) => r.cookieNames || []))];
    }
    return out;
  });

  await scenario('T04c redirect to an unrelated host does not carry cookies', async () => {
    const away = 'http://other-site.test/media/HSSMT.mp4';
    const start = `http://media.grab-audit.test/redirect?to=${encodeURIComponent(away)}`;
    const { vault, ref, kept } = sessionFrom([start], [ext('hostonly_media', 'media.grab-audit.test'), ext('domain_wide', '.grab-audit.test', { hostOnly: false })]);
    const r = await lookupWith(vault, ref, start, { requestContext: { userAgent: FAKE_BROWSER_UA, referer: 'http://www.grab-audit.test/watch/42', origin: 'http://www.grab-audit.test' } });
    const req = requestsOf('T04c redirect to an unrelated host does not carry cookies');
    return { kept, ...r, perHost: Object.fromEntries([...new Set(req.map((x) => x.host))].map((h) => [h, { cookies: [...new Set(req.filter((x) => x.host === h).flatMap((x) => x.cookieNames || []))], origin: req.find((x) => x.host === h)?.origin, referer: req.find((x) => x.host === h)?.referer }])) };
  });

  await scenario('T04d forgotten / expired handle refuses to run without the session', async () => {
    const { vault, ref } = sessionFrom([target], [ext('hostonly_ok', 'media.grab-audit.test')]);
    vault.forget(ref);
    try { await vault.withJar(ref, () => engine.analyze(target)); return { ranWithoutSession: true }; }
    catch (e) { return { ranWithoutSession: false, errorKind: e.kind }; }
  });

  if (a.tls) await scenario('T04e secure cookie is sent over HTTPS to its own host only', async () => tlsCase());

  endpoint.close();
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('summary:', path.join(OUT, 'summary.json'));
  fs.rmSync(path.join(OUT, 'jar-tmp'), { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

async function endpointListen() {
  if (a.tls) {
    const tls = makeTestCert(path.join(OUT, 'tls'));
    if (!tls) throw new Error('--tls needs openssl on PATH');
    endpoint.enableTls(tls);
  }
  return endpoint.listen(0);
}

// yt-dlp verifies HTTPS against its bundled CA list; for this one case only, it is pointed at
// the throwaway test CA (system store + SSL_CERT_FILE). The jar is the real CookieVault jar.
async function tlsCase() {
  const media = 'https://media.grab-audit.test/media/HSSMT.mp4';
  const { vault, ref, kept } = sessionFrom([media], [ext('secure_ok', 'media.grab-audit.test', { secure: true }), ext('secure_other', 'cdn.grab-audit.test', { secure: true })]);
  const exe = (() => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' }).split(/\r?\n/)[0]; } catch { return 'yt-dlp'; } })();
  let status;
  await vault.withJar(ref, async (cookieFile) => {
    // async: this process also serves the endpoint
    status = await new Promise((resolve) => {
      const child = spawn(exe, ['--ignore-config', '--compat-options', 'no-certifi', '--cookies', cookieFile, '-J', '--skip-download', media],
        { env: { ...process.env, https_proxy: `http://127.0.0.1:${PORT}`, HTTPS_PROXY: `http://127.0.0.1:${PORT}`, SSL_CERT_FILE: path.join(OUT, 'tls', 'ca.pem') }, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill(), 60000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
  });
  const req = requestsOf('T04e secure cookie is sent over HTTPS to its own host only');
  return { kept, exit: status, overTls: req.filter((r) => r.via === 'tls').map((r) => ({ host: r.host, cookies: r.cookieNames || [] })) };
}
