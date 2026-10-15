#!/usr/bin/env node
// Before packaging: bin/ must hold exactly the tools pinned in native-tools.lock.json (GRB-06).
// Fails (exit 1) on a missing file, a hash mismatch, an unexpected executable or missing licenses.
// Usage: node scripts/verify-native-tools.cjs [binDir]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const bin = path.resolve(process.argv[2] || path.join(root, 'bin'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'native-tools.lock.json'), 'utf8'));

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const problems = [];
const expected = new Set();

for (const tool of lock.tools) {
  for (const [name, hash] of Object.entries(tool.files)) {
    expected.add(name.toLowerCase());
    const file = path.join(bin, name);
    if (!fs.existsSync(file)) { problems.push(`${name}: missing (run npm run fetch-bin)`); continue; }
    const actual = sha256(file);
    if (actual !== hash) problems.push(`${name}: SHA-256 ${actual}, expected ${hash} (${tool.name} ${tool.version})`);
  }
  for (const license of tool.licenseFiles || []) {
    const file = path.join(bin, 'licenses', license.name);
    if (!fs.existsSync(file)) problems.push(`licenses/${license.name}: missing`);
    else if (sha256(file) !== license.sha256) problems.push(`licenses/${license.name}: unexpected content`);
  }
}
let names = [];
try { names = fs.readdirSync(bin); } catch { problems.push(`${bin}: not found`); }
for (const name of names) {
  if (/\.(exe|dll)$/i.test(name) && !expected.has(name.toLowerCase())) problems.push(`${name}: not in native-tools.lock.json`);
}

if (problems.length) {
  console.error('Native tools do not match native-tools.lock.json:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('Native tools verified: ' + lock.tools.map((t) => `${t.name} ${t.version}`).join(', '));
