// Runs only in the release workflow after all three checks pass on the same main commit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { info, verifyBundle } = require('./bundle.cjs');

function checkedRun(runs, sha, name) {
  const run = runs.filter((r) => r.head_sha === sha && r.head_branch === 'main' && r.event === 'push').sort((a, b) => b.run_number - a.run_number)[0];
  assert.ok(run, name + ' has no main run for this commit');
  assert.equal(run.status, 'completed', name + ' is still running');
  assert.equal(run.conclusion, 'success', name + ' did not pass');
  return run;
}
function checkAssets(release, assets) {
  assert.deepEqual(release.assets.map((a) => a.name).sort(), assets.map((a) => a.name).sort(), 'published asset names');
  for (const file of assets) {
    const remote = release.assets.find((a) => a.name === file.name);
    assert.equal(remote.state, 'uploaded', file.name + ' upload');
    assert.equal(remote.size, file.bytes, file.name + ' uploaded size');
    assert.equal(remote.digest, 'sha256:' + file.sha256, file.name + ' GitHub digest');
  }
}
async function publish() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'publish only through Actions');
  const root = path.resolve(__dirname, '../..');
  const expected = info(root); assert.match(expected.version, /^\d+\.\d+\.\d+$/, 'stable release only');
  const sha = process.env.RELEASE_SHA; assert.match(sha || '', /^[0-9a-f]{40}$/);
  const repo = process.env.GITHUB_REPOSITORY; assert.equal(repo, 'OrMeirDev/Grab');
  const gh = (args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  const api = (endpoint, args = []) => JSON.parse(gh(['api', 'repos/' + repo + '/' + endpoint, ...args]));
  const ensureMain = () => assert.equal(api('git/ref/heads/main').object.sha, sha, 'main changed; publish the newly verified commit instead');
  ensureMain();
  const runs = {};
  for (const workflow of ['ci.yml', 'browser-integration.yml', 'windows-verify.yml']) {
    runs[workflow] = checkedRun(api(`actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=30`).workflow_runs, sha, workflow);
  }
  const integration = runs['browser-integration.yml'];
  const artifactName = `Grab-${expected.version}-Windows`;
  const artifacts = api(`actions/runs/${integration.id}/artifacts?per_page=100`).artifacts.filter((a) => a.name === artifactName && !a.expired);
  assert.equal(artifacts.length, 1, 'one verified Windows bundle');
  assert.equal(artifacts[0].workflow_run.head_sha, sha, 'artifact source commit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-release-'));
  try {
    gh(['run', 'download', String(integration.id), '--repo', repo, '--name', artifactName, '--dir', dir]);
    const bundle = verifyBundle({ root, dir, sourceSha: sha });
    const tag = 'v' + expected.version;
    const tags = api('git/matching-refs/tags/' + tag).filter((r) => r.ref === 'refs/tags/' + tag);
    if (!tags.length) api('git/refs', ['--method', 'POST', '-f', 'ref=refs/tags/' + tag, '-f', 'sha=' + sha]);
    let object = api('git/ref/tags/' + tag).object;
    for (let depth = 0; object.type === 'tag' && depth < 4; depth++) object = api('git/tags/' + object.sha).object;
    assert.equal(object.type, 'commit'); assert.equal(object.sha, sha, 'release tag cannot be moved');
    const notes = path.join(root, 'docs', 'releases', expected.version + '.md'); assert.ok(fs.existsSync(notes));
    let release = api('releases?per_page=100').find((r) => r.tag_name === tag);
    if (!release) {
      gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--target', sha, '--draft', '--title', 'Grab ' + expected.version, '--notes-file', notes]);
      release = api('releases/tags/' + tag);
    }
    assert.equal(release.prerelease, false, 'full release');
    if (release.draft) {
      gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...bundle.assets.map((f) => path.join(dir, f.name))]);
      checkAssets(api('releases/tags/' + tag), bundle.assets);
      ensureMain();
      gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
    }
    const latest = api('releases/latest');
    assert.equal(latest.tag_name, tag); assert.equal(latest.draft, false); assert.equal(latest.prerelease, false);
    checkAssets(latest, bundle.assets);
    fs.writeFileSync(path.join(root, 'release-proof.json'), JSON.stringify({ version: expected.version, sha, tag, url: latest.html_url,
      checks: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { id: r.id, url: r.html_url }])), assets: bundle.assets }, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\ntag=${tag}\n`);
    console.log(`Published ${latest.html_url} with ${bundle.assets.length} verified assets from ${sha}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { checkedRun, checkAssets };
if (require.main === module) publish().catch((error) => { console.error(error.message); process.exitCode = 1; });
