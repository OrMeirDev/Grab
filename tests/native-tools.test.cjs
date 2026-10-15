// The native tool lock (GRB-06): exact releases only, hashes present, and the packaging check
// refuses a bin/ folder that doesn't match it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'native-tools.lock.json'), 'utf8'));
const HEX = /^[0-9a-f]{64}$/;

test('every bundled tool is pinned to an exact release with SHA-256 hashes', () => {
  assert.deepEqual(lock.tools.map((t) => t.name).sort(), ['deno', 'ffmpeg', 'yt-dlp']);
  for (const tool of lock.tools) {
    assert.match(tool.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/, tool.name);
    assert.doesNotMatch(tool.url, /\/latest\b|master-latest/, `${tool.name} must not float`);
    assert.match(tool.sha256, HEX, tool.name);
    assert.ok(tool.version && tool.license && tool.source, tool.name);
    assert.ok(Object.keys(tool.files).length, tool.name);
    for (const hash of Object.values(tool.files)) assert.match(hash, HEX);
    for (const l of tool.licenseFiles) assert.match(l.sha256, HEX);
  }
  const script = fs.readFileSync(path.join(root, 'scripts', 'fetch-bin.ps1'), 'utf8');
  assert.doesNotMatch(script, /releases\/latest|master-latest/, 'fetch-bin downloads only what the lock names');
});

test('the packaging check refuses missing, altered and unexpected executables', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-bin-'));
  try {
    fs.writeFileSync(path.join(bin, 'yt-dlp.exe'), 'not the pinned build');
    fs.writeFileSync(path.join(bin, 'extra.exe'), 'x');
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-native-tools.cjs'), bin], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /yt-dlp\.exe: SHA-256 [0-9a-f]+, expected 6667/);
    assert.match(r.stderr, /ffmpeg\.exe: missing/);
    assert.match(r.stderr, /extra\.exe: not in native-tools\.lock\.json/);
    assert.match(r.stderr, /licenses\/ffmpeg-LICENSE\.txt: missing/);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});
