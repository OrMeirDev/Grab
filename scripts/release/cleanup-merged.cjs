// Explicitly selected retired branches only. Keep changed/unmerged work and use a deletion lease.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'branch cleanup only on the release runner');
const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 }).trim();
git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
for (const branch of process.argv.slice(2)) {
  assert.match(branch, /^(?:claude|codex|feature)\/[a-z0-9][a-z0-9/-]+$/);
  const ref = 'refs/heads/' + branch;
  const remote = git(['ls-remote', '--heads', 'origin', ref]);
  if (!remote) { console.log('Already absent: ' + branch); continue; }
  const sha = remote.split(/\s/)[0]; assert.match(sha, /^[0-9a-f]{40}$/);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { encoding: 'utf8', timeout: 30000 });
  if (ancestor.status !== 0) { console.log('Kept unmerged/changed branch: ' + branch); continue; }
  console.log(git(['push', '--force-with-lease=' + ref + ':' + sha, 'origin', ':' + ref]));
  console.log('Deleted merged branch: ' + branch + ' at ' + sha);
}
