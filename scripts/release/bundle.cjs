// The release consumes the installer that passed integration/package checks, without rebuilding it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = (p, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(fs.readFileSync(p)).digest(encoding);
const git = (root, arg) => execFileSync('git', ['rev-parse', arg], { cwd: root, encoding: 'utf8' }).trim();
function info(root) {
  const { version } = json(path.join(root, 'package.json'));
  assert.match(version, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/, 'expected a release/candidate version');
  const channel = version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest';
  const installer = `Grab-Setup-${version}.exe`;
  return { version, installer, feed: channel + '.yml', files: [installer, installer + '.blockmap', channel + '.yml', 'INSTALL-WINDOWS-HE.md', 'native-tools.lock.json', 'THIRD_PARTY_NOTICES.md'] };
}
function checkFeed(dir, expected) {
  const feed = yaml.load(fs.readFileSync(path.join(dir, expected.feed), 'utf8'), { schema: yaml.JSON_SCHEMA });
  const exe = path.join(dir, expected.installer);
  assert.equal(feed.version, expected.version, 'update feed version');
  assert.equal(feed.path, expected.installer, 'update feed installer path');
  assert.equal(feed.sha512, hash(exe, 'sha512', 'base64'), 'update feed installer SHA-512');
  assert.equal(feed.files?.length, 1, 'one Windows x64 installer');
  assert.equal(feed.files[0].url, expected.installer, 'update file URL');
  assert.equal(feed.files[0].sha512, feed.sha512, 'update file SHA-512');
  assert.equal(feed.files[0].size, fs.statSync(exe).size, 'update file size');
}
function verifyBundle({ root, dir, sourceSha = git(root, 'HEAD'), sourceTree = git(root, 'HEAD^{tree}') }) {
  const expected = info(root);
  const manifest = json(path.join(dir, 'release-manifest.json'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.version, expected.version);
  assert.equal(manifest.sourceSha, sourceSha, 'installer source commit');
  assert.equal(manifest.sourceTree, sourceTree, 'installer source tree');
  assert.equal(manifest.extensionVersion, json(path.join(root, 'extension', 'manifest.json')).version);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...expected.files, 'release-manifest.json', 'SHA256SUMS.txt'].sort(), 'exact release file set');
  assert.deepEqual(manifest.files.map((f) => f.name).sort(), expected.files.slice().sort());
  for (const f of manifest.files) {
    assert.ok(expected.files.includes(f.name));
    assert.equal(f.sha256, hash(path.join(dir, f.name)), f.name + ' SHA-256');
    assert.equal(f.bytes, fs.statSync(path.join(dir, f.name)).size, f.name + ' size');
  }
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/).map((line) => {
    const m = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert.ok(m, 'valid SHA256SUMS entry');
    return { sha256: m[1], name: m[2] };
  });
  assert.deepEqual(sums.map((f) => f.name).sort(), [...expected.files, 'release-manifest.json'].sort(), 'all release checksums, without duplicates');
  for (const f of sums) assert.equal(f.sha256, hash(path.join(dir, f.name)), f.name + ' checksum');
  assert.deepEqual(json(path.join(dir, 'native-tools.lock.json')), json(path.join(root, 'native-tools.lock.json')), 'pinned engines');
  checkFeed(dir, expected);
  return { ...expected, manifest, assets: [...expected.files, 'release-manifest.json', 'SHA256SUMS.txt'].map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size, sha256: hash(path.join(dir, name)) })) };
}
function prepareBundle({ root, sourceSha = git(root, 'HEAD'), sourceTree = git(root, 'HEAD^{tree}') }) {
  const expected = info(root);
  const output = path.join(root, 'release');
  const dir = path.join(output, 'bundle');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const name of expected.files) {
    const from = name === 'INSTALL-WINDOWS-HE.md' ? path.join(root, 'docs', name) : ['native-tools.lock.json', 'THIRD_PARTY_NOTICES.md'].includes(name) ? path.join(root, name) : path.join(output, name);
    fs.copyFileSync(from, path.join(dir, name));
  }
  checkFeed(dir, expected);
  const manifest = { schema: 1, version: expected.version, sourceSha, sourceTree,
    extensionVersion: json(path.join(root, 'extension', 'manifest.json')).version,
    files: expected.files.map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size, sha256: hash(path.join(dir, name)) })) };
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), [...expected.files, 'release-manifest.json'].map((name) => hash(path.join(dir, name)) + '  ' + name).join('\n') + '\n');
  return verifyBundle({ root, dir, sourceSha, sourceTree });
}
module.exports = { info, hash, prepareBundle, verifyBundle };
if (require.main === module) {
  const result = prepareBundle({ root: path.resolve(__dirname, '../..') });
  console.log(`Verified release bundle ${result.version}: ${result.assets.length} files, source ${result.manifest.sourceSha}`);
}
