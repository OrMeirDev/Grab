// scripts/fetch-bin.ps1 (npm run fetch-bin) on Windows, against a local server instead of GitHub:
// a plain executable and a zip, each with its license, hash-checked; a tampered download stops
// the script and installs nothing. Started the way a developer in a PowerShell 7 terminal (and the
// CI runner) starts it, which is where Windows PowerShell 5.1 could not find Get-FileHash.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile, execFileSync } = require('node:child_process');

const windows = process.platform === 'win32';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A zip with stored (uncompressed) entries: enough for Expand-Archive or .NET ZipFile.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Like `npm run fetch-bin` typed in a PowerShell 7 window: npm's shell starts Windows PowerShell
// with the module path PowerShell 7 set up (PowerShell 7 itself would reset it for a direct child).
function fetchBin(lockFile, binDir) {
  const script = path.join(__dirname, '..', 'scripts', 'fetch-bin.ps1');
  const env = { ...process.env };
  try { env.PSModulePath = execFileSync('pwsh', ['-NoProfile', '-Command', '$env:PSModulePath'], { encoding: 'utf8' }).trim(); } catch { /* no PowerShell 7 here */ }
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-LockFile', lockFile, '-BinDir', binDir],
    { encoding: 'utf8', timeout: 120000, env }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout + stderr, psModulePath: env.PSModulePath })));
}

test('fetch-bin: plain and zipped tools with licenses, every hash checked; a tampered file installs nothing', { skip: !windows && 'Windows only', timeout: 180000 }, async () => {
  const toolA = Buffer.from('MZ tool a');
  const toolB = Buffer.from('MZ tool b');
  const licenseA = Buffer.from('license a');
  const licenseB = Buffer.from('license b');
  const archive = zip({ 'pkg/bin/tool-b.exe': toolB, 'pkg/LICENSE.txt': licenseB });
  const files = { '/tool-a.exe': toolA, '/tool-a-LICENSE': licenseA, '/tool-b.zip': archive };
  const server = http.createServer((req, res) => {
    const body = files[req.url];
    res.writeHead(body ? 200 : 404);
    res.end(body || '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-fetchbin-'));
  try {
    const lock = {
      tools: [
        { name: 'tool-a', version: '1', url: base + '/tool-a.exe', sha256: sha256(toolA), files: { 'tool-a.exe': sha256(toolA) },
          licenseFiles: [{ url: base + '/tool-a-LICENSE', name: 'tool-a-LICENSE.txt', sha256: sha256(licenseA) }] },
        { name: 'tool-b', version: '2', url: base + '/tool-b.zip', sha256: sha256(archive), files: { 'tool-b.exe': sha256(toolB) },
          licenseFiles: [{ archivePath: 'pkg/LICENSE.txt', name: 'tool-b-LICENSE.txt', sha256: sha256(licenseB) }] },
      ],
    };
    const lockFile = path.join(dir, 'lock.json');
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    const bin = path.join(dir, 'bin');
    const ok = await fetchBin(lockFile, bin);
    assert.equal(ok.code, 0, `${ok.out}\nPSModulePath=${ok.psModulePath}`);
    assert.deepEqual(fs.readFileSync(path.join(bin, 'tool-a.exe')), toolA);
    assert.deepEqual(fs.readFileSync(path.join(bin, 'tool-b.exe')), toolB);
    assert.deepEqual(fs.readFileSync(path.join(bin, 'licenses', 'tool-a-LICENSE.txt')), licenseA);
    assert.deepEqual(fs.readFileSync(path.join(bin, 'licenses', 'tool-b-LICENSE.txt')), licenseB);
    assert.equal(fs.readFileSync(path.join(bin, 'native-tools.lock.json'), 'utf8'), fs.readFileSync(lockFile, 'utf8'));

    // The server now hands out something else under the pinned name.
    files['/tool-a.exe'] = Buffer.from('MZ not the pinned build');
    const bin2 = path.join(dir, 'bin2');
    const bad = await fetchBin(lockFile, bin2);
    assert.notEqual(bad.code, 0, bad.out);
    assert.match(bad.out, /SHA-256 mismatch for tool-a\.exe/);
    assert.equal(fs.existsSync(path.join(bin2, 'tool-a.exe')), false);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
