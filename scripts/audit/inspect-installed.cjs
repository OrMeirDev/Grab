#!/usr/bin/env node
// Phase 1 check (docs/audits/): does an INSTALLED Grab contain a given revision's security changes?
// Read-only: opens <install>/resources/app.asar and the unpacked extension, never runs Grab.
//
//   node scripts/audit/inspect-installed.cjs --installed "%LOCALAPPDATA%\Programs\Grab" --compare <checkout> [--compare <checkout2>]
//
// For each security-relevant file it prints whether the installed copy is byte-identical to the
// copy in each checkout (SHA-256), plus the app version and the extension's permissions.
// SAME = identical; differs = both have it, different bytes; missing = only the checkout has it;
// not-there = only the installed build has it (for example a file added by a newer branch).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const a = { compare: [] };
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  const k = process.argv[i].slice(2); const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  if (k === 'compare') a.compare.push(path.resolve(v)); else a[k] = v;
}
const installed = path.resolve(a.installed || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Grab'));
const resources = path.join(installed, 'resources');
const asarFile = path.join(resources, 'app.asar');
if (!fs.existsSync(asarFile)) { console.error(`No app.asar under ${resources}`); process.exit(2); }
// @electron/asar ships with the repository's devDependencies (electron-builder)
const asar = require(require.resolve('@electron/asar', { paths: [...a.compare, path.join(__dirname, '..', '..')] }));

const FILES = [
  'electron/main.cjs', 'electron/engine.cjs', 'electron/browser/service.cjs', 'electron/domain/cookie-scope.cjs',
  'electron/domain/records.cjs', 'electron/domain/secrets.cjs', 'electron/infrastructure/cookie-vault.cjs',
  'electron/infrastructure/diagnostics.cjs', 'electron/infrastructure/json-store.cjs', 'electron/infrastructure/private-info-dir.cjs',
  'electron/infrastructure/repositories.cjs', 'electron/hidden-probe.cjs',
];
const sha = (buf) => (buf ? crypto.createHash('sha256').update(buf).digest('hex') : null);
const fromAsar = (f) => { try { return asar.extractFile(asarFile, f); } catch { return null; } };
const fromDir = (dir, f) => { try { return fs.readFileSync(path.join(dir, f)); } catch { return null; } };
const rev = (dir) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return path.basename(dir); } };

const pkg = JSON.parse(fromAsar('package.json'));
console.log(`installed: ${installed}\napp version: ${pkg.version}  app.asar sha256: ${sha(fs.readFileSync(asarFile)).slice(0, 16)}…`);
const labels = a.compare.map(rev);
console.log(`\n${'file'.padEnd(48)} ${labels.map((l) => l.padEnd(10)).join(' ')}`);
for (const f of FILES) {
  const mine = sha(fromAsar(f));
  const cols = a.compare.map((dir) => {
    const other = sha(fromDir(dir, f));
    return (!mine && !other ? 'absent' : mine === other ? 'SAME' : !mine ? 'missing' : !other ? 'not-there' : 'differs').padEnd(10);
  });
  console.log(`${f.padEnd(48)} ${cols.join(' ')}`);
}
const manifest = path.join(resources, 'extension', 'manifest.json');
if (fs.existsSync(manifest)) {
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  console.log(`\nextension ${m.version}: permissions=${JSON.stringify(m.permissions)} host_permissions=${JSON.stringify(m.host_permissions)}`);
  console.log(`  "tabs" permission present: ${m.permissions.includes('tabs')} (removed on the security branch)`);
}
