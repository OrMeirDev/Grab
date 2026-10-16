#!/usr/bin/env node
// T06 persistence scan (docs/audits/): what Grab left on disk, without printing any secret.
//
//   node scripts/audit/scan-profile.cjs --profile <userData dir> [--temp <temp dir>] [--marker SYNTH] [--json out.json]
//
// Windows defaults: --profile %APPDATA%\Grab, --temp %TEMP%. Only grab-* entries of the temp
// folder are scanned. For every file: size, permissions (POSIX mode, or the principals that hold
// access according to icacls on Windows) and the KINDS of sensitive data found, with counts.
// Values are never printed or written.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const a = { marker: [] };
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  const k = process.argv[i].slice(2); const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  if (k === 'marker') a.marker.push(v); else a[k] = v;
}
const IS_WIN = process.platform === 'win32';
const PROFILE = path.resolve(a.profile || (IS_WIN ? path.join(process.env.APPDATA || '', 'Grab') : path.join(os.homedir(), '.config', 'Grab')));
const TEMP = path.resolve(a.temp || os.tmpdir());
// Chromium's own caches are listed by size only (binary, and not written by Grab's code)
const SKIP_CONTENT = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|blob_storage|Crashpad|Shared Dictionary|Dictionaries)([\\/]|$)/;

const SECRET_QUERY = /[?&#](?:[^=&#\s"']*(?:token|sig|signature|policy|expires|key-pair-id|credential|hdnts|hdnea|auth|session|x-amz-[a-z-]+|x-goog-[a-z-]+))=[^&#\s"']+/gi;
const CHECKS = [
  ['signed-url-query', SECRET_QUERY],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['netscape-cookie-line', /^(?:#HttpOnly_)?[A-Za-z0-9.-]+\t(?:TRUE|FALSE)\t\/[^\t]*\t(?:TRUE|FALSE)\t\d+\t[^\t\n]+\t[^\n]*$/gm],
  ['cookie-header', /\bcookie\s*:\s*[^\s"]+=[^\s";]+/gi],
  ['ytdlp-cookies-field', /"cookies"\s*:\s*"[^"]+=/g],
  ['authorization-header', /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi],
];

function permissions(file) {
  if (!IS_WIN) return '0' + (fs.statSync(file).mode & 0o777).toString(8);
  try {
    const out = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
    return [...new Set(out.split(/\r?\n/).map((l) => l.replace(file, '').trim()).filter(Boolean).filter((l) => !/Successfully processed/i.test(l)).map((l) => l.split(':')[0]))].join(', ');
  } catch { return 'icacls failed'; }
}

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { yield { path: p, symlink: true }; continue; }
    if (e.isDirectory()) { yield { path: p, dir: true }; yield* walk(p); } else if (e.isFile()) yield { path: p };
  }
}

function scanFile(file) {
  const rec = { path: file, size: fs.statSync(file).size, permissions: permissions(file), findings: {} };
  if (SKIP_CONTENT.test(file) || rec.size > 50 * 1024 * 1024) { rec.contentSkipped = true; return rec; }
  const text = fs.readFileSync(file).toString('latin1');
  for (const [kind, re] of CHECKS) { const n = (text.match(re) || []).length; if (n) rec.findings[kind] = n; }
  for (const m of a.marker) { const n = text.split(m).length - 1; if (n) rec.findings[`marker:${m}`] = n; }
  return rec;
}

const report = { profile: PROFILE, temp: TEMP, scannedAt: new Date().toISOString(), files: [], dirs: [] };
for (const e of walk(PROFILE)) {
  if (e.dir) { report.dirs.push({ path: e.path, permissions: permissions(e.path) }); continue; }
  if (e.symlink) { report.files.push({ path: e.path, symlink: true }); continue; }
  report.files.push(scanFile(e.path));
}
let temps = [];
try { temps = fs.readdirSync(TEMP).filter((n) => /^grab-/.test(n)).map((n) => path.join(TEMP, n)); } catch { /* no temp */ }
report.tempEntries = temps.map((p) => path.basename(p));
for (const t of temps) {
  report.dirs.push({ path: t, permissions: permissions(t) });
  for (const e of walk(t)) if (!e.dir && !e.symlink) report.files.push(scanFile(e.path));
}

const flagged = report.files.filter((f) => f.findings && Object.keys(f.findings).length);
if (a.json) fs.writeFileSync(path.resolve(a.json), JSON.stringify(report, null, 2));
console.log(`profile: ${PROFILE}\ntemp grab-* entries: ${report.tempEntries.join(', ') || '(none)'}\nfiles: ${report.files.length}, with findings: ${flagged.length}`);
for (const f of flagged) console.log(`  ${path.relative(path.dirname(PROFILE), f.path)}  [${f.permissions}]  ${JSON.stringify(f.findings)}`);
for (const f of report.files.filter((x) => /history\.json|queue\.json|settings\.json|diagnostics\.log|\.updaterId|cookies\.txt|grab-info/i.test(x.path))) {
  console.log(`  perms ${path.relative(path.dirname(PROFILE), f.path)}  ${f.permissions}`);
}
