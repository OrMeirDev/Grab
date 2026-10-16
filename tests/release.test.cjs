const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { execFileSync } = require('node:child_process');
const { prepareBundle, verifyBundle } = require('../scripts/release/bundle.cjs');
const { checkedRun, checkAssets, checkPublicationOnlyChanges, findRelease } = require('../scripts/release/publish.cjs');
const sourceSha = 'a'.repeat(40), sourceTree = 'b'.repeat(40);
function fixture(t, changeFeed = (feed) => feed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ['extension', 'release', 'docs']) fs.mkdirSync(path.join(root, folder));
  const write = (name, data) => fs.writeFileSync(path.join(root, name), data);
  write('package.json', JSON.stringify({ version: '1.7.0' }));
  write('extension/manifest.json', JSON.stringify({ version: '1.1.3' }));
  write('native-tools.lock.json', JSON.stringify({ tools: [{ name: 'fixture-tool', version: '1' }] }));
  write('THIRD_PARTY_NOTICES.md', 'fixture license notices');
  write('docs/INSTALL-WINDOWS-HE.md', 'התקנת Grab');
  const installer = Buffer.from('fixture executable');
  write('release/Grab-Setup-1.7.0.exe', installer);
  write('release/Grab-Setup-1.7.0.exe.blockmap', 'fixture blockmap');
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  write('release/latest.yml', yaml.dump(changeFeed({ version: '1.7.0', path: 'Grab-Setup-1.7.0.exe', sha512,
    files: [{ url: 'Grab-Setup-1.7.0.exe', sha512, size: installer.length }] })));
  return { root, dir: path.join(root, 'release', 'bundle'), sourceSha, sourceTree };
}
test('release bundle preserves the checked binary and validates updater metadata and all checksums', (t) => {
  const options = fixture(t); const result = prepareBundle(options);
  assert.equal(result.version, '1.7.0'); assert.equal(result.assets.length, 8);
  assert.deepEqual(fs.readFileSync(path.join(options.dir, result.installer)), fs.readFileSync(path.join(options.root, 'release', result.installer)));
  assert.equal(verifyBundle(options).manifest.extensionVersion, '1.1.3');
});
test('publication rejects a modified installer, an extra asset and different engine pins', (t) => {
  for (const mutation of ['installer', 'asset', 'engines']) {
    const options = fixture(t); prepareBundle(options);
    if (mutation === 'installer') fs.appendFileSync(path.join(options.dir, 'Grab-Setup-1.7.0.exe'), 'changed');
    if (mutation === 'asset') fs.writeFileSync(path.join(options.dir, 'unreviewed.exe'), 'extra');
    if (mutation === 'engines') fs.writeFileSync(path.join(options.root, 'native-tools.lock.json'), '{}');
    assert.throws(() => verifyBundle(options));
  }
});
test('a valid bundle from another commit or tree cannot be released', (t) => {
  const options = fixture(t); prepareBundle(options);
  assert.throws(() => verifyBundle({ ...options, sourceSha: 'c'.repeat(40) }), /source commit/);
  assert.throws(() => verifyBundle({ ...options, sourceTree: 'c'.repeat(40) }), /source tree/);
});
for (const [name, mutate] of [
  ['stale candidate version', (f) => ({ ...f, version: '1.7.0-rc.4' })],
  ['wrong installer SHA-512', (f) => ({ ...f, sha512: 'incorrect' })],
  ['external update URL', (f) => ({ ...f, files: [{ ...f.files[0], url: 'https://example.invalid/setup.exe' }] })],
  ['wrong update size', (f) => ({ ...f, files: [{ ...f.files[0], size: 1 }] })],
]) test('release preparation rejects ' + name, (t) => assert.throws(() => prepareBundle(fixture(t, mutate))));
test('release gate requires successful main push checks for the exact commit and latest run', () => {
  const pass = { head_sha: sourceSha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_number: 1 };
  assert.equal(checkedRun([pass], sourceSha, 'CI'), pass);
  for (const change of [{ head_sha: 'c'.repeat(40) }, { head_branch: 'feature/test' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.throws(() => checkedRun([{ ...pass, ...change }], sourceSha, 'CI'));
  }
  assert.throws(() => checkedRun([pass, { ...pass, run_number: 2, conclusion: 'failure' }], sourceSha, 'CI'));
});
test('GitHub uploaded assets must have the exact file set, bytes and digest before publication', () => {
  const assets = [{ name: 'Grab-Setup-1.7.0.exe', bytes: 123, sha256: 'a'.repeat(64) }];
  const remote = { assets: [{ name: assets[0].name, size: 123, digest: 'sha256:' + assets[0].sha256, state: 'uploaded' }] };
  checkAssets(remote, assets);
  for (const change of [{ size: 1 }, { digest: 'sha256:wrong' }, { state: 'new' }]) assert.throws(() => checkAssets({ assets: [{ ...remote.assets[0], ...change }] }, assets));
  assert.throws(() => checkAssets({ assets: [] }, assets));
});
test('an authenticated draft is found through the list instead of the published-tag endpoint', () => {
  const draft = { id: 123, tag_name: 'v1.7.0', draft: true, assets: [] };
  const api = (endpoint) => { assert.equal(endpoint, 'releases?per_page=100'); return [draft]; };
  assert.equal(findRelease(api, 'v1.7.0'), draft);
  assert.equal(findRelease(api, 'v1.8.0'), undefined);
});
test('resuming the tested installer permits publication repairs and rejects every shipped input change', () => {
  checkPublicationOnlyChanges(['scripts/release/publish.cjs', '.github/workflows/release.yml', 'tests/release.test.cjs', 'docs/releasing.md', 'docs/handoff.md']);
  for (const file of ['package.json', 'package-lock.json', 'native-tools.lock.json', 'electron/main.cjs', 'src/app/AppShell.jsx', 'extension/manifest.json', 'native-host/host.cjs', 'build/installer.nsh', 'docs/INSTALL-WINDOWS-HE.md']) {
    assert.throws(() => checkPublicationOnlyChanges(['scripts/release/publish.cjs', file]));
  }
});
test('branch cleanup deletes integrated work and preserves unmerged work in an isolated Git repository', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-branch-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'), work = path.join(dir, 'work');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  const git = (args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['config', 'user.name', 'Release test']); git(['config', 'user.email', 'release-test@example.invalid']);
  fs.writeFileSync(path.join(work, 'base.txt'), 'base'); git(['add', '.']); git(['commit', '-m', 'base']);
  git(['remote', 'add', 'origin', remote]); git(['push', 'origin', 'main']);
  git(['branch', 'feature/retired']); git(['switch', '-c', 'feature/in-progress']);
  fs.writeFileSync(path.join(work, 'new-work.txt'), 'keep'); git(['add', '.']); git(['commit', '-m', 'unmerged work']);
  const unmerged = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', 'feature/retired', 'feature/in-progress']); git(['switch', 'main']);
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/release/cleanup-merged.cjs'), 'feature/retired', 'feature/in-progress'],
    { cwd: work, env: { ...process.env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(output, /Deleted merged branch: feature\/retired/);
  assert.match(output, /Kept unmerged\/changed branch: feature\/in-progress/);
  assert.equal(git(['ls-remote', '--heads', 'origin', 'refs/heads/feature/retired']), '');
  assert.ok(git(['ls-remote', '--heads', 'origin', 'refs/heads/feature/in-progress']).startsWith(unmerged));
});
